// Issue #272 — verify LLMHelper gates the live-negotiation coaching short-circuit
// by the active ModesManager template. The premium negotiation tracker fires on
// any interviewer utterance regardless of active mode, so without this gate a
// technical-interview / team-meet / lecture user can have their "what to answer"
// stream replaced by a salary-coaching card.
//
// We exercise the compiled JS in dist-electron so the test runs against the
// same code path the Electron main process loads. The setup:
//   1. Stub the `electron` module (LLMHelper -> ModelVersionManager depends on
//      `app.getPath('userData')` during construction).
//   2. Stub knowledgeOrchestrator so isKnowledgeMode() returns true and
//      processQuestion() returns a payload with liveNegotiationResponse.
//   3. Patch ModesManager.getInstance().getActiveMode to return a specific
//      template (same singleton-patching pattern used by ModesManager.test.mjs).
//   4. Drive both streamChat and chatWithGemini and observe whether the
//      negotiation coaching handler was called.
//
// Expected:
//   - For modes where coaching is contextually appropriate
//     (looking-for-work, sales, recruiting, general, no-active-mode):
//     handler IS invoked AND the function short-circuits (no provider call).
//   - For modes where coaching would clobber the answer
//     (technical-interview, team-meet, lecture):
//     handler is NOT invoked. The function falls through to normal LLM
//     dispatch which, with no providers configured, will throw — we catch
//     that and assert only on the handler-invocation flag.

import { test, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import Module from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

// The default `npm run build:electron` produces a single esbuild bundle per
// entry point, which inlines ModesManager into LLMHelper. That makes the
// internal singleton unreachable from outside, so we cannot patch
// getActiveMode to drive the gate. To keep the test hermetic we compile a
// per-file CJS tree just for this test where LLMHelper still resolves
// ModesManager via Node's CJS cache.
const distDir = (() => {
  const bundledLLMHelper = path.resolve(repoRoot, 'dist-electron/electron/LLMHelper.js');
  const isBundled = fs.existsSync(bundledLLMHelper) &&
    fs.readFileSync(bundledLLMHelper, 'utf8').includes('init_ModesManager');
  if (!isBundled) return path.resolve(repoRoot, 'dist-electron');

  const target = path.resolve(repoRoot, 'dist-electron-test-isolated');
  // Only re-emit when missing or when our two source files are newer than the
  // compiled outputs — keep the test cheap on the happy path.
  const llmTsMtime = fs.statSync(path.resolve(repoRoot, 'electron/LLMHelper.ts')).mtimeMs;
  const modesTsMtime = fs.statSync(path.resolve(repoRoot, 'electron/services/ModesManager.ts')).mtimeMs;
  const compiledLLM = path.join(target, 'electron/LLMHelper.js');
  const compiledModes = path.join(target, 'electron/services/ModesManager.js');
  const stale = !fs.existsSync(compiledLLM) || !fs.existsSync(compiledModes) ||
    fs.statSync(compiledLLM).mtimeMs < llmTsMtime ||
    fs.statSync(compiledModes).mtimeMs < modesTsMtime;
  if (stale) {
    // tsc exits non-zero on pre-existing type errors in unrelated test files,
    // but still emits JS for files that compile cleanly. We swallow the
    // non-zero status and verify post-hoc that LLMHelper.js was produced.
    try {
      execSync(`node node_modules/.bin/tsc -p electron/tsconfig.json --outDir ${target}`, {
        cwd: repoRoot,
        stdio: 'pipe',
      });
    } catch (_tscErr) {
      // expected — tsc returns 1 on type errors elsewhere
    }
  }
  if (!fs.existsSync(path.join(target, 'electron/LLMHelper.js'))) {
    throw new Error('tsc emission failed — LLMHelper.js missing from isolated tree');
  }
  return target;
})();

const llmHelperPath = path.resolve(distDir, 'electron/LLMHelper.js');
const modesPath = path.resolve(distDir, 'electron/services/ModesManager.js');

const cjsRequire = createRequire(import.meta.url);

// --- Electron stub ----------------------------------------------------------
// LLMHelper transitively constructs ModelVersionManager which calls
// `electron.app.getPath('userData')`. We need a tmp dir that exists so the
// state-persistence loader doesn't ENOENT.
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'llmhelper-gate-test-'));
const electronStub = {
  app: {
    isReady: () => true,
    getPath: name => (name === 'userData' ? tmpUserData : os.tmpdir()),
    getName: () => 'natively-test',
    getVersion: () => '0.0.0-test',
  },
  shell: { openPath: async () => '' },
  ipcMain: { on: () => {}, handle: () => {}, removeAllListeners: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
};

const electronStubModule = new Module('electron');
electronStubModule.exports = electronStub;
electronStubModule.loaded = true;
cjsRequire.cache.electron = electronStubModule;
try { cjsRequire.cache[cjsRequire.resolve('electron')] = electronStubModule; } catch { /* no on-disk electron in this env */ }

// Same singleton, both here and inside compiled LLMHelper's
// `require('./services/ModesManager')`, because Node's CJS cache keys by
// resolved path.
const { ModesManager } = cjsRequire(modesPath);
const { LLMHelper } = cjsRequire(llmHelperPath);

const PAYLOAD_SENTINEL = { phase: 'gate-test', amount: '$0', tone: 'firm' };

function installActiveMode(templateType) {
  const manager = ModesManager.getInstance();
  manager.getActiveMode = () => {
    if (!templateType) return null;
    return {
      id: `${templateType}-mode`,
      name: templateType,
      templateType,
      customContext: '',
      isActive: true,
      createdAt: '2026-05-26T00:00:00.000Z',
    };
  };
  // Neutralize mode-context injection that runs AFTER the gate so the
  // streaming path doesn't try to retrieve real reference files.
  manager.getActiveModeSystemPromptSuffix = () => '';
  manager.buildRetrievedActiveModeContextBlock = () => '';
  manager.buildActiveModeContextBlock = () => '';
}

function buildHelper() {
  // No API keys, no Ollama -> no provider client branches taken. The gate is
  // checked BEFORE any provider dispatch, so the early-return / fall-through
  // behavior is observable without making a network call.
  return new LLMHelper(undefined, false);
}

function buildOrchestratorStub(opts = {}) {
  const feedCalls = [];
  return {
    isKnowledgeMode: () => true,
    feedForDepthScoring: msg => feedCalls.push(msg),
    feedInterviewerUtterance: () => {},
    processQuestion: async () => ({
      liveNegotiationResponse: opts.payload ?? PAYLOAD_SENTINEL,
    }),
    feedCalls,
  };
}

async function drainStream(generator) {
  // We don't care about chunks — only whether processQuestion's payload was
  // forwarded to the negotiation handler before/instead of provider dispatch.
  // Provider dispatch with no clients will throw; swallow so the assertion
  // about handler invocation is what fails the test, not unconfigured deps.
  const chunks = [];
  try {
    for await (const chunk of generator) chunks.push(chunk);
  } catch (_err) {
    // expected when the gate blocks and we fall through to provider dispatch
  }
  return chunks;
}

async function callChat(helper, message) {
  try {
    return await helper.chatWithGemini(message, undefined, undefined, true);
  } catch (_err) {
    return null;
  }
}

beforeEach(() => {
  installActiveMode(null);
});

test('streamChat: handler IS invoked when active mode allows coaching (looking-for-work)', async () => {
  const helper = buildHelper();
  helper.setKnowledgeOrchestrator(buildOrchestratorStub());
  const captured = [];
  helper.setNegotiationCoachingHandler(payload => captured.push(payload));

  installActiveMode('looking-for-work');
  const chunks = await drainStream(helper.streamChat('What salary should I ask for?'));

  assert.equal(captured.length, 1, 'handler must fire once for looking-for-work');
  assert.deepEqual(captured[0], PAYLOAD_SENTINEL);
  // Early-return — no normal stream tokens.
  assert.deepEqual(chunks, []);
});

test('streamChat: handler IS invoked when no active mode is set (default-open)', async () => {
  const helper = buildHelper();
  helper.setKnowledgeOrchestrator(buildOrchestratorStub());
  const captured = [];
  helper.setNegotiationCoachingHandler(payload => captured.push(payload));

  installActiveMode(null);
  const chunks = await drainStream(helper.streamChat('Any salary thoughts?'));

  assert.equal(captured.length, 1, 'handler must fire when no mode is active');
  assert.deepEqual(captured[0], PAYLOAD_SENTINEL);
  assert.deepEqual(chunks, []);
});

test('streamChat: handler is NOT invoked when active mode is technical-interview (issue #272)', async () => {
  const helper = buildHelper();
  helper.setKnowledgeOrchestrator(buildOrchestratorStub());
  const captured = [];
  helper.setNegotiationCoachingHandler(payload => captured.push(payload));

  installActiveMode('technical-interview');
  await drainStream(helper.streamChat('Walk me through your last system design.'));

  assert.equal(
    captured.length,
    0,
    'technical-interview must NEVER receive a salary card mid-answer (issue #272)',
  );
});

test('streamChat: handler is NOT invoked for team-meet or lecture either', async () => {
  for (const templateType of ['team-meet', 'lecture']) {
    const helper = buildHelper();
    helper.setKnowledgeOrchestrator(buildOrchestratorStub());
    const captured = [];
    helper.setNegotiationCoachingHandler(payload => captured.push(payload));

    installActiveMode(templateType);
    await drainStream(helper.streamChat('any input?'));

    assert.equal(
      captured.length,
      0,
      `${templateType} must NOT trigger a salary-coaching card (issue #272)`,
    );
  }
});

test('streamChat: handler IS invoked for the remaining coaching-eligible modes', async () => {
  for (const templateType of ['sales', 'recruiting', 'general']) {
    const helper = buildHelper();
    helper.setKnowledgeOrchestrator(buildOrchestratorStub());
    const captured = [];
    helper.setNegotiationCoachingHandler(payload => captured.push(payload));

    installActiveMode(templateType);
    await drainStream(helper.streamChat('compensation discussion'));

    assert.equal(
      captured.length,
      1,
      `${templateType} should still allow coaching short-circuit`,
    );
    assert.deepEqual(captured[0], PAYLOAD_SENTINEL);
  }
});

// Symmetry check for the non-streaming path — same gate at LLMHelper.ts:~1354.
// Cheap to exercise: chatWithGemini's gate is structurally identical.
test('chatWithGemini: handler IS invoked when active mode allows coaching', async () => {
  const helper = buildHelper();
  helper.setKnowledgeOrchestrator(buildOrchestratorStub());
  const captured = [];
  helper.setNegotiationCoachingHandler(payload => captured.push(payload));

  installActiveMode('looking-for-work');
  const result = await callChat(helper, 'What salary should I ask for?');

  assert.equal(captured.length, 1, 'chatWithGemini must fire handler for looking-for-work');
  assert.deepEqual(captured[0], PAYLOAD_SENTINEL);
  // chatWithGemini returns '' on the coaching short-circuit branch.
  assert.equal(result, '');
});

test('chatWithGemini: handler is NOT invoked when active mode is technical-interview', async () => {
  const helper = buildHelper();
  helper.setKnowledgeOrchestrator(buildOrchestratorStub());
  const captured = [];
  helper.setNegotiationCoachingHandler(payload => captured.push(payload));

  installActiveMode('technical-interview');
  await callChat(helper, 'Explain consistent hashing.');

  assert.equal(
    captured.length,
    0,
    'technical-interview must block the coaching short-circuit on the non-streaming path too (issue #272)',
  );
});
