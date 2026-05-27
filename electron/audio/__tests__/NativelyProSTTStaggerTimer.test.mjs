// Regression test for the "orphan stagger setTimeout double-connect" bug in
// NativelyProSTT.connect().
//
// Symptom: the 3s stagger setTimeout inside connect() at ~line 308 (used to
// space concurrent same-key sessions to avoid the server's
// concurrent_session_blocked race) used to be UNTRACKED — its handle was
// thrown away. If stop() then start() ran within the stagger window, the
// orphan timer survived. Its body checks `this.isActive`, which is true again
// after the new start(), so it called `connect(true)` INSIDE the new session
// while the new session's own connect() was already running. Two WebSockets
// raced, one lost with code 1006, and the close handler kicked off a
// reconnect cascade that briefly dropped transcripts.
//
// Fix: the stagger setTimeout now stores its handle in the same
// `pendingConnectTimer` field that inline reconnect timers (setSampleRate /
// setRecognitionLanguage / language_detected) already use. start() and stop()
// clear the field, so a stop+start sequence cancels any in-flight stagger.
//
// Strategy: load the COMPILED NativelyProSTT with `Module._load` patched so
// `require('electron')` is harmless, force the static `nextSlotByKey` map to
// guarantee a stagger window, then spy on the instance's `connect` method to
// count `connect(true)` (the stagger continuation). After stop+start within
// the window, only ONE stagger continuation should fire — the new session's
// — not two (which would prove the orphan survived).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(__dirname, '../../../dist-electron/electron/audio');

const origLoad = Module._load;
Module._load = function patchedLoad(request, _parent, _isMain) {
    if (request === 'electron') {
        return {
            app: {
                getAppPath: () => '/tmp/fake-natively-app',
                isPackaged: false,
                isReady: () => false,
            },
        };
    }
    return origLoad.apply(this, arguments);
};

const { NativelyProSTT } = await import(path.join(distRoot, 'NativelyProSTT.js'));

test('orphan stagger setTimeout from connect() must not fire after stop()/start() (no double-connect)', async () => {
    const API_KEY = 'stagger-regression-key';

    // Make sure no other test poisoned the slot map for this key.
    NativelyProSTT.nextSlotByKey.delete(API_KEY);

    const stt = new NativelyProSTT(API_KEY, 'mic');

    // Wrap `connect` so we can:
    //   (a) count calls and observe whether skipStagger=true (the stagger
    //       continuation) ever fires from the orphan,
    //   (b) short-circuit the real WebSocket-construction branch — once the
    //       stagger logic has run, we don't want to actually open a socket.
    let connectCalls = 0;
    let staggerContinuationCalls = 0;
    const origConnect = stt.connect.bind(stt);
    stt.connect = function spyConnect(skipStagger = false) {
        connectCalls++;
        if (skipStagger) staggerContinuationCalls++;
        // Run the real stagger arithmetic so pendingConnectTimer gets set,
        // but short-circuit BEFORE the `new WebSocket(...)` line by faking
        // the isConnecting flag. We do this by calling the original only
        // when skipStagger=false; when skipStagger=true (the continuation),
        // we deliberately do nothing — its only job here is to prove it
        // was called, not to open a socket.
        if (skipStagger) {
            // Simulate what real connect(true) would do up to the WS line:
            // reset isConnecting so a subsequent connect can proceed.
            stt.isConnecting = false;
            return;
        }
        // Manually reproduce the stagger branch so pendingConnectTimer is
        // populated by THIS spy (not the original) — this keeps the test
        // independent of any future change to connect's pre-WS code path,
        // and avoids accidentally invoking `new WebSocket()`.
        if (!stt.isActive) return;
        const now = Date.now();
        const reserved = NativelyProSTT.nextSlotByKey.get(stt.apiKey) ?? 0;
        const staggerMs = Math.max(0, reserved - now);
        NativelyProSTT.nextSlotByKey.set(
            stt.apiKey,
            Math.max(now, reserved) + 3000,
        );
        if (staggerMs > 0) {
            stt.isConnecting = true;
            if (stt.pendingConnectTimer) clearTimeout(stt.pendingConnectTimer);
            stt.pendingConnectTimer = setTimeout(() => {
                stt.pendingConnectTimer = null;
                stt.isConnecting = false;
                if (stt.isActive) stt.connect(true);
            }, staggerMs);
        }
        // No staggerMs===0 path needed — every start() in this test forces a stagger.
    };

    // ── Step 1: force the first start() into a stagger window ──────────
    NativelyProSTT.nextSlotByKey.set(API_KEY, Date.now() + 2000);
    stt.start();
    assert.equal(connectCalls, 1, 'first start() should invoke connect() exactly once');
    assert.equal(staggerContinuationCalls, 0, 'no stagger continuation yet — still inside the window');
    assert.ok(
        stt.pendingConnectTimer !== null && stt.pendingConnectTimer !== undefined,
        'first connect() should have stored its stagger setTimeout on pendingConnectTimer',
    );
    const firstTimerHandle = stt.pendingConnectTimer;

    // ── Step 2: stop() then start() IMMEDIATELY, well inside the 2s window ──
    // Without the fix, `firstTimerHandle` would still be alive and would
    // fire ~2s later inside the new session, calling connect(true) a second
    // time — that's the double-connect.
    stt.stop();
    assert.equal(
        stt.pendingConnectTimer,
        null,
        'stop() must clear pendingConnectTimer so the orphan stagger cannot fire later',
    );

    // Force the second start() into a stagger too, so we can prove that ONLY
    // the second session's stagger continuation fires (not both).
    NativelyProSTT.nextSlotByKey.set(API_KEY, Date.now() + 2000);
    stt.start();
    assert.equal(connectCalls, 2, 'second start() should bring connect call count to 2');
    assert.equal(staggerContinuationCalls, 0, 'still 0 continuations — both staggers are pending');
    assert.ok(
        stt.pendingConnectTimer !== null && stt.pendingConnectTimer !== undefined,
        'second connect() should have stored a fresh stagger timer',
    );
    assert.notStrictEqual(
        stt.pendingConnectTimer,
        firstTimerHandle,
        'new stagger timer handle must be distinct from the orphan',
    );

    // ── Step 3: wait past both stagger windows ──────────────────────────
    await new Promise((r) => setTimeout(r, 2500));

    // ── Step 4: the critical assertion ──────────────────────────────────
    // Exactly ONE stagger continuation must have fired — the live session's.
    // Two would mean the orphan from the first start() survived stop() and
    // also fired against the new session: the exact double-connect bug.
    assert.equal(
        staggerContinuationCalls,
        1,
        `BUG: orphan stagger setTimeout from the first start() fired inside ` +
        `the new session — connect(true) was called ${staggerContinuationCalls} ` +
        `times (expected exactly 1). This means the stagger branch's ` +
        `setTimeout handle was not tracked by pendingConnectTimer (or not ` +
        `cleared by stop()/start()).`,
    );

    // Total connect() invocations should be:
    //   1 (first start) + 1 (second start) + 1 (live stagger continuation) = 3.
    // The buggy path would yield 4 (extra orphan continuation).
    assert.equal(
        connectCalls,
        3,
        `total connect() invocations should be 3 (start, start, one continuation); got ${connectCalls}`,
    );

    // Cleanup so we don't leak timers across the test runner.
    stt.stop();
    NativelyProSTT.nextSlotByKey.delete(API_KEY);
});
