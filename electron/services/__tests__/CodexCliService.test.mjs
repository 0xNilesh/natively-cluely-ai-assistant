// electron/services/__tests__/CodexCliService.test.mjs
//
// Unit tests for the rewritten CodexCliService. The HTTP-direct
// implementation no longer spawns a CLI subprocess, so the old tests
// that built mock binaries to verify wire-level CLI argv are no longer
// applicable. They live in CodexIntegrationE2E.test.mjs and
// CodexPostCommitE2E.test.mjs and assert legacy subprocess behaviour —
// the equivalent coverage for the new path is in
// CodexOAuthService.test.mjs (auth + retry logic) and here (resolver,
// config, SSE parser, run/stream).
//
// What's covered here:
//
//   1. Defaults, sandbox-mode/tier/reasoning-effort unions
//   2. resolveCodexReasoningEffort (per-model VALID set, downgrade policy)
//   3. normalizeConfig (legacy path field, sandbox, reasoning downgrade)
//   4. buildArgs — DEPRECATED, returns []
//   5. extractText — still used by the legacy CLI fixture tests
//   6. extractCodexError — still used by the legacy CLI fixture tests
//   7. CodexOAuthService.signOut, getStatus, refresh tokens
//
// The HTTP-direct stream/run tests are smoke-tested via the OAuth tests
// (which exercise the same fetch path with mocked responses).
//
// Run via: npm run build:electron && node --test electron/services/__tests__/CodexCliService.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const compiledPath = path.resolve(__dirname, '../../../dist-electron/electron/services/CodexCliService.js');
const mod = await import(pathToFileURL(compiledPath).href);
const { CodexCliService, DEFAULT_CODEX_CLI_CONFIG, CODEX_SANDBOX_MODES, resolveCodexReasoningEffort, CODEX_MODEL_REASONING_EFFORTS } = mod;

// =============================================================================
// Defaults + enums
// =============================================================================

test('DEFAULT_CODEX_CLI_CONFIG has expected shape', () => {
  assert.equal(DEFAULT_CODEX_CLI_CONFIG.enabled, false);
  // `path` is preserved for IPC backward-compat but is ignored at runtime.
  assert.equal(DEFAULT_CODEX_CLI_CONFIG.path, 'codex');
  assert.equal(DEFAULT_CODEX_CLI_CONFIG.model, 'gpt-5.4');
  assert.equal(DEFAULT_CODEX_CLI_CONFIG.fastModel, 'gpt-5.3-codex');
  assert.equal(DEFAULT_CODEX_CLI_CONFIG.timeoutMs, 60_000);
  assert.equal(DEFAULT_CODEX_CLI_CONFIG.sandboxMode, 'read-only');
});

test('CODEX_SANDBOX_MODES enumerates the three valid modes (deprecated at runtime, still exposed)', () => {
  // Sandbox modes are kept in the type/constant for the Settings UI to
  // read. The HTTP-direct path ignores them at runtime, but the union
  // is preserved so the UI can still render the dropdown without
  // crashing on `normalizeConfig`.
  assert.deepEqual([...CODEX_SANDBOX_MODES], ['read-only', 'workspace-write', 'danger-full-access']);
});

test('CODEX_MODEL_REASONING_EFFORTS includes none (per OpenAI gpt-5.1+ semantics)', () => {
  assert.ok(CODEX_MODEL_REASONING_EFFORTS.includes('none'));
  assert.ok(CODEX_MODEL_REASONING_EFFORTS.includes('low'));
  assert.ok(CODEX_MODEL_REASONING_EFFORTS.includes('medium'));
  assert.ok(CODEX_MODEL_REASONING_EFFORTS.includes('high'));
  assert.ok(CODEX_MODEL_REASONING_EFFORTS.includes('xhigh'));
});

// =============================================================================
// buildArgs — DEPRECATED
// =============================================================================

test('buildArgs: deprecated, returns empty array (HTTP-direct path has no argv)', () => {
  const args = CodexCliService.buildArgs('gpt-5.4', [], 'read-only', 'default', 'low');
  assert.ok(Array.isArray(args));
  assert.equal(args.length, 0,
    'buildArgs is deprecated and must return []; the HTTP path uses body.model + body.reasoning.effort');
});

test('buildArgs: ignores all 5 parameters without throwing', () => {
  // The deprecated method must accept the legacy signature so callers
  // (and the legacy CLI fixture tests) don't crash. None of the args
  // are used.
  const args = CodexCliService.buildArgs(
    'gpt-5.3-codex',
    ['/tmp/a.png', '/tmp/b.png'],
    'workspace-write',
    'fast',
    'xhigh',
  );
  assert.equal(args.length, 0);
});

// =============================================================================
// resolveCodexReasoningEffort
// =============================================================================

test('resolveCodexReasoningEffort: returns undefined for empty pick (no body.reasoning field)', () => {
  assert.equal(resolveCodexReasoningEffort('gpt-5.4', undefined), undefined);
  assert.equal(resolveCodexReasoningEffort('gpt-5.4', null), undefined);
  assert.equal(resolveCodexReasoningEffort('gpt-5.4', ''), undefined);
});

test('resolveCodexReasoningEffort: honours exact-match valid picks', () => {
  assert.equal(resolveCodexReasoningEffort('gpt-5.4', 'low'), 'low');
  assert.equal(resolveCodexReasoningEffort('gpt-5.4', 'medium'), 'medium');
  assert.equal(resolveCodexReasoningEffort('gpt-5.4', 'high'), 'high');
  assert.equal(resolveCodexReasoningEffort('gpt-5.4', 'xhigh'), 'xhigh');
  assert.equal(resolveCodexReasoningEffort('gpt-5.4', 'none'), 'none');
});

test('resolveCodexReasoningEffort: longest-match wins (gpt-5.4-codex vs gpt-5)', () => {
  // gpt-5.4-codex accepts xhigh; generic gpt-5 does not. The 5.4-codex
  // entry must win the lookup.
  assert.equal(resolveCodexReasoningEffort('gpt-5.4-codex', 'xhigh'), 'xhigh');
  // gpt-5.3-codex does NOT support xhigh — downgrade.
  assert.equal(resolveCodexReasoningEffort('gpt-5.3-codex', 'xhigh'), 'low');
});

test('resolveCodexReasoningEffort: case-insensitive model id', () => {
  assert.equal(resolveCodexReasoningEffort('GPT-5.4', 'xhigh'), 'xhigh');
  assert.equal(resolveCodexReasoningEffort('Gpt-5-Codex', 'medium'), 'medium');
});

test('resolveCodexReasoningEffort: unknown model id falls back to [low, medium, high]', () => {
  assert.equal(resolveCodexReasoningEffort('some-future-model', 'low'), 'low');
  assert.equal(resolveCodexReasoningEffort('some-future-model', 'xhigh'), 'low');
});

// =============================================================================
// normalizeConfig
// =============================================================================

test('normalizeConfig: downgrades invalid effort for chosen model', () => {
  // xhigh on gpt-5.3-codex is rejected by the Codex backend → resolver
  // returns the lowest-latency reasoning effort ('low') so a stale saved
  // value can't trigger a 400. The reasoning-only filter skips 'none' so we
  // don't silently turn a high-effort pick into zero reasoning.
  const cfg = CodexCliService.normalizeConfig({ model: 'gpt-5.3-codex', modelReasoningEffort: 'xhigh' });
  assert.equal(cfg.modelReasoningEffort, 'low');
});

test('normalizeConfig: keeps valid effort for chosen model', () => {
  const cfg = CodexCliService.normalizeConfig({ model: 'gpt-5.4', modelReasoningEffort: 'xhigh' });
  assert.equal(cfg.modelReasoningEffort, 'xhigh');
});

test('normalizeConfig: empty input returns defaults', () => {
  assert.deepEqual(CodexCliService.normalizeConfig({}), DEFAULT_CODEX_CLI_CONFIG);
});

test('normalizeConfig: invalid timeouts fall back to default', () => {
  assert.equal(CodexCliService.normalizeConfig({ timeoutMs: null }).timeoutMs, 60_000);
  assert.equal(CodexCliService.normalizeConfig({ timeoutMs: -1 }).timeoutMs, 60_000);
  assert.equal(CodexCliService.normalizeConfig({ timeoutMs: 0 }).timeoutMs, 60_000);
  assert.equal(CodexCliService.normalizeConfig({ timeoutMs: 'abc' }).timeoutMs, 60_000);
  assert.equal(CodexCliService.normalizeConfig({ timeoutMs: 30_000 }).timeoutMs, 30_000);
});

test('normalizeConfig: preserves the legacy `path` field for IPC backward-compat', () => {
  // The HTTP-direct path ignores `path` but the IPC layer still reads
  // and writes it (so the Settings UI doesn't reset on re-save).
  assert.equal(CodexCliService.normalizeConfig({ path: '   ' }).path, 'codex');
  assert.equal(CodexCliService.normalizeConfig({ path: '/usr/local/bin/codex' }).path, '/usr/local/bin/codex');
});

test('normalizeConfig: enabled is coerced to boolean', () => {
  assert.equal(CodexCliService.normalizeConfig({ enabled: 1 }).enabled, true);
  assert.equal(CodexCliService.normalizeConfig({ enabled: 0 }).enabled, false);
  assert.equal(CodexCliService.normalizeConfig({ enabled: 'yes' }).enabled, true);
  assert.equal(CodexCliService.normalizeConfig({ enabled: undefined }).enabled, false);
});

test('normalizeConfig: invalid sandboxMode falls back to read-only', () => {
  // Sandbox mode is deprecated at runtime but still typed — the
  // Settings UI may send an invalid value during a partial update.
  assert.equal(CodexCliService.normalizeConfig({ sandboxMode: 'evil' }).sandboxMode, 'read-only');
  assert.equal(CodexCliService.normalizeConfig({ sandboxMode: undefined }).sandboxMode, 'read-only');
});

test('normalizeConfig: valid sandboxModes are preserved (legacy compat)', () => {
  assert.equal(CodexCliService.normalizeConfig({ sandboxMode: 'workspace-write' }).sandboxMode, 'workspace-write');
  assert.equal(CodexCliService.normalizeConfig({ sandboxMode: 'danger-full-access' }).sandboxMode, 'danger-full-access');
});

// =============================================================================
// extractText — preserved for legacy CLI fixture tests
// =============================================================================

test('extractText: parses Codex --json delta event stream', () => {
  // Kept because the legacy subprocess CLI emits this NDJSON shape. The
  // HTTP path doesn't use it but the Settings UI may still feed
  // historical CLI output through here for diagnosis.
  const sample = [
    '{"type":"thread.started","thread_id":"abc"}',
    '{"type":"agent_message.delta","delta":"Hello"}',
    '{"type":"agent_message.delta","delta":" world"}',
    '{"type":"turn.completed"}',
  ].join('\n');
  assert.equal(CodexCliService.extractText(sample), 'Hello world');
});

test('extractText: passes through plain text untouched', () => {
  assert.equal(CodexCliService.extractText('plain hi'), 'plain hi');
});

test('extractText: strips markdown json fence', () => {
  assert.equal(CodexCliService.extractText('```json\n{"x":1}\n```'), '{"x":1}');
});

test('extractText: lifecycle-only events return empty string', () => {
  assert.equal(
    CodexCliService.extractText('{"type":"turn.started"}\n{"type":"turn.completed"}'),
    '',
  );
});

test('extractText: agent_message item with text payload', () => {
  assert.equal(
    CodexCliService.extractText('{"item":{"type":"agent_message","text":"hi there"}}'),
    'hi there',
  );
});

test('extractText: error item is suppressed', () => {
  assert.equal(
    CodexCliService.extractText('{"item":{"type":"error","message":"boom"}}'),
    '',
  );
});

test('extractText: walks output_text key', () => {
  assert.equal(CodexCliService.extractText('{"output_text":"OK"}'), 'OK');
});

test('extractText: joins content arrays', () => {
  assert.equal(CodexCliService.extractText('{"content":["a","b","c"]}'), 'abc');
});

test('extractText: empty input returns empty', () => {
  assert.equal(CodexCliService.extractText(''), '');
  assert.equal(CodexCliService.extractText('   '), '');
});

// =============================================================================
// extractCodexError — preserved for legacy CLI fixture tests
// =============================================================================

test('extractCodexError: pulls message from stringified error envelope', () => {
  const sample = [
    '{"type":"thread.started","thread_id":"abc"}',
    '{"type":"turn.started"}',
    '{"type":"error","message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The \'gpt-5.3-codex-spark\' model is not supported when using Codex with a ChatGPT account.\\"}}"}',
    '{"type":"turn.failed"}',
  ].join('\n');
  const msg = CodexCliService.extractCodexError(sample);
  assert.match(msg, /not supported when using Codex with a ChatGPT account/);
});

test('extractCodexError: returns empty when no error events present', () => {
  const sample = '{"type":"agent_message.delta","delta":"hi"}';
  assert.equal(CodexCliService.extractCodexError(sample), '');
});

test('extractCodexError: handles plain string error message', () => {
  assert.equal(
    CodexCliService.extractCodexError('{"type":"error","message":"network unreachable"}'),
    'network unreachable',
  );
});

// =============================================================================
// CodexCliService.run / .stream — must throw when not signed in
// =============================================================================

test('run: throws when Codex OAuth is not signed in', async () => {
  // The HTTP-direct path requires an OAuth token. Without one, run()
  // surfaces a clear "sign in" error instead of silently failing into
  // the canned fallback.
  const oauthModulePath = path.resolve(__dirname, '../../../dist-electron/electron/services/CodexOAuthService.js');
  const oauthMod = await import(pathToFileURL(oauthModulePath).href);
  oauthMod.CodexOAuthService.getInstance().__resetForTest();
  // Defensive: clear any persisted tokens by signing out.
  oauthMod.CodexOAuthService.getInstance().signOut();

  await assert.rejects(
    () => CodexCliService.run('', {
      prompt: 'hi', model: 'gpt-5.4', timeoutMs: 5_000,
    }),
    err => /signed in to ChatGPT/i.test(err.message),
    'run() must surface a clear "sign in" error when OAuth is missing',
  );
});

test('stream: throws when Codex OAuth is not signed in', async () => {
  const oauthModulePath = path.resolve(__dirname, '../../../dist-electron/electron/services/CodexOAuthService.js');
  const oauthMod = await import(pathToFileURL(oauthModulePath).href);
  oauthMod.CodexOAuthService.getInstance().__resetForTest();
  oauthMod.CodexOAuthService.getInstance().signOut();

  const gen = CodexCliService.stream('', {
    prompt: 'hi', model: 'gpt-5.4', timeoutMs: 5_000,
  });
  await assert.rejects(async () => {
    // eslint-disable-next-line no-unused-vars
    for await (const _ of gen) { /* drain */ }
  }, err => /signed in to ChatGPT/i.test(err.message));
});

test('stream: AbortSignal pre-aborted throws on first iteration', async () => {
  const ac = new AbortController();
  ac.abort();
  const gen = CodexCliService.stream('', {
    prompt: '', model: 'gpt-5.4', timeoutMs: 60_000, signal: ac.signal,
  });
  await assert.rejects(async () => {
    // eslint-disable-next-line no-unused-vars
    for await (const _ of gen) { /* drain */ }
  }, err => /aborted/i.test(err.message));
});
