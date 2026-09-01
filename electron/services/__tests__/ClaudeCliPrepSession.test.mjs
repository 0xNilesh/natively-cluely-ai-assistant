// electron/services/__tests__/ClaudeCliPrepSession.test.mjs
//
// Prep session (`--resume` / `--fork-session`) and the per-turn effort control
// for the Claude Code CLI provider.
//
// As in ClaudeCliService.test.mjs and ClaudeCliSession.test.mjs, NOTHING here
// invokes the real `claude` binary. The fake is a generated Node script that
// implements the half of the wire protocol these tests need: it records the
// argv it was given, emits a `system`/`init` frame carrying a session id
// (a NEW one when --fork-session is present, the resumed one otherwise, which
// is the CLI's actual behaviour), answers with a delta, and ends with a
// `result` frame. Recording argv is what makes the assertions here meaningful —
// the properties under test are all about WHICH FLAGS a turn was spawned with.
//
// Covered:
//   1. Blank prep session id = today's behaviour, --no-session-persistence and
//      all, byte for byte
//   2. The first turn of a meeting forks the prep session and captures the new id
//   3. Later turns resume the FORKED id and never fork again
//   4. Effort is independent of the model, and 'default' omits the flag
//   5. The judge (isolated: true) never receives a session
//   6. An invalid prep id fails loudly, stays failed, and never falls back to
//      an ungrounded answer
//   7. Prep session and stdin session mode never both apply
//   8. The forked id survives session teardown, for the meeting row
//
// Run via: node scripts/build-electron.js && node --test \
//   electron/services/__tests__/ClaudeCliPrepSession.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const compiledPath = path.resolve(__dirname, '../../../dist-electron/electron/services/ClaudeCliService.js');
const {
  ClaudeCliService,
  DEFAULT_CLAUDE_CLI_CONFIG,
  CLAUDE_CLI_EFFORT_LEVELS,
  CLAUDE_CLI_PREP_SESSION_MISSING_MESSAGE,
  extractClaudeSessionId,
  looksLikeMissingSessionError,
} = await import(pathToFileURL(compiledPath).href);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-claude-prep-test-'));

const PREP_ID = '11111111-2222-4333-8444-555555555555';
const FORKED_ID = '99999999-8888-4777-8666-555555555555';

/**
 * A fake `claude` that records its argv and honours --resume/--fork-session.
 *
 * Every invocation appends one JSON line to `logFile` describing the argv it
 * saw, so a test can assert on flags rather than on text. `missingSession`
 * makes it behave like the real CLI asked to resume an id that does not exist:
 * "No conversation found with session ID: <id>" on STDERR, a bare `is_error`
 * result frame with no message on stdout, exit 1. That exact shape is what the
 * loud-failure path has to recognise.
 */
function makeCli(name, logFile, { missingSession = false } = {}) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, `#!${process.execPath}
'use strict';
const fs = require('fs');
const argv = process.argv.slice(2);
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
const flagValue = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const resumed = flagValue('--resume');
const forked = argv.includes('--fork-session');
// --fork-session returns a NEW session id; a plain --resume returns the SAME
// one; with neither, the CLI mints one for the throwaway session.
const sessionId = resumed ? (forked ? ${JSON.stringify(FORKED_ID)} : resumed) : 'ephemeral-0000';

let buf = '';
const answer = (turn) => {
  const text = (turn && turn.message && turn.message.content || [])
    .filter(b => b.type === 'text').map(b => b.text).join('');
  fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({
    argv, resumed, forked,
    persistence: argv.includes('--no-session-persistence'),
    effort: flagValue('--effort'),
    model: flagValue('--model'),
    text,
  }) + '\\n');

  if (${JSON.stringify(missingSession)}) {
    process.stderr.write('No conversation found with session ID: ' + resumed + '\\n');
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: resumed });
    process.exit(1);
    return;
  }

  emit({ type: 'system', subtype: 'init', session_id: sessionId });
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok:' + text } } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok:' + text, session_id: sessionId,
         usage: { input_tokens: 2, cache_read_input_tokens: 9400 } });
  process.exit(0);
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
    answer(turn);
  }
});
process.stdin.on('end', () => process.exit(0));
`, { mode: 0o755 });
  return file;
}

/** Recorded invocations, newest last. */
function readLog(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
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
    // 0 so every process in these tests is one a turn asked for; a warm pool
    // would spawn extra `claude` invocations and pollute the argv log.
    maxWarmProcesses: 0,
    sessionMode: 'isolated',
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

function reset() {
  ClaudeCliService.endSession('test reset');
  ClaudeCliService.endPrepSession('test reset');
  ClaudeCliService.disposeWarmPool();
}

/**
 * A prep session id the on-disk pre-check will accept.
 *
 * beginPrepSession() looks for `~/.claude/projects/<slug>/<id>.jsonl` and fails
 * loudly when it can confirm the id is absent. These tests are about the RESUME
 * mechanics, not the pre-check, so they plant a real (empty) transcript for the
 * happy-path id and remove it afterwards. The pre-check has its own tests below.
 */
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects', '__natively_prep_test__');
function plantPrepTranscript(id = PREP_ID) {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROJECTS_DIR, `${id}.jsonl`), '');
}
function removePrepTranscripts() {
  try { fs.rmSync(PROJECTS_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
}

// =============================================================================
// 1. Blank prep session id = exactly today's behaviour
// =============================================================================

test('buildArgs with no options is byte-for-byte the pre-feature argv', () => {
  const args = ClaudeCliService.buildArgs('sonnet');
  assert.deepEqual(args, [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--no-session-persistence',
    '--system-prompt', args[args.indexOf('--system-prompt') + 1],
    '--model', 'sonnet',
  ]);
  assert.ok(!args.includes('--resume'), 'no prep session means no --resume');
  assert.ok(!args.includes('--fork-session'));
  assert.ok(!args.includes('--effort'), "'default' effort must omit the flag entirely");
});

test('a blank prep session id leaves every turn on today\'s isolated path', async (t) => {
  t.after(reset);
  const log = newLog('blank.log');
  const bin = makeCli('blank.js', log);
  reset();

  // Arming with a blank id is the no-op that keeps existing users unaffected.
  assert.equal(ClaudeCliService.beginPrepSession(cfg(bin, { prepSessionId: '' }), 'm-blank'), null);
  assert.equal(ClaudeCliService.prepSessionStatus(), null, 'a blank id must not arm a prep session');

  await ask(bin, 'A');
  await ask(bin, 'B');

  const rows = readLog(log);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.resumed, null, 'no --resume on the no-prep path');
    assert.equal(row.forked, false);
    assert.equal(row.persistence, true,
      '--no-session-persistence MUST be retained: a user who did not opt in gets nothing written to ~/.claude');
    assert.equal(row.effort, null);
  }
});

// =============================================================================
// 2 & 3. Fork once at meeting start, then resume the fork
// =============================================================================

test('the first turn forks the prep session and captures the new id; later turns resume it', async (t) => {
  t.after(() => { reset(); removePrepTranscripts(); });
  const log = newLog('fork.log');
  const bin = makeCli('fork.js', log);
  reset();
  plantPrepTranscript();

  assert.equal(ClaudeCliService.beginPrepSession(cfg(bin, { prepSessionId: PREP_ID }), 'm-fork'), null);
  assert.equal(ClaudeCliService.prepSessionStatus().forkedSessionId, null,
    'nothing is forked until a turn actually runs');

  assert.equal(await ask(bin, 'first'), 'ok:first');
  assert.equal(await ask(bin, 'second'), 'ok:second');
  assert.equal(await ask(bin, 'third'), 'ok:third');

  const rows = readLog(log);
  assert.equal(rows.length, 3);

  // Turn 1: fork FROM the prep session.
  assert.equal(rows[0].resumed, PREP_ID);
  assert.equal(rows[0].forked, true);
  // --fork-session cannot write without session persistence, so this is the one
  // path where the flag is dropped.
  assert.equal(rows[0].persistence, false,
    '--fork-session requires session persistence, so --no-session-persistence must be dropped here');

  // Turns 2 and 3: resume the FORK, and never fork again — that is what makes
  // context accumulate so "expand on that" works.
  for (const row of rows.slice(1)) {
    assert.equal(row.resumed, FORKED_ID, 'later turns resume the forked id, not the prep id');
    assert.equal(row.forked, false, 'forking again every turn would discard the meeting so far');
    assert.equal(row.persistence, false);
  }

  const status = ClaudeCliService.prepSessionStatus();
  assert.equal(status.forkedSessionId, FORKED_ID);
  assert.equal(status.prepSessionId, PREP_ID, 'the prep session id is remembered as the source, unmodified');
  assert.equal(status.turns, 3);
  assert.equal(status.failure, null);
  // Falls out of the result frame the capture already parses.
  assert.equal(status.lastContextTokens, 9402);
});

test('the forked id survives teardown, so the meeting row can persist it', async (t) => {
  t.after(() => { reset(); removePrepTranscripts(); });
  const bin = makeCli('persist.js', newLog('persist.log'));
  reset();
  plantPrepTranscript();

  ClaudeCliService.beginPrepSession(cfg(bin, { prepSessionId: PREP_ID }), 'm-persist');
  await ask(bin, 'q');
  assert.equal(ClaudeCliService.meetingSessionId(), FORKED_ID);

  // endMeeting kills the session in its synchronous section; the meeting row is
  // written later, from MeetingPersistence.stopMeeting. The id has to outlive
  // the first to reach the second.
  ClaudeCliService.endPrepSession('meeting ended');
  assert.equal(ClaudeCliService.meetingSessionId(), FORKED_ID,
    'the forked id must survive endPrepSession or nothing can persist it');

  // …but it must NOT leak onto the next meeting, which may use no prep session
  // at all. That would hand the user a link into a different interview.
  ClaudeCliService.beginPrepSession(cfg(bin, { prepSessionId: '' }), 'm-next');
  assert.equal(ClaudeCliService.meetingSessionId(), null);
});

test('an overlapping turn re-forks the PREP session instead of racing the meeting one', async (t) => {
  t.after(() => { reset(); removePrepTranscripts(); });
  const log = newLog('overlap.log');
  const bin = makeCli('overlap.js', log);
  reset();
  plantPrepTranscript();

  ClaudeCliService.beginPrepSession(cfg(bin, { prepSessionId: PREP_ID }), 'm-overlap');

  // Two turns started without awaiting the first: the second finds the slot
  // held. Two processes appending to one session id would fork its history
  // unpredictably, so the loser gets its own fork of the PREP conversation —
  // which keeps the full prep grounding, unlike falling back to no context.
  const [a, b] = await Promise.all([ask(bin, 'A'), ask(bin, 'B')]);
  assert.equal(a, 'ok:A');
  assert.equal(b, 'ok:B');

  const rows = readLog(log);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.resumed, PREP_ID, 'both overlapping turns read the prep conversation');
    assert.equal(row.forked, true, 'neither may append to the meeting session concurrently');
  }
});

// =============================================================================
// 4. Effort is independent of the model
// =============================================================================

test('CLAUDE_CLI_EFFORT_LEVELS covers the CLI levels plus the omit sentinel', () => {
  assert.deepEqual([...CLAUDE_CLI_EFFORT_LEVELS], ['default', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('effort is orthogonal to the model: every level pairs with every model', () => {
  for (const model of ['sonnet', 'opus', 'haiku', 'fable']) {
    for (const effort of CLAUDE_CLI_EFFORT_LEVELS) {
      const args = ClaudeCliService.buildArgs(model, { effort });
      // The model is whatever was asked for, unchanged. Effort must NEVER be
      // implemented as a model downgrade — `opus --effort low` is the explicit
      // combination this guards.
      assert.equal(args[args.indexOf('--model') + 1], model,
        `--effort ${effort} must not change --model ${model}`);
      if (effort === 'default') {
        assert.ok(!args.includes('--effort'), "'default' means omit the flag");
      } else {
        assert.equal(args[args.indexOf('--effort') + 1], effort);
      }
    }
  }
});

test('effort reaches the spawned process, and does not disturb the resume flags', async (t) => {
  t.after(() => { reset(); removePrepTranscripts(); });
  const log = newLog('effort.log');
  const bin = makeCli('effort.js', log);
  reset();
  plantPrepTranscript();

  // Isolated path, opus at low effort — the combination the design insists on.
  await ask(bin, 'A', { model: 'opus', effort: 'low' });

  ClaudeCliService.beginPrepSession(cfg(bin, { prepSessionId: PREP_ID }), 'm-effort');
  await ask(bin, 'B', { model: 'opus', effort: 'high' });

  const rows = readLog(log);
  assert.deepEqual(
    rows.map(r => ({ model: r.model, effort: r.effort, forked: r.forked })),
    [
      { model: 'opus', effort: 'low', forked: false },
      { model: 'opus', effort: 'high', forked: true },
    ],
  );
});

// =============================================================================
// 5. The judge is never given the session
// =============================================================================

test('an isolated turn gets no prep session, even while one is armed', async (t) => {
  t.after(() => { reset(); removePrepTranscripts(); });
  const log = newLog('judge.log');
  const bin = makeCli('judge.js', log);
  reset();
  plantPrepTranscript();

  ClaudeCliService.beginPrepSession(cfg(bin, { prepSessionId: PREP_ID }), 'm-judge');

  // The answer turn forks, as usual.
  await ask(bin, 'answer');
  // The judge turn does not. It is the only genuinely concurrent caller, and a
  // session is strictly serial — keeping it out is what makes one per-meeting
  // session safe at all. It also has no use for 20k tokens of prep context to
  // decide a yes/no.
  await ask(bin, 'judge', { isolated: true });

  const rows = readLog(log);
  assert.equal(rows[0].forked, true);
  assert.equal(rows[1].resumed, null, 'the judge must never resume any session');
  assert.equal(rows[1].forked, false);
  assert.equal(rows[1].persistence, true,
    'an isolated turn keeps --no-session-persistence, so a judge verdict is never written to ~/.claude');

  // …and it did not consume the meeting's turn slot or disturb the fork.
  assert.equal(ClaudeCliService.prepSessionStatus().forkedSessionId, FORKED_ID);
  assert.equal(ClaudeCliService.prepSessionStatus().turns, 1);
});

test('an isolated turn is unaffected by a prep session that has already failed', async (t) => {
  t.after(() => { reset(); removePrepTranscripts(); });
  const log = newLog('judge-failed.log');
  const bin = makeCli('judge-failed.js', log);
  reset();
  removePrepTranscripts();

  // A prep id with no transcript on disk: armed, and immediately failed.
  const error = ClaudeCliService.beginPrepSession(cfg(bin, { prepSessionId: PREP_ID }), 'm-judge-failed');
  assert.ok(error, 'a prep id with no conversation must fail at meeting start');

  // Answer turns are refused (see below), but the judge keeps working — Auto
  // Answer must not go deaf because the prep session is misconfigured.
  assert.equal(await ask(bin, 'judge', { isolated: true }), 'ok:judge');
});

test('an isolated turn does not claim the stdin meeting session either', async (t) => {
  t.after(reset);
  const log = newLog('judge-stdin.log');
  const bin = makeCli('judge-stdin.js', log);
  reset();

  // REGRESSION. Before the `isolated` flag existed this was a real leak, not a
  // hypothetical: the judge routes through generateContentStructured, which
  // seats this provider at Priority 0 whenever a claude-cli model is selected,
  // and its argv matched the session's signature exactly — so on a Gemini-less
  // install (the install this provider exists for) every judge verdict was
  // claiming the meeting session and landing in the interview conversation.
  ClaudeCliService.beginSession(cfg(bin, { sessionMode: 'meeting' }), 'm-judge-stdin');
  assert.ok(ClaudeCliService.sessionStatus()?.active, 'a stdin session is open for this test');

  await ask(bin, 'judge', { isolated: true });

  assert.equal(ClaudeCliService.sessionStatus().turns, 0,
    'the judge must not consume a turn of the meeting session');
  const rows = readLog(log);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].persistence, true, 'the isolated turn ran on its own one-off process');
});

// =============================================================================
// 6. An invalid prep session id fails loudly and stays failed
// =============================================================================

test('looksLikeMissingSessionError matches the CLI\'s actual sentence', () => {
  assert.ok(looksLikeMissingSessionError('No conversation found with session ID: abc'));
  assert.ok(looksLikeMissingSessionError('Session not found'));
  assert.ok(!looksLikeMissingSessionError('Invalid API key'));
  assert.ok(!looksLikeMissingSessionError(''));
});

test('beginPrepSession reports a prep id that does not resolve, and arms it failed', async (t) => {
  t.after(() => { reset(); removePrepTranscripts(); });
  const log = newLog('missing-start.log');
  const bin = makeCli('missing-start.js', log);
  reset();
  removePrepTranscripts();

  const error = ClaudeCliService.beginPrepSession(cfg(bin, { prepSessionId: PREP_ID }), 'm-missing');
  assert.ok(error?.includes(CLAUDE_CLI_PREP_SESSION_MISSING_MESSAGE),
    'the failure must name the fix, not just say something went wrong');
  assert.equal(ClaudeCliService.prepSessionStatus().failure, error);

  // The turn is REFUSED rather than silently answered without context. A
  // generic answer the user cannot tell is ungrounded is the outcome this
  // whole path exists to prevent.
  await assert.rejects(() => ask(bin, 'A'), (e) => {
    assert.ok(e.message.includes(CLAUDE_CLI_PREP_SESSION_MISSING_MESSAGE));
    return true;
  });
  assert.equal(readLog(log).length, 0, 'a refused turn must not even spawn the CLI');

  // Sticky: a second turn fails the same way rather than spending the meeting
  // spawning doomed processes.
  await assert.rejects(() => ask(bin, 'B'));
});

test('a prep id the CLI itself rejects surfaces the actionable message, not "no message"', async (t) => {
  t.after(() => { reset(); removePrepTranscripts(); });
  const log = newLog('missing-turn.log');
  // This binary reproduces the real failure shape: the explanation on stderr,
  // a bare is_error result frame with no message on stdout, exit 1.
  const bin = makeCli('missing-turn.js', log, { missingSession: true });
  reset();
  // Planted, so the filesystem pre-check PASSES and only --resume knows better
  // — the deleted-between-configuring-and-asking case.
  plantPrepTranscript();

  assert.equal(ClaudeCliService.beginPrepSession(cfg(bin, { prepSessionId: PREP_ID }), 'm-missing-turn'), null);

  await assert.rejects(() => ask(bin, 'A'), (e) => {
    assert.ok(e.message.includes(CLAUDE_CLI_PREP_SESSION_MISSING_MESSAGE),
      `expected an actionable prep-session error, got: ${e.message}`);
    assert.ok(!e.message.includes('gave no message'),
      'the empty is_error frame must yield to the stderr sentence');
    return true;
  });

  assert.equal(readLog(log).length, 1, 'the turn was attempted once');
  // Failed turns must not adopt the session id the CLI echoed back — it is the
  // one just proven not to exist, and persisting it would hand the user a dead
  // "resume your interview" link.
  const status = ClaudeCliService.prepSessionStatus();
  assert.equal(status.forkedSessionId, null);
  assert.ok(status.failure, 'the failure is sticky after the CLI refuses the resume');
});

test('locateSessionTranscript separates "absent" from "could not look"', () => {
  // A malformed id is genuinely not a session — a completed check.
  assert.deepEqual(ClaudeCliService.locateSessionTranscript('../../etc/passwd'), { checked: true, path: null });
  assert.deepEqual(ClaudeCliService.locateSessionTranscript(''), { checked: true, path: null });

  plantPrepTranscript();
  try {
    const found = ClaudeCliService.locateSessionTranscript(PREP_ID);
    assert.equal(found.checked, true);
    assert.ok(found.path?.endsWith(`${PREP_ID}.jsonl`));
  } finally {
    removePrepTranscripts();
  }

  const absent = ClaudeCliService.locateSessionTranscript('00000000-0000-4000-8000-000000000000');
  // `checked` may be false on a machine with no ~/.claude at all, and that is
  // NOT evidence the id is bad — the distinction this asserts.
  if (absent.checked) assert.equal(absent.path, null);
});

// =============================================================================
// 7. Prep session and stdin session mode never both apply
// =============================================================================

test('a configured prep session supersedes stdin session mode', async (t) => {
  t.after(() => { reset(); removePrepTranscripts(); });
  const log = newLog('supersede.log');
  const bin = makeCli('supersede.js', log);
  reset();
  plantPrepTranscript();

  const config = cfg(bin, { prepSessionId: PREP_ID, sessionMode: 'meeting' });
  ClaudeCliService.beginPrepSession(config, 'm-both');
  ClaudeCliService.beginSession(config, 'm-both');

  // Two mechanisms for the same job would replay the conversation on top of the
  // copy a held process already has. Exactly one is armed.
  assert.equal(ClaudeCliService.sessionStatus(), null,
    'stdin session mode must not open a process while a prep session is configured');
  assert.ok(ClaudeCliService.prepSessionStatus());

  await ask(bin, 'A');
  await ask(bin, 'B');
  const rows = readLog(log);
  assert.equal(rows.length, 2, 'each turn is its own resumed process, not one held open');
  assert.equal(rows[0].forked, true);
  assert.equal(rows[1].resumed, FORKED_ID);
});

test('with no prep session, stdin session mode still behaves exactly as before', async (t) => {
  t.after(() => { reset(); removePrepTranscripts(); });
  const bin = makeCli('nopep.js', newLog('noprep.log'));
  reset();

  const config = cfg(bin, { prepSessionId: '', sessionMode: 'meeting' });
  ClaudeCliService.beginPrepSession(config, 'm-stdin');
  ClaudeCliService.beginSession(config, 'm-stdin');
  assert.equal(ClaudeCliService.prepSessionStatus(), null);
  assert.equal(ClaudeCliService.sessionStatus()?.meetingId, 'm-stdin',
    'the pre-existing session mode is untouched when no prep session is set');
});

test('reapplyConfigToSession keeps an unchanged prep session and its fork', async (t) => {
  t.after(() => { reset(); removePrepTranscripts(); });
  const bin = makeCli('reapply.js', newLog('reapply.log'));
  reset();
  plantPrepTranscript();

  const config = cfg(bin, { prepSessionId: PREP_ID });
  ClaudeCliService.beginPrepSession(config, 'm-reapply');
  await ask(bin, 'A');
  assert.equal(ClaudeCliService.prepSessionStatus().forkedSessionId, FORKED_ID);

  // Saving an unrelated setting mid-meeting must not throw the interview away.
  assert.equal(ClaudeCliService.reapplyConfigToSession(cfg(bin, { prepSessionId: PREP_ID, timeoutMs: 30_000 })), true);
  assert.equal(ClaudeCliService.prepSessionStatus().forkedSessionId, FORKED_ID,
    'an unrelated settings save must not discard the meeting conversation');

  // Actually changing the prep session does start over — the fork came from the
  // old one and no longer describes what the user asked for.
  ClaudeCliService.reapplyConfigToSession(cfg(bin, { prepSessionId: '' }));
  assert.equal(ClaudeCliService.prepSessionStatus(), null);
});

// =============================================================================
// 8. Frame parsing
// =============================================================================

test('extractClaudeSessionId reads init and result frames only', () => {
  assert.equal(extractClaudeSessionId({ type: 'system', subtype: 'init', session_id: 'a' }), 'a');
  assert.equal(extractClaudeSessionId({ type: 'result', session_id: 'b' }), 'b');
  // A subagent frame carries its own session id; adopting it would point the
  // persisted "resume your interview" link at the wrong conversation.
  assert.equal(extractClaudeSessionId({ type: 'result', session_id: 'c', parent_tool_use_id: 'tool_1' }), '');
  assert.equal(extractClaudeSessionId({ type: 'system', subtype: 'other', session_id: 'd' }), '');
  assert.equal(extractClaudeSessionId({ type: 'stream_event', session_id: 'e' }), '');
  assert.equal(extractClaudeSessionId({ type: 'result' }), '');
  assert.equal(extractClaudeSessionId(null), '');
});

test('DEFAULT_CLAUDE_CLI_CONFIG opts out of everything this feature adds', () => {
  assert.equal(DEFAULT_CLAUDE_CLI_CONFIG.prepSessionId, '');
  assert.equal(DEFAULT_CLAUDE_CLI_CONFIG.effort, 'default');
});

// =============================================================================
// 9. Wiring pins
//
// Source pins rather than behaviour, in the style of
// OllamaErrorReachesRenderer2026_08_14: the failure mode they guard is a
// channel with a producer and no consumer, which no unit test of either side
// can see. Each one names the property, not the line.
// =============================================================================

const ROOT = path.resolve(__dirname, '../../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the prep-session failure has a producer AND a consumer', () => {
  const llmHelper = read('electron/LLMHelper.ts');
  assert.ok(llmHelper.includes("'claude-cli:prep-session-error'"),
    'LLMHelper must broadcast the failure');

  const preload = read('electron/preload.ts');
  const at = preload.lastIndexOf('onClaudeCliPrepSessionError:');
  assert.notEqual(at, -1, 'preload must expose onClaudeCliPrepSessionError');
  const body = preload.slice(at, at + 400);
  assert.ok(/ipcRenderer\.on\('claude-cli:prep-session-error'/.test(body));
  assert.ok(/removeListener\('claude-cli:prep-session-error'/.test(body),
    'the subscription must return an unsubscribe');

  // Without a renderer consumer the message reaches nobody, and a silently
  // ungrounded meeting is exactly what this feature must not produce.
  assert.ok(read('src/components/NativelyInterface.tsx').includes('onClaudeCliPrepSessionError'),
    'the overlay must consume the failure into a visible message');
});

test('effort is settable from the overlay without a full config round trip', () => {
  assert.ok(read('electron/ipcHandlers.ts').includes("safeHandle('claude-cli:set-effort'"),
    'a dedicated handler exists, so a mid-meeting change cannot race an open Settings panel');
  assert.ok(read('electron/preload.ts').includes("ipcRenderer.invoke('claude-cli:set-effort'"));

  const overlay = read('src/components/NativelyInterface.tsx');
  assert.ok(overlay.includes('data-claude-effort-toggle'),
    'the effort control must exist in the overlay');
  // "Next to the model picker", literally: the control sits between the model
  // chip and the divider that separates it from Settings. lastIndexOf, because
  // both toggle attributes appear EARLIER in the file as click-outside selectors
  // — matching those would compare the wrong things entirely.
  const modelChip = overlay.lastIndexOf('data-model-selector-toggle');
  const effortChip = overlay.lastIndexOf('data-claude-effort-toggle');
  const settingsChip = overlay.lastIndexOf('data-settings-toggle');
  assert.ok(modelChip !== -1 && effortChip !== -1 && settingsChip !== -1);
  assert.ok(modelChip < effortChip && effortChip < settingsChip,
    'effort belongs beside the model picker, not buried in Settings');
});

test('the settings keys persist, and the prep id is checkable from Settings', () => {
  const settings = read('electron/services/SettingsManager.ts');
  assert.ok(settings.includes('claudeCliSessionId?: string'));
  assert.ok(settings.includes('claudeCliEffort?:'));

  const ipc = read('electron/ipcHandlers.ts');
  assert.ok(ipc.includes("sm.set('claudeCliSessionId'"), 'the prep id must reach the settings store');
  assert.ok(ipc.includes("sm.set('claudeCliEffort'"));
  assert.ok(ipc.includes("safeHandle('claude-cli:check-session'"),
    'Settings must be able to say "that session does not exist" before an interview, not during one');

  // main.ts reads them back at boot, or the whole thing is inert after relaunch.
  const main = read('electron/main.ts');
  assert.ok(main.includes("settingsManager.get('claudeCliSessionId')"));
  assert.ok(main.includes("settingsManager.get('claudeCliEffort')"));
});

test('the meeting detail page can show and copy the session id', () => {
  const details = read('src/components/MeetingDetails.tsx');
  assert.ok(details.includes('meeting.claudeSessionId'),
    'the detail page must render the session id');
  assert.ok(/claudeSessionId && \(/.test(details),
    'and only when the meeting actually has one — i.e. only for a claude-cli meeting');
  assert.ok(/CopyButton text=\{meeting\.claudeSessionId\}/.test(details),
    'the id is meant to be pasted into `claude --resume`, so it must be copyable');

  // And it has to survive the trip out of the main process.
  assert.ok(read('electron/MeetingPersistence.ts').includes('getClaudeCliMeetingSessionId'),
    'the save path must capture the id while the meeting is still live');
});

test.after(() => {
  reset();
  removePrepTranscripts();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});
