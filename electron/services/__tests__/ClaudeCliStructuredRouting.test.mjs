// electron/services/__tests__/ClaudeCliStructuredRouting.test.mjs
//
// Auto Answer never reached claude-cli.
//
// Observed in a real build with `claude-cli` selected as the model:
//
//   [LLMHelper] Switched to Model: claude-cli
//   [LLMHelper] 🧠 Structured generation: trying OpenAI (gpt-5.4)...
//   [LLMHelper] ⚠️ ... failed: Model busy, try again
//   [LLMHelper] 🔄 rotation 3/3 after 2000ms backoff...
//   [AutoAnswer:simple] skipped: engine_busy_or_cooling
//
// generateContentStructured is what Auto Answer's judge falls back to, and it
// had no term for claude-cli at all. So the user's explicit model choice was
// ignored, and — worse — when the substituted provider was rate-limited the
// ladder burned all three rotations plus backoff, which is long enough for
// autoAnswerGate to declare the engine busy and drop the answer entirely.
//
// The fix must NOT be "seat claude-cli in the ladder". A process spawn per call
// is too expensive to put ahead of Gemini flash-lite for a user who merely has
// the CLI installed — the identical latency argument that keeps Codex CLI down
// at Priority 5. Only an EXPLICIT selection may lead. Both halves of that are
// pinned below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = (p) => path.join(__dirname, '../../../dist-electron/electron', p);

// `electron` is an esbuild external and SettingsManager touches `app` at module
// scope; without this shim the module graph fails to load.
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: {
    app: { isReady: () => true, getPath: () => os.tmpdir(), getVersion: () => '0.0.0-test' },
    safeStorage: { isEncryptionAvailable: () => false },
  },
};

const { LLMHelper } = require(dist('LLMHelper.js'));

/**
 * A helper whose every provider is a recording stub.
 *
 * `attempts` is the ORDER the ladder tried things in — the only thing these
 * tests care about. Each stub throws so the ladder keeps walking, except the
 * one named by `succeedWith`.
 */
function helper({ currentModelId, claudeCliAvailable = true, succeedWith = null } = {}) {
  const h = Object.create(LLMHelper.prototype);
  const attempts = [];
  const answer = (name) => {
    attempts.push(name);
    if (succeedWith === name) return Promise.resolve(`${name}-answer`);
    return Promise.reject(new Error(`${name} unavailable`));
  };

  h.currentModelId = currentModelId;
  h.claudeCliConfig = {
    enabled: true, path: '/fake/claude', model: 'sonnet', fastModel: 'haiku',
    timeoutMs: 1000, maxWarmProcesses: 0, sessionMode: 'isolated',
  };
  h.codexCliConfig = { path: '/fake/codex', model: 'gpt-5.4', fastModel: 'f', timeoutMs: 1000 };
  h.isProviderDisabled = () => false;
  h.isClaudeCliAvailable = () => claudeCliAvailable;
  h.isCodexAvailable = () => false;
  h.useOllama = false;
  h.ensureOllamaModelSelected = async () => false;
  h.customProvider = null;
  h.activeCurlProvider = null;
  h.nativelyKey = null;
  h.rateLimiters = { gemini: { acquire: async () => {} } };
  h.withRetry = (fn) => fn();
  h.delay = async () => {};   // skip the rotation backoff

  h.generateWithClaudeCli = () => answer('claude-cli');
  h.generateWithOpenai = () => answer('openai');
  h.generateWithClaude = () => answer('claude-api');
  h._openaiClient = {};
  h._claudeClient = {};
  h._client = null;           // no Gemini: keeps the expected order short

  return { h, attempts };
}

const run = (h, message = 'extract this') =>
  LLMHelper.prototype.generateContentStructured.call(h, message);

test('an EXPLICITLY selected claude-cli leads the structured ladder', async () => {
  const { h, attempts } = helper({ currentModelId: 'claude-cli', succeedWith: 'claude-cli' });
  const out = await run(h);
  assert.equal(out, 'claude-cli-answer');
  assert.deepEqual(attempts, ['claude-cli'],
    'the selected model must answer FIRST — nothing else should have been tried');
});

test('the `claude-cli:<model>` form is honoured too', async () => {
  const { h, attempts } = helper({ currentModelId: 'claude-cli:opus', succeedWith: 'claude-cli' });
  await run(h);
  assert.equal(attempts[0], 'claude-cli');
});

test('when it fails, the ladder still falls through to the cloud providers', async () => {
  // The selection leads; it does not become a single point of failure.
  const { h, attempts } = helper({ currentModelId: 'claude-cli', succeedWith: 'openai' });
  const out = await run(h);
  assert.equal(out, 'openai-answer');
  assert.deepEqual(attempts.slice(0, 2), ['claude-cli', 'openai']);
});

test('MERELY HAVING the CLI installed does not seat it ahead of the cloud tiers', async () => {
  // The property the fix had to preserve. claude-cli is available, but the user
  // picked an OpenAI model, so a process spawn must not get in front of a
  // document ingest.
  const { h, attempts } = helper({ currentModelId: 'gpt-5.4', succeedWith: 'openai' });
  const out = await run(h);
  assert.equal(out, 'openai-answer');
  assert.deepEqual(attempts, ['openai']);
  assert.ok(!attempts.includes('claude-cli'),
    'an unselected claude-cli must never be tried on the structured path');
});

test('an unavailable claude-cli is skipped even when selected', async () => {
  // Selected but the binary cannot be found: seating it would cost one
  // guaranteed-failing attempt per rotation.
  const { h, attempts } = helper({
    currentModelId: 'claude-cli', claudeCliAvailable: false, succeedWith: 'openai',
  });
  await run(h);
  assert.deepEqual(attempts, ['openai']);
});

test('a permanent Claude Code failure does not mark the Anthropic API dead too', async () => {
  // permanentFailureKeyFor() matches on the provider's display name, and
  // "Claude Code (sonnet)" starts with "Claude". Folding the two onto one key
  // would let a CLI auth failure disable the user's separately-credentialed
  // Anthropic API key for the rest of the call.
  const attempts = [];
  const { h } = helper({ currentModelId: 'claude-cli' });
  h.generateWithClaudeCli = () => {
    attempts.push('claude-cli');
    // Shaped like a permanent auth failure so isPermanentKeyError() trips.
    const err = new Error('401 Unauthorized: invalid x-api-key');
    err.status = 401;
    return Promise.reject(err);
  };
  h.generateWithClaude = () => { attempts.push('claude-api'); return Promise.resolve('claude-api-answer'); };
  h.generateWithOpenai = () => { attempts.push('openai'); return Promise.reject(new Error('nope')); };

  const out = await run(h);
  assert.equal(out, 'claude-api-answer');
  assert.ok(attempts.includes('claude-api'),
    'the Anthropic API must still be tried after a Claude Code auth failure — separate credentials, separate providers');
});
