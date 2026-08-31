/**
 * ModelPreloader — keeps warm Whisper workers alive in the background so the
 * first recording session starts instantly instead of waiting 2–5s for the
 * model to load off disk into ONNX Runtime.
 *
 * Usage pattern:
 *   1. Call preload(modelId) when the app launches or when local-whisper is selected.
 *   2. When LocalWhisperSTT.start() fires, call takeWarmWorker(modelId).
 *      If a warm worker exists it is handed off (no startup delay).
 *      If not, LocalWhisperSTT falls back to spawning its own worker normally.
 *
 * One warm worker is kept PER MODEL ID. This was a single slot until
 * per-channel transcription shipped a second consumer: mic and interviewer are
 * independent LocalWhisperSTT instances, the mic always asked first and took
 * the only warm worker, and the interviewer was left to cold-start. That is not
 * the graceful degradation the comment here used to claim — a cold-started
 * worker logs "Loading" and then sits at 0% CPU without ever reporting `ready`,
 * so the interviewer channel never transcribed at all and everything
 * downstream of it (interviewer segments, Auto Answer) stayed silent. Keying
 * the warm slot by model id lets every selected model be handed off ready.
 *
 * The cost is one worker per distinct selected model — two Moonshine workers
 * measured ~150MB and ~0.4% CPU combined — and the map is capped at
 * MAX_WARM_WORKERS so it cannot grow past what the app can actually select.
 */

import { Worker } from 'worker_threads';
import fs from 'fs';
import { app } from 'electron';
import path from 'path';
import { buildWorkerInitMessage } from './inferenceConfig';
import { resolveWhisperWorkerPath } from './workerPathResolver';
import { acquireSharedNemotronWorker } from './nemotron/sharedWorkerRegistry';

// Stable channelId for the preloader's warm hold. Distinct from LocalWhisperSTT's
// per-channel ids ('mic' / 'system'), so it occupies its own registry slot and
// its engine instance is never mistaken for an audio channel's.
const NEMOTRON_WARM_CHANNEL_ID = 'preload-warm';
import { acquireOnnxSlot, hasEnoughMemoryForOnnxSession, getMinFreeGBForOnnxSession } from '../../utils/onnxThreadConfig';
import {
    consumePoisonedOnnxLoad,
    isSentinelWithinTtl,
    clearLoadSentinel as clearOnnxLoadSentinel,
    writeLoadSentinel as writeOnnxLoadSentinel,
} from '../../utils/onnxLoadSentinel';

// Recent preload failure cooldown: tracks modelIds that just failed to init
// so we don't hammer them on every app launch / settings toggle / hotkey.
// Persisted to a small JSON file in the userData dir so a failure isn't
// re-attempted across restarts. TTL is short (5 min) — the recovery path is
// the new local-whisper-reset-to-default IPC.
const RECENT_FAILURE_TTL_MS = 5 * 60 * 1000;

// Ceiling on simultaneously warm workers. The app can only ever have three
// distinct models selected at once — the global `localWhisperModel` plus the
// `localWhisperModelMic` / `localWhisperModelSystem` per-channel overrides — so
// three is the natural bound and the cap does not bite in normal use. It exists
// so that a caller looping over more ids than that (or a future third audio
// channel) evicts instead of accumulating workers forever. Map iteration is
// insertion order, so the entry dropped is the least recently warmed.
const MAX_WARM_WORKERS = 3;

// Cross-launch disk sentinel: re-exports of the generalized module keyed on
// the 'whisper' family. The original `WhisperLoadSentinel` type is preserved
// as a structural superset of the generalized record, so call sites and the
// existing `WhisperLoadSentinel.test.mjs` keep compiling without changes.
// `family` is widened to the full `OnnxFamily` union so the generalized
// module's return type assigns cleanly into this alias.
import type { OnnxFamily } from '../../utils/onnxLoadSentinel';
export type WhisperLoadSentinel = {
    family: OnnxFamily;
    modelId: string;
    startedAt: number;
    attempt: number;
};

function recentFailuresPath(): string {
    return path.join(app.getPath('userData'), 'whisper-recent-failures.json');
}

function loadRecentFailures(): Map<string, number> {
    try {
        const raw = fs.readFileSync(recentFailuresPath(), 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, number>;
        const m = new Map<string, number>();
        for (const [k, v] of Object.entries(parsed)) {
            if (typeof k === 'string' && typeof v === 'number' && v > Date.now()) m.set(k, v);
        }
        return m;
    } catch {
        return new Map();
    }
}

function saveRecentFailures(m: Map<string, number>): void {
    try {
        const obj: Record<string, number> = {};
        for (const [k, v] of m.entries()) obj[k] = v;
        // Atomic write (tmp + rename) so a process kill mid-write doesn't
        // leave the JSON half-written. Matches the pattern in
        // SettingsManager.saveSettings(). Without this, loadRecentFailures
        // catches the JSON.parse error and returns an empty map — which
        // silently forgets the cooldown and allows immediate retries.
        const finalPath = recentFailuresPath();
        const tmpPath = `${finalPath}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(obj), 'utf-8');
        fs.renameSync(tmpPath, finalPath);
    } catch {
        // best-effort; failure to persist is non-fatal
    }
}

// Whisper-family thin shims over the generalized module so existing call
// sites in `electron/main.ts` and `electron/audio/LocalWhisperSTT.ts` keep
// working byte-identically. New families wire the generalized primitives
// directly (no shim).
export function writeLoadSentinel(modelId: string): void {
    writeOnnxLoadSentinel('whisper', modelId);
}

export function clearLoadSentinel(modelId?: string): void {
    clearOnnxLoadSentinel('whisper', modelId);
}

class ModelPreloader {
    // modelId -> worker that has reported `ready` and is waiting to be claimed
    // by takeWarmWorker(). Replaces the old warmWorker/warmModelId pair; see
    // the file header for why a single slot starved the interviewer channel.
    private warmWorkers: Map<string, Worker> = new Map();
    // modelId -> worker that has been spawned but has not reported `ready` yet.
    // Replaces loadingWorker/pendingModelId/loading. A Map rather than the Set
    // of ids the duplicate-preload guard alone would need, because terminate()
    // still has to be able to tear in-flight loads down.
    private loadingWorkers: Map<string, Worker> = new Map();
    // Nemotron only. Not a Worker: the registry owns that. This is just the
    // refcount hold that keeps its shared worker (and the three loaded ONNX
    // sessions) alive between meetings, so mic/system JOIN instead of cold
    // starting. Released when the selected model changes away from Nemotron.
    private nemotronWarmRelease: (() => void) | null = null;
    private nemotronWarmModelId: string | null = null;
    private nemotronWarmLoading = false;
    // The Nemotron build we intend to keep warm — set when the registry acquire
    // starts and held for the lifetime of the hold. The acquire's .then()
    // compares against it to notice a selection change that landed while it was
    // still loading; that check used to read the single `pendingModelId` slot,
    // which no longer exists.
    private nemotronWarmPendingId: string | null = null;
    // Ids passed to preload() since the last reconcile, plus the one-shot
    // microtask flag that drains them. See noteWarmRequest().
    private requestedThisBatch: Set<string> = new Set();
    private reconcileScheduled = false;
    // modelId -> epoch ms expiry. A preload for a modelId whose entry is still
    // in the future is a no-op (avoids the same crash firing repeatedly during
    // a session that touches the same bad model). Persisted via the
    // recentFailuresPath() helper above.
    private recentFailures: Map<string, number> = loadRecentFailures();

    /**
     * Warms Nemotron by taking a long-lived registry channel. The registry
     * remains the sole owner of the worker — this only contributes a refcount
     * so the loaded sessions survive between meetings.
     *
     * Deliberately fire-and-forget: preload() is synchronous by contract (its
     * only caller is the app-launch path, which must not block on a ~7s model
     * load). A failure here is non-fatal — LocalWhisperSTT still cold-starts
     * through the registry exactly as before, just slowly.
     */
    private preloadNemotronViaRegistry(modelId: string): void {
        if (this.nemotronWarmModelId === modelId && this.nemotronWarmRelease) return;
        if (this.nemotronWarmLoading) return;
        // A different Nemotron build was warm — let it go before warming this one.
        this.releaseNemotronWarmHold();
        // Same persisted cooldown the normal preload path honours — a model
        // that just crashed the process must not be re-warmed on every launch.
        const failureExpiry = this.recentFailures.get(modelId);
        if (failureExpiry && failureExpiry > Date.now()) {
            console.warn(`[ModelPreloader] Skipping Nemotron warm for ${modelId} — recent failure cooldown until ${new Date(failureExpiry).toISOString()}`);
            return;
        }
        const workerPath = resolveWhisperWorkerPath();
        if (!workerPath || !fs.existsSync(workerPath)) {
            console.error(`[ModelPreloader] Worker path missing or invalid: ${workerPath}`);
            this.recordFailure(modelId);
            return;
        }
        if (!hasEnoughMemoryForOnnxSession()) {
            console.warn(`[ModelPreloader] Skipping Nemotron warm — under ${getMinFreeGBForOnnxSession()}GB free`);
            return;
        }
        const initMsg = buildWorkerInitMessage(modelId);
        this.nemotronWarmLoading = true;
        this.nemotronWarmPendingId = modelId;
        console.log(`[ModelPreloader] Warming Nemotron via sharedWorkerRegistry for ${modelId}...`);
        const startedAt = Date.now();
        // Same crash sentinel every other preloaded model gets: a NATIVE abort
        // during session load kills the process before any catch runs, and the
        // sentinel is what makes the next launch treat the model as poisoned.
        writeLoadSentinel(modelId);
        acquireSharedNemotronWorker(modelId, NEMOTRON_WARM_CHANNEL_ID, initMsg.executionProviders ?? ['cpu'], initMsg.cacheDir, workerPath)
            .then(({ release }) => {
                clearLoadSentinel(modelId);
                this.nemotronWarmLoading = false;
                // Model changed while we were loading — don't strand a hold on
                // a worker nobody wants. reconcileWarmHolds() clears
                // nemotronWarmPendingId when the selection moves off Nemotron,
                // which is what makes this comparison fail.
                if (this.nemotronWarmPendingId !== modelId) { release(); return; }
                this.nemotronWarmRelease = release;
                this.nemotronWarmModelId = modelId;
                console.log(`[ModelPreloader] Nemotron warm for ${modelId} (${Date.now() - startedAt}ms) — channels will join, not cold start`);
            })
            .catch((err: unknown) => {
                clearLoadSentinel(modelId);
                this.nemotronWarmLoading = false;
                this.recordFailure(modelId);
                console.warn(`[ModelPreloader] Nemotron warm failed for ${modelId}:`, (err as Error)?.message ?? err);
            });
    }

    /** Drops the Nemotron warm hold, if any. Safe to call unconditionally. */
    private releaseNemotronWarmHold(): void {
        if (!this.nemotronWarmRelease) return;
        console.log(`[ModelPreloader] Releasing Nemotron warm hold for ${this.nemotronWarmModelId}`);
        try { this.nemotronWarmRelease(); } catch { /* registry already torn down */ }
        this.nemotronWarmRelease = null;
        this.nemotronWarmModelId = null;
        this.nemotronWarmPendingId = null;
    }

    /**
     * Detach and terminate a worker this class still owns.
     *
     * Listeners come off BEFORE terminate() for the same reason
     * takeWarmWorker() strips them before handoff: terminate() makes the worker
     * exit with a non-zero code, and the `exit` handler installed in preload()
     * reads a non-zero code as "this model failed to load" and writes a
     * 5-minute recentFailures cooldown for it. Disposing a perfectly healthy
     * worker — cap eviction, app teardown — must not poison the model it was
     * warming. Dropping the `exit` listener also drops the `__slotRelease()`
     * call it would have made, so the ONNX slot is released explicitly here.
     */
    private disposeWorker(worker: Worker, modelId: string, reason: string): void {
        console.log(`[ModelPreloader] Disposing ${reason} for ${modelId}`);
        worker.removeAllListeners('message');
        worker.removeAllListeners('error');
        worker.removeAllListeners('exit');
        try { (worker as any).__slotRelease?.(); } catch { /* slot already released */ }
        worker.terminate();
    }

    /**
     * Drop a worker from whichever map still points at it. Identity-checked so
     * a late `exit` / `error` from a superseded worker cannot evict the
     * replacement that has since taken its modelId.
     */
    private forgetWorker(modelId: string, worker: Worker): void {
        if (this.loadingWorkers.get(modelId) === worker) this.loadingWorkers.delete(modelId);
        if (this.warmWorkers.get(modelId) === worker) this.warmWorkers.delete(modelId);
    }

    /** Evict least-recently-warmed workers until the map is back under the cap. */
    private enforceWarmCap(): void {
        while (this.warmWorkers.size > MAX_WARM_WORKERS) {
            const oldestId = this.warmWorkers.keys().next().value;
            if (oldestId === undefined) return;
            const oldest = this.warmWorkers.get(oldestId);
            this.warmWorkers.delete(oldestId);
            if (oldest) this.disposeWorker(oldest, oldestId, `warm worker over the ${MAX_WARM_WORKERS}-model cap`);
        }
    }

    /**
     * Note that `modelId` belongs to the selection the app wants warm, and
     * schedule the end-of-batch reconcile.
     *
     * preload() is called once per selected model, back to back, from a single
     * synchronous block (main.ts's app-launch loop). Deferring by a microtask
     * makes the reconcile run exactly once, after every call in that batch has
     * been seen — which is what makes "does anything still want Nemotron?"
     * answerable now that more than one model can be selected at a time. It
     * does not touch preload()'s own fire-and-forget synchronous contract.
     */
    private noteWarmRequest(modelId: string): void {
        this.requestedThisBatch.add(modelId);
        if (this.reconcileScheduled) return;
        this.reconcileScheduled = true;
        queueMicrotask(() => {
            this.reconcileScheduled = false;
            const requested = this.requestedThisBatch;
            this.requestedThisBatch = new Set();
            this.reconcileWarmHolds(requested);
        });
    }

    /**
     * Drop the Nemotron warm hold when nothing in the latest batch of preload()
     * calls wants it — the "switching AWAY from Nemotron" case that used to sit
     * inline at the top of preload().
     *
     * It cannot sit there any more: a non-Nemotron preload no longer implies
     * the user moved off Nemotron, because the OTHER channel may still be on it
     * (mic on Nemotron, system on Moonshine is a legal per-channel selection).
     * Releasing on the Moonshine call would tear down the three ONNX sessions
     * the mic channel is about to join and put the ~7s cold start back at
     * meeting start — the exact cost preloadNemotronViaRegistry() exists to
     * avoid.
     *
     * Ordinary warm workers are deliberately NOT evicted here. preload() is an
     * additive public API — the local-whisper-preload IPC calls it with a
     * single id — so a lone call must not throw away another channel's warm
     * worker. Their bound is MAX_WARM_WORKERS instead.
     */
    private reconcileWarmHolds(requested: Set<string>): void {
        // Fall back to the pending id so a selection change that lands while
        // the registry acquire is still in flight is not forgotten; clearing it
        // is what makes that acquire release itself when it resolves.
        const held = this.nemotronWarmModelId ?? this.nemotronWarmPendingId;
        if (!held || requested.has(held)) return;
        this.nemotronWarmPendingId = null;
        this.releaseNemotronWarmHold();
    }

    /**
     * Warm up a worker for the given model ID.
     * Safe to call multiple times — no-ops if this model is already warm or
     * already loading. Preloading a DIFFERENT model no longer cancels the
     * first: both stay warm, keyed by model id, up to MAX_WARM_WORKERS.
     */
    preload(modelId: string): void {
        // Record the request BEFORE any early return below. An id that
        // short-circuits (already warm, still loading, in failure cooldown) is
        // every bit as "wanted" as one that spawns a worker, and
        // reconcileWarmHolds() decides what to tear down from exactly this set.
        this.noteWarmRequest(modelId);

        // Dual-channel Nemotron routes worker acquisition entirely through
        // sharedWorkerRegistry.ts, so it must NOT go through this class's
        // warm-worker scheme — that would create a second, competing concept
        // of who owns the worker. This used to return outright, leaving
        // LocalWhisperSTT to pay the cold start on first use.
        //
        // That cold start is not cheap and not hidden: loading the three ONNX
        // sessions takes ~7s, and it happened at MEETING START. VAD banks a
        // backlog for those 7s, so the first dispatch is seconds of audio
        // (observed 4080ms mic / 5670ms system) — and streamingTaskInFlight
        // gates re-dispatch until it returns, so the streaming loop stalls
        // behind that one oversized request. A short meeting ended before any
        // result came back and produced an empty transcript.
        //
        // Fixed by warming through the REGISTRY rather than through the
        // warmWorkers map: acquire a long-lived channel here and hold its
        // release. The registry stays the single owner (no competing
        // lifecycle), the sessions load at app start, and mic/system then JOIN
        // a ready worker — their NemotronEngine.create() reuses
        // nemotronSharedResources and returns without loading anything.
        if (modelId.toLowerCase().includes('nemotron')) {
            this.preloadNemotronViaRegistry(modelId);
            return;
        }
        // "Switching AWAY from Nemotron — drop the warm hold so the registry
        // can tear its worker down and free the ONNX slot for the incoming
        // model" used to happen right here. It moved to reconcileWarmHolds():
        // with per-channel models a non-Nemotron preload no longer implies the
        // user left Nemotron, because the other channel may still be on it.
        //
        // Both guards below are per-model now, so preloading a SECOND model
        // warms it alongside the first instead of being mistaken for a repeat
        // of the first. Repeats of the same id are still free no-ops, which is
        // what keeps a caller that preloads on every settings toggle from
        // spawning duplicate workers.
        if (this.warmWorkers.has(modelId)) return;
        if (this.loadingWorkers.has(modelId)) return;

        // Skip if this modelId recently failed — the user has the
        // local-whisper-reset-to-default IPC for the clean recovery path,
        // and re-attempting on every settings toggle would re-trigger the
        // crash. TTL is short; after 5 min we try once more in case the
        // underlying issue resolved itself.
        const failureExpiry = this.recentFailures.get(modelId);
        if (failureExpiry && failureExpiry > Date.now()) {
            console.warn(`[ModelPreloader] Skipping preload for ${modelId} — recent failure cooldown active until ${new Date(failureExpiry).toISOString()}`);
            return;
        }

        // Cross-loader ONNX gate — REFUSE silently if memory is tight. Do NOT
        // surface as a worker error here, or the 5-min persisted failure
        // cooldown above would block future preloads. The user can retry by
        // toggling Settings → Audio when memory frees up. Acquire the slot
        // at HIGH priority (Whisper is latency-critical).
        if (!hasEnoughMemoryForOnnxSession()) {
            console.warn(
                `[ModelPreloader] skipping preload for ${modelId} — free memory below ${getMinFreeGBForOnnxSession()}GB floor (silent skip, not a worker error)`,
            );
            return;
        }

        // There is no "cancel the in-progress load / tear down the warm worker
        // for a different model" step any more: coexisting models are the whole
        // point of the maps. Nothing is evicted until a worker reports ready
        // and enforceWarmCap() finds the map over MAX_WARM_WORKERS.
        console.log(`[ModelPreloader] Warming worker for ${modelId}...`);

        const workerPath = resolveWhisperWorkerPath();
        // Defensive: a missing/moved workerPath would otherwise throw a
        // cryptic "Worker not constructed" on the next line and leave this
        // instance in a half-loaded state. Bail out cleanly instead.
        if (!workerPath || !fs.existsSync(workerPath)) {
            console.error(`[ModelPreloader] Worker path missing or invalid: ${workerPath}`);
            this.recordFailure(modelId);
            return;
        }
        // Acquire the shared ONNX slot BEFORE spawning the worker. The release
        // function is wired into the worker's error/exit handlers below — the
        // slot stays held for the lifetime of the worker's session. Always
        // weight 1: Nemotron never reaches this line (the early-return guard
        // at the top of preload() routes it through sharedWorkerRegistry.ts
        // instead), and every other model is one worker = one gate unit —
        // the previous `includes('nemotron') ? 3 : 1` here was dead code.
        // A weight-1 acquisition never rejects (only weight > cap does, per
        // acquireOnnxSlot's contract), so the empty .catch() is genuinely
        // unreachable, kept purely as a chain guard.
        let slotRelease: (() => void) | null = null;
        acquireOnnxSlot('high', 1).then((release) => {
            slotRelease = release;
        }).catch(() => { /* unreachable for weight 1 — chain guard only */ });

        writeLoadSentinel(modelId);
        const w = new Worker(workerPath);
        this.loadingWorkers.set(modelId, w);
        // Stash release on the worker object so takeWarmWorker() can hand it
        // off cleanly when LocalWhisperSTT picks up this warm worker.
        (w as any).__slotRelease = () => {
            if (slotRelease) { slotRelease(); slotRelease = null; }
        };
        w.on('exit', (code) => {
            if (code === 0) {
                clearLoadSentinel(modelId);
            } else {
                this.recordFailure(modelId);
            }
            // forgetWorker() also drops a WARM entry, which the old
            // `if (this.loadingWorker === w)` check could not: a warm worker
            // that died on its own left a dead Worker in the slot, and the next
            // takeWarmWorker() handed that corpse to LocalWhisperSTT.
            this.forgetWorker(modelId, w);
            (w as any).__slotRelease?.();
        });

        w.on('message', (msg: any) => {
            if (msg.type === 'ready') {
                clearLoadSentinel(modelId);
                console.log(`[ModelPreloader] Worker warm for ${modelId}`);
                this.loadingWorkers.delete(modelId);
                // Defensive: a warm entry for this id should be impossible (the
                // guard at the top of preload() would have returned early), but
                // overwriting one would drop the only reference to a live
                // worker — leaking it past terminate() and past the cap.
                const superseded = this.warmWorkers.get(modelId);
                if (superseded && superseded !== w) {
                    this.disposeWorker(superseded, modelId, 'superseded warm worker');
                }
                this.warmWorkers.set(modelId, w);
                this.enforceWarmCap();
            } else if (msg.type === 'error') {
                console.warn(`[ModelPreloader] Worker init failed: ${msg.message}`);
                this.recordFailure(modelId);
                clearLoadSentinel(modelId);
                this.loadingWorkers.delete(modelId);
                w.terminate();
            }
        });

        // One 'error' handler, not the two the single-slot version registered
        // (a slot-release-only one beside the 'exit' handler, plus this one).
        // Node fires every registered listener, so both always ran; folding
        // them together keeps the slot release on the error path without the
        // duplicate registration.
        w.on('error', (err) => {
            console.warn('[ModelPreloader] Worker error:', err.message);
            this.recordFailure(modelId);
            this.forgetWorker(modelId, w);
            (w as any).__slotRelease?.();
        });

        w.postMessage(buildWorkerInitMessage(modelId));
    }

    private recordFailure(modelId: string): void {
        const expiry = Date.now() + RECENT_FAILURE_TTL_MS;
        this.recentFailures.set(modelId, expiry);
        saveRecentFailures(this.recentFailures);
    }

    recordLoadFailure(modelId: string): void {
        this.recordFailure(modelId);
    }

    consumePoisonedLoadSentinel(): WhisperLoadSentinel | null {
        const sentinel = consumePoisonedOnnxLoad('whisper');
        if (sentinel && isSentinelWithinTtl(sentinel)) {
            console.warn(`[ModelPreloader] Previous process exited while loading ${sentinel.modelId}; recording recent-failure cooldown`);
            this.recordFailure(sentinel.modelId);
            return sentinel;
        }
        return null;
    }

    /**
     * Clear the recent-failure entry for a modelId. Called by the
     * local-whisper-reset-to-default IPC after we successfully swap the
     * active model back to the safe fallback — the bad id is no longer
     * active, so the cooldown shouldn't block a future intentional re-select.
     */
    clearRecentFailure(modelId: string): void {
        if (this.recentFailures.delete(modelId)) {
            saveRecentFailures(this.recentFailures);
        }
    }

    /**
     * Hand off the warm worker for `modelId` to a caller and drop it from the
     * warm map. Returns null if no warm worker is available for that model ID —
     * including the ordinary case where the caller's model was never preloaded,
     * which LocalWhisperSTT handles by cold-starting its own worker.
     *
     * IMPORTANT: removes ALL of the preloader's listeners (`message`,
     * `error`, `exit`) before handoff — not just `message`. Node's
     * EventEmitter fires every registered listener for an event, not just
     * the most recently added one, so leaving the preloader's `error`/`exit`
     * handlers attached means BOTH the preloader's AND the consumer's
     * handler fire on a live-worker error. The preloader's `error`/`exit`
     * handlers call `recordFailure(modelId)` (the `exit` / `error` listeners
     * installed in preload()) — so a transient error on the worker AFTER
     * handoff (while LocalWhisperSTT is actively driving it during a live
     * recording) would silently poison the 5-minute recent-failure cooldown for a
     * model that is demonstrably fine (it's mid-session, not failing to
     * load). The NEXT meeting's pre-warm would then silently skip for up
     * to 5 minutes (preload()'s recentFailures cooldown check), manifesting as
     * "transcription is slow to start" with no visible error. The consumer
     * (LocalWhisperSTT.attachWorkerListeners) installs its own complete
     * message/error/exit handlers immediately after taking the worker, so
     * removing all three preloader listeners here is safe — the worker is
     * never left without error/exit handling. The ONNX slot release
     * (`__slotRelease`, stashed on the worker object) is unaffected by this
     * — it's read by the CONSUMER's own exit/error handlers, not the
     * preloader's removed ones. Mirrors the listener-cleanup pattern in
     * LocalWhisperSTT.beginWorkerTermination.
     */
    takeWarmWorker(modelId: string): Worker | null {
        const w = this.warmWorkers.get(modelId);
        if (!w) return null;
        w.removeAllListeners('message');
        w.removeAllListeners('error');
        w.removeAllListeners('exit');
        this.warmWorkers.delete(modelId);
        console.log(`[ModelPreloader] Handing off warm worker for ${modelId}`);
        return w;
    }

    isWarm(modelId: string): boolean {
        return this.warmWorkers.has(modelId);
    }

    terminate(): void {
        // disposeWorker() rather than a bare terminate(): a non-zero exit code
        // from an intentional teardown would otherwise be recorded as a load
        // failure and persist a 5-minute cooldown for a model that never failed.
        for (const [id, w] of this.loadingWorkers) this.disposeWorker(w, id, 'in-flight load');
        this.loadingWorkers.clear();
        for (const [id, w] of this.warmWorkers) this.disposeWorker(w, id, 'warm worker');
        this.warmWorkers.clear();
    }
}

export const modelPreloader = new ModelPreloader();
