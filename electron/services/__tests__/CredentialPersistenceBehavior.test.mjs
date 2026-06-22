// Behavioral persistence tests for CredentialsManager's app-managed fallback.
//
// These run against the COMPILED dist-electron module and exercise real disk I/O in
// a temp userData dir, so they prove actual save→restart→load behavior — unlike the
// source-text assertions in CredentialStorage.test.mjs. They were added after a
// code review found two silent-loss paths that the source-text suite passed green:
//   1. a real disk-write failure still reported "Saved" (write result was discarded);
//   2. os.hostname() in the key material made the fallback undecryptable after a
//      hostname change (Wi-Fi/DHCP/roaming), silently re-losing the key.
//
// Run via: npm run build:electron && node --test electron/services/__tests__/CredentialPersistenceBehavior.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const COMPILED = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../../dist-electron/electron/services/CredentialsManager.js',
);

// Shared, mutable electron mock. Tests flip `keyringAvailable` and `hostname` (the
// hostname is irrelevant to the key now — that's the point of one of the tests).
function makeEnv() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-persist-'));
  const state = { keyringAvailable: false, userData };
  const fakeElectron = {
    app: { getPath: () => state.userData, isPackaged: false, getVersion: () => '0.0.0-test' },
    safeStorage: {
      isEncryptionAvailable: () => state.keyringAvailable,
      // Trivial reversible transform so the keyring path is exercisable in tests.
      encryptString: (s) => Buffer.concat([Buffer.from('KR'), Buffer.from(s, 'utf8')]),
      decryptString: (b) => Buffer.from(b).subarray(2).toString('utf8'),
      getSelectedStorageBackend: () => 'basic_text',
    },
  };
  return { state, fakeElectron, userData };
}

// Install the electron mock once; point it at whichever env is "current".
let CURRENT = null;
const origLoad = Module._load;
Module._load = function patched(request, _p, _m) {
  if (request === 'electron') {
    if (!CURRENT) throw new Error('no electron env active');
    return CURRENT.fakeElectron;
  }
  return origLoad.apply(this, arguments);
};

// Load a FRESH CredentialsManager class (cleared module cache + reset singleton) so
// each "restart" is a genuine cold start that re-reads disk.
function freshManager(env) {
  CURRENT = env;
  delete require.cache[require.resolve(COMPILED)];
  const mod = require(COMPILED);
  // Reset the singleton in case the class object was cached elsewhere.
  if (mod.CredentialsManager.instance) mod.CredentialsManager.instance = undefined;
  const cm = mod.CredentialsManager.getInstance();
  cm.init();
  return cm;
}

const SECRET = 'sk-deepgram-LIVE-SENTINEL-abc123XYZ';

test('save with keyring unavailable → key survives a restart via the encrypted fallback', () => {
  const env = makeEnv();
  env.state.keyringAvailable = false;

  const cm = freshManager(env);
  const persisted = cm.setDeepgramApiKey(SECRET);
  assert.equal(persisted, true, 'setter must report a successful write');

  const fallback = path.join(env.userData, 'credentials.fallback.enc');
  assert.ok(fs.existsSync(fallback), 'fallback file should exist');
  assert.ok(!fs.existsSync(path.join(env.userData, 'credentials.enc')), 'no keyring file while keyring down');

  // No plaintext at rest.
  const blob = fs.readFileSync(fallback);
  assert.ok(!blob.includes(Buffer.from(SECRET, 'utf8')), 'secret must not appear in the file');

  // Restart (cold) — key must load back.
  const cm2 = freshManager(env);
  assert.equal(cm2.getDeepgramApiKey(), SECRET, 'key must survive restart');
});

test('hostname change between restarts does NOT lose the key (regression: no os.hostname in key material)', () => {
  const env = makeEnv();
  env.state.keyringAvailable = false;

  const cm = freshManager(env);
  cm.setSonioxApiKey(SECRET);

  // Simulate a hostname change (Wi-Fi roaming, DHCP, rename). The OLD code mixed
  // os.hostname() into the derived key, so this used to make the fallback
  // undecryptable. We monkeypatch os.hostname for the next cold load to prove the
  // key material no longer depends on it.
  const realHostname = os.hostname;
  os.hostname = () => 'A-Totally-Different-Name.local';
  try {
    const cm2 = freshManager(env);
    assert.equal(cm2.getSonioxApiKey(), SECRET, 'key must survive a hostname change');
  } finally {
    os.hostname = realHostname;
  }
});

test('disk-write failure is reported (success=false), never a false "Saved"', () => {
  const env = makeEnv();
  env.state.keyringAvailable = false;

  const cm = freshManager(env);

  // The on-disk paths were fixed (from this temp dir) at module load, so to force a
  // real write failure we make the directory itself unwritable. The fallback (and
  // its salt) write then throws EACCES inside saveCredentials → must return false.
  fs.chmodSync(env.userData, 0o500); // r-x, no write for owner
  try {
    const persisted = cm.setDeepgramApiKey(SECRET);
    assert.equal(persisted, false, 'a failed disk write must return false, not a false success');
  } finally {
    fs.chmodSync(env.userData, 0o700); // restore so temp cleanup works
  }
});

test('keyring becomes available → fallback migrates up and is deleted', () => {
  const env = makeEnv();
  env.state.keyringAvailable = false;

  const cm = freshManager(env);
  cm.setDeepgramApiKey(SECRET);
  const fallback = path.join(env.userData, 'credentials.fallback.enc');
  const keyring = path.join(env.userData, 'credentials.enc');
  assert.ok(fs.existsSync(fallback));

  // Keyring returns; cold start should load the fallback then migrate up.
  env.state.keyringAvailable = true;
  const cm2 = freshManager(env);
  assert.equal(cm2.getDeepgramApiKey(), SECRET, 'key survives the migration');
  assert.ok(fs.existsSync(keyring), 'keyring file written on migrate-up');
  assert.ok(!fs.existsSync(fallback), 'fallback deleted after migrate-up');

  // And a further restart still has it (now via keyring).
  const cm3 = freshManager(env);
  assert.equal(cm3.getDeepgramApiKey(), SECRET, 'key persists via keyring post-migration');
});

test('a decrypt failure does NOT destroy a recoverable fallback (no migrate of empty creds)', () => {
  const env = makeEnv();
  env.state.keyringAvailable = false;

  const cm = freshManager(env);
  cm.setDeepgramApiKey(SECRET);
  const fallback = path.join(env.userData, 'credentials.fallback.enc');

  // Corrupt the salt so the derived key changes → decrypt throws → creds = {}.
  // With the keyring now "available", the migrate-up guard must NOT run on an empty
  // set and delete the fallback.
  fs.writeFileSync(path.join(env.userData, 'credentials.salt'), Buffer.alloc(32, 7));
  env.state.keyringAvailable = true;

  const cm2 = freshManager(env);
  // Key is unrecoverable (expected — corruption), but the empty set must not have
  // been migrated/persisted as if it were real, and nothing crashed.
  assert.equal(cm2.getDeepgramApiKey(), undefined);
  // The fallback file must NOT have been deleted by an empty-set migrate-up.
  assert.ok(fs.existsSync(fallback), 'fallback must be preserved when load yielded empty creds');
});

test.after(() => { Module._load = origLoad; });
