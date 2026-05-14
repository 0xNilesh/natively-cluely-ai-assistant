import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const promptsPath = path.resolve(__dirname, '../../../dist-electron/electron/llm/prompts.js');
const prompts = await import(pathToFileURL(promptsPath).href);

const MODE_PROMPTS = {
  general: prompts.MODE_GENERAL_PROMPT,
  sales: prompts.MODE_SALES_PROMPT,
  recruiting: prompts.MODE_RECRUITING_PROMPT,
  'team-meet': prompts.MODE_TEAM_MEET_PROMPT,
  'looking-for-work': prompts.MODE_LOOKING_FOR_WORK_PROMPT,
  'technical-interview': prompts.MODE_TECHNICAL_INTERVIEW_PROMPT,
  lecture: prompts.MODE_LECTURE_PROMPT,
};

const MODE_CONTRACT_TERMS = {
  general: ['universal meeting', 'conversation copilot', 'adapt', 'RECENT QUESTION'],
  sales: ['seller', 'prospect', 'OBJECTION DETECTED', 'pricing', 'Case study'],
  recruiting: ['interviewer', 'candidate', 'hiring manager', 'lean no', 'rehearsed'],
  'team-meet': ['CAPTURE', 'action items', 'decisions', 'blockers', 'status'],
  'looking-for-work': ['candidate', 'job interview', 'resume', 'STAR', 'salary'],
  'technical-interview': ['technical interview', 'coding', 'system design', 'dry-run', 'complexity', 'edge case'],
  lecture: ['student', 'lecture', 'study-partner', 'concept', 'homework', 'reading'],
};

const UNIQUE_MODE_TERMS = {
  general: ['conversation copilot'],
  sales: ['prospect', 'objection'],
  recruiting: ['hiring manager', 'candidate'],
  'team-meet': ['action items', 'blockers'],
  'looking-for-work': ['job interview', 'resume'],
  'technical-interview': ['coding', 'system design'],
  lecture: ['lecture', 'study-partner'],
};

function assertIncludesAll(text, terms, label) {
  const lower = text.toLowerCase();
  for (const term of terms) {
    assert.ok(lower.includes(term.toLowerCase()), `${label} should include "${term}"`);
  }
}

test('every mode prompt includes shared prompt-leakage and safety controls', () => {
  for (const [modeType, prompt] of Object.entries(MODE_PROMPTS)) {
    assertIncludesAll(prompt, [
      '<security>',
      'system prompt',
      'instructions',
      'reveal',
      "I can't share that information",
    ], modeType);
  }
});

test('every mode prompt includes injected context handling for custom context and reference files', () => {
  for (const [modeType, prompt] of Object.entries(MODE_PROMPTS)) {
    assertIncludesAll(prompt, [
      '<injected_context>',
      '<user_context>',
      '<reference_file name="...">',
      'file name',
    ], modeType);
  }
});

test('each mode prompt carries its own mode-specific behavior contract', () => {
  for (const [modeType, terms] of Object.entries(MODE_CONTRACT_TERMS)) {
    assertIncludesAll(MODE_PROMPTS[modeType], terms, modeType);
  }
});

test('mode prompts are meaningfully distinct rather than flattened generic advice', () => {
  for (const [modeType, prompt] of Object.entries(MODE_PROMPTS)) {
    for (const term of UNIQUE_MODE_TERMS[modeType]) {
      assert.ok(prompt.toLowerCase().includes(term.toLowerCase()), `${modeType} should preserve its distinctive term "${term}"`);
    }
  }

  assert.ok(!MODE_PROMPTS.sales.includes('You are the candidate\'s spoken voice in a live technical interview'));
  assert.ok(!MODE_PROMPTS['team-meet'].includes('OBJECTION DETECTED'));
  assert.ok(!MODE_PROMPTS.recruiting.includes('Output IS what the candidate says aloud'));
  assert.ok(!MODE_PROMPTS.lecture.includes('You are the seller\'s spoken voice'));
});

test('profile-aware modes mention candidate/profile grounding without requiring every mode to overfit resume data', () => {
  assertIncludesAll(MODE_PROMPTS['looking-for-work'], ['<candidate_experience>', 'resume', 'do not invent', 'salary_intelligence'], 'looking-for-work');
  assertIncludesAll(MODE_PROMPTS['technical-interview'], ['<candidate_experience>', 'technical interview', 'salary_intelligence'], 'technical-interview');
  assertIncludesAll(MODE_PROMPTS.general, ['<candidate_experience>', 'do not invent', 'salary_intelligence'], 'general');
});

test('mode formatting contracts prevent coachy meta-output in live suggestions', () => {
  assertIncludesAll(MODE_PROMPTS.sales, ['DO NOT use meta-labels', 'No preamble', 'Under 3 sentences'], 'sales');
  assertIncludesAll(MODE_PROMPTS['looking-for-work'], ['first person', 'No preamble', 'ready to deliver'], 'looking-for-work');
  assertIncludesAll(MODE_PROMPTS['technical-interview'], ['glance-and-go', 'fenced', 'complexity'], 'technical-interview');
  assertIncludesAll(MODE_PROMPTS.recruiting, ['Do NOT speak as the candidate', 'third-person observer'], 'recruiting');
  assertIncludesAll(MODE_PROMPTS.lecture, ['NOT the student speaking', 'plain language'], 'lecture');
});
