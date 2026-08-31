// Regression tests for the per-channel (mic / system) local-model selection.
//
// Symptom (2026-08-31): in Settings → Speech Engine the MIC AUDIO MODEL
// dropdown could be changed freely; the SYSTEM AUDIO MODEL dropdown accepted
// no input at all. Reproduced with both Moonshine models installed, with only
// Moonshine Tiny installed, and with a third model added — mic always worked,
// system never did. The only way to change the setting was to edit
// settings.json with the app closed.
//
// Root cause was PURELY presentational and lived in the renderer: the split
// column that holds the system select is a motion.div animating its width, so
// it carried `overflow: hidden`. `.aip-select-list` — the menu — is absolutely
// positioned at `top: 100%` of `.aip-select`, which is a DESCENDANT of that
// column, and CSS clips any descendant whose containing block is a descendant
// of the clipping box. So the menu rendered, correctly wired to setSystemModel,
// entirely outside the clip rect: invisible and unhittable. The mic select has
// no clipping ancestor, hence the asymmetry.
//
// These tests cover the three layers the bug touched:
//   1. renderer contract — the column must not clip unconditionally, and the
//      system select must report its open state so the column can un-clip.
//   2. IPC setter behaviour — the real `local-whisper-set-channel-config`
//      handler body is EXECUTED against a fake settings store: a system pick
//      persists, mic and system hold different ids at the same time, unknown
//      ids are refused, and a degraded store is reported rather than faked.
//   3. startup validation — the real main.ts preload gate is EXECUTED: a valid
//      in-catalog per-channel id must survive untouched; only junk is reset to
//      the fallback.
//
// (2) and (3) run the SHIPPED source rather than a paraphrase of it: the block
// is extracted from the .ts file, has its handful of type-only constructs
// erased, and is evaluated with stubs. Both files are far too large to import
// in a unit test, which is why the neighbouring suites assert on their source
// text; executing the extracted block is the same technique with the assertion
// moved from "the code says this" to "the code does this".

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../../..');

const FALLBACK = 'Xenova/whisper-tiny.en';

function readSrc(relPath) {
  return fs.readFileSync(path.resolve(root, relPath), 'utf8');
}

const ipcSrc = readSrc('electron/ipcHandlers.ts');
const mainSrc = readSrc('electron/main.ts');
const panelSrc = readSrc('src/components/LocalWhisperModelPanel.tsx');

// The real catalog, read off MODEL_CATALOG rather than hardcoded, so these
// tests keep testing the ids the app actually ships. modelManager.ts cannot be
// imported directly here (it pulls in `electron` for app.getPath), and the
// compiled dist is not guaranteed to exist for a plain `node --test` run.
const MODEL_CATALOG_IDS = (() => {
  const src = readSrc('electron/audio/whisper/modelManager.ts');
  const start = src.indexOf('export const MODEL_CATALOG:');
  const end = src.indexOf('export const MODEL_CATALOG_IDS');
  assert.ok(start > -1 && end > start, 'MODEL_CATALOG must be locatable in modelManager.ts');
  const ids = [...src.slice(start, end).matchAll(/\bid:\s*'([^']+)'/g)].map((m) => m[1]);
  return new Set(ids);
})();

describe('catalog fixture', () => {
  test('the parsed catalog is the real one', () => {
    assert.ok(MODEL_CATALOG_IDS.size >= 10, `expected a full catalog, got ${MODEL_CATALOG_IDS.size} ids`);
    assert.ok(MODEL_CATALOG_IDS.has(FALLBACK), 'the safe fallback must be in the catalog');
    // The two models the bug was reproduced with.
    assert.ok(MODEL_CATALOG_IDS.has('onnx-community/moonshine-tiny-ONNX'));
    assert.ok(MODEL_CATALOG_IDS.has('onnx-community/moonshine-base-ONNX'));
  });
});

/* ─── renderer contract ──────────────────────────────────────────────────── */

describe('renderer: the split column must not clip the system select menu', () => {
  // The motion.div's inline style object, from `key="system"` up to the first
  // animation prop.
  const columnStyle = (() => {
    const keyIdx = panelSrc.indexOf('key="system"');
    assert.ok(keyIdx > -1, 'the animated system column (key="system") must exist');
    const styleIdx = panelSrc.indexOf('style={{', keyIdx);
    assert.ok(styleIdx > -1, 'the system column must carry an inline style object');
    const endIdx = panelSrc.indexOf('initial=', styleIdx);
    assert.ok(endIdx > styleIdx, 'the system column must carry an `initial` animation prop');
    return panelSrc.slice(styleIdx, endIdx);
  })();

  test('overflow is NOT hardcoded to hidden', () => {
    // This is the bug. A constant `overflow: 'hidden'` here clips the select's
    // absolutely-positioned menu out of existence for the whole life of the
    // column, so no option is ever clickable.
    assert.doesNotMatch(
      columnStyle,
      /overflow:\s*['"]hidden['"]/,
      'the system column must not clip unconditionally — that clips the select menu away and the '
      + 'system model becomes unselectable (the original bug)',
    );
  });

  test('overflow is driven by the select menu\'s open state', () => {
    const m = columnStyle.match(/overflow:\s*([A-Za-z_$][\w$]*)\s*\?/);
    assert.ok(
      m,
      'the system column must still clip while it animates its width — bind `overflow` to the '
      + 'menu\'s open state rather than dropping the clip entirely',
    );
    // …and the closed branch must actually clip, or the select squashes out
    // over the mic column for the length of the open/close animation.
    assert.match(
      columnStyle,
      /overflow:\s*[A-Za-z_$][\w$]*\s*\?\s*['"]visible['"]\s*:\s*['"]hidden['"]/,
      'open → visible, closed → hidden',
    );
    const stateName = m[1];
    assert.match(
      panelSrc,
      new RegExp(`const\\s*\\[\\s*${stateName}\\s*,`),
      `${stateName} must be component state so a menu open/close re-renders the column`,
    );
  });

  test('the system select reports its open state upward', () => {
    const idx = panelSrc.indexOf("label={t('System Audio Model')}");
    assert.ok(idx > -1, 'the System Audio Model select must exist');
    const block = panelSrc.slice(idx, panelSrc.indexOf('/>', idx));
    assert.match(
      block,
      /onOpenChange=\{/,
      'the system select must report open/close so its clipping ancestor can un-clip',
    );
    assert.match(block, /onChange=\{setSystemModel\}/, 'and must still be wired to setSystemModel');
  });

  test('PremiumSelect accepts and fires the open-state callback', () => {
    assert.match(
      panelSrc,
      /function PremiumSelect\(\{[^}]*onOpenChange[^}]*\}/,
      'PremiumSelect must accept an onOpenChange prop',
    );
    assert.match(
      panelSrc,
      /onOpenChangeRef\.current\?\.\(isOpen\)/,
      'PremiumSelect must fire onOpenChange with its isOpen state',
    );
  });

  test('mic and system selects are wired to their own setters', () => {
    // Guards the other half of the asymmetry: whatever happens to the styling,
    // the two channels must never share one handler.
    assert.match(panelSrc, /const setMicModel = async \(modelId: string\)/);
    assert.match(panelSrc, /const setSystemModel = async \(modelId: string\)/);
    assert.match(
      panelSrc,
      /localWhisperSetChannelConfig\?\.\(\{ micModelId: modelId \}\)/,
      'setMicModel must persist micModelId',
    );
    assert.match(
      panelSrc,
      /localWhisperSetChannelConfig\?\.\(\{ systemModelId: modelId \}\)/,
      'setSystemModel must persist systemModelId',
    );
  });
});

/* ─── IPC setter, executed ───────────────────────────────────────────────── */

const setChannelConfig = (() => {
  const body = eraseTypeOnlySyntax(extractArrowBody(ipcSrc, "safeHandle(\n    'local-whisper-set-channel-config',"));
  const run = new Function('SettingsManager', 'require', 'cfg', body);
  return (sm, cfg) =>
    run(
      { getInstance: () => sm },
      (id) => {
        assert.equal(id, './audio/whisper/modelManager', `unexpected require(${id}) in the handler`);
        return { MODEL_CATALOG_IDS };
      },
      cfg,
    );
})();

describe('local-whisper-set-channel-config (executed)', () => {
  test('a system model pick persists', () => {
    const sm = fakeSettings();
    const res = setChannelConfig(sm, { systemModelId: 'onnx-community/moonshine-base-ONNX' });
    assert.deepEqual(res, { success: true });
    assert.equal(sm.store.localWhisperModelSystem, 'onnx-community/moonshine-base-ONNX');
  });

  test('mic and system hold different models at the same time', () => {
    // The whole point of split channels, and the workaround the broken
    // dropdown denied users.
    const sm = fakeSettings();
    assert.deepEqual(setChannelConfig(sm, { enabled: true }), { success: true });
    assert.deepEqual(
      setChannelConfig(sm, { micModelId: 'onnx-community/moonshine-tiny-ONNX' }),
      { success: true },
    );
    assert.deepEqual(
      setChannelConfig(sm, { systemModelId: 'onnx-community/moonshine-base-ONNX' }),
      { success: true },
    );
    assert.equal(sm.store.localWhisperPerChannelEnabled, true);
    assert.equal(sm.store.localWhisperModelMic, 'onnx-community/moonshine-tiny-ONNX');
    assert.equal(sm.store.localWhisperModelSystem, 'onnx-community/moonshine-base-ONNX');
    assert.notEqual(sm.store.localWhisperModelMic, sm.store.localWhisperModelSystem);
  });

  test('setting the system model leaves the mic model alone (and vice versa)', () => {
    const sm = fakeSettings({
      localWhisperModelMic: 'Xenova/whisper-base.en',
      localWhisperModelSystem: 'Xenova/whisper-base.en',
    });
    setChannelConfig(sm, { systemModelId: 'Xenova/whisper-small.en' });
    assert.equal(sm.store.localWhisperModelMic, 'Xenova/whisper-base.en');
    assert.equal(sm.store.localWhisperModelSystem, 'Xenova/whisper-small.en');
    setChannelConfig(sm, { micModelId: 'Xenova/whisper-tiny' });
    assert.equal(sm.store.localWhisperModelMic, 'Xenova/whisper-tiny');
    assert.equal(sm.store.localWhisperModelSystem, 'Xenova/whisper-small.en');
  });

  test('an unknown system id is refused and nothing is written', () => {
    const sm = fakeSettings({ localWhisperModelSystem: 'Xenova/whisper-base.en' });
    const res = setChannelConfig(sm, { enabled: true, systemModelId: 'not-a-real-model' });
    assert.equal(res.success, false);
    assert.match(res.error, /Unknown local Whisper system model/);
    assert.equal(sm.store.localWhisperModelSystem, 'Xenova/whisper-base.en');
    // Validation runs BEFORE any write, so the enabled flag must not have
    // landed either — a half-applied config is worse than a rejected one.
    assert.equal(sm.store.localWhisperPerChannelEnabled, undefined);
    assert.equal(sm.writes.length, 0);
  });

  test('an empty system id is accepted (clears the override)', () => {
    const sm = fakeSettings({ localWhisperModelSystem: 'Xenova/whisper-base.en' });
    assert.deepEqual(setChannelConfig(sm, { systemModelId: '' }), { success: true });
    assert.equal(sm.store.localWhisperModelSystem, '');
  });

  test('a refused write is reported, never reported as success', () => {
    // R-24: reporting success off a degraded store put every window on a value
    // disk never received, and the setting silently reverted on next launch.
    for (const cfg of [
      { systemModelId: 'Xenova/whisper-small.en' },
      { micModelId: 'Xenova/whisper-small.en' },
      { enabled: true },
    ]) {
      const sm = fakeSettings({}, { degraded: true });
      const res = setChannelConfig(sm, cfg);
      assert.equal(res.success, false, `${JSON.stringify(cfg)} must not report success`);
      assert.equal(res.error, 'settings_store_degraded');
    }
  });
});

/* ─── startup validation gate, executed ──────────────────────────────────── */

const runStartupGate = (() => {
  const body = eraseTypeOnlySyntax(extractSetImmediateBody(mainSrc, 'Preloading local Whisper model'));
  const run = new Function('settingsManager', 'require', 'console', body);
  return (sm, { poisoned = null, cached = () => true } = {}) => {
    const warnings = [];
    const preloaded = [];
    const downloaded = [];
    const notices = [];
    const consoleStub = {
      warn: (...a) => warnings.push(a.join(' ')),
      log: () => {},
      error: (...a) => warnings.push(a.join(' ')),
    };
    const modules = {
      './services/CredentialsManager': {
        CredentialsManager: { getInstance: () => ({ getSttProvider: () => 'local-whisper' }) },
      },
      './audio/whisper/modelManager': { isModelCached: (id) => cached(id), MODEL_CATALOG_IDS },
      './audio/whisper/modelPreloader': {
        modelPreloader: {
          consumePoisonedLoadSentinel: () => poisoned,
          preload: (id) => preloaded.push(id),
        },
      },
      './audio/whisper/inferenceConfig': { resolveInferenceConfig: () => ({ dtype: 'q8' }) },
      './services/LocalModelDownloadService': {
        LocalModelDownloadService: {
          getInstance: () => ({
            start: (_provider, id) => {
              downloaded.push(id);
              return { success: true };
            },
          }),
        },
        resolveLocalModelProviderName: () => 'whisper',
      },
    };
    const appState = { setLocalWhisperRecoveryNotice: (n) => notices.push(n) };
    run.call(
      appState,
      sm,
      (id) => {
        assert.ok(id in modules, `unexpected require(${id}) in the startup gate`);
        return modules[id];
      },
      consoleStub,
    );
    // The shipped block wraps everything in a try/catch that only console.warns.
    // Without this the stubs could throw and every assertion below would pass
    // vacuously.
    const swallowed = warnings.find((w) => w.includes('Local Whisper preload skipped'));
    assert.equal(swallowed, undefined, `the gate threw and swallowed it: ${swallowed}`);
    return { warnings, preloaded, downloaded, notices };
  };
})();

describe('main.ts startup validation gate (executed)', () => {
  test('a valid in-catalog system model is NOT reset', () => {
    // The half that must not over-fire: this setting is the only user-side
    // workaround for the starved system-audio worker, so clobbering it on
    // every launch would undo the fix above.
    const sm = fakeSettings({
      localWhisperModel: 'Xenova/whisper-tiny.en',
      localWhisperPerChannelEnabled: true,
      localWhisperModelMic: 'onnx-community/moonshine-tiny-ONNX',
      localWhisperModelSystem: 'onnx-community/moonshine-base-ONNX',
    });
    const { warnings } = runStartupGate(sm);
    assert.equal(sm.store.localWhisperModelSystem, 'onnx-community/moonshine-base-ONNX');
    assert.equal(sm.store.localWhisperModelMic, 'onnx-community/moonshine-tiny-ONNX');
    assert.equal(
      warnings.some((w) => w.includes('not in catalog')),
      false,
      `a valid selection must not be reset: ${warnings.join(' | ')}`,
    );
    // Nothing was written at all — the gate is a no-op on a healthy config.
    assert.deepEqual(sm.writes, []);
  });

  test('mic and system survive as DIFFERENT models across startup', () => {
    const sm = fakeSettings({
      localWhisperModel: 'Xenova/whisper-tiny.en',
      localWhisperPerChannelEnabled: true,
      localWhisperModelMic: 'Xenova/whisper-base.en',
      localWhisperModelSystem: 'Xenova/whisper-small.en',
    });
    runStartupGate(sm);
    assert.equal(sm.store.localWhisperModelMic, 'Xenova/whisper-base.en');
    assert.equal(sm.store.localWhisperModelSystem, 'Xenova/whisper-small.en');
    assert.notEqual(sm.store.localWhisperModelMic, sm.store.localWhisperModelSystem);
  });

  test('an out-of-catalog system model IS reset to the fallback', () => {
    const sm = fakeSettings({
      localWhisperModel: 'Xenova/whisper-tiny.en',
      localWhisperPerChannelEnabled: true,
      localWhisperModelMic: 'Xenova/whisper-base.en',
      localWhisperModelSystem: 'Xenova/whisper-retired-fork',
    });
    const { warnings } = runStartupGate(sm);
    assert.equal(sm.store.localWhisperModelSystem, FALLBACK);
    // …and only that key.
    assert.equal(sm.store.localWhisperModelMic, 'Xenova/whisper-base.en');
    assert.ok(
      warnings.some((w) => w.includes('localWhisperModelSystem') && w.includes('not in catalog')),
      `expected a reset warning, got: ${warnings.join(' | ')}`,
    );
  });

  test('an out-of-catalog GLOBAL model is reset independently', () => {
    const sm = fakeSettings({ localWhisperModel: 'Xenova/whisper-retired-fork' });
    runStartupGate(sm);
    assert.equal(sm.store.localWhisperModel, FALLBACK);
  });

  test('per-channel ids are left alone while split mode is off', () => {
    // They are not read in this mode, and resetting them would lose the user's
    // choice the moment they flip Split back on.
    const sm = fakeSettings({
      localWhisperModel: 'Xenova/whisper-tiny.en',
      localWhisperPerChannelEnabled: false,
      localWhisperModelSystem: 'onnx-community/moonshine-base-ONNX',
    });
    runStartupGate(sm);
    assert.equal(sm.store.localWhisperModelSystem, 'onnx-community/moonshine-base-ONNX');
    assert.deepEqual(sm.writes, []);
  });

  test('the poison sentinel still resets a matching system selection', () => {
    const sm = fakeSettings({
      localWhisperModel: 'Xenova/whisper-tiny.en',
      localWhisperPerChannelEnabled: true,
      localWhisperModelMic: 'Xenova/whisper-base.en',
      localWhisperModelSystem: 'onnx-community/moonshine-base-ONNX',
    });
    const { notices } = runStartupGate(sm, {
      poisoned: { modelId: 'onnx-community/moonshine-base-ONNX' },
    });
    assert.equal(sm.store.localWhisperModelSystem, FALLBACK);
    assert.equal(sm.store.localWhisperModelMic, 'Xenova/whisper-base.en');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].badModelId, 'onnx-community/moonshine-base-ONNX');
    assert.equal(notices[0].fallbackModelId, FALLBACK);
  });
});

/* ─── helpers ────────────────────────────────────────────────────────────── */

function fakeSettings(initial = {}, { degraded = false } = {}) {
  const store = { ...initial };
  return {
    store,
    writes: [],
    get(key) {
      return store[key];
    },
    set(key, value) {
      // Mirrors SettingsManager.set: refuses (returns false) without mutating
      // when the store is degraded, so memory and disk cannot disagree.
      if (degraded) return false;
      store[key] = value;
      this.writes.push([key, value]);
      return true;
    },
  };
}

/**
 * The three type-only constructs that appear in the blocks executed above.
 * Everything else in them is already valid JavaScript. Asserted, not assumed:
 * a leftover annotation would be a SyntaxError from `new Function`, which
 * surfaces as a failing test rather than a silent pass.
 */
function eraseTypeOnlySyntax(src) {
  const out = src
    .replace(/\s+as\s+const\b/g, '')
    .replace(/new\s+(Set|Map)\s*<[^<>]*>\s*\(/g, 'new $1(')
    .replace(/catch\s*\(\s*([A-Za-z_$][\w$]*)\s*:\s*[\w$.[\]|\s]+\)/g, 'catch ($1)');
  assert.doesNotMatch(out, /\bas const\b/, 'type erasure missed an `as const`');
  assert.doesNotMatch(out, /catch\s*\([^)]*:/, 'type erasure missed a catch annotation');
  return out;
}

/** Body of the block-bodied arrow function following `anchor`, braces excluded. */
function extractArrowBody(source, anchor) {
  const start = source.indexOf(anchor);
  assert.ok(start > -1, `anchor not found: ${anchor}`);
  const arrowIdx = source.indexOf('=>', start + anchor.length);
  assert.ok(arrowIdx > -1, `no arrow function after: ${anchor}`);
  let i = arrowIdx + 2;
  while (i < source.length && /\s/.test(source[i])) i++;
  assert.equal(source[i], '{', `expected a block-bodied arrow after: ${anchor}`);
  return source.slice(i + 1, matchBrace(source, i));
}

/** Body of a `setImmediate(() => { … })` block containing `anchor`. */
function extractSetImmediateBody(source, anchor) {
  const re = /setImmediate\s*\(\s*(?:async\s*)?\(\s*\)\s*=>\s*\{/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const open = m.index + m[0].length - 1;
    const body = source.slice(open + 1, matchBrace(source, open));
    if (body.includes(anchor)) return body;
  }
  assert.fail(`no setImmediate block containing: ${anchor}`);
}

/**
 * Index of the `}` matching the `{` at `open`. Skips string and template
 * literals (so `${…}` interpolations do not unbalance the count) and comments.
 */
function matchBrace(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      for (; i < source.length && source[i] !== quote; i++) {
        if (source[i] === '\\') i++;
      }
    } else if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? source.length : nl;
    } else if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 1;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  assert.fail('unbalanced braces while extracting a block');
}
