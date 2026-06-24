/**
 * ModelPreloader — keeps one warm Whisper worker alive in the background
 * so the first recording session starts instantly instead of waiting 2–5s
 * for the model to load off disk into ONNX Runtime.
 *
 * Usage pattern:
 *   1. Call preload(modelId) when the app launches or when local-whisper is selected.
 *   2. When LocalWhisperSTT.start() fires, call takeWarmWorker(modelId).
 *      If a warm worker exists it is handed off (no startup delay).
 *      If not, LocalWhisperSTT falls back to spawning its own worker normally.
 *
 * Only one warm worker is kept alive at a time. The second audio channel
 * (interviewer vs user) will spawn a fresh worker, which is acceptable because
 * the ONNX model weights file is already in the OS disk-cache after the first
 * worker loaded it, making the cold-start much faster than the first load.
 */

import { Worker } from 'worker_threads';
import fs from 'fs';
import { app } from 'electron';
import path from 'path';
import { buildWorkerInitMessage } from './inferenceConfig';
import { resolveWhisperWorkerPath } from './workerPathResolver';

// Recent preload failure cooldown: tracks modelIds that just failed to init
// so we don't hammer them on every app launch / settings toggle / hotkey.
// Persisted to a small JSON file in the userData dir so a failure isn't
// re-attempted across restarts. TTL is short (5 min) — the recovery path is
// the new local-whisper-reset-to-default IPC.
const RECENT_FAILURE_TTL_MS = 5 * 60 * 1000;

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
        fs.writeFileSync(recentFailuresPath(), JSON.stringify(obj), 'utf-8');
    } catch {
        // best-effort; failure to persist is non-fatal
    }
}

class ModelPreloader {
    private warmWorker: Worker | null = null;
    private warmModelId: string | null = null;
    private loadingWorker: Worker | null = null;
    private pendingModelId: string | null = null;
    private loading = false;
    // modelId -> epoch ms expiry. A preload for a modelId whose entry is still
    // in the future is a no-op (avoids the same crash firing repeatedly during
    // a session that touches the same bad model). Persisted via the
    // recentFailuresPath() helper above.
    private recentFailures: Map<string, number> = loadRecentFailures();

    /**
     * Warm up a worker for the given model ID.
     * Safe to call multiple times — no-ops if already warm or loading for the same model.
     * Cancels an in-progress load if a different model is requested.
     */
    preload(modelId: string): void {
        if (this.warmModelId === modelId && this.warmWorker) return;
        if (this.pendingModelId === modelId && this.loading) return;

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

        // Cancel any in-progress load for a different model
        if (this.loadingWorker) {
            this.loadingWorker.terminate();
            this.loadingWorker = null;
        }
        // Tear down warm worker for a different model
        if (this.warmWorker) {
            this.warmWorker.terminate();
            this.warmWorker = null;
            this.warmModelId = null;
        }

        this.loading = true;
        this.pendingModelId = modelId;

        console.log(`[ModelPreloader] Warming worker for ${modelId}...`);

        const workerPath = resolveWhisperWorkerPath();
        // Defensive: a missing/moved workerPath would otherwise throw a
        // cryptic "Worker not constructed" on the next line and leave this
        // instance in a half-loaded state. Bail out cleanly instead.
        if (!workerPath || !fs.existsSync(workerPath)) {
            console.error(`[ModelPreloader] Worker path missing or invalid: ${workerPath}`);
            this.recordFailure(modelId);
            this.loading = false;
            this.pendingModelId = null;
            return;
        }
        const w = new Worker(workerPath);
        this.loadingWorker = w;

        w.on('message', (msg: any) => {
            if (msg.type === 'ready') {
                console.log(`[ModelPreloader] Worker warm for ${modelId}`);
                this.warmWorker = w;
                this.loadingWorker = null;
                this.warmModelId = modelId;
                this.pendingModelId = null;
                this.loading = false;
            } else if (msg.type === 'error') {
                console.warn(`[ModelPreloader] Worker init failed: ${msg.message}`);
                this.recordFailure(modelId);
                w.terminate();
                this.loadingWorker = null;
                this.pendingModelId = null;
                this.loading = false;
            }
        });

        w.on('error', (err) => {
            console.warn('[ModelPreloader] Worker error:', err.message);
            this.recordFailure(modelId);
            this.loadingWorker = null;
            this.pendingModelId = null;
            this.loading = false;
        });

        w.postMessage(buildWorkerInitMessage(modelId));
    }

    private recordFailure(modelId: string): void {
        const expiry = Date.now() + RECENT_FAILURE_TTL_MS;
        this.recentFailures.set(modelId, expiry);
        saveRecentFailures(this.recentFailures);
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
     * Hand off the warm worker to a caller and clear the cache.
     * Returns null if no warm worker is available for that model ID.
     */
    takeWarmWorker(modelId: string): Worker | null {
        if (this.warmModelId === modelId && this.warmWorker) {
            const w = this.warmWorker;
            this.warmWorker = null;
            this.warmModelId = null;
            console.log(`[ModelPreloader] Handing off warm worker for ${modelId}`);
            return w;
        }
        return null;
    }

    isWarm(modelId: string): boolean {
        return this.warmModelId === modelId && this.warmWorker !== null;
    }

    terminate(): void {
        this.loadingWorker?.terminate();
        this.loadingWorker = null;
        this.warmWorker?.terminate();
        this.warmWorker = null;
        this.warmModelId = null;
        this.pendingModelId = null;
        this.loading = false;
    }
}

export const modelPreloader = new ModelPreloader();
