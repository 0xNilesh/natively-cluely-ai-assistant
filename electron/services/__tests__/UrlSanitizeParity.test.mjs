// electron/services/__tests__/UrlSanitizeParity.test.mjs
//
// The URL privacy guard is duplicated across the package boundary: the extension
// primary (sanitizeUrl in natively-browser tab-classifier.ts) and the desktop
// defense-in-depth copy (reSanitizeUrl in BrowserMetadataClassifierService.ts).
// They MUST stay in lockstep or the desktop re-sanitizer could pass through a
// secret the extension would have redacted. This feeds a shared fixture set
// through BOTH compiled copies and asserts identical output.
//
// Run: npm run test:services (after build:electron + the extension build:test)

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../');
const extRoot = path.join(repoRoot, 'natively-browser');

const desktopPath = path.resolve(repoRoot, 'dist-electron/electron/services/browser-context/BrowserMetadataClassifierService.js');
const extPath = path.resolve(extRoot, 'dist-test/capture/classifier/tab-classifier.js');

let reSanitizeUrl, sanitizeUrl;

before(async () => {
  // Ensure the extension's pure modules are compiled to dist-test (idempotent,
  // fast). The desktop bundle is built by `npm run test:services` upstream.
  try {
    execFileSync('node', ['esbuild.test.mjs'], { cwd: extRoot, stdio: 'ignore' });
  } catch { /* if it's already built, the import below still works */ }
  ({ reSanitizeUrl } = await import(pathToFileURL(desktopPath).href));
  ({ sanitizeUrl } = await import(pathToFileURL(extPath).href));
});

// Fixtures: secrets that MUST be redacted + descriptive slugs that must survive.
const FIXTURES = [
  'https://leetcode.com/problems/two-sum/?source=nav#editor',
  'https://x.com/u/550e8400-e29b-41d4-a716-446655440000/edit',
  'https://x.com/orders/123456789',
  'https://x.com/u/me@example.com',
  'https://x.com/s/AbCdEf0123456789ghIjKlMnOp',     // long opaque w/ digits
  'https://x.com/s/abcdefghijklmnopqrstuvwxyz',      // long opaque ALL-ALPHA (the gap fix)
  'https://x.com/auth/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiОiJ4In0.s5kT9Qabcdef',  // JWT-ish in one segment
  'https://x.com/problems/two-sum',                  // descriptive — keep
  'https://WWW.Example.com/Docs/API/fetch',          // host normalize + keep
  'javascript://evil/x',                             // scheme downgrade
  'http://acme.com/login',
  'not a url at all',
  '',
];

describe('URL sanitizer parity — extension sanitizeUrl === desktop reSanitizeUrl', () => {
  test('both copies produce identical output for every fixture', () => {
    for (const u of FIXTURES) {
      const ext = sanitizeUrl(u) || undefined; // ext returns '' for junk; desktop returns undefined
      const desk = reSanitizeUrl(u);
      assert.equal(
        ext ?? undefined,
        desk ?? undefined,
        `divergence for input ${JSON.stringify(u)}: ext=${JSON.stringify(ext)} desk=${JSON.stringify(desk)}`,
      );
    }
  });

  test('the all-alpha long token IS redacted (regression for the review gap)', () => {
    assert.equal(reSanitizeUrl('https://x.com/s/abcdefghijklmnopqrstuvwxyz'), 'https://x.com/s/:token');
    assert.equal(sanitizeUrl('https://x.com/s/abcdefghijklmnopqrstuvwxyz'), 'https://x.com/s/:token');
  });

  test('a JWT-shaped path segment IS redacted', () => {
    const u = 'https://x.com/auth/aaaaaaaa.bbbbbbbb.cccccccc';
    assert.equal(reSanitizeUrl(u), 'https://x.com/auth/:token');
    assert.equal(sanitizeUrl(u), 'https://x.com/auth/:token');
  });
});
