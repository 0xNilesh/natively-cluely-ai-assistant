import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainPath = path.resolve(__dirname, '../../main.ts');
const source = fs.readFileSync(mainPath, 'utf8');

// ── Function isolation ──────────────────────────────────────────────────────
const startMeetingStart = source.indexOf('public async startMeeting');
const endMeetingStart = source.indexOf('public async endMeeting', startMeetingStart);
const ragStart = source.indexOf('private async processCompletedMeetingForRAG', endMeetingStart);

const startMeetingSource = source.slice(startMeetingStart, endMeetingStart);
const endMeetingSource = source.slice(endMeetingStart, ragStart);

// ── Balanced-brace body extractor ───────────────────────────────────────────
// Given a source string and an index that points at a '{', return the
// substring INSIDE that brace pair (excluding the outer braces). Tracks
// quotes minimally so we don't get tripped by `}` inside strings/comments
// at the depths we care about (the main.ts source uses standard formatting).
function extractBracedBody(src, openBraceIdx) {
  assert.equal(src[openBraceIdx], '{', 'extractBracedBody expects pointer at opening brace');
  let depth = 0;
  let inString = null; // ', ", or `
  let inLineComment = false;
  let inBlockComment = false;
  let i = openBraceIdx;
  const bodyStart = openBraceIdx + 1;
  for (; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i++; }
      continue;
    }
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return src.slice(bodyStart, i);
      }
    }
  }
  throw new Error('extractBracedBody: unterminated brace at index ' + openBraceIdx);
}

test('startMeeting exists and contains the audio-init IIFE pattern', () => {
  assert.ok(startMeetingStart >= 0, 'startMeeting should exist');
  assert.ok(endMeetingStart > startMeetingStart, 'endMeeting should follow startMeeting');
  assert.match(
    startMeetingSource,
    /this\._audioInitPromise\s*=\s*\(async\s*\(\)\s*=>\s*\{/,
    'startMeeting should contain the audio-init IIFE pattern'
  );
});

test('audio-init IIFE finally block clears BOTH controller AND promise in strict-ref check', () => {
  // 1. Locate the IIFE opening brace.
  const iifeAssignMatch = startMeetingSource.match(/this\._audioInitPromise\s*=\s*\(async\s*\(\)\s*=>\s*\{/);
  assert.ok(iifeAssignMatch, 'IIFE assignment regex must match');
  const iifeBraceIdx = iifeAssignMatch.index + iifeAssignMatch[0].length - 1;
  const iifeBody = extractBracedBody(startMeetingSource, iifeBraceIdx);

  // 2. Locate `finally {` within the IIFE body and extract its body.
  const finallyMatch = iifeBody.match(/\}\s*finally\s*\{/);
  assert.ok(finallyMatch, 'IIFE body should contain a finally { block');
  const finallyOpenBraceIdx = finallyMatch.index + finallyMatch[0].length - 1;
  const finallyBody = extractBracedBody(iifeBody, finallyOpenBraceIdx);

  // 3. Finally block should contain the strict-reference check on the
  //    captured audioInitController.
  const strictRefMatch = finallyBody.match(
    /if\s*\(\s*this\._audioInitController\s*===\s*audioInitController\s*\)\s*\{/
  );
  assert.ok(
    strictRefMatch,
    'finally block must contain strict-reference check `this._audioInitController === audioInitController`'
  );

  // 4. Inside that if-block, BOTH controller and promise are cleared.
  const ifOpenBraceIdx = strictRefMatch.index + strictRefMatch[0].length - 1;
  const ifBody = extractBracedBody(finallyBody, ifOpenBraceIdx);

  assert.match(
    ifBody,
    /this\._audioInitController\s*=\s*null\s*;/,
    'strict-ref if-block must clear this._audioInitController'
  );
  assert.match(
    ifBody,
    /this\._audioInitPromise\s*=\s*null\s*;/,
    'B9 regression: strict-ref if-block MUST also clear this._audioInitPromise in lockstep. ' +
      'Do NOT remove this — see commit fixing the stale-promise hazard.'
  );
});

test('B9 negative regression: stale "intentionally do NOT clear" rationale must be GONE', () => {
  // If a future contributor revives the old (incorrect) rationale that
  // warned against clearing _audioInitPromise in the finally block, this
  // assertion fails.
  assert.ok(
    !source.includes('intentionally do NOT clear'),
    'Pre-fix comment "intentionally do NOT clear" must not reappear in main.ts. ' +
      'The promise slot SHOULD be cleared in lockstep with the controller (see B9).'
  );
});

test('endMeeting retains defense-in-depth clear of this._audioInitPromise', () => {
  assert.ok(endMeetingStart >= 0, 'endMeeting should exist');
  assert.ok(ragStart > endMeetingStart, 'endMeeting source should be isolated');
  // Even though the IIFE's finally now also clears the slot, endMeeting's
  // own clear is idempotent and remains as defense-in-depth.
  assert.match(
    endMeetingSource,
    /this\._audioInitPromise\s*=\s*null\s*;/,
    'endMeeting must still clear this._audioInitPromise (defense-in-depth, idempotent w/ finally clear)'
  );
});
