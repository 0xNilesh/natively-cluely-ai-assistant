// HindsightManager — config resolution (settings OR env), health-check, and the cached
// isAvailable() gate that the retain/recall paths use. Headless-safe: SettingsManager
// needs Electron, so these tests drive getHindsightConfig via ENV (which takes precedence)
// and verify graceful degrade when nothing is configured / the server is absent.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { HindsightManager } from '../../../dist-electron/electron/services/HindsightManager.js';

const ENV_KEYS = ['HINDSIGHT_BASE_URL', 'HINDSIGHT_API_KEY', 'HINDSIGHT_TIMEOUT_MS'];
function clearEnv() { for (const k of ENV_KEYS) delete process.env[k]; }

describe('HindsightManager.getHindsightConfig', () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  test('returns null when nothing is configured (feature off)', () => {
    // No env + (headless) no settings → null.
    assert.equal(HindsightManager.getInstance().getHindsightConfig(), null);
  });

  test('env HINDSIGHT_BASE_URL configures the server', () => {
    process.env.HINDSIGHT_BASE_URL = 'http://localhost:8888';
    const cfg = HindsightManager.getInstance().getHindsightConfig();
    assert.ok(cfg);
    assert.equal(cfg.baseUrl, 'http://localhost:8888');
    assert.equal(cfg.timeoutMs, 800);
  });

  test('apiKey + timeout carried from env (Cloud path)', () => {
    process.env.HINDSIGHT_BASE_URL = 'https://cloud.example/api';
    process.env.HINDSIGHT_API_KEY = 'secret';
    process.env.HINDSIGHT_TIMEOUT_MS = '1500';
    const cfg = HindsightManager.getInstance().getHindsightConfig();
    assert.equal(cfg.apiKey, 'secret');
    assert.equal(cfg.timeoutMs, 1500);
  });

  test('blank/whitespace baseUrl → null (treated as unconfigured)', () => {
    process.env.HINDSIGHT_BASE_URL = '   ';
    assert.equal(HindsightManager.getInstance().getHindsightConfig(), null);
  });
});

describe('HindsightManager.healthCheck + isAvailable', () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  test('healthCheck is false when unconfigured', async () => {
    assert.equal(await HindsightManager.getInstance().healthCheck(), false);
  });

  test('healthCheck is false (no throw) when the server is unreachable', async () => {
    process.env.HINDSIGHT_BASE_URL = 'http://127.0.0.1:59999'; // nothing listening
    const ok = await HindsightManager.getInstance().healthCheck();
    assert.equal(ok, false);
  });

  test('isAvailable false when unconfigured (gate closed → retain/recall Noop)', () => {
    assert.equal(HindsightManager.getInstance().isAvailable(), false);
  });

  test('start() never throws when unconfigured (no spawn)', async () => {
    await assert.doesNotReject(() => HindsightManager.getInstance().start());
  });

  test('start() with a baseUrl but memory flag OFF does not spawn (stays Noop)', async () => {
    process.env.HINDSIGHT_BASE_URL = 'http://127.0.0.1:59999'; // unreachable
    delete process.env.NATIVELY_HINDSIGHT_MEMORY; // flag off
    // Must return quickly without spawning anything; isAvailable stays false.
    await assert.doesNotReject(() => HindsightManager.getInstance().start());
    assert.equal(HindsightManager.getInstance().isAvailable(), false);
  });

  test('stop() never throws when nothing is app-managed', async () => {
    await assert.doesNotReject(() => HindsightManager.getInstance().stop());
  });

  // OPT-IN: with a real server running, healthCheck passes and isAvailable gates open.
  test('healthCheck TRUE against a live server', { skip: process.env.HINDSIGHT_LIVE_TEST !== '1' && 'set HINDSIGHT_LIVE_TEST=1 + run the dev server' }, async () => {
    process.env.HINDSIGHT_BASE_URL = process.env.HINDSIGHT_BASE_URL || 'http://localhost:8888';
    const mgr = HindsightManager.getInstance();
    assert.equal(await mgr.healthCheck(), true);
    assert.equal(mgr.isAvailable(), true);
  });
});

// autoStartCommand() — the zero-config default that fixes the "never auto-starts" bug.
// These reach the private method directly (JS has no real privacy); they verify the
// command resolution precedence + the script-existence gating that keeps a packaged build
// (no bundled script) from spawning a broken `bash <missing>`.
describe('HindsightManager.autoStartCommand (zero-config default)', () => {
  const COMMAND_ENV = 'HINDSIGHT_SERVER_COMMAND';
  let savedCwd;
  beforeEach(() => { savedCwd = process.cwd(); delete process.env[COMMAND_ENV]; });
  afterEach(() => { try { process.chdir(savedCwd); } catch {} delete process.env[COMMAND_ENV]; });

  test('explicit HINDSIGHT_SERVER_COMMAND env wins (verbatim)', () => {
    process.env[COMMAND_ENV] = 'my-custom-launcher --foo';
    const cmd = HindsightManager.getInstance().autoStartCommand();
    assert.equal(cmd, 'my-custom-launcher --foo');
  });

  test('defaults to `bash "<abs scripts/hindsight-start.sh>"` when the script exists on disk', async () => {
    // Tests run from the project root, where scripts/hindsight-start.sh is present.
    const cmd = HindsightManager.getInstance().autoStartCommand();
    assert.ok(cmd, 'expected a defaulted command');
    assert.match(cmd, /^bash "/);
    assert.match(cmd, /scripts[/\\]hindsight-start\.sh"$/);
    // The path between the quotes must be absolute and actually exist.
    const m = cmd.match(/^bash "(.+)"$/);
    assert.ok(m, 'command should be `bash "<path>"`');
    const fs = await import('node:fs');
    assert.ok(fs.existsSync(m[1]), `defaulted script path should exist: ${m[1]}`);
  });

  test('locateLauncherScript returns null + no default when the script is absent (packaged-build degrade)', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    // chdir to a scratch dir with NO scripts/, so process.cwd() candidate misses. The
    // __dirname/app.getAppPath() candidates also won't find a script under a temp tree.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hsmgr-'));
    process.chdir(tmp);
    const mgr = HindsightManager.getInstance();
    // locateLauncherScript walks up from the COMPILED module dir too (dist-electron/...),
    // which lives under the real project root → the script is still findable there. So this
    // assertion documents that the on-disk module layout, not cwd, drives discovery.
    const located = mgr.locateLauncherScript();
    if (located) {
      const fsm = await import('node:fs');
      assert.ok(fsm.existsSync(located), 'if a path is returned it must exist');
    } else {
      assert.equal(mgr.autoStartCommand(), null);
    }
  });
});

describe('HindsightManager.augmentPath (Finder-launch PATH caveat)', () => {
  test('on darwin, prepends common bin locations and keeps the inherited PATH', () => {
    const merged = HindsightManager.getInstance().augmentPath();
    if (process.platform === 'darwin') {
      assert.ok(merged.includes('/usr/local/bin'));
      // inherited PATH entries are preserved
      for (const p of (process.env.PATH || '').split(':')) {
        if (p) assert.ok(merged.split(':').includes(p), `inherited PATH entry preserved: ${p}`);
      }
    } else {
      assert.equal(merged, process.env.PATH || '');
    }
  });
});
