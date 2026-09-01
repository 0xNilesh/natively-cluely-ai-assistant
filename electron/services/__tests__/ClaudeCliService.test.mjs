// electron/services/__tests__/ClaudeCliService.test.mjs
//
// Unit tests for the Claude Code (`claude`) CLI provider.
//
// NOTHING here invokes the real `claude` binary. Every subprocess test spawns a
// generated Node script that impersonates the CLI's stream-json contract: it
// reads one turn from stdin and writes NDJSON frames to stdout. That keeps the
// tests hermetic (no network, no auth, no cost) while still exercising the REAL
// spawn / pipe / kill code path — a fully mocked child_process would prove
// nothing about the thing most likely to break.
//
// Covered:
//   1. Defaults + normalizeConfig round-trip (including the 0 / clamp cases)
//   2. buildArgs — every load-bearing flag, and what must NOT be in it
//   3. Stream-json parsing: chunked frames, split mid-line and mid-UTF8,
//      malformed lines, thinking/tool deltas, subagent frames
//   4. Incremental delivery: deltas reach the consumer BEFORE the process exits
//   5. Non-zero exit surfaces an error (both `is_error` result frames and a
//      bare exit code with stderr)
//   6. Abort kills the child process — asserted against the real pid
//   7. Binary-path resolution when `claude` is absent
//   8. Warm-pool: reuse, replacement, disposal
//
// Run via: npm run build:electron && node --test electron/services/__tests__/ClaudeCliService.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const compiledPath = path.resolve(__dirname, '../../../dist-electron/electron/services/ClaudeCliService.js');
const mod = await import(pathToFileURL(compiledPath).href);
const {
  ClaudeCliService,
  ClaudeStreamJsonParser,
  DEFAULT_CLAUDE_CLI_CONFIG,
  CLAUDE_CLI_BASE_SYSTEM_PROMPT,
  CLAUDE_CLI_NOT_FOUND_MESSAGE,
  extractClaudeTextDelta,
  extractClaudeAssistantText,
  extractClaudeStreamError,
  describeClaudeCliFailure,
  isClaudeCliError,
} = mod;

// =============================================================================
// Fake `claude` binaries
// =============================================================================

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-claude-cli-test-'));

/**
 * Write an executable Node script that stands in for the `claude` binary.
 *
 * `body` runs with `readTurn()` available — a promise resolving to the parsed
 * stdin turn — plus `emit(frame)` for writing one NDJSON line. The shebang
 * points at the running Node so the test never depends on a PATH lookup.
 */
function makeFakeCli(name, body) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, `#!${process.execPath}
'use strict';
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
const raw = (s) => process.stdout.write(s);
const readTurn = () => new Promise((resolve) => {
  let buf = '';
  process.stdin.on('data', (c) => {
    buf += c.toString();
    const nl = buf.indexOf('\\n');
    if (nl >= 0) { try { resolve(JSON.parse(buf.slice(0, nl))); } catch { resolve(null); } }
  });
  process.stdin.on('end', () => resolve(null));
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
${body}
`, { mode: 0o755 });
  return file;
}

/** Frame helper matching the real CLI's shape. */
const textDelta = (text) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  parent_tool_use_id: null,
});

async function drain(gen) {
  const out = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

// =============================================================================
// 1. Defaults + normalizeConfig
// =============================================================================

test('DEFAULT_CLAUDE_CLI_CONFIG has the expected shape', () => {
  assert.equal(DEFAULT_CLAUDE_CLI_CONFIG.enabled, false);
  assert.equal(DEFAULT_CLAUDE_CLI_CONFIG.path, 'claude');
  assert.equal(DEFAULT_CLAUDE_CLI_CONFIG.model, 'sonnet');
  assert.equal(DEFAULT_CLAUDE_CLI_CONFIG.fastModel, 'haiku');
  assert.equal(DEFAULT_CLAUDE_CLI_CONFIG.timeoutMs, 60_000);
  assert.equal(DEFAULT_CLAUDE_CLI_CONFIG.maxWarmProcesses, 2);
  // Isolated by default: persistent sessions couple turns together, so they
  // are opt-in rather than something a user gets without asking.
  assert.equal(DEFAULT_CLAUDE_CLI_CONFIG.sessionMode, 'isolated');
  // BLANK prep session by default, and this one is load-bearing: blank is the
  // opt-out that keeps today's behaviour (no resume, no replay,
  // --no-session-persistence retained). A non-empty default here would impose
  // the replay cost on every existing user without asking.
  assert.equal(DEFAULT_CLAUDE_CLI_CONFIG.prepSessionId, '');
  // 'default' = do not pass --effort at all.
  assert.equal(DEFAULT_CLAUDE_CLI_CONFIG.effort, 'default');
});

test('normalizeConfig: empty input returns the defaults', () => {
  assert.deepEqual(ClaudeCliService.normalizeConfig({}), DEFAULT_CLAUDE_CLI_CONFIG);
  assert.deepEqual(ClaudeCliService.normalizeConfig(), DEFAULT_CLAUDE_CLI_CONFIG);
});

test('normalizeConfig: round-trips a fully specified config unchanged', () => {
  const input = {
    enabled: true,
    path: '/opt/bin/claude',
    model: 'opus',
    fastModel: 'haiku',
    timeoutMs: 45_000,
    maxWarmProcesses: 3,
    sessionMode: 'meeting',
    // A prep session id and an effort level round-trip like every other field.
    // Both are part of the config the get/set IPC carries, so leaving them out
    // here would let a normalization bug in either reach the settings store.
    prepSessionId: '9f3a2b1c-0000-4000-8000-abcdefabcdef',
    effort: 'high',
  };
  assert.deepEqual(ClaudeCliService.normalizeConfig(input), input);
  // Idempotent: normalizing the normalized value is a fixed point, which is
  // what the get/set IPC round-trip relies on.
  assert.deepEqual(
    ClaudeCliService.normalizeConfig(ClaudeCliService.normalizeConfig(input)),
    input,
  );
});

test('normalizeConfig: coerces enabled and trims path/model', () => {
  const out = ClaudeCliService.normalizeConfig({ enabled: 1, path: '  claude  ', model: '  opus ' });
  assert.equal(out.enabled, true);
  assert.equal(out.path, 'claude');
  assert.equal(out.model, 'opus');
  assert.equal(ClaudeCliService.normalizeConfig({ enabled: 0 }).enabled, false);
});

test('normalizeConfig: invalid timeouts fall back to the default', () => {
  for (const bad of [0, -1, NaN, 'abc', null, undefined]) {
    assert.equal(
      ClaudeCliService.normalizeConfig({ timeoutMs: bad }).timeoutMs,
      DEFAULT_CLAUDE_CLI_CONFIG.timeoutMs,
      `timeoutMs=${String(bad)} must fall back`,
    );
  }
});

test('normalizeConfig: maxWarmProcesses 0 survives (it means "never prewarm")', () => {
  // The regression this pins: a truthiness check would silently turn the
  // user's explicit "no background processes" into the default of 2.
  assert.equal(ClaudeCliService.normalizeConfig({ maxWarmProcesses: 0 }).maxWarmProcesses, 0);
  assert.equal(ClaudeCliService.normalizeConfig({ maxWarmProcesses: 3 }).maxWarmProcesses, 3);
  assert.equal(ClaudeCliService.normalizeConfig({ maxWarmProcesses: 2.7 }).maxWarmProcesses, 2);
  // Clamped, so a typo cannot park hundreds of node processes.
  assert.equal(ClaudeCliService.normalizeConfig({ maxWarmProcesses: 500 }).maxWarmProcesses, 8);
  assert.equal(
    ClaudeCliService.normalizeConfig({ maxWarmProcesses: -1 }).maxWarmProcesses,
    DEFAULT_CLAUDE_CLI_CONFIG.maxWarmProcesses,
  );
});

// =============================================================================
// 2. buildArgs
// =============================================================================

test('buildArgs: carries every flag the streaming contract depends on', () => {
  const args = ClaudeCliService.buildArgs('sonnet');
  const pairOf = (flag) => args[args.indexOf(flag) + 1];

  assert.ok(args.includes('-p'), '-p is what makes the run non-interactive');
  assert.equal(pairOf('--input-format'), 'stream-json', 'stdin turn is what makes the process prewarmable');
  assert.equal(pairOf('--output-format'), 'stream-json');
  assert.ok(args.includes('--include-partial-messages'),
    'without this the CLI emits one whole assistant frame and word-by-word rendering is lost');
  assert.ok(args.includes('--verbose'), '--print + stream-json requires --verbose');
  assert.equal(pairOf('--model'), 'sonnet');
});

test('buildArgs: locks the CLI out of tools, MCP, settings and session history', () => {
  const args = ClaudeCliService.buildArgs('opus');
  const pairOf = (flag) => args[args.indexOf(flag) + 1];
  // Natively asks questions; it must never let the CLI act on the machine.
  assert.equal(pairOf('--tools'), '', '--tools "" disables Bash/Edit/Read');
  assert.ok(args.includes('--strict-mcp-config'), 'user MCP servers must not load');
  assert.equal(pairOf('--setting-sources'), '', 'user/project/local settings and hooks must not load');
  assert.ok(args.includes('--no-session-persistence'),
    'a Natively turn must not land in the user\'s ~/.claude session history');
  assert.equal(pairOf('--system-prompt'), CLAUDE_CLI_BASE_SYSTEM_PROMPT,
    'the coding-agent persona must be replaced');
});

test('buildArgs: is per-model only, so the warm-pool key stays tiny', () => {
  // The whole prewarm win rests on this: if anything per-request leaked into
  // argv, every call would miss the pool and pay the full cold-start cost.
  const a = ClaudeCliService.buildArgs('sonnet');
  const b = ClaudeCliService.buildArgs('sonnet');
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, ClaudeCliService.buildArgs('opus'));
});

test('buildTurnText: prepends the per-turn system prompt to the user turn', () => {
  assert.equal(ClaudeCliService.buildTurnText('Q?', 'SYS'), 'SYS\n\nQ?');
  assert.equal(ClaudeCliService.buildTurnText('Q?'), 'Q?');
  assert.equal(ClaudeCliService.buildTurnText('Q?', ''), 'Q?');
});

// =============================================================================
// 3. Stream-json parsing
// =============================================================================

test('parser: decodes whole lines and buffers a partial trailing line', () => {
  const p = new ClaudeStreamJsonParser();
  assert.deepEqual(p.push('{"type":"a"}\n{"type":"b"}\n'), [{ type: 'a' }, { type: 'b' }]);
  assert.deepEqual(p.push('{"type":"c"'), [], 'incomplete line must not be emitted');
  assert.deepEqual(p.push('}\n'), [{ type: 'c' }]);
});

test('parser: a frame split across many chunks emerges exactly once', () => {
  const frame = JSON.stringify(textDelta('hello'));
  const p = new ClaudeStreamJsonParser();
  const seen = [];
  // One byte at a time — the worst case a pipe can produce.
  for (const ch of `${frame}\n`) seen.push(...p.push(ch));
  assert.equal(seen.length, 1);
  assert.equal(extractClaudeTextDelta(seen[0]), 'hello');
});

test('parser: flush() drains a final line with no trailing newline', () => {
  const p = new ClaudeStreamJsonParser();
  assert.deepEqual(p.push('{"type":"result","is_error":false,"result":"x"}'), []);
  assert.deepEqual(p.flush(), [{ type: 'result', is_error: false, result: 'x' }]);
  assert.deepEqual(p.flush(), [], 'flush is idempotent');
});

test('parser: malformed lines are dropped, not thrown, and never stop the stream', () => {
  const p = new ClaudeStreamJsonParser();
  const frames = p.push(
    'not json at all\n'
    + '{"type":"ok"}\n'
    + '{"broken":\n'          // truncated JSON on its own line
    + '[1,2,3]\n'             // valid JSON but not an object
    + '"a string"\n'
    + '\n'                    // blank line
    + '{"type":"ok2"}\n',
  );
  assert.deepEqual(frames, [{ type: 'ok' }, { type: 'ok2' }],
    'one bad line must not cost the user the rest of a good answer');
  assert.equal(p.malformedLines.length, 4);
});

test('parser: handles a multi-byte character split across chunks', () => {
  // Chunks arrive as decoded strings, so the service decodes with utf8 before
  // pushing; this pins the line-splitting half of that contract.
  const p = new ClaudeStreamJsonParser();
  const frame = JSON.stringify(textDelta('héllo — ok'));
  const mid = Math.floor(frame.length / 2);
  const seen = [...p.push(frame.slice(0, mid)), ...p.push(`${frame.slice(mid)}\n`)];
  assert.equal(seen.length, 1);
  assert.equal(extractClaudeTextDelta(seen[0]), 'héllo — ok');
});

test('extractClaudeTextDelta: only text_delta counts', () => {
  assert.equal(extractClaudeTextDelta(textDelta('hi')), 'hi');
  // Extended thinking is NOT the answer and must never reach the renderer.
  assert.equal(extractClaudeTextDelta({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
  }), '');
  assert.equal(extractClaudeTextDelta({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"a"' } },
  }), '');
  assert.equal(extractClaudeTextDelta({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'x' } },
  }), '');
  assert.equal(extractClaudeTextDelta({ type: 'stream_event', event: { type: 'message_stop' } }), '');
  assert.equal(extractClaudeTextDelta({ type: 'system', subtype: 'init' }), '');
  assert.equal(extractClaudeTextDelta(null), '');
});

test('extractClaudeTextDelta: subagent output is not this turn\'s answer', () => {
  assert.equal(extractClaudeTextDelta({ ...textDelta('sub'), parent_tool_use_id: 'toolu_1' }), '');
});

test('extractClaudeAssistantText: a <synthetic> message is an error envelope, not an answer', () => {
  // REGRESSION, caught against the real `claude` 2.1.251. An unusable --model
  // makes the CLI deliver its failure as an ordinary-looking assistant turn
  // marked model:"<synthetic>", followed by the is_error result frame. Emitting
  // that text made the stream "succeed" and handed the user the error message
  // as the answer, with the provider recorded healthy.
  assert.equal(extractClaudeAssistantText({
    type: 'assistant',
    message: {
      model: '<synthetic>',
      content: [{ type: 'text', text: "There's an issue with the selected model (bogus)." }],
    },
  }), '');
  // A real model's message is still emitted.
  assert.equal(extractClaudeAssistantText({
    type: 'assistant',
    message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'real answer' }] },
  }), 'real answer');
});

test('stream: the synthetic error envelope does not become the answer', async () => {
  // End-to-end shape of the frames the real CLI emits for an unusable model.
  const bin = makeFakeCli('synthetic-error.js', `
(async () => {
  await readTurn();
  emit({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: "There's an issue with the selected model (bogus)." }] } });
  emit({ type: 'result', subtype: 'success', is_error: true, result: "There's an issue with the selected model (bogus)." });
  process.exit(1);
})();
`);
  await assert.rejects(
    () => drain(ClaudeCliService.stream(bin, { prompt: 'hi', model: 'bogus', timeoutMs: 10_000, maxWarmProcesses: 0 })),
    err => /issue with the selected model/.test(err.message),
    'the failure must surface as an error, not be returned as the answer text',
  );
});

test('extractClaudeAssistantText: joins text blocks and ignores the rest', () => {
  assert.equal(extractClaudeAssistantText({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'a' }, { type: 'thinking', thinking: 'x' }, { type: 'text', text: 'b' }] },
  }), 'ab');
  assert.equal(extractClaudeAssistantText({ type: 'assistant', message: { content: 'plain' } }), 'plain');
  assert.equal(extractClaudeAssistantText({ type: 'user', message: { content: [{ type: 'text', text: 'q' }] } }), '');
});

test('extractClaudeStreamError: only an is_error result is an error', () => {
  assert.match(
    extractClaudeStreamError({ type: 'result', is_error: true, result: 'model not found' }),
    /model not found/,
  );
  assert.equal(extractClaudeStreamError({ type: 'result', is_error: false, result: 'fine' }), '');
  assert.equal(extractClaudeStreamError(textDelta('x')), '');
  // An is_error frame with no message still has to read as an error.
  assert.ok(extractClaudeStreamError({ type: 'result', is_error: true }).length > 0);
});

test('describeClaudeCliFailure: maps stderr onto actionable messages', () => {
  assert.match(describeClaudeCliFailure(1, 'spawn claude ENOENT', 'claude'), /not found/i);
  assert.ok(isClaudeCliError(new Error(describeClaudeCliFailure(1, 'ENOENT', 'claude'))));
  assert.match(describeClaudeCliFailure(1, 'Invalid API key', 'claude'), /not signed in/i);
  assert.match(describeClaudeCliFailure(1, 'OAuth token has expired', 'claude'), /not signed in/i);
  assert.match(describeClaudeCliFailure(2, 'some other problem', 'claude'), /some other problem/);
  assert.match(describeClaudeCliFailure(3, '', 'claude'), /exited with code 3/);
});

// =============================================================================
// 4. Streaming: incremental delivery
// =============================================================================

test('stream: yields deltas incrementally, before the process exits', async () => {
  // The point of the whole provider. The fake holds the process open for 400ms
  // after the last delta; if stream() buffered until exit, the first chunk
  // would not arrive until then and this assertion fails.
  const bin = makeFakeCli('incremental.js', `
(async () => {
  await readTurn();
  emit({ type: 'system', subtype: 'init', tools: [] });
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } } });
  await sleep(30);
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } } });
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'Hello world' });
  await sleep(400);
  process.exit(0);
})();
`);

  const gen = ClaudeCliService.stream(bin, { prompt: 'hi', model: 'sonnet', timeoutMs: 10_000, maxWarmProcesses: 0 });
  let firstChunkAt = 0;
  const chunks = [];
  for await (const chunk of gen) {
    if (chunks.length === 0) firstChunkAt = Date.now();
    chunks.push(chunk);
  }
  const finishedAt = Date.now();
  assert.deepEqual(chunks, ['Hello', ' world'],
    'the assistant + result frames repeat the deltas and must not be re-emitted');
  // Measured from the first chunk to the END of the stream, not from spawn:
  // an absolute budget would really be measuring how fast this machine boots
  // Node. The fake holds the process open for 400ms after its last frame, so a
  // gap anywhere near that size can only mean the chunk was delivered while the
  // process was still running.
  const gap = finishedAt - firstChunkAt;
  assert.ok(gap >= 300,
    `first chunk must be delivered well before the process exits; gap was only ${gap}ms`);
});

test('stream: sends exactly one user turn, then closes stdin', async () => {
  // Independence between concurrent requests rests on this.
  const out = path.join(TMP, 'turn-capture.json');
  const bin = makeFakeCli('capture-turn.js', `
(async () => {
  const turn = await readTurn();
  require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(turn));
  emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } } });
  emit({ type: 'result', is_error: false, result: 'ok' });
  process.exit(0);
})();
`);
  await drain(ClaudeCliService.stream(bin, {
    prompt: 'What is 2+2?', instructions: 'Be terse.', model: 'sonnet', timeoutMs: 10_000, maxWarmProcesses: 0,
  }));
  const turn = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(turn.type, 'user');
  assert.equal(turn.message.role, 'user');
  assert.deepEqual(turn.message.content, [{ type: 'text', text: 'Be terse.\n\nWhat is 2+2?' }]);
});

test('stream: falls back to the assistant frame when no partial deltas arrive', async () => {
  // An older CLI (or one that rejects --include-partial-messages) emits only
  // whole assistant messages. The answer must still reach the user.
  const bin = makeFakeCli('no-partials.js', `
(async () => {
  await readTurn();
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'whole answer' }] } });
  emit({ type: 'result', is_error: false, result: 'whole answer' });
  process.exit(0);
})();
`);
  const chunks = await drain(ClaudeCliService.stream(bin, {
    prompt: 'hi', model: 'sonnet', timeoutMs: 10_000, maxWarmProcesses: 0,
  }));
  assert.deepEqual(chunks, ['whole answer'], 'exactly once — not once per frame');
});

test('stream: tolerates a stream with no trailing newline on the last frame', async () => {
  const bin = makeFakeCli('no-trailing-nl.js', `
(async () => {
  await readTurn();
  raw(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'tail' } } }) + '\\n');
  raw(JSON.stringify({ type: 'result', is_error: false, result: 'tail' }));
  process.exit(0);
})();
`);
  const chunks = await drain(ClaudeCliService.stream(bin, {
    prompt: 'hi', model: 'sonnet', timeoutMs: 10_000, maxWarmProcesses: 0,
  }));
  assert.deepEqual(chunks, ['tail']);
});

test('run: concatenates the deltas into one string', async () => {
  const bin = makeFakeCli('run-concat.js', `
(async () => {
  await readTurn();
  for (const t of ['a', 'b', 'c']) emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
  emit({ type: 'result', is_error: false, result: 'abc' });
  process.exit(0);
})();
`);
  const text = await ClaudeCliService.run(bin, {
    prompt: 'hi', model: 'sonnet', timeoutMs: 10_000, maxWarmProcesses: 0,
  });
  assert.equal(text, 'abc');
});

test('stream: two concurrent calls do not interfere', async () => {
  // Auto Answer prefetches while its judge is still deciding, so overlapping
  // invocations are the normal case, not an edge case.
  const bin = makeFakeCli('concurrent.js', `
(async () => {
  const turn = await readTurn();
  const q = turn.message.content[0].text;
  await sleep(80);
  emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'echo:' + q } } });
  emit({ type: 'result', is_error: false, result: 'x' });
  process.exit(0);
})();
`);
  const [a, b] = await Promise.all([
    ClaudeCliService.run(bin, { prompt: 'AAA', model: 'sonnet', timeoutMs: 10_000, maxWarmProcesses: 0 }),
    ClaudeCliService.run(bin, { prompt: 'BBB', model: 'sonnet', timeoutMs: 10_000, maxWarmProcesses: 0 }),
  ]);
  assert.equal(a, 'echo:AAA');
  assert.equal(b, 'echo:BBB');
});

// =============================================================================
// 5. Errors
// =============================================================================

test('stream: an is_error result frame surfaces its message', async () => {
  const bin = makeFakeCli('result-error.js', `
(async () => {
  await readTurn();
  emit({ type: 'result', subtype: 'success', is_error: true, result: "There's an issue with the selected model (bogus)." });
  process.exit(1);
})();
`);
  await assert.rejects(
    () => drain(ClaudeCliService.stream(bin, { prompt: 'hi', model: 'bogus', timeoutMs: 10_000, maxWarmProcesses: 0 })),
    err => /issue with the selected model/.test(err.message),
    'the CLI\'s own message beats the exit code — it is the one a user can act on',
  );
});

test('stream: a non-zero exit with only stderr still surfaces an error', async () => {
  const bin = makeFakeCli('exit-nonzero.js', `
(async () => {
  await readTurn();
  process.stderr.write('[claude-code:unrecognized_model] something went wrong\\n');
  process.exit(7);
})();
`);
  await assert.rejects(
    () => drain(ClaudeCliService.stream(bin, { prompt: 'hi', model: 'sonnet', timeoutMs: 10_000, maxWarmProcesses: 0 })),
    err => /something went wrong/.test(err.message),
    'stderr must not vanish',
  );
});

test('stream: a clean exit with no output at all is an error, not an empty answer', async () => {
  const bin = makeFakeCli('silent.js', `(async () => { await readTurn(); process.exit(0); })();`);
  await assert.rejects(
    () => drain(ClaudeCliService.stream(bin, { prompt: 'hi', model: 'sonnet', timeoutMs: 10_000, maxWarmProcesses: 0 })),
    err => /empty response/i.test(err.message),
  );
});

test('stream: a missing binary reports the actionable "not found" message', async () => {
  const missing = path.join(TMP, 'definitely-not-here', 'claude');
  await assert.rejects(
    () => drain(ClaudeCliService.stream(missing, { prompt: 'hi', model: 'sonnet', timeoutMs: 5_000, maxWarmProcesses: 0 })),
    err => isClaudeCliError(err) && err.message.includes(CLAUDE_CLI_NOT_FOUND_MESSAGE),
  );
});

test('stream: an error AFTER partial output ends the stream instead of appending', async () => {
  // Appending an error onto a half-written answer is worse than stopping: the
  // user sees the partial answer, which is what the renderer already showed.
  const bin = makeFakeCli('late-error.js', `
(async () => {
  await readTurn();
  emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } } });
  await sleep(20);
  emit({ type: 'result', is_error: true, result: 'upstream blew up' });
  process.exit(1);
})();
`);
  const chunks = await drain(ClaudeCliService.stream(bin, {
    prompt: 'hi', model: 'sonnet', timeoutMs: 10_000, maxWarmProcesses: 0,
  }));
  assert.deepEqual(chunks, ['partial']);
});

test('stream: a pre-aborted signal throws before anything is spawned', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => drain(ClaudeCliService.stream('/nonexistent/claude', {
      prompt: 'hi', model: 'sonnet', timeoutMs: 10_000, signal: ac.signal, maxWarmProcesses: 0,
    })),
    err => /aborted/i.test(err.message),
  );
});

// =============================================================================
// 6. Cancellation actually kills the child
// =============================================================================

/** True while `pid` is alive. signal 0 is a permission/existence probe. */
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

test('abort: kills the in-flight child rather than orphaning it', async () => {
  // The fake writes its pid, streams one delta, then hangs forever. Barge-in
  // aborts mid-answer; the process must not survive it.
  const pidFile = path.join(TMP, 'abort-pid.txt');
  const bin = makeFakeCli('hangs.js', `
(async () => {
  await readTurn();
  require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'start' } } });
  setInterval(() => {}, 1000); // never exits on its own
})();
`);

  const ac = new AbortController();
  const chunks = [];
  const gen = ClaudeCliService.stream(bin, {
    prompt: 'hi', model: 'sonnet', timeoutMs: 30_000, signal: ac.signal, maxWarmProcesses: 0,
  });
  for await (const chunk of gen) {
    chunks.push(chunk);
    ac.abort();       // barge-in the moment the first token lands
  }
  assert.deepEqual(chunks, ['start'], 'partial output already shown must stand');

  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.ok(await waitForDeath(pid), `child ${pid} survived the abort — it is orphaned`);
});

test('abort: breaking out of the for-await loop also kills the child', async () => {
  // The consumer abandoning the generator is a real path (a superseded turn),
  // and it does NOT go through the AbortSignal — only the generator's finally.
  const pidFile = path.join(TMP, 'break-pid.txt');
  const bin = makeFakeCli('hangs2.js', `
(async () => {
  await readTurn();
  require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'a' } } });
  setInterval(() => {}, 1000);
})();
`);
  for await (const _chunk of ClaudeCliService.stream(bin, {
    prompt: 'hi', model: 'sonnet', timeoutMs: 30_000, maxWarmProcesses: 0,
  })) {
    break;
  }
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(await waitForDeath(pid), `child ${pid} survived an abandoned generator`);
});

test('idle timeout: kills a silent child and reports the timeout', async () => {
  const pidFile = path.join(TMP, 'timeout-pid.txt');
  // pid is written at module top, NOT after readTurn(): the timeout must be
  // allowed to fire before the fake has done anything, and the test still needs
  // a pid to assert the kill against.
  const bin = makeFakeCli('silent-hang.js', `
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
(async () => {
  await readTurn();
  setInterval(() => {}, 1000); // accepts the turn, then never answers
})();
`);
  // Comfortably above Node's own boot time so the assertion is about the idle
  // guard, not about how fast this machine starts a process.
  await assert.rejects(
    () => drain(ClaudeCliService.stream(bin, {
      prompt: 'hi', model: 'sonnet', timeoutMs: 1_200, maxWarmProcesses: 0,
    })),
    err => /timed out/i.test(err.message),
  );
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(await waitForDeath(pid), `child ${pid} survived the idle timeout`);
});

// =============================================================================
// 7. Binary-path resolution
// =============================================================================

test('getCandidatePaths: non-empty, absolute, and platform-appropriate', () => {
  const candidates = ClaudeCliService.getCandidatePaths();
  assert.ok(candidates.length > 0);
  for (const c of candidates) assert.ok(path.isAbsolute(c), `${c} must be absolute`);
  const bin = process.platform === 'win32' ? 'claude.exe' : 'claude';
  assert.ok(candidates.some(c => c.endsWith(bin) || c.endsWith('claude.cmd')));
});

test('autoDetectPath: returns null when claude is absent from PATH and every candidate', (t) => {
  // Empty PATH + a HOME with nothing in it means no candidate can resolve, so
  // this is the "user has not installed Claude Code" case.
  const realPath = process.env.PATH;
  const realHome = process.env.HOME;
  const realUserProfile = process.env.USERPROFILE;
  t.after(() => {
    process.env.PATH = realPath;
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realUserProfile;
  });
  const emptyHome = fs.mkdtempSync(path.join(TMP, 'home-'));
  process.env.PATH = '';
  process.env.HOME = emptyHome;
  process.env.USERPROFILE = emptyHome;

  // The absolute candidates (/usr/local/bin/claude etc.) are outside our
  // control, so only assert when the machine genuinely has none of them.
  const anyAbsoluteExists = ClaudeCliService.getCandidatePaths()
    .some(c => { try { return fs.statSync(c).isFile(); } catch { return false; } });
  if (anyAbsoluteExists) {
    t.diagnostic('a system-wide claude install exists; asserting the found-path shape instead');
    assert.equal(typeof ClaudeCliService.autoDetectPath(), 'string');
    return;
  }
  assert.equal(ClaudeCliService.autoDetectPath(), null);
  assert.equal(ClaudeCliService.binaryLooksAvailable('claude'), false,
    'a bare command that cannot be located must not seat the provider');
});

test('autoDetectPath: finds an executable claude on PATH', (t) => {
  const realPath = process.env.PATH;
  t.after(() => { process.env.PATH = realPath; });
  const dir = fs.mkdtempSync(path.join(TMP, 'pathdir-'));
  const bin = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.PATH = dir;
  assert.equal(ClaudeCliService.autoDetectPath(), bin);
  assert.equal(ClaudeCliService.binaryLooksAvailable('claude'), true);
});

test('autoDetectPath: a non-executable file on PATH is not a match', (t) => {
  if (process.platform === 'win32') { t.skip('POSIX exec bit only'); return; }
  const realPath = process.env.PATH;
  t.after(() => { process.env.PATH = realPath; });
  const dir = fs.mkdtempSync(path.join(TMP, 'noexec-'));
  fs.writeFileSync(path.join(dir, 'claude'), 'not executable\n', { mode: 0o644 });
  process.env.PATH = dir;
  assert.notEqual(ClaudeCliService.autoDetectPath(), path.join(dir, 'claude'));
});

test('resolvePath: an explicit path is used verbatim; a bare one is auto-detected', (t) => {
  const realPath = process.env.PATH;
  t.after(() => { process.env.PATH = realPath; });
  const dir = fs.mkdtempSync(path.join(TMP, 'resolve-'));
  const detected = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
  fs.writeFileSync(detected, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.PATH = dir;

  // Explicit wins — a typo must surface as a real error, not be "fixed" into
  // some other binary the user did not choose.
  assert.equal(ClaudeCliService.resolvePath('/opt/custom/claude'), '/opt/custom/claude');
  assert.equal(ClaudeCliService.resolvePath('claude'), detected);
  assert.equal(ClaudeCliService.resolvePath(''), detected, 'empty falls back to the default, then detection');
});

test('binaryLooksAvailable: an explicit path is trusted even when absent', () => {
  assert.equal(ClaudeCliService.binaryLooksAvailable('/no/such/dir/claude'), true,
    'dropping the provider silently would hide the real error from the user');
});

test('validateExecutable: succeeds on a working binary and reports its version', async () => {
  const bin = makeFakeCli('version-ok.js', `
if (process.argv.includes('--version')) { process.stdout.write('9.9.9 (Fake Claude Code)\\n'); process.exit(0); }
process.exit(1);
`);
  const result = await ClaudeCliService.validateExecutable(bin, 10_000);
  assert.equal(result.success, true, result.error);
  assert.equal(result.resolvedPath, bin);
  assert.match(result.version, /9\.9\.9/);
});

test('validateExecutable: a missing binary fails with the actionable message', async () => {
  const result = await ClaudeCliService.validateExecutable(path.join(TMP, 'nope', 'claude'), 5_000);
  assert.equal(result.success, false);
  assert.match(result.error, /not found/i);
});

test('validateExecutable: a bare command falls back to auto-detection and returns the path that worked', async (t) => {
  const realPath = process.env.PATH;
  t.after(() => { process.env.PATH = realPath; });
  const dir = fs.mkdtempSync(path.join(TMP, 'validate-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!${process.execPath}\nprocess.stdout.write('1.2.3\\n');\n`, { mode: 0o755 });
  // PATH holds only a directory the shell lookup cannot use for a bare spawn on
  // this platform? It can — so point PATH somewhere empty and rely on the
  // candidate/PATH scan inside autoDetectPath by putting `dir` back for it.
  process.env.PATH = dir;
  const result = await ClaudeCliService.validateExecutable('claude', 10_000);
  assert.equal(result.success, true, result.error);
  assert.ok(result.resolvedPath.endsWith('claude'));
});

// =============================================================================
// 8. Warm-process pool
// =============================================================================

test('prewarm: parks processes and disposeWarmPool reaps them', async () => {
  ClaudeCliService.disposeWarmPool();
  assert.equal(ClaudeCliService.warmPoolSize(), 0);

  const pidFile = path.join(TMP, 'warm-pids.txt');
  const bin = makeFakeCli('warm.js', `
require('fs').appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n');
(async () => {
  const turn = await readTurn();
  emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'warm:' + turn.message.content[0].text } } });
  emit({ type: 'result', is_error: false, result: 'x' });
  process.exit(0);
})();
`);
  fs.writeFileSync(pidFile, '');

  ClaudeCliService.prewarm({ enabled: true, path: bin, model: 'sonnet', fastModel: 'sonnet', timeoutMs: 10_000, maxWarmProcesses: 2 });
  assert.equal(ClaudeCliService.warmPoolSize(), 1, 'one per distinct model');

  // A parked process must answer a real request without being re-spawned.
  const text = await ClaudeCliService.run(bin, { prompt: 'Q1', model: 'sonnet', timeoutMs: 10_000, maxWarmProcesses: 0 });
  assert.equal(text, 'warm:Q1');
  const pids = fs.readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(pids.length, 1, 'the request reused the parked process instead of spawning a second');
  assert.equal(ClaudeCliService.warmPoolSize(), 0, 'maxWarmProcesses:0 on the call means no replacement');

  ClaudeCliService.disposeWarmPool();
  assert.equal(ClaudeCliService.warmPoolSize(), 0);
});

test('prewarm: a request refills the pool for the next one', async () => {
  ClaudeCliService.disposeWarmPool();
  const bin = makeFakeCli('warm-refill.js', `
(async () => {
  await readTurn();
  emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } } });
  emit({ type: 'result', is_error: false, result: 'ok' });
  process.exit(0);
})();
`);
  const text = await ClaudeCliService.run(bin, { prompt: 'hi', model: 'sonnet', timeoutMs: 10_000, maxWarmProcesses: 1 });
  assert.equal(text, 'ok');
  assert.equal(ClaudeCliService.warmPoolSize(), 1, 'the next request must find a warm process waiting');
  ClaudeCliService.disposeWarmPool();
  assert.equal(ClaudeCliService.warmPoolSize(), 0);
});

test('prewarm: disabled config and maxWarmProcesses:0 park nothing', () => {
  ClaudeCliService.disposeWarmPool();
  ClaudeCliService.prewarm({ enabled: false, path: 'claude', model: 'sonnet', fastModel: 'haiku', timeoutMs: 1000, maxWarmProcesses: 2 });
  assert.equal(ClaudeCliService.warmPoolSize(), 0);
  ClaudeCliService.prewarm({ enabled: true, path: 'claude', model: 'sonnet', fastModel: 'haiku', timeoutMs: 1000, maxWarmProcesses: 0 });
  assert.equal(ClaudeCliService.warmPoolSize(), 0);
});

test('prewarm: a bad binary path, then an immediate dispose, does not crash the process', async () => {
  // REGRESSION. A failed spawn emits 'error' asynchronously; disposing the pool
  // before that lands used to make kill() emit a second one, and with a spent
  // `once` listener the emitter had none left — an unhandled 'error' event,
  // which in the main process takes the whole app down. The bug presented as
  // the test runner dying mid-file with no failure reported.
  ClaudeCliService.disposeWarmPool();
  assert.doesNotThrow(() => ClaudeCliService.prewarm({
    enabled: true, path: path.join(TMP, 'no-such-dir', 'claude'),
    model: 'sonnet', fastModel: 'sonnet', timeoutMs: 1000, maxWarmProcesses: 2,
  }));
  ClaudeCliService.disposeWarmPool(); // synchronous, i.e. BEFORE the ENOENT lands
  // Give the async ENOENT (and any kill-induced second 'error') time to fire.
  await new Promise(r => setTimeout(r, 250));
  assert.equal(ClaudeCliService.warmPoolSize(), 0);
  // Reaching here at all is the assertion: an unhandled 'error' would have
  // terminated this process before now.
});

test.after(() => {
  ClaudeCliService.disposeWarmPool();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});
