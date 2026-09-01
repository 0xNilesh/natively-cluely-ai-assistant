// electron/utils/__tests__/OnnxSlotStarvation2026_09_01.test.mjs
//
// The bounded NORMAL-priority acquisition (`maxWaitMs`), and the starvation it
// exists for.
//
// `canAcquireNow` refuses every normal-priority request for as long as ANY
// high-priority waiter is queued — deliberately, so Whisper takes the next free
// slot promptly. But a high waiter that can never be admitted (Nemotron's
// exclusive weight-3 request against the default cap of 2, queued behind a live
// Whisper session) makes that refusal PERMANENT: normal-priority callers loop
// forever on an `await waiterP` with no deadline.
//
// That is not theoretical. The intent classifier's `ensureLoaded()` sat on
// exactly this acquisition, `classifyIntent` awaited it with no budget, and
// `runWhatShouldISay` awaited THAT with no budget — so a single starved slot
// froze every What-to-Answer in the session between the
// 'latest_question_extracted' and 'answer_type_selected' trace marks, with no
// error, no answer, and the engine's busy flag left set (which is what stopped
// Auto Answer from ever dispatching). See INTENT_BUDGET_MS in
// IntelligenceEngine.ts and SLOT_WAIT_MS in IntentClassifier.ts.
//
// The unbounded contract is UNCHANGED for callers that do not opt in — pinned
// below, because ordinary contention (embeddings, reranker) must still queue
// however long it takes.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_URL = pathToFileURL(
  path.resolve(__dirname, '../../../dist-electron/electron/utils/onnxThreadConfig.js')
).href;

const { acquireOnnxSlot, __resetOnnxGateForTests } = await import(MODULE_URL);

process.env.NATIVELY_ONNX_MAX_CONCURRENT_SESSIONS = '2';
process.env.NATIVELY_ONNX_EXCLUSIVE_TIMEOUT_MS = '200';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STILL_PENDING = Symbol('still-pending');
async function isStillPending(promise, delayMs = 150) {
  return (await Promise.race([
    promise.then(() => 'resolved', () => 'rejected'),
    sleep(delayMs).then(() => STILL_PENDING),
  ])) === STILL_PENDING;
}

/**
 * Reproduce the live starvation: the gate is full AND a high-priority waiter is
 * queued behind it, so `canAcquireNow('normal', 1)` is false and stays false
 * until the holder — a whole meeting of Whisper — lets go.
 * Returns the releases, newest last.
 */
async function starveTheGate() {
  const a = await acquireOnnxSlot('normal', 1);
  const b = await acquireOnnxSlot('normal', 1);
  // Queued and unsatisfiable while a+b hold the cap.
  const queuedHigh = acquireOnnxSlot('high', 1);
  await sleep(10);
  return { releases: [a, b], queuedHigh };
}

describe('normal-priority ONNX acquisition under high-priority starvation', () => {
  beforeEach(() => __resetOnnxGateForTests());

  test('unbounded, it waits forever — this is the hang, kept as the baseline', async () => {
    const { releases, queuedHigh } = await starveTheGate();

    const starved = acquireOnnxSlot('normal', 1);
    assert.equal(await isStillPending(starved, 250), true,
      'a normal acquisition must still be queued behind the high waiter — if this resolves, the starvation this suite is about no longer exists and the bound below is untested');

    // Drain so the suite does not leave live handles.
    releases.forEach((r) => r());
    (await queuedHigh)();
    (await starved)();
  });

  test('with maxWaitMs it REJECTS instead, naming the gate state so the caller can degrade', async () => {
    const { releases, queuedHigh } = await starveTheGate();

    const started = Date.now();
    await assert.rejects(
      () => acquireOnnxSlot('normal', 1, 120),
      (err) => {
        assert.match(err.message, /timed out after 120ms/);
        // The message must say WHY, not just that it gave up: a bare timeout
        // is the same diagnostic dead end as the bare `engine_busy_or_cooling`.
        assert.match(err.message, /high-priority waiter/);
        assert.match(err.message, /cap 2/);
        return true;
      },
    );
    assert.ok(Date.now() - started >= 100, 'it must actually wait out the budget, not fail fast');

    releases.forEach((r) => r());
    (await queuedHigh)();
  });

  test('the bound does not fire when a slot frees inside it', async () => {
    __resetOnnxGateForTests();
    const a = await acquireOnnxSlot('normal', 1);
    const b = await acquireOnnxSlot('normal', 1);

    const waiting = acquireOnnxSlot('normal', 1, 1000);
    setTimeout(() => a(), 30);

    const release = await waiting;
    assert.equal(typeof release, 'function', 'a slot that frees in time must be handed over normally');
    release();
    b();
  });

  test('a rejected bounded waiter leaves no stale queue entry behind it', async () => {
    const { releases, queuedHigh } = await starveTheGate();
    await assert.rejects(() => acquireOnnxSlot('normal', 1, 60));

    // The high waiter must still be the only thing queued: a stale normal
    // resolver would be woken on release and then never re-checked.
    releases.forEach((r) => r());
    const high = await Promise.race([queuedHigh, sleep(300).then(() => null)]);
    assert.notEqual(high, null, 'the queued high-priority waiter must be admitted once the gate drains');
    high();

    const after = await Promise.race([
      acquireOnnxSlot('normal', 1, 300),
      sleep(500).then(() => null),
    ]);
    assert.notEqual(after, null, 'a fresh normal acquisition must succeed on a drained gate');
    after();
  });
});
