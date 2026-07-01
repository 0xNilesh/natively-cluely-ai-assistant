/**
 * OKF Phase 0 (2026-07-01): false-refusal self-trigger guard regression tests.
 *
 * Root cause: the system's OWN safe refusal phrase ("I could not find that in
 * the retrieved sections of the document") could match the `saysNotMentioned`
 * detector and trigger an unnecessary/incorrect repair regen on the model's
 * correct, honest refusal. Fixed by adding SYSTEM_REFUSAL_RE + a
 * strong-evidence-only repair gate for that specific phrase, behind the
 * docGroundedFalseRefusalRepair flag (default ON).
 *
 * Source-assertion pattern (reads .ts source as a string), matching
 * DocGroundedRetrievalFix.test.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const ipcHandlersSrc = read('electron/ipcHandlers.ts');
const flagsSrc = read('electron/intelligence/intelligenceFlags.ts');

test('ipcHandlers: defines SYSTEM_REFUSAL_RE for the system own refusal phrase', () => {
  assert.match(ipcHandlersSrc, /const SYSTEM_REFUSAL_RE = \/\^I could not find that in the retrieved sections/);
});

test('ipcHandlers: derives highSignalEntities from the question + the active document\'s own extracted knowledge (not a hardcoded fixture list)', () => {
  // Senior review fix (2026-07-01): a prior version hardcoded
  // HIGH_SIGNAL_ENTITIES = ['OpenVLA-OFT', 'OpenVLA', 'AgenticVLA', ...] —
  // literal terms from the one thesis PDF this feature was developed
  // against, which made the strong-evidence repair branch inert for any
  // OTHER uploaded document. Now derives target entities from
  // QuestionClassifier.classifyQuestion(message).targetEntities and
  // cross-checks them against the active OKF pack's own entity/card names.
  assert.match(ipcHandlersSrc, /let highSignalEntities: string\[\] = \[\];/);
  assert.match(ipcHandlersSrc, /classifyQuestion\(message\)\.targetEntities/);
  assert.match(ipcHandlersSrc, /packEntityNames\.has\(e\.toLowerCase\(\)\)/);
  assert.ok(!ipcHandlersSrc.includes("const HIGH_SIGNAL_ENTITIES = ["), 'must not contain the old hardcoded fixture-specific entity list assignment (a mention in an explanatory comment is fine)');
});

test('ipcHandlers: strong-evidence threshold requires >=3 terms OR a matched high-signal entity', () => {
  assert.match(ipcHandlersSrc, /present\.length >= 3 \|\| Boolean\(matchedHighSignalEntity\)/);
});

test('ipcHandlers: system own refusal phrase only repairs on strong evidence, not the >=2-term threshold', () => {
  assert.match(ipcHandlersSrc, /isSystemOwnRefusalPhrase \? hasStrongEvidence : present\.length >= 2/);
});

test('ipcHandlers: false-refusal repair is gated behind docGroundedFalseRefusalRepair flag', () => {
  assert.match(ipcHandlersSrc, /isIntelligenceFlagEnabled\('docGroundedFalseRefusalRepair'\)/);
  assert.match(ipcHandlersSrc, /saysNotMentioned && docContextBlock && falseRefusalRepairEnabled/);
});

test('ipcHandlers: regen is attempted at most once regardless of reason (no loop)', () => {
  // The repair path only runs once per answer turn: locate the `if (reason) {`
  // block boundaries by the matching `} catch (dgErr` that closes the
  // surrounding try block, and confirm exactly one regen call with no loop.
  const startIdx = ipcHandlersSrc.indexOf('if (reason) {');
  assert.ok(startIdx >= 0, 'expected to find the `if (reason) {` repair block');
  const endIdx = ipcHandlersSrc.indexOf('} catch (dgErr', startIdx);
  assert.ok(endIdx > startIdx, 'expected to find the closing `} catch (dgErr` after the repair block');
  const block = ipcHandlersSrc.slice(startIdx, endIdx);
  const raceCalls = (block.match(/raceStreamWithDeadline/g) || []).length;
  assert.equal(raceCalls, 1, 'expected exactly one regen attempt (no retry loop)');
  assert.ok(!/\bwhile\s*\(/.test(block), 'repair block must not contain a while loop');
});

test('intelligenceFlags: okfKnowledgePacks/okfMarkdownExport/okfHybridRetrieval default ON in dev/test contexts', () => {
  assert.match(flagsSrc, /okfKnowledgePacks: \{[^}]*default: isInternalDevTestContext\(\)/);
  assert.match(flagsSrc, /okfMarkdownExport: \{[^}]*default: isInternalDevTestContext\(\)/);
  assert.match(flagsSrc, /okfHybridRetrieval: \{[^}]*default: isInternalDevTestContext\(\)/);
});

test('intelligenceFlags: okfGraphExpansion/okfKnowledgeUi/okfUserEditableCards default OFF', () => {
  assert.match(flagsSrc, /okfGraphExpansion: \{[^}]*default: false/);
  assert.match(flagsSrc, /okfKnowledgeUi: \{[^}]*default: false/);
  assert.match(flagsSrc, /okfUserEditableCards: \{[^}]*default: false/);
});

test('intelligenceFlags: docGroundedStrictIsolation and docGroundedFalseRefusalRepair default ON everywhere', () => {
  assert.match(flagsSrc, /docGroundedStrictIsolation: \{[^}]*default: true/);
  assert.match(flagsSrc, /docGroundedFalseRefusalRepair: \{[^}]*default: true/);
});

// ---------------------------------------------------------------------------
// Behavioral simulation of the regex/threshold logic (mirrors the live code
// paths without requiring a compiled build).
// ---------------------------------------------------------------------------

const SYSTEM_REFUSAL_RE = /^I could not find that in the retrieved sections? of the (?:document|uploaded material)\b/i;
const SAYS_NOT_MENTIONED_RE = /not (?:directly )?(?:mentioned|in (?:the|my) (?:uploaded|seminar|thesis|retrieved) (?:material|sections?|document)|found in|present in)|(?:^|(?<=[.!?]\s+))I could not find\b/i;

// Simulates the RESULT of the production highSignalEntities derivation
// (classifyQuestion(message).targetEntities, cross-checked against the
// active OKF pack's own entity/card names) — these simulation tests pass
// the already-cross-checked candidate list directly, since they exercise
// the strong-evidence THRESHOLD logic, not the entity-derivation step
// itself (which is covered by the source-assertion test above and by
// QuestionClassifier's own tests).
function simulateShouldRepair(answer, question, docContextBlock, documentDerivedHighSignalEntities) {
  const trimmed = answer.trim();
  const isSystemOwnRefusalPhrase = SYSTEM_REFUSAL_RE.test(trimmed);
  const saysNotMentioned = SAYS_NOT_MENTIONED_RE.test(trimmed);
  if (!saysNotMentioned || !docContextBlock) return false;
  const qTerms = (question.match(/\b[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]\b/g) || [])
    .filter((t) => t.length >= 3 && t.length <= 40)
    .filter((t) => !/^(?:the|this|that|what|when|where|who|how|why|which|does|did|was|were|are|is|in|of|at|to|for|with|about|and|or|not|has|have|had|its|can|could|would|should|will|from|than|more|any|all|some|tell|explain|describe|me|my|your|their|it|be|do|an|on|by|as|up|if|so|but|out|no|we|they|he|she|you|his|her|our|us|them)$/i.test(t));
  const chunkLower = docContextBlock.toLowerCase();
  const present = qTerms.filter((t) => chunkLower.includes(t.toLowerCase()));
  const messageLower = question.toLowerCase();
  const matchedHighSignalEntity = (documentDerivedHighSignalEntities || []).find(
    (e) => messageLower.includes(e.toLowerCase()) && chunkLower.includes(e.toLowerCase()),
  );
  const hasStrongEvidence = present.length >= 3 || Boolean(matchedHighSignalEntity);
  return isSystemOwnRefusalPhrase ? hasStrongEvidence : present.length >= 2;
}

test('simulation: system own safe refusal does NOT trigger repair when evidence is weak', () => {
  const answer = 'I could not find that in the retrieved sections of the document.';
  const question = 'What is the capital of France?';
  const ctx = 'OpenVLA-OFT uses parallel decoding for 43x faster throughput.';
  assert.equal(simulateShouldRepair(answer, question, ctx, ['OpenVLA-OFT']), false);
});

test('simulation: system own safe refusal DOES trigger repair when a high-signal entity matches both question and context', () => {
  const answer = 'I could not find that in the retrieved sections of the document.';
  const question = 'What is OpenVLA-OFT?';
  const ctx = '[Section 2.1.2 | p13] OpenVLA-OFT replaces autoregressive decoding with parallel decoding, achieving 43x faster throughput.';
  assert.equal(simulateShouldRepair(answer, question, ctx, ['OpenVLA-OFT']), true);
});

test('simulation: system own safe refusal DOES trigger repair when >=3 unique question terms are present', () => {
  const answer = 'I could not find that in the retrieved sections of the document.';
  const question = 'What are the main objectives of the thesis?';
  const ctx = '[Section 1.2] The main objectives of this thesis include four phases.';
  assert.equal(simulateShouldRepair(answer, question, ctx, []), true);
});

test('simulation: a non-system refusal phrasing repairs on the original >=2-term threshold', () => {
  const answer = 'This is not mentioned in the retrieved material.';
  const question = 'What is AgenticVLA and AutoGen?';
  const ctx = 'AgenticVLA integrates AutoGen with OpenVLA-OFT for embodied robotic tasks.';
  assert.equal(simulateShouldRepair(answer, question, ctx, []), true);
});

test('simulation: a high-signal entity from a DIFFERENT document (not in the active pack) does NOT count as strong evidence', () => {
  // Regression test for the fixture-specific-allowlist bug: an entity name
  // that matches the question and the context text is only "high-signal"
  // when it's also present in the active document's own extracted
  // knowledge — passing an empty document-derived list here simulates a
  // document where that cross-check failed (e.g. a different upload).
  const answer = 'I could not find that in the retrieved sections of the document.';
  const question = 'What is OpenVLA-OFT?';
  const ctx = 'OpenVLA-OFT uses parallel decoding.'; // only 1 non-stopword question term overlaps ("OpenVLA-OFT" itself is 1 term)
  assert.equal(simulateShouldRepair(answer, question, ctx, []), false);
});

test('simulation: no infinite loop — repeated calls with the same inputs are idempotent (pure function, no state)', () => {
  const answer = 'I could not find that in the retrieved sections of the document.';
  const question = 'What is OpenVLA?';
  const ctx = 'OpenVLA is a 7B-parameter open-source VLA model.';
  const first = simulateShouldRepair(answer, question, ctx);
  const second = simulateShouldRepair(answer, question, ctx);
  assert.equal(first, second);
});
