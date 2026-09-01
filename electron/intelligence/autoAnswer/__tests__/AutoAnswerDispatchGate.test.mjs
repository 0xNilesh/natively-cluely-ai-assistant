/**
 * Why Auto Answer never completed an automatic dispatch, in three layers.
 *
 * 1. THE HANG. `runWhatShouldISay` awaited `classifyIntent` with no budget.
 *    classifyIntent Tier-2 is the zero-shot ONNX worker, whose `ensureLoaded()`
 *    waits on an unbounded `acquireOnnxSlot('normal')` — starved for as long as
 *    any high-priority waiter is queued. The live trace stopped dead between
 *    'latest_question_extracted' and 'answer_type_selected', with no
 *    answer-generation request ever made. A `.catch()` cannot rescue a promise
 *    that never settles. Bound: INTENT_BUDGET_MS (see
 *    OnnxSlotStarvation2026_09_01.test.mjs for the gate half).
 *
 * 2. THE WEDGE. `activeMode` is the engine's busy flag — `canAutoAnswer()`
 *    refuses while it is 'what_to_say', and SimpleAutoAnswer's parked dispatch
 *    is woken by the `mode_changed('idle')` EVENT. It was set before the first
 *    await and restored only on the paths that produce an answer. A request that
 *    hangs, is superseded, aborts or throws left it set forever, with nothing in
 *    flight to ever clear it: every later verdict then parked for RETRY_TTL_MS
 *    and reported `engine_busy_or_cooling`. Fixed by restoring it in `finally`.
 *
 * 3. THE BLINDNESS. `engine_busy_or_cooling` covered a legitimate 800 ms
 *    throttle, a live manual answer and a permanently wedged flag with one
 *    identical string, so a session that never dispatched once read exactly like
 *    healthy pacing. That is why it survived. Fixed by naming the condition in
 *    the log AND in the telemetry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FakeClock } from './fakeClock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '../../../..');
const dist = (p) => path.resolve(root, 'dist-electron/electron', p);

const { describeAutoAnswerBusy, formatAutoAnswerBusy } = require(dist('intelligence/autoAnswerBusyReason.js'));
const { SimpleAutoAnswerEngine, RETRY_MS, RETRY_TTL_MS, STABILITY_MS } = require(dist('intelligence/autoAnswer/SimpleAutoAnswer.js'));

const flush = () => new Promise((r) => setImmediate(r));
const YES = JSON.stringify({ is_ask: true, directed_at_user: true, complete: true, act: 'question', answerability: 0.95, question_text: null });

// ── 1. describeAutoAnswerBusy: the condition, named ─────────────────────────

const busyInput = (over = {}) => ({
  activeMode: 'idle',
  answerInFlight: false,
  now: 10_000,
  lastTriggerTime: 0,
  automaticTriggerCooldown: 800,
  ...over,
});

test('an idle engine past its cooldown is not blocked — otherwise every case below is vacuous', () => {
  assert.equal(describeAutoAnswerBusy(busyInput()), null);
});

test("'assist' is free: it is the same state maybeSpeculate treats as free", () => {
  assert.equal(describeAutoAnswerBusy(busyInput({ activeMode: 'assist' })), null);
});

test('a live What-to-Answer stream reports answer_in_flight — a legitimate refusal', () => {
  const reason = describeAutoAnswerBusy(busyInput({ activeMode: 'what_to_say', answerInFlight: true }));
  assert.equal(reason.code, 'answer_in_flight');
  assert.equal(formatAutoAnswerBusy(reason), 'answer_in_flight(what_to_say)');
});

test('the WEDGE has its own code: busy mode, nothing in flight, nobody left to clear it', () => {
  const reason = describeAutoAnswerBusy(busyInput({ activeMode: 'what_to_say', answerInFlight: false }));
  assert.equal(reason.code, 'mode_wedged',
    'this is the whole diagnostic: a stuck flag must NOT look like a live stream');
  assert.equal(formatAutoAnswerBusy(reason), 'mode_wedged(what_to_say)');
});

test('another mode owning the engine is distinguishable from both', () => {
  const reason = describeAutoAnswerBusy(busyInput({ activeMode: 'recap' }));
  assert.equal(reason.code, 'mode_other');
  assert.equal(formatAutoAnswerBusy(reason), 'mode_other(recap)');
});

test('the cooldown reports how much of it is left, so pacing is obviously pacing', () => {
  const reason = describeAutoAnswerBusy(busyInput({ now: 1000, lastTriggerTime: 600 }));
  assert.equal(reason.code, 'trigger_cooldown');
  assert.equal(reason.cooldownRemainingMs, 400);
  assert.equal(formatAutoAnswerBusy(reason), 'trigger_cooldown(400ms)');
  // Mutation probe: one millisecond past the window and it is not blocked.
  assert.equal(describeAutoAnswerBusy(busyInput({ now: 1000, lastTriggerTime: 200 })), null);
});

test('a busy mode is reported ahead of the cooldown — it is the condition that outlives it', () => {
  const reason = describeAutoAnswerBusy(busyInput({
    activeMode: 'what_to_say', answerInFlight: false, now: 1000, lastTriggerTime: 900,
  }));
  assert.equal(reason.code, 'mode_wedged');
});

// ── 2. The engine: the busy flag clears on every exit path ──────────────────

async function makeEngine() {
  const { IntelligenceEngine } = await import(pathToFileURL(dist('IntelligenceEngine.js')).href);
  const { SessionTracker } = require(dist('SessionTracker.js'));
  const engine = new IntelligenceEngine({ setNegotiationCoachingHandler() {} }, new SessionTracker());
  engine.on('error', () => {});
  engine.lastTriggerTime = 0;
  return engine;
}

/** Put the engine in the state a live What-to-Answer request leaves behind. */
function enterWhatToSay(engine, token) {
  engine.activeMode = 'what_to_say';
  engine.whatToAnswerCancellationToken = token;
}

test('the owning request releases the flag AND emits mode_changed — the parked dispatch is woken by that event', async () => {
  const engine = await makeEngine();
  const seen = [];
  engine.on('mode_changed', (m) => seen.push(m));

  const token = new AbortController();
  enterWhatToSay(engine, token);
  assert.equal(engine.canAutoAnswer(), false, 'busy while the request owns the engine');

  // What the `finally` does: drop the slot it owns, then release the flag.
  engine.whatToAnswerCancellationToken = null;
  engine.releaseWhatToSayMode();

  assert.equal(engine.getActiveMode(), 'idle');
  assert.equal(engine.canAutoAnswer(), true);
  assert.deepEqual(seen, ['idle'],
    'without the EVENT, onEngineIdle never fires and a parked dispatch waits out the full retry TTL');
});

test('a SUPERSEDED request does not clear the flag out from under the run that replaced it', async () => {
  const engine = await makeEngine();
  const older = new AbortController();
  const newer = new AbortController();

  enterWhatToSay(engine, older);
  // A newer request took the slot; the older one now unwinds.
  engine.whatToAnswerCancellationToken = newer;
  engine.releaseWhatToSayMode();

  assert.equal(engine.getActiveMode(), 'what_to_say',
    'the newer request is genuinely streaming — releasing here would let an auto-trigger supersede it');
  assert.equal(engine.canAutoAnswer(), false);
  assert.equal(engine.autoAnswerBlockReason().code, 'answer_in_flight',
    'and it must read as a REAL stream, not as the wedge');

  // When the newer one finishes, the flag comes back.
  engine.whatToAnswerCancellationToken = null;
  engine.releaseWhatToSayMode();
  assert.equal(engine.canAutoAnswer(), true);
});

test('a request abandoned with nobody holding the slot restores the flag — the wedge, closed', async () => {
  const engine = await makeEngine();
  enterWhatToSay(engine, new AbortController());
  // reset() / an aborted+released run: the slot is gone, the flag is not.
  engine.whatToAnswerCancellationToken = null;

  engine.releaseWhatToSayMode();
  assert.equal(engine.canAutoAnswer(), true);
});

test('releasing is idempotent and never steals another mode', async () => {
  const engine = await makeEngine();
  engine.activeMode = 'recap';
  engine.whatToAnswerCancellationToken = null;
  engine.releaseWhatToSayMode();
  assert.equal(engine.getActiveMode(), 'recap', 'only the What-to-Answer flag is this method\'s business');

  engine.activeMode = 'idle';
  engine.releaseWhatToSayMode();
  engine.releaseWhatToSayMode();
  assert.equal(engine.getActiveMode(), 'idle');
});

test('reset() emits the idle event too — a silent field write left a candidate parked behind an idle engine', async () => {
  const engine = await makeEngine();
  const seen = [];
  enterWhatToSay(engine, new AbortController());
  engine.on('mode_changed', (m) => seen.push(m));

  engine.reset();
  assert.equal(engine.getActiveMode(), 'idle');
  assert.deepEqual(seen, ['idle']);
});

test('a real abandoned runWhatShouldISay leaves the engine accepting again', async () => {
  const engine = await makeEngine();
  // A speculative run with nothing to answer: a genuine early return that used
  // to leave activeMode = 'what_to_say' with the slot already released.
  engine.whatToAnswerLLM = { generateStream: async function* () { yield 'x'; } };

  const answer = await engine.runWhatShouldISay(undefined, 0.8, undefined, { speculative: true });

  assert.equal(answer, null, 'the speculative contract: return silently');
  assert.equal(engine.whatToAnswerCancellationToken, null, 'nothing is in flight');
  assert.equal(engine.getActiveMode(), 'idle', 'and therefore nothing may still claim the engine');
  assert.equal(engine.canAutoAnswer(), true);
});

// ── 3. Structural pins: the release and the budgets cannot be lost again ────

const engineSource = fs.readFileSync(path.join(root, 'electron/IntelligenceEngine.ts'), 'utf8');
/** Code only. The comments in this file quote the very patterns pinned below. */
const engineCode = engineSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

/** The body of the named block, brace-matched from its first `{`. */
function blockAfter(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `expected to find ${JSON.stringify(marker)} in IntelligenceEngine.ts`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces after ${marker}`);
}

test('the release lives in the `finally`, so EVERY exit path is covered by construction', () => {
  // The point of the fix. Enumerating exit paths in a test would only ever
  // cover the ones someone remembered; a `finally` covers success, error,
  // abort/barge-in, supersession and timeout without being told about them.
  const finallyBlock = blockAfter(engineSource, '            // Resume background drains on EVERY exit path');
  assert.ok(
    engineSource.includes('this.releaseWhatToSayMode();\n            // Resume background drains'),
    'runWhatShouldISay\'s finally must call releaseWhatToSayMode — an exit-path-by-exit-path restore is exactly what leaked',
  );
  assert.ok(finallyBlock.includes('releaseFg()'), 'sanity: the finally block was located correctly');
});

test('neither classifyIntent join is unbounded — that single await froze the whole feature', () => {
  assert.equal((engineCode.match(/await\s+classifyIntent\(/g) ?? []).length, 0,
    'classifyIntent must never be awaited bare; wrap it in withTimeout(..., INTENT_BUDGET_MS, ...)');
  assert.equal((engineCode.match(/await\s+intentPromise\b/g) ?? []).length, 0,
    'the joined promise must go through the budget too');
  assert.equal((engineCode.match(/classifyIntent\(/g) ?? []).length, 2,
    'sanity: both call sites are still here to be bounded');
  // ...and both are joined through the budget: `INTENT_BUDGET_MS,` only ever
  // appears as withTimeout's middle argument.
  assert.equal((engineCode.match(/INTENT_BUDGET_MS,/g) ?? []).length, 2,
    'each classifyIntent call site must be joined through withTimeout(..., INTENT_BUDGET_MS, fallback)');
});

test('the automatic dispatch bypasses the speculative 3 s cooldown it already cleared a gate for', () => {
  assert.ok(
    /skipCooldown:\s*trigger\.automatic === true/.test(engineCode),
    'a verdict that passed canAutoAnswer() must not then be eaten by shouldThrottleTrigger — it returns null before any mode, event or log',
  );
});

// ── 4. SimpleAutoAnswer: the dispatch, and what it now records ─────────────

function makeSimple(overrides = {}, hostOverrides = {}) {
  const clock = new FakeClock();
  const state = {
    enabled: true, meetingActive: true, generation: 1, accepting: true, streaming: false,
    blockReason: null, turns: [], dispatched: [], events: [], logs: [],
    ...overrides,
  };
  const host = {
    isEnabled: () => state.enabled,
    isMeetingActive: () => state.meetingActive,
    meetingGeneration: () => state.generation,
    engineAccepting: () => state.accepting,
    engineBlockReason: () => state.blockReason,
    answerStreamActive: () => state.streaming,
    recentTurns: () => state.turns,
    dispatch: (q) => { state.dispatched.push(q); state.streaming = true; },
    telemetry: (e) => state.events.push(e),
    log: (line) => state.logs.push(line),
    judgeCandidate: async () => YES,
    ...hostOverrides,
  };
  const engine = new SimpleAutoAnswerEngine(host, clock);
  engine.onMeetingStart();
  const interviewer = (text) => {
    state.turns.push({ role: 'interviewer', text, timestamp: clock.now() });
    engine.ingest({ speaker: 'interviewer', text, final: true, timestamp: clock.now(), origin: 'stt' });
  };
  const advance = async (ms) => {
    let left = ms;
    while (left > 0) { const step = Math.min(100, left); clock.advance(step); left -= step; await flush(); await flush(); }
  };
  const skips = () => state.events.filter((e) => e.name === 'auto_answer_ignored');
  return { engine, clock, state, interviewer, advance, skips };
}

const QUESTION = 'Tell me about a time you had to debug something hard in production?';

test('a verdict after a PREVIOUS aborted generation still dispatches — end to end, against a real engine', async () => {
  // The whole bug in one test, with the REAL IntelligenceEngine behind
  // `engineAccepting`: an answer run is abandoned, and the next verdict must
  // still get through. Before the fix the abandoned run left activeMode
  // 'what_to_say' with nothing in flight, so this dispatched zero times no
  // matter how long it waited.
  const engine = await makeEngine();
  engine.whatToAnswerLLM = { generateStream: async function* () { yield 'x'; } };

  const h = makeSimple({}, {
    engineAccepting: () => engine.canAutoAnswer(),
    engineBlockReason: () => {
      const reason = engine.autoAnswerBlockReason();
      return reason ? formatAutoAnswerBusy(reason) : null;
    },
  });
  // main.ts's wiring: the idle EVENT is what wakes a parked dispatch.
  engine.on('mode_changed', (mode) => { if (mode === 'idle') h.engine.onEngineIdle(); });

  // An answer run that is abandoned rather than completed (here: the
  // speculative empty-context return — one of the six paths that leaked).
  const abandoned = await engine.runWhatShouldISay(undefined, 0.8, undefined, { speculative: true });
  assert.equal(abandoned, null, 'sanity: it really did abandon the run');
  engine.lastTriggerTime = 0;             // step past the 800 ms automatic cooldown

  h.interviewer(QUESTION);
  await h.advance(STABILITY_MS + 50);

  assert.equal(h.state.dispatched.length, 1,
    'a genuine verdict must dispatch after an abandoned generation — it never once did');
  assert.equal(h.state.dispatched[0].text, QUESTION);
  assert.equal(h.skips().some((e) => e.skipReason === 'engine_busy_or_cooling'), false);
});

test('a dispatch parked behind a real stream goes as soon as the engine releases the flag', async () => {
  const h = makeSimple();
  h.state.accepting = false;
  h.state.blockReason = 'answer_in_flight(what_to_say)';

  h.interviewer(QUESTION);
  await h.advance(STABILITY_MS + 50);
  assert.equal(h.state.dispatched.length, 0, 'parked while a real answer is streaming');

  h.state.accepting = true;
  h.state.blockReason = null;
  h.engine.onEngineIdle();                 // what mode_changed('idle') triggers
  await flush();

  assert.equal(h.state.dispatched.length, 1);
  assert.equal(h.skips().some((e) => e.skipReason === 'engine_busy_or_cooling'), false);
});

test('giving up records WHICH condition blocked it, not just that something did', async () => {
  const h = makeSimple();
  h.state.accepting = false;
  h.state.blockReason = 'mode_wedged(what_to_say)';

  h.interviewer(QUESTION);
  await h.advance(STABILITY_MS + RETRY_TTL_MS + RETRY_MS + 100);

  const gaveUp = h.skips().find((e) => e.skipReason === 'engine_busy_or_cooling');
  assert.ok(gaveUp, 'the give-up must still be recorded');
  assert.equal(gaveUp.engineBlocked, 'mode_wedged(what_to_say)',
    'a wedged engine and an 800 ms throttle were the same string — that is why this survived');
  assert.ok(h.state.logs.some((l) => l.includes('mode_wedged(what_to_say)')),
    'and the console must say it too, so a live run is readable without a telemetry pipeline');
});

test('a legitimate throttle is now visibly different from a wedge', async () => {
  const h = makeSimple();
  h.state.accepting = false;
  h.state.blockReason = 'trigger_cooldown(600ms)';

  h.interviewer(QUESTION);
  await h.advance(STABILITY_MS + RETRY_TTL_MS + RETRY_MS + 100);

  const gaveUp = h.skips().find((e) => e.skipReason === 'engine_busy_or_cooling');
  assert.equal(gaveUp.engineBlocked, 'trigger_cooldown(600ms)');
});

test('a host with no engineBlockReason hook records no detail and still works', async () => {
  const h = makeSimple();
  h.state.accepting = false;
  h.state.blockReason = undefined;         // the hook exists but has nothing to say

  h.interviewer(QUESTION);
  await h.advance(STABILITY_MS + RETRY_TTL_MS + RETRY_MS + 100);

  const gaveUp = h.skips().find((e) => e.skipReason === 'engine_busy_or_cooling');
  assert.ok(gaveUp);
  assert.equal(gaveUp.engineBlocked, undefined);
});

test('a parked dispatch killed by new speech is recorded instead of vanishing', async () => {
  const h = makeSimple();
  h.state.accepting = false;
  h.state.blockReason = 'answer_in_flight(what_to_say)';

  h.interviewer(QUESTION);
  await h.advance(STABILITY_MS + 50);
  assert.equal(h.state.dispatched.length, 0);

  // The interviewer keeps talking: judgeSeq moves and the parked attempt is
  // dropped. It used to be the one silent exit in the pipeline.
  h.interviewer('Actually, let me ask something else instead.');
  await h.advance(RETRY_MS + 50);

  assert.equal(h.skips().some((e) => e.skipReason === 'stale_generation'), true,
    'a positive verdict dropped at dispatch must leave a record');
  assert.equal(h.state.dispatched.length, 0);
});
