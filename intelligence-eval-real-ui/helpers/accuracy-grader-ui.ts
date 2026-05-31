// intelligence-eval-real-ui/helpers/accuracy-grader-ui.ts
// Grades the REAL UI-visible answer text. Same 10-rule contract proven in the
// real-API grader, operating on the DOM-visible answer. Punctuation/space-
// insensitive fact matching (a real model paraphrases codenames). anyOfFacts
// supports "list/one" questions. Forbidden facts + assistant-identity = hard fail.

export interface UiTestCase {
  testId: string; profileId: string; mode: 'manual_input' | 'what_to_answer'; pattern: string;
  question?: string; transcript?: string;
  expectedPerspective: 'first_person' | 'second_person'; expectedSpeaker?: string;
  requiredFacts: string[]; anyOfFacts?: string[]; forbiddenFacts: string[];
  expectedLayers: string[]; excludedLayers: string[];
  missingInfo?: string; mustAdmitMissing?: boolean; followUpTarget?: string; isFollowUp?: boolean;
  critical?: boolean; personaNoInvention?: boolean;
}

export interface UiGrade { passed: boolean; score: number; failReasons: string[];
  requiredFactsFound: string[]; missingRequiredFacts: string[]; forbiddenFactsFound: string[];
  hallucinationFlags: string[]; perspectiveCorrect: boolean; }

const norm = (s: string) => (s || '').toLowerCase();
const spaced = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const stripped = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const factHit = (ans: string, f: string) => spaced(ans).includes(spaced(f)) || stripped(ans).includes(stripped(f));

const ADMISSIONS = ['not found','not in',"isn't in",'is not in','not available',"don't have",'do not have','not loaded',
  'not present','no record',"couldn't find",'could not find','not specified','not listed',"don't think",'honestly',
  "i haven't",'not something i','not part of',"can't share",'cannot share',"can't provide",'cannot provide',"don't recall",
  "don't remember","not able to",'unable to','no specific',"don't currently have",'off the top'];

export function gradeUiAnswer(tc: UiTestCase, answer: string): UiGrade {
  const fail: string[] = [];
  const a = norm(answer);
  const requiredFactsFound: string[] = []; const missingRequiredFacts: string[] = []; const forbiddenFactsFound: string[] = []; const hallucinationFlags: string[] = [];

  if (!answer || !/\S/.test(answer)) {
    return { passed: false, score: 0, failReasons: ['empty_answer'], requiredFactsFound, missingRequiredFacts: tc.requiredFacts || [], forbiddenFactsFound, hallucinationFlags, perspectiveCorrect: false };
  }
  for (const f of tc.requiredFacts || []) {
    if (!f) continue;
    if (factHit(answer, f)) requiredFactsFound.push(f); else { missingRequiredFacts.push(f); fail.push(`missing_required_fact:${f}`); }
  }
  if (tc.anyOfFacts?.length && !tc.anyOfFacts.some(f => factHit(answer, f))) fail.push(`missing_any_of_facts:${tc.anyOfFacts.join('|')}`);
  for (const f of tc.forbiddenFacts || []) { if (f && factHit(answer, f)) { forbiddenFactsFound.push(f); fail.push(`forbidden_fact_in_answer:${f}`); } }

  let perspectiveCorrect = true;
  if (/\b(i'?m natively|i am natively|as an ai assistant|i'?m an ai|i am an ai)\b/.test(a)) { fail.push('assistant_identity_confusion'); perspectiveCorrect = false; }
  if (tc.expectedPerspective === 'first_person' && /\byour name is\b/.test(a)) { fail.push('wrong_perspective:second_person_in_live_mode'); perspectiveCorrect = false; }
  if (tc.expectedPerspective === 'second_person' && tc.pattern === 'identity_manual' && /\bmy name is\b/.test(a)) { fail.push('wrong_perspective:first_person_in_manual_mode'); perspectiveCorrect = false; }

  if ((tc.requiredFacts || []).length > 0 && /\b(what would you like|how can i (assist|help)|i have your background loaded)\b/.test(a)) fail.push('vague_answer_when_facts_exist');

  if (tc.missingInfo) {
    if (/\b\d{1,3}(\.\d+)?\s?%/.test(answer) || /\$\s?\d/.test(answer)) { hallucinationFlags.push(`hallucinated_specific:${tc.missingInfo}`); fail.push(`hallucinated_specific:${tc.missingInfo}`); }
  }
  if (tc.mustAdmitMissing && !ADMISSIONS.some(p => a.includes(p))) fail.push(`missing_not_admitted:${tc.missingInfo || 'unknown'}`);
  // Follow-up MUST address the resolved topic. Per the spec, answering a
  // follow-up about the wrong topic is release-blocking — so this is a hard fail
  // (factHit is punctuation/space-insensitive, so a paraphrase of the target
  // still counts; only a genuinely off-topic answer fails).
  if (tc.isFollowUp && tc.followUpTarget && !factHit(answer, tc.followUpTarget)) {
    fail.push(`followup_off_topic:${tc.followUpTarget}`);
  }
  if (tc.personaNoInvention && /\b\d{1,3}(\.\d+)?\s?%/.test(answer)) hallucinationFlags.push('persona_metric_present');

  const passed = fail.length === 0;
  return { passed, score: passed ? 1 : Math.max(0, 1 - fail.length / 8), failReasons: fail, requiredFactsFound, missingRequiredFacts, forbiddenFactsFound, hallucinationFlags, perspectiveCorrect };
}
