// R-22 regression test.
//
// R-05: v28 fell through after a failed repair, so v29's block ran and stamped
// user_version past a v28 that never applied — `version < 28` was false ever
// after and the repair never retried. v28 was fixed to `return`.
//
// v29 was then written the same way. It is currently the LAST migration, so its
// fall-through is inert today — which is exactly why it would not have stayed
// inert: whoever adds v30 inherits R-05 verbatim, with no failing test to warn
// them.
//
// The invariant, stated precisely: a block that stamps user_version INSIDE its
// try (so a failure skips the stamp) must also stop the chain — by `return` or,
// as v22 does, by re-throwing to halt startup. Blocks that stamp outside the
// try advance deliberately and are a different, pre-existing design; this test
// does not judge them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../DatabaseManager.ts', import.meta.url), 'utf8');
const CHAIN_END = src.indexOf('Migrations completed.');

function migrationBlocks() {
  const starts = [];
  const re = /if \(version < (\d+)\) \{/g;
  let m;
  while ((m = re.exec(src)) !== null) starts.push({ version: Number(m[1]), at: m.index });
  assert.ok(starts.length >= 2, 'expected to find the migration chain');
  return starts.map((b, i) => {
    const body = src.slice(b.at, starts[i + 1] ? starts[i + 1].at : CHAIN_END);
    const tryAt = body.indexOf('try {');
    const catchAt = body.lastIndexOf('} catch (e) {');
    const stampAt = body.lastIndexOf('user_version =');
    return {
      version: b.version,
      body,
      // A failure skips the stamp only when the stamp sits inside the try.
      stampSkippedOnFailure: tryAt !== -1 && catchAt !== -1 && tryAt < stampAt && stampAt < catchAt,
      terminatesChain: catchAt !== -1 && /\breturn;|\bthrow /.test(body.slice(catchAt)),
    };
  });
}

test('a migration that skips its stamp on failure also stops the chain', () => {
  const offenders = migrationBlocks()
    .filter((b) => b.stampSkippedOnFailure && !b.terminatesChain)
    .map((b) => b.version);

  assert.deepEqual(offenders, [],
    `v${offenders.join(', v')} skips its user_version stamp on failure but lets the chain continue: `
    + 'the next migration will stamp past it and it can never retry (R-05)');
});

test('v29 specifically terminates rather than relying on being last', () => {
  const v29 = migrationBlocks().find((b) => b.version === 29);
  assert.ok(v29, 'the v29 block must still exist');
  assert.equal(v29.stampSkippedOnFailure, true, 'v29 stamps inside its try, so a failure must not fall through');
  assert.equal(v29.terminatesChain, true, 'v29 must return (or throw) on failure');
  assert.ok(/leaving version at 28 to retry next launch/.test(v29.body),
    'the retry intent must remain explicit for whoever adds v30');
});

test('v28 — the block R-05 was found in — is still terminating', () => {
  const v28 = migrationBlocks().find((b) => b.version === 28);
  assert.ok(v28 && v28.terminatesChain, 'R-05 must not regress');
});
