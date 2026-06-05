// electron/llm/ProfileOutputValidator.ts
//
// Spec §7 / acceptance §12.9: deterministic POST-GENERATION validation of profile
// answers. The model is instructed at prompt time to follow the perspective and
// grounding rules, but instructions are not guarantees — this module VERIFIES the
// output and reports violations so the caller can repair or fall back.
//
// It is pure and content-free of any profile data: it inspects the generated
// answer text against the AnswerPlan (which carries answerType, perspective, and
// forbidden context layers) plus a small set of facts about what context was
// available. No LLM, no I/O — cheap enough for the live path.
//
// Failure modes it catches (all from the spec):
//   1. Wrong perspective: a profile answer that should be first-person ("My name
//      is...") but speaks in third person or as the assistant.
//   2. Assistant-identity leak: a profile/identity answer that says "I am
//      Natively" / "I'm an AI assistant" when the interviewer asked the CANDIDATE.
//   3. False "no access" / "no experience" refusal when the profile EXISTS.
//   4. Sensitive/salary leak in a non-salary answer.
//   5. Resume/JD leak in a generic coding/technical answer.

import type { AnswerPlan, AnswerType, OutputPerspective } from './AnswerPlanner';

export type ProfileViolationCode =
  | 'wrong_perspective_not_first_person'
  | 'assistant_identity_leak'
  | 'false_no_access_refusal'
  | 'false_no_experience_refusal'
  | 'sensitive_salary_leak'
  | 'profile_in_generic_answer';

export interface ProfileViolation {
  code: ProfileViolationCode;
  /** Human-readable detail for telemetry/logs (no raw profile content). */
  detail: string;
  /** Whether this should trigger a repair/fallback (vs a soft warning). */
  severity: 'error' | 'warning';
}

export interface ProfileValidationInput {
  answer: string;
  plan: Pick<AnswerPlan, 'answerType' | 'outputPerspective' | 'forbiddenContextLayers'>;
  /** True when a candidate profile (resume/identity) is loaded and usable. */
  profileAvailable: boolean;
  /** True when the question is directed at the candidate (interviewer asking). */
  candidateDirected: boolean;
}

export interface ProfileValidationResult {
  ok: boolean;
  violations: ProfileViolation[];
  /** Convenience: the error-severity violation codes only. */
  errorCodes: ProfileViolationCode[];
}

// Answer types that speak AS the candidate (first person) when interviewer-directed.
const PROFILE_ANSWER_TYPES: ReadonlySet<AnswerType> = new Set<AnswerType>([
  'identity_answer', 'profile_fact_answer', 'project_answer', 'project_followup_answer',
  'skills_answer', 'skill_experience_answer', 'experience_answer', 'jd_fit_answer',
  'behavioral_interview_answer', 'negotiation_answer',
]);

const isProfileAnswerType = (t: AnswerType): boolean => PROFILE_ANSWER_TYPES.has(t);

// "I am Natively" / "I'm an AI assistant" — the assistant identity leaking into a
// candidate answer. Distinct from the candidate legitimately saying "I" or stating
// a real job title ("I'm an AI Engineer", "I'm an AI & Full Stack Engineer"): the
// "an AI" clause requires it NOT be followed by an engineering/role word, so a job
// title is not a false positive (Issue 2).
const ASSISTANT_IDENTITY_RE =
  /\bI(?:'m| am)\s+Natively\b|\bI(?:'m| am)\s+an?\s+(?:AI\s+)?(?:assistant|language model|chat\s?bot)\b|\bI(?:'m| am)\s+an\s+AI\b(?!\s*(?:and|engineer|developer|intern|specialist|enthusiast)\b)(?![\s]*[&/,])|\bas\s+an\s+AI(?:\s+(?:language\s+)?model)?,?\s+I\b/i;
const NATIVELY_SELF_RE = /\b(?:I am|I'm|as)\s+Natively\b/i;

// "I don't have access to your..." / "I don't know your name" / "I can't share
// that information" / "I don't have your resume/profile/JD loaded" — false-refusal
// failures when the profile IS present (benchmark 2026-06-05 what-to-answer mode).
const NO_ACCESS_RE =
  /\bI\s+(?:do(?:n'?t| not)|cannot|can'?t)\s+(?:have\s+access\s+to|access)\b|\bI\s+do(?:n'?t| not)\s+(?:have|know)\s+(?:your|the user'?s|that)\b|\bno\s+access\s+to\s+(?:your|the user'?s|personal)\b|\bI\s+(?:cannot|can'?t)\s+share\s+(?:that|this|your|personal)\b|\bI\s+do(?:n'?t| not)\s+have\s+(?:the\s+)?(?:specific\s+)?(?:job\s+description|jd|resume|profile|past\s+experience)\b(?:\s+loaded)?|\bI\s+do(?:n'?t| not)\s+have\s+(?:specific\s+)?past\s+experience\s+loaded\b/i;

// "I don't have personal experience" / "as an AI I haven't" / "I don't have a
// story loaded" / "if that matches my background" — false no-experience phrasings
// banned when the profile contains experience (Issue 6, spec ban-list).
const NO_EXPERIENCE_RE =
  /\bI\s+do(?:n'?t| not)\s+have\s+(?:personal\s+|any\s+|a\s+)?(?:experience|projects?|a\s+resume|a\s+background|story)\b|\bI\s+have\s+no\s+personal\s+experience\b|\bas\s+an\s+AI[, ].{0,40}\b(?:experience|cannot|can'?t)\b|\bif\s+that\s+matches\s+my\s+background\b|\bI\s+do(?:n'?t| not)\s+have\s+a\s+story\s+loaded\b/i;

// Salary/comp figures + negotiation strategy language that must not appear outside
// a negotiation answer.
const SALARY_FIGURE_RE = /(?:\$|₹|€|£)\s?\d|(?:\b\d{2,3}\s?k\b)|\b\d+\s?lpa\b|\bCTC\b/i;
const NEGOTIATION_STRATEGY_RE = /\b(counter[- ]?offer|walk\s?away|batna|anchor (?:high|to)|leverage point|minimum acceptable|target range)\b/i;

// Resume/JD leakage markers for generic (coding/technical/sales/lecture) answers.
const PROFILE_LEAK_RE = /\b(my resume|the candidate'?s resume|job description|the JD|candidate_profile|target_job)\b/i;

function firstPersonPresent(answer: string): boolean {
  return /\b(I|I'?m|I'?ve|I'?d|I'?ll|my|mine|myself|me)\b/i.test(answer);
}

function thirdPersonAboutUser(answer: string): boolean {
  // WRONG-PERSON voice for a candidate answer: either THIRD person about the user
  // ("the candidate's experience", "their projects") OR SECOND person ("your
  // name is", "you are <name>", "your experience includes") — a what-to-answer
  // candidate answer must say what the candidate says aloud, never address them.
  return /\b(the user'?s?|the candidate'?s?|their\s+(?:name|experience|background|projects?|skills?))\b/i.test(answer)
    || /\byour\s+(?:name\s+is|experience\s+(?:includes|is)|background\s+is|projects?\s+(?:include|are)|skills?\s+(?:include|are))\b/i.test(answer)
    || /\byou\s+are\s+[A-Z][a-z]+/i.test(answer); // "You are Evin ..."
}

/**
 * Validate a generated profile answer against the spec's output rules.
 * Returns ok:true with no violations when the answer is compliant.
 */
export function validateProfileOutput(input: ProfileValidationInput): ProfileValidationResult {
  const { answer, plan, profileAvailable, candidateDirected } = input;
  const text = (answer || '').trim();
  const violations: ProfileViolation[] = [];

  // Nothing to validate on an empty answer.
  if (!text) {
    return { ok: true, violations: [], errorCodes: [] };
  }

  const isProfile = isProfileAnswerType(plan.answerType);
  const wantsFirstPerson = plan.outputPerspective === 'first_person_candidate';

  // 1 & 3 & 4: profile/identity answers must never refuse access or claim no
  // experience when the profile exists, and (for identity) never claim to be
  // the assistant.
  if (isProfile && profileAvailable) {
    if (NO_ACCESS_RE.test(text)) {
      violations.push({
        code: 'false_no_access_refusal',
        detail: `${plan.answerType} answered "no access" though a profile is loaded`,
        severity: 'error',
      });
    }
    if (NO_EXPERIENCE_RE.test(text)) {
      violations.push({
        code: 'false_no_experience_refusal',
        detail: `${plan.answerType} claimed no personal experience though a profile is loaded`,
        severity: 'error',
      });
    }
  }

  // 2: assistant-identity leak — only an error when the candidate is being asked
  // (interviewer-directed identity/profile). A normal assistant chat saying "I'm
  // Natively" is fine, so gate on candidateDirected + profile answer type.
  if (isProfile && candidateDirected && (ASSISTANT_IDENTITY_RE.test(text) || NATIVELY_SELF_RE.test(text))) {
    violations.push({
      code: 'assistant_identity_leak',
      detail: `${plan.answerType} answered as the assistant ("I am Natively / an AI") instead of the candidate`,
      severity: 'error',
    });
  }

  // 1: wrong perspective — a first-person-required answer that uses third person
  // about the user and lacks first-person voice.
  if (isProfile && wantsFirstPerson) {
    if (!firstPersonPresent(text) && thirdPersonAboutUser(text)) {
      violations.push({
        code: 'wrong_perspective_not_first_person',
        detail: `${plan.answerType} should be first-person but spoke in third person about the user`,
        severity: 'error',
      });
    }
  }

  // 4: sensitive/salary leak in a NON-salary answer.
  if (plan.answerType !== 'negotiation_answer') {
    const forbidsNegotiation = plan.forbiddenContextLayers.includes('negotiation');
    if (forbidsNegotiation && NEGOTIATION_STRATEGY_RE.test(text)) {
      violations.push({
        code: 'sensitive_salary_leak',
        detail: `${plan.answerType} leaked negotiation strategy language in a non-salary answer`,
        severity: 'error',
      });
    }
    // Bare salary figures are only flagged for clearly non-financial profile/coding
    // answers (identity, skills, coding) where a number is almost certainly a leak.
    const figureSensitiveTypes: AnswerType[] = [
      'identity_answer', 'skills_answer', 'skill_experience_answer',
    ];
    if (figureSensitiveTypes.includes(plan.answerType) && SALARY_FIGURE_RE.test(text)) {
      violations.push({
        code: 'sensitive_salary_leak',
        detail: `${plan.answerType} contained a salary/comp figure where none belongs`,
        severity: 'warning',
      });
    }
  }

  // 5: resume/JD leak in a generic coding/technical/sales/lecture answer.
  if (plan.forbiddenContextLayers.includes('resume') && PROFILE_LEAK_RE.test(text)) {
    violations.push({
      code: 'profile_in_generic_answer',
      detail: `${plan.answerType} referenced resume/JD in a profile-forbidden answer`,
      severity: 'error',
    });
  }

  const errorCodes = violations.filter(v => v.severity === 'error').map(v => v.code);
  return { ok: errorCodes.length === 0, violations, errorCodes };
}

/**
 * Build a terse corrective instruction the caller can append to a regeneration
 * prompt when validation fails. Content-free of profile data — names the rule to
 * fix, not the data. Returns '' when there are no error-severity violations.
 */
export function buildProfileRepairInstruction(result: ProfileValidationResult): string {
  if (result.ok) return '';
  const lines: string[] = [];
  for (const code of new Set(result.errorCodes)) {
    switch (code) {
      case 'false_no_access_refusal':
        lines.push('- You DO have the user\'s profile. Answer the question directly from it; never say you lack access to their information.');
        break;
      case 'false_no_experience_refusal':
        lines.push('- The user\'s real experience is in the profile. Answer from it; never claim you have no personal experience.');
        break;
      case 'assistant_identity_leak':
        lines.push('- Answer AS the candidate in first person ("My name is ...", "I worked on ..."). Never say you are Natively or an AI.');
        break;
      case 'wrong_perspective_not_first_person':
        lines.push('- Use first person ("I", "my"). Do not describe the user in third person.');
        break;
      case 'sensitive_salary_leak':
        lines.push('- Remove all salary, compensation, and negotiation-strategy details; they do not belong in this answer.');
        break;
      case 'profile_in_generic_answer':
        lines.push('- This is a technical answer. Remove any mention of the resume, job description, or personal profile.');
        break;
    }
  }
  return lines.length
    ? `Your previous answer broke these rules. Regenerate, fixing ONLY these:\n${lines.join('\n')}`
    : '';
}
