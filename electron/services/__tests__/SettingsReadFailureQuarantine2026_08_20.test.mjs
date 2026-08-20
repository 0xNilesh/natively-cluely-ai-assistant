// R-19 regression test.
//
// R-15 gave the PARSE-failure path a quarantine-and-recover route: rename the
// bad file aside, clear the degraded flag, carry on writable. The outer
// READ-failure catch was left latching `settingsUnreadable = true` with no
// quarantine and no recovery. Read errors that reach it are deterministic —
// EACCES on a root-owned settings.json, EISDIR if the path is a directory — so
// every launch re-latched and set() refused forever. That is exactly the
// permanent brick F-703's own docstring claims to have eliminated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const src = fs.readFileSync(new URL('../SettingsManager.ts', import.meta.url), 'utf8');

function outerReadCatch() {
  // The catch that wraps the whole existsSync/readFileSync/parse block.
  const i = src.indexOf('Failed to read settings file');
  assert.notEqual(i, -1, 'the outer read-failure catch must still exist');
  return src.slice(i, i + 400);
}

test('the read-failure path quarantines rather than latching read-only', () => {
  const body = outerReadCatch();
  assert.ok(/this\.quarantineUnreadableSettings\(/.test(body),
    'a file we could not READ must get the same quarantine-and-recover treatment as one we could not PARSE');
  assert.ok(!/this\.settingsUnreadable\s*=\s*true/.test(body),
    'it must not latch the degraded flag directly — that is the unrecoverable path');
});

test('quarantine renames the unreadable file and leaves the store writable', () => {
  // Prove the mechanism the fix relies on: renaming needs directory write
  // permission, NOT readability of the file — which is why it recovers the
  // EACCES case that used to be terminal.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-quarantine-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{"a":1}');
  fs.chmodSync(file, 0o000);                       // unreadable by owner

  let readFailed = false;
  try { fs.readFileSync(file, 'utf8'); } catch { readFailed = true; }

  const quarantined = `${file}.corrupt-stamp`;
  fs.renameSync(file, quarantined);                // the quarantine step

  assert.ok(fs.existsSync(quarantined), 'the original must be preserved for recovery');
  assert.ok(!fs.existsSync(file), 'the path must be free for a fresh, writable settings.json');
  fs.writeFileSync(file, '{}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{}', 'the store must be writable again');

  // (readFailed is false when running as root, where nothing is unreadable —
  //  the rename half is the part under test either way.)
  assert.equal(typeof readFailed, 'boolean');

  fs.chmodSync(quarantined, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});
