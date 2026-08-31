import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SystemAudioHealthClassifier } from '../systemAudioHealthClassifier.mjs';

function zeroChunk(bytes = 1920) {
  return Buffer.alloc(bytes);
}

function rampChunk(samples = 960) {
  const chunk = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = i % 2 === 0 ? -1000 : 1000;
    chunk.writeInt16LE(value, i * 2);
  }
  return chunk;
}

function assertNoUserWarning(decision) {
  assert.notEqual(decision.type, 'warn-user', `expected no user warning, got ${JSON.stringify(decision)}`);
}

test('no chunks after watchdog tick is log-only and never a user warning', () => {
  const health = new SystemAudioHealthClassifier({ watchdogMs: 12_000 });
  assertNoUserWarning(health.handle({ kind: 'capture-started', nowMs: 0 }));

  const decision = health.handle({ kind: 'watchdog-tick', nowMs: 12_000 });

  assert.equal(decision.type, 'log');
  assert.equal(decision.reason, 'initial-silence-no-chunks');
});

test('sustained zero-valued chunks are treated as silence, not permission failure', () => {
  const health = new SystemAudioHealthClassifier({ zeroObservationMs: 12_000 });
  health.handle({ kind: 'capture-started', nowMs: 0 });

  const decisions = [];
  for (let nowMs = 0; nowMs <= 13_000; nowMs += 1000) {
    const decision = health.handle({ kind: 'chunk', nowMs, chunk: zeroChunk() });
    assertNoUserWarning(decision);
    decisions.push(decision);
  }

  const silenceLog = decisions.find((decision) => decision.reason === 'sustained-zero-valued-silence');
  assert.equal(silenceLog?.type, 'log');
});

test('transcript absence cannot influence system-audio health classification', () => {
  const health = new SystemAudioHealthClassifier();
  health.handle({ kind: 'capture-started', nowMs: 0 });

  const decision = health.handle({ kind: 'watchdog-tick', nowMs: 45_000 });

  assertNoUserWarning(decision);
  assert.equal(
    SystemAudioHealthClassifier.supportedEventKinds.includes('transcript-missing'),
    false,
    'classifier API must not accept transcript absence as a system-audio failure signal',
  );
});

test('same-device route conflict emits one actionable user warning', () => {
  const health = new SystemAudioHealthClassifier();

  const first = health.handle({
    kind: 'same-device-route-detected',
    nowMs: 12_000,
    device: "Evin's AirPods Pro",
  });
  const duplicate = health.handle({
    kind: 'same-device-route-detected',
    nowMs: 13_000,
    device: "Evin's AirPods Pro",
  });

  assert.deepEqual(first, {
    type: 'warn-user',
    reason: 'same-device-input-output',
    device: "Evin's AirPods Pro",
    terminal: false,
    stuck: true,
  });
  assert.equal(duplicate.type, 'none');
});

test('inter-chunk gaps are diagnostics only', () => {
  const health = new SystemAudioHealthClassifier({ interChunkGapLogMs: 2_000 });
  health.handle({ kind: 'capture-started', nowMs: 0 });
  assertNoUserWarning(health.handle({ kind: 'chunk', nowMs: 0, chunk: rampChunk() }));

  const decision = health.handle({ kind: 'chunk', nowMs: 3_000, chunk: rampChunk() });

  assert.equal(decision.type, 'log');
  assert.equal(decision.reason, 'inter-chunk-gap');
});

function overflow(droppedSamples, overflowEvents = 1, droppedMs = droppedSamples / 48) {
  return { droppedSamples, overflowEvents, droppedMs };
}

test('capture-ring overflow is reported the first time audio is dropped', () => {
  const health = new SystemAudioHealthClassifier();
  health.handle({ kind: 'capture-started', nowMs: 0 });
  assertNoUserWarning(health.handle({ kind: 'chunk', nowMs: 0, chunk: rampChunk(), overflow: overflow(0, 0, 0) }));

  const decision = health.handle({
    kind: 'chunk',
    nowMs: 100,
    chunk: rampChunk(),
    overflow: overflow(24_000, 1, 500),
  });

  assert.equal(decision.type, 'log');
  assert.equal(decision.level, 'warn');
  assert.equal(decision.reason, 'capture-ring-overflow');
  assert.equal(decision.newlyDropped, 24_000);
  assert.equal(decision.droppedSamples, 24_000);
  assertNoUserWarning(decision);
});

test('overflow reporting is rate limited but keeps its running total', () => {
  // interChunkGapLogMs is pushed out of the way so the only thing that can
  // speak here is the overflow reporter.
  const health = new SystemAudioHealthClassifier({
    overflowLogIntervalMs: 10_000,
    interChunkGapLogMs: 60_000,
  });
  health.handle({ kind: 'capture-started', nowMs: 0 });

  const first = health.handle({ kind: 'chunk', nowMs: 0, chunk: rampChunk(), overflow: overflow(1_000) });
  assert.equal(first.reason, 'capture-ring-overflow');

  // More loss, but inside the interval — no second log line.
  const suppressed = health.handle({ kind: 'chunk', nowMs: 5_000, chunk: rampChunk(), overflow: overflow(5_000, 2) });
  assert.equal(suppressed.type, 'none');

  const later = health.handle({ kind: 'chunk', nowMs: 20_000, chunk: rampChunk(), overflow: overflow(9_000, 3) });
  assert.equal(later.reason, 'capture-ring-overflow');
  assert.equal(later.droppedSamples, 9_000, 'running total must survive the suppressed reports');
  assert.equal(later.newlyDropped, 4_000, 'newlyDropped counts since the last LOG, not the last chunk');
});

test('a steady overflow counter is not re-reported', () => {
  const health = new SystemAudioHealthClassifier({ overflowLogIntervalMs: 0, interChunkGapLogMs: 60_000 });
  health.handle({ kind: 'capture-started', nowMs: 0 });
  assert.equal(health.handle({ kind: 'chunk', nowMs: 0, chunk: rampChunk(), overflow: overflow(500) }).reason, 'capture-ring-overflow');

  // Same cumulative count on later chunks: the episode is over, stay quiet.
  assert.equal(health.handle({ kind: 'chunk', nowMs: 1_000, chunk: rampChunk(), overflow: overflow(500) }).type, 'none');
  assert.equal(health.handle({ kind: 'chunk', nowMs: 2_000, chunk: rampChunk(), overflow: overflow(500) }).type, 'none');
});

test('overflow outranks an inter-chunk gap as the reported cause', () => {
  // A stalled consumer produces BOTH a chunk gap and dropped samples. The gap
  // is the symptom; the overflow says who is at fault, so it must win.
  const health = new SystemAudioHealthClassifier({ interChunkGapLogMs: 2_000 });
  health.handle({ kind: 'capture-started', nowMs: 0 });
  health.handle({ kind: 'chunk', nowMs: 0, chunk: rampChunk(), overflow: overflow(0, 0, 0) });

  const decision = health.handle({
    kind: 'chunk',
    nowMs: 5_000,
    chunk: rampChunk(),
    overflow: overflow(48_000, 1, 1_000),
  });

  assert.equal(decision.reason, 'capture-ring-overflow');
});

test('chunk events without overflow data behave exactly as before', () => {
  // main.ts passes null when the native monitor is absent or predates
  // getOverflowStats(); the classifier must not change behaviour for it.
  const health = new SystemAudioHealthClassifier({ interChunkGapLogMs: 2_000 });
  health.handle({ kind: 'capture-started', nowMs: 0 });
  health.handle({ kind: 'chunk', nowMs: 0, chunk: rampChunk(), overflow: null });

  const decision = health.handle({ kind: 'chunk', nowMs: 3_000, chunk: rampChunk() });
  assert.equal(decision.reason, 'inter-chunk-gap');
});

test('capture-started resets the overflow baseline', () => {
  const health = new SystemAudioHealthClassifier();
  health.handle({ kind: 'capture-started', nowMs: 0 });
  health.handle({ kind: 'chunk', nowMs: 0, chunk: rampChunk(), overflow: overflow(10_000) });

  // Native counters reset on restart; the classifier must reset with them or a
  // fresh, healthy capture would look like it had already dropped audio.
  health.handle({ kind: 'capture-started', nowMs: 60_000 });
  const decision = health.handle({ kind: 'chunk', nowMs: 60_100, chunk: rampChunk(), overflow: overflow(120) });
  assert.equal(decision.reason, 'capture-ring-overflow');
  assert.equal(decision.newlyDropped, 120);
});
