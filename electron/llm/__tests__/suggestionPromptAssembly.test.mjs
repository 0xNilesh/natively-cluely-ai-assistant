import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(__dirname, '../../LLMHelper.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const generateSuggestionStart = source.indexOf('public async generateSuggestion');
const generateSuggestionEnd = source.indexOf('public setKnowledgeOrchestrator', generateSuggestionStart);
const generateSuggestionSource = source.slice(generateSuggestionStart, generateSuggestionEnd);

test('generateSuggestion loads active mode prompt suffix and active mode context block', () => {
  assert.ok(generateSuggestionStart >= 0, 'generateSuggestion should exist');
  assert.match(generateSuggestionSource, /require\('\.\/services\/ModesManager'\)/);
  assert.match(generateSuggestionSource, /getActiveModeSystemPromptSuffix\(\)/);
  assert.match(generateSuggestionSource, /buildActiveModeContextBlock\(\)/);
});

test('generateSuggestion prepends mode context before transcript context', () => {
  assert.match(generateSuggestionSource, /const enrichedContext = modeContextBlock[\s\S]*\? `\$\{modeContextBlock\}\\n\\n\$\{context\}`[\s\S]*: context;/);
});

test('generateSuggestion places active mode suffix in system prompt before custom notes', () => {
  assert.match(generateSuggestionSource, /const basePrompt = activeModePrompt[\s\S]*\? `\$\{HARD_SYSTEM_PROMPT\}\\n\\n## ACTIVE MODE\\n\$\{activeModePrompt\}\$\{customNotesBlock\}`/);
});

test('generateSuggestion sends enriched mode context to streaming custom-provider path', () => {
  assert.match(generateSuggestionSource, /streamChat\(lastQuestion, undefined, enrichedContext, basePrompt, true\)/);
});

test('generateSuggestion uses active mode path without duplicating custom notes in fallback branch', () => {
  const customNotesOccurrences = (generateSuggestionSource.match(/customNotesBlock/g) ?? []).length;
  assert.ok(customNotesOccurrences >= 4, 'custom notes should be assembled once and appended through basePrompt branches');
  assert.match(generateSuggestionSource, /customNotesBlock is intentionally NOT inside the ternary/);
});
