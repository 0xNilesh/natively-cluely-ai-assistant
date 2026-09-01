// electron/services/__tests__/ClaudeCliSession.test.mjs
//
// Persistent per-meeting session mode for the Claude Code CLI provider.
//
// As in ClaudeCliService.test.mjs, NOTHING here invokes the real `claude`
// binary. The fake is a generated Node script that implements the multi-turn
// half of the stream-json contract: it reads one JSON turn per line from stdin,
// answers each with deltas plus a terminal `result` frame, and exits when stdin
// reaches EOF. Every turn it serves is appended to a log file with the serving
// pid, which is what lets these tests assert the property that actually
// matters — WHICH PROCESS answered — rather than just the text.
//
// Covered:
//   1. Isolated mode (default): a fresh process per turn, no session
//   2. Meeting mode: one process serves consecutive turns and accumulates them
//   3. THE OVERLAP CASE: a second turn arriving mid-flight runs on its own
//      one-off process instead of queueing, and does not disturb the session
//   4. Disposal on meeting end, on app-quit-style teardown, and on a
//      mid-meeting config change
//   5. Turn and age caps retiring a session
//   6. Model/argv mismatch falling back to isolated
//   7. The crash backstop: closing stdin ends the session process
//
// Run via: npm run build:electron && node --test electron/services/__tests__/ClaudeCliSession.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const compiledPath = path.resolve(__dirname, '../../../dist-electron/electron/services/ClaudeCliService.js');
const { ClaudeCliService, DEFAULT_CLAUDE_CLI_CONFIG, CLAUDE_CLI_SESSION_MODES } =
  await import(pathToFileURL(compiledPath).href);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-claude-session-test-'));

/**
 * A fake `claude` that serves MANY turns on one process.
 *
 * Each turn appends `<pid>\t<turnIndexOnThisProcess>\t<promptText>` to
 * `logFile`, then answers with `t<n>:<promptText>` — so a test can prove both
 * that a process was reused and that it remembered how many turns it had seen.
 * `delayMs` holds the answer back, which is how the overlap test arranges for
 * two turns to be in flight at once.
 */
function makeMultiTurnCli(name, logFile, { delayMs = 0 } = {}) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, `#!${process.execPath}
'use strict';
const fs = require('fs');
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let seen = 0;
let buf = '';
let chain = Promise.resolve();

const answer = async (turn) => {
  seen += 1;
  const text = (turn && turn.message && turn.message.content || [])
    .filter(b => b.type === 'text').map(b => b.text).join('');
  fs.appendFileSync(${JSON.stringify(logFile)}, process.pid + '\\t' + seen + '\\t' + text + '\\n');
  await sleep(${delayMs});
  const reply = 't' + seen + ':' + text;
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: reply });
};

process.stdin.on('data', (c) => {
  buf += c.toString();
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let turn = null;
    try { turn = JSON.parse(line); } catch { continue; }
    // Serialise: the real CLI reads turns in order, and interleaving frames
    // from two turns would make the output unattributable.
    chain = chain.then(() => answer(turn));
  }
});
// EOF on stdin ends the process. This is the crash backstop the service
// relies on: when the parent dies the pipe closes and the CLI exits.
process.stdin.on('end', () => { chain.then(() => process.exit(0)); });
`, { mode: 0o755 });
  return file;
}

/** Turn log rows: [{ pid, seen, text }]. */
function readLog(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(line => {
    const [pid, seen, ...rest] = line.split('\t');
    return { pid: Number(pid), seen: Number(seen), text: rest.join('\t') };
  });
}

function newLog(name) {
  const f = path.join(TMP, name);
  fs.writeFileSync(f, '');
  return f;
}

function cfg(bin, over = {}) {
  return ClaudeCliService.normalizeConfig({
    enabled: true,
    path: bin,
    model: 'sonnet',
    fastModel: 'haiku',
    timeoutMs: 15_000,
    // 0 so the only processes in these tests are the ones under test — a warm
    // pool would make the pid accounting below ambiguous.
    maxWarmProcesses: 0,
    sessionMode: 'meeting',
    ...over,
  });
}

async function ask(bin, prompt, over = {}) {
  let out = '';
  for await (const c of ClaudeCliService.stream(bin, {
    prompt, model: 'sonnet', timeoutMs: 15_000, maxWarmProcesses: 0, ...over,
  })) out += c;
  return out;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForDeath(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return !isAlive(pid);
}

function resetSessions() {
  ClaudeCliService.endSession('test reset');
  ClaudeCliService.disposeWarmPool();
}

// =============================================================================
// 1. Mode plumbing
// =============================================================================

test('CLAUDE_CLI_SESSION_MODES enumerates exactly the two modes', () => {
  assert.deepEqual([...CLAUDE_CLI_SESSION_MODES], ['isolated', 'meeting']);
});

test('normalizeConfig: sessionMode defaults to isolated and rejects junk', () => {
  assert.equal(ClaudeCliService.normalizeConfig({}).sessionMode, 'isolated');
  assert.equal(ClaudeCliService.normalizeConfig({ sessionMode: 'meeting' }).sessionMode, 'meeting');
  for (const bad of ['persistent', '', null, undefined, 7, {}]) {
    assert.equal(
      ClaudeCliService.normalizeConfig({ sessionMode: bad }).sessionMode,
      'isolated',
      `sessionMode=${JSON.stringify(bad)} must fall back to isolated`,
    );
  }
  assert.equal(DEFAULT_CLAUDE_CLI_CONFIG.sessionMode, 'isolated');
});

test('beginSession: a no-op unless the config actually asks for a session', (t) => {
  t.after(resetSessions);
  const bin = makeMultiTurnCli('noop.js', newLog('noop.log'));
  resetSessions();

  ClaudeCliService.beginSession(cfg(bin, { sessionMode: 'isolated' }), 'm1');
  assert.equal(ClaudeCliService.sessionStatus(), null, 'isolated mode must not open a session');

  ClaudeCliService.beginSession(cfg(bin, { enabled: false }), 'm1');
  assert.equal(ClaudeCliService.sessionStatus(), null, 'a disabled provider must not open a session');

});

test('beginSession: a broken binary path degrades to isolated without a spawn storm', async (t) => {
  t.after(resetSessions);
  resetSessions();
  const missing = path.join(TMP, 'no-such-dir', 'claude');
  // An EXPLICIT path is trusted at config time by design (a typo must surface
  // as a real error, not silently drop the provider), so a session object is
  // created and only dies once Node reports ENOENT asynchronously.
  ClaudeCliService.beginSession(cfg(missing), 'm-broken');
  await new Promise(r => setTimeout(r, 300));

  // The first turn after the death degrades to an isolated process, which
  // produces the actionable "not found" error rather than a bare exit code.
  await assert.rejects(
    () => ask(missing, 'A'),
    err => /not found/i.test(err.message),
  );
  // And the session is NOT respawned: a session that never served a turn is a
  // broken configuration, so retrying it on every turn would spawn a doomed
  // process per question for the rest of the meeting.
  assert.equal(ClaudeCliService.sessionStatus(), null,
    'a session that died without serving a turn must not be respawned');
});

// =============================================================================
// 2. Isolated mode — the default, unchanged
// =============================================================================

test('isolated mode: every turn gets its own process and no memory', async (t) => {
  t.after(resetSessions);
  const log = newLog('isolated.log');
  const bin = makeMultiTurnCli('isolated.js', log);
  resetSessions();
  // No beginSession at all — this is the pre-session behaviour.
  assert.equal(await ask(bin, 'A'), 't1:A');
  assert.equal(await ask(bin, 'B'), 't1:B');

  const rows = readLog(log);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].pid, rows[1].pid, 'isolated turns must not share a process');
  assert.deepEqual(rows.map(r => r.seen), [1, 1], 'each process must see exactly one turn');
  assert.ok(await waitForDeath(rows[0].pid), 'the first process must be reaped');
  assert.ok(await waitForDeath(rows[1].pid), 'the second process must be reaped');
});

test('isolated mode: beginSession with sessionMode:isolated keeps turns isolated', async (t) => {
  t.after(resetSessions);
  const log = newLog('isolated2.log');
  const bin = makeMultiTurnCli('isolated2.js', log);
  resetSessions();
  ClaudeCliService.beginSession(cfg(bin, { sessionMode: 'isolated' }), 'meeting-1');
  await ask(bin, 'A');
  await ask(bin, 'B');
  const rows = readLog(log);
  assert.notEqual(rows[0].pid, rows[1].pid);
});

// =============================================================================
// 3. Meeting mode — one process, accumulated context
// =============================================================================

test('meeting mode: consecutive turns reuse ONE process and it accumulates them', async (t) => {
  t.after(resetSessions);
  const log = newLog('session.log');
  const bin = makeMultiTurnCli('session.js', log);
  resetSessions();

  ClaudeCliService.beginSession(cfg(bin), 'meeting-7');
  const status = ClaudeCliService.sessionStatus();
  assert.equal(status.active, true);
  assert.equal(status.meetingId, 'meeting-7');
  assert.equal(status.turns, 0);
  assert.equal(status.busy, false);

  assert.equal(await ask(bin, 'A'), 't1:A');
  assert.equal(await ask(bin, 'B'), 't2:B', 'the second turn must land on the SAME process, which has now seen two');
  assert.equal(await ask(bin, 'C'), 't3:C');

  const rows = readLog(log);
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map(r => r.pid)).size, 1, 'all three turns must share one process');
  assert.deepEqual(rows.map(r => r.seen), [1, 2, 3], 'the process must remember how many turns it has served');

  const after = ClaudeCliService.sessionStatus();
  assert.equal(after.turns, 3);
  assert.equal(after.busy, false, 'the session must be free again after each turn');
});

test('meeting mode: the session survives a barge-in and still serves the next turn', async (t) => {
  t.after(resetSessions);
  const log = newLog('bargein.log');
  // Slow enough that the abort lands mid-turn.
  const bin = makeMultiTurnCli('bargein.js', log, { delayMs: 150 });
  resetSessions();
  ClaudeCliService.beginSession(cfg(bin), 'meeting-barge');
  const pid0 = readLog(log).length; // no rows yet

  const ac = new AbortController();
  const gen = ClaudeCliService.stream(bin, {
    prompt: 'A', model: 'sonnet', timeoutMs: 15_000, signal: ac.signal, maxWarmProcesses: 0,
  });
  // Abort while the turn is IN FLIGHT. Aborting before the first next() would
  // only exercise the pre-start guard, which is a different code path and says
  // nothing about whether a session survives a barge-in.
  const bargeIn = setTimeout(() => ac.abort(), 60);
  // eslint-disable-next-line no-unused-vars
  for await (const _ of gen) { /* may yield nothing before the abort lands */ }
  clearTimeout(bargeIn);

  // The reader detaches and drains in the background; the next turn either
  // finds the session free or, if the drain is still running, runs isolated.
  // Either way it must ANSWER — that is the property under test.
  const second = await ask(bin, 'B');
  assert.match(second, /:B$/, `barge-in must not break the next turn (got ${second})`);
  assert.equal(pid0, 0);

  // And the session must still be alive and usable afterwards.
  const status = ClaudeCliService.sessionStatus();
  assert.ok(status && status.active, 'a barge-in must not tear the meeting session down');
});

// =============================================================================
// 4. THE OVERLAP CASE
// =============================================================================

test('overlap: a turn arriving mid-flight runs on its OWN process, never queued', async (t) => {
  t.after(resetSessions);
  const log = newLog('overlap.log');
  // 400ms per answer, so the second request definitely arrives while the first
  // still holds the session.
  const bin = makeMultiTurnCli('overlap.js', log, { delayMs: 400 });
  resetSessions();
  ClaudeCliService.beginSession(cfg(bin), 'meeting-overlap');
  const sessionPid = readLog(log).length;
  assert.equal(sessionPid, 0);

  const startedAt = Date.now();
  const first = ask(bin, 'JUDGE');
  // Give the first turn time to claim the session, then overlap it — this is
  // Auto Answer prefetching while its judge is still deciding.
  await new Promise(r => setTimeout(r, 80));
  const busyStatus = ClaudeCliService.sessionStatus();
  assert.equal(busyStatus.busy, true, 'the session must report busy while a turn is in flight');

  const secondStart = Date.now();
  const second = await ask(bin, 'PREFETCH');
  const secondElapsed = Date.now() - secondStart;
  const firstText = await first;

  assert.equal(firstText, 't1:JUDGE');
  assert.equal(second, 't1:PREFETCH', 'the overlapping turn ran on a FRESH process, so it saw one turn, not two');

  const rows = readLog(log);
  assert.equal(rows.length, 2);
  const pids = new Set(rows.map(r => r.pid));
  assert.equal(pids.size, 2, 'the overlapping turn must not share the session process');

  // The decisive assertion: it did not WAIT for the first turn. Queueing would
  // have made it finish at roughly (remaining first turn + its own 400ms).
  assert.ok(secondElapsed < (Date.now() - startedAt),
    'the overlapping turn must not have been serialised behind the first');

  // The session recorded only its own turn.
  const after = ClaudeCliService.sessionStatus();
  assert.equal(after.turns, 1, 'the isolated turn must not be counted against the session');
});

test('overlap: the session is still usable, with intact history, once the overlap clears', async (t) => {
  t.after(resetSessions);
  const log = newLog('overlap2.log');
  const bin = makeMultiTurnCli('overlap2.js', log, { delayMs: 250 });
  resetSessions();
  ClaudeCliService.beginSession(cfg(bin), 'meeting-overlap2');

  const first = ask(bin, 'A');
  await new Promise(r => setTimeout(r, 60));
  await ask(bin, 'B');       // overlaps → isolated
  await first;
  const third = await ask(bin, 'C');

  // The session served A then C, so C is its SECOND turn. The isolated B never
  // touched it — that gap is the documented cost of the overlap policy.
  assert.equal(third, 't2:C');
});

// =============================================================================
// 5. Disposal
// =============================================================================

test('endSession: kills the session process on meeting end', async (t) => {
  t.after(resetSessions);
  const log = newLog('dispose.log');
  const bin = makeMultiTurnCli('dispose.js', log);
  resetSessions();
  ClaudeCliService.beginSession(cfg(bin), 'meeting-dispose');
  await ask(bin, 'A');
  const pid = readLog(log)[0].pid;
  assert.ok(isAlive(pid), 'the session process must be alive while the meeting runs');

  ClaudeCliService.endSession('meeting ended');
  assert.equal(ClaudeCliService.sessionStatus(), null);
  assert.ok(await waitForDeath(pid), `session process ${pid} survived meeting end — it is orphaned`);
});

test('endSession: idempotent, and safe with no session open', () => {
  resetSessions();
  assert.doesNotThrow(() => ClaudeCliService.endSession());
  assert.doesNotThrow(() => ClaudeCliService.endSession('again'));
  assert.equal(ClaudeCliService.sessionStatus(), null);
});

test('beginSession: clears a session a crash or force-quit left behind', async (t) => {
  t.after(resetSessions);
  const log = newLog('stale.log');
  const bin = makeMultiTurnCli('stale.js', log);
  resetSessions();

  ClaudeCliService.beginSession(cfg(bin), 'meeting-old');
  await ask(bin, 'A');
  const stale = readLog(log)[0].pid;

  // No endSession — this is the app-crashed / force-quit path, where the next
  // meeting start is the first code that runs.
  ClaudeCliService.beginSession(cfg(bin), 'meeting-new');
  assert.equal(ClaudeCliService.sessionStatus().meetingId, 'meeting-new');
  assert.ok(await waitForDeath(stale), `the stale session process ${stale} was not reaped at the next meeting start`);
});

test('reapplyConfigToSession: a mid-meeting settings save re-opens, never silently drops', async (t) => {
  t.after(resetSessions);
  const log = newLog('reapply.log');
  const bin = makeMultiTurnCli('reapply.js', log);
  resetSessions();
  ClaudeCliService.beginSession(cfg(bin), 'meeting-cfg');
  await ask(bin, 'A');
  const firstPid = readLog(log)[0].pid;

  // The user saves Settings mid-meeting. LLMHelper.setClaudeCliConfig tears the
  // warm pool down unconditionally, so the session has to be carried over here
  // or it would be left bound to argv that no longer matches.
  const carried = ClaudeCliService.reapplyConfigToSession(cfg(bin));
  assert.equal(carried, true);
  const status = ClaudeCliService.sessionStatus();
  assert.ok(status && status.active);
  assert.equal(status.meetingId, 'meeting-cfg', 'the replacement must stay bound to the same meeting');
  assert.equal(status.turns, 0, 'history cannot survive an argv change — the replacement starts empty');
  assert.ok(await waitForDeath(firstPid), 'the superseded session process must be reaped');

  // Switching to isolated mid-meeting closes the session for good.
  const off = ClaudeCliService.reapplyConfigToSession(cfg(bin, { sessionMode: 'isolated' }));
  assert.equal(off, false);
  assert.equal(ClaudeCliService.sessionStatus(), null);
});

test('crash backstop: closing stdin ends the session process', async (t) => {
  t.after(resetSessions);
  const log = newLog('eof.log');
  const bin = makeMultiTurnCli('eof.js', log);
  resetSessions();
  ClaudeCliService.beginSession(cfg(bin), 'meeting-eof');
  await ask(bin, 'A');
  const pid = readLog(log)[0].pid;

  // dispose() ends stdin before signalling. The same pipe close happens for
  // free when the main process dies without running any teardown at all, which
  // is the only protection a hard crash has.
  ClaudeCliService.endSession('simulated quit');
  assert.ok(await waitForDeath(pid));
});

// =============================================================================
// 6. Caps and binding
// =============================================================================

test('caps: a session bound to one model does not serve another', async (t) => {
  t.after(resetSessions);
  const log = newLog('modelbind.log');
  const bin = makeMultiTurnCli('modelbind.js', log);
  resetSessions();
  ClaudeCliService.beginSession(cfg(bin), 'meeting-model', 'sonnet');

  await ask(bin, 'A', { model: 'sonnet' });
  // A fast-mode turn on a different model must NOT land on this session: a
  // different --model is a different conversation.
  await ask(bin, 'B', { model: 'haiku' });

  const rows = readLog(log);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].pid, rows[1].pid, 'a different model must run on its own process');
  assert.equal(ClaudeCliService.sessionStatus().turns, 1, 'only the matching-model turn counts');
});

test('caps: the session reports its age and turn count for the cap logic', async (t) => {
  t.after(resetSessions);
  const log = newLog('caps.log');
  const bin = makeMultiTurnCli('caps.js', log);
  resetSessions();
  ClaudeCliService.beginSession(cfg(bin), 'meeting-caps');
  const before = ClaudeCliService.sessionStatus();
  assert.equal(before.turns, 0);
  assert.ok(before.ageMs >= 0 && before.ageMs < 5_000);
  await ask(bin, 'A');
  await ask(bin, 'B');
  assert.equal(ClaudeCliService.sessionStatus().turns, 2);
});

test('a dead session process falls back to isolated and is replaced', async (t) => {
  t.after(resetSessions);
  const log = newLog('dead.log');
  const bin = makeMultiTurnCli('dead.js', log);
  resetSessions();
  ClaudeCliService.beginSession(cfg(bin), 'meeting-dead');
  await ask(bin, 'A');
  const pid = readLog(log)[0].pid;

  // Kill the session process behind the service's back — the user running
  // `pkill claude`, or the OOM killer.
  process.kill(pid, 'SIGKILL');
  assert.ok(await waitForDeath(pid));

  // The next turn must still answer.
  const answer = await ask(bin, 'B');
  assert.match(answer, /:B$/, 'a dead session must degrade to an isolated turn, not fail the request');
});

test.after(() => {
  resetSessions();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});
