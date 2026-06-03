import type { IntentResult } from './IntentClassifier';
import type { ExtractedQuestion } from './transcriptQuestionExtractor';
import { CODING_CONTRACT, CODING_VERIFICATION_INSTRUCTION } from './codingContract';

export type AnswerType =
  | 'identity_answer'
  | 'profile_fact_answer'
  | 'project_answer'
  | 'skills_answer'
  | 'experience_answer'
  | 'jd_fit_answer'
  | 'behavioral_interview_answer'
  | 'coding_question_answer'
  | 'dsa_question_answer'
  | 'system_design_answer'
  | 'debugging_question_answer'
  | 'negotiation_answer'
  | 'follow_up_answer'
  | 'unknown_answer'
  | 'general_meeting_answer';

export type AnswerSource = 'manual_input' | 'what_to_answer' | 'transcript' | 'system';
export type SpeakerPerspective = 'candidate' | 'interviewer' | 'user' | 'assistant' | 'unknown';
export type OutputPerspective = 'first_person_candidate' | 'second_person_user' | 'assistant_explanation';
export type ContextLayer =
  | 'stable_identity'
  | 'resume'
  | 'jd'
  | 'custom_context'
  | 'ai_persona'
  | 'negotiation'
  | 'reference_files'
  | 'live_transcript'
  | 'prior_assistant_responses'
  | 'active_mode'
  | 'screen_context'
  | 'preferred_language';

export interface AnswerPlan {
  answerType: AnswerType;
  source: AnswerSource;
  speakerPerspective: SpeakerPerspective;
  outputPerspective: OutputPerspective;
  requiredContextLayers: ContextLayer[];
  forbiddenContextLayers: ContextLayer[];
  responseTemplate: string;
  /**
   * Latency budget for the first useful token, in ms (the target the live path
   * is held to). Named per REPORT_TO_CHATGPT Phase 5; `maxInitialLatencyMs` is
   * kept as a deprecated alias for any external reader.
   */
  maxFirstUsefulTokenMs: number;
  /** @deprecated alias of maxFirstUsefulTokenMs — kept for compatibility. */
  maxInitialLatencyMs: number;
  requiresLLM: boolean;
  canUseFastPath: boolean;
  /**
   * True for structured answer types (coding/DSA/system-design/debugging) where
   * the UI must paint a deterministic section scaffold BEFORE any model token,
   * so the user never sees code-first / malformed markdown mid-stream.
   */
  shouldShowImmediateScaffold: boolean;
  question: string;
  confidence: number;
}

export interface PlanAnswerInput {
  question?: string | null;
  source: AnswerSource;
  speakerPerspective?: SpeakerPerspective;
  extractedQuestion?: ExtractedQuestion | null;
  intentResult?: IntentResult | null;
  hasCandidateProfile?: boolean;
  hasJobDescription?: boolean;
  hasNegotiationContext?: boolean;
}

// Derives from the single canonical CODING_CONTRACT (codingContract.ts) so the
// planner's template can never drift from the prompts/validator. Adds the two
// answer-contract rules that are planner-specific (no context leakage, no
// Natively mention) on top of the shared section spec.
// NOTE: the hidden <verification_spec> instruction is appended at PROMPT-BUILD
// time (formatAnswerPlanForPrompt) only when code verification is enabled, so a
// disabled kill-switch also stops the model wasting tokens emitting the spec.
// Keeping it OUT of this base template also keeps AnswerPlanner pure/testable.
const CODING_TEMPLATE = `You are generating a live coding interview answer.

${CODING_CONTRACT}

Additional rules:
- Do not include resume, JD, salary, negotiation, or unrelated profile context unless explicitly asked.
- Do not mention Natively.`;

const BEHAVIORAL_TEMPLATE = `Use exactly these sections:

Direct Answer:
[One clear first-person answer.]

Strong Example / STAR:
[Situation, task, action, result using only grounded candidate facts.]

Why It Matters For This Role:
[Connect to the role only if JD context is present.]

Short Closing Line:
[One speakable closing sentence.]`;

const JD_FIT_TEMPLATE = `Use exactly these sections:

Short Fit Summary:
[Concise fit statement.]

Matching Experience:
[Grounded candidate experience relevant to the role.]

Matching Skills/Projects:
[Grounded skills/projects mapped to JD needs.]

Why This Role:
[Specific motivation tied to JD/company context.]

Speakable Final Answer:
[Polished first-person answer the candidate can say.]`;

const NEGOTIATION_TEMPLATE = `Use exactly these sections:

Polite Opening:
[Acknowledge the question or offer professionally.]

Flexible Range / Expectation:
[State grounded target/range if available, otherwise preserve flexibility.]

Justification:
[Brief value-based justification.]

Closing:
[Collaborative next step.]`;

const SYSTEM_DESIGN_TEMPLATE = `Use exactly these sections:

Clarify Requirements:
[State the most important assumptions or questions.]

High-Level Design:
[Architecture overview.]

Core Components:
[Main services/components and responsibilities.]

Data Flow:
[How requests/data move through the system.]

Scaling / Reliability:
[Scale, fault tolerance, observability.]

Tradeoffs:
[Key design tradeoffs.]

Follow-up Points:
[Likely interviewer follow-ups.]`;

const DEBUGGING_TEMPLATE = `Use exactly these sections:

Likely Cause:
[Most probable root cause.]

How I Would Investigate:
[Concrete debugging steps.]

Fix:
[Specific fix or mitigation.]

Validation:
[How to prove it works.]

Prevention:
[How to prevent recurrence.]`;

const DIRECT_SHORT_TEMPLATE = `Answer directly in 1-2 sentences. Do not include irrelevant context. Do not mention loaded context.`;
const GENERAL_TEMPLATE = `Answer naturally and directly. Use only relevant context. Keep it predictable and concise.`;

const includesAny = (text: string, patterns: RegExp[]): boolean => patterns.some(pattern => pattern.test(text));

const DSA_PATTERNS = [
  /\btwo\s*sum\b/i,
  /\blongest substring\b/i,
  /\breverse (a )?linked list\b/i,
  /\blinked list\b/i,
  /\bbinary search\b/i,
  /\bsliding window\b/i,
  /\btwo pointers?\b/i,
  /\bhash\s?(map|set|table)\b/i,
  /\bstack\b|\bqueue\b|\bheap\b|\btrie\b/i,
  /\bgraph\b|\btree\b|\bbfs\b|\bdfs\b/i,
  /\bdynamic programming\b|\bdp\b|\bmemoization\b/i,
  /\bbacktracking\b|\brecursion\b|\bunion[- ]find\b/i,
  /\btime complexity\b|\bspace complexity\b|\bbig[- ]?o\b/i,
];

const COMMON_CODING_PROBLEM_PATTERNS = [
  /\bodd\s*(?:\/|or|and|even)?\s*even\b|\beven\s*(?:\/|or|and)?\s*odd\b/i,
  /\b(check|find|determine|detect)\b.*\b(odd|even)\b/i,
  /\bprime number\b|\bpalindrome\b|\bfactorial\b|\bfibonacci\b/i,
  /\breverse string\b|\bsort array\b|\bfind (?:max|min)\b/i,
  /\bcheck if\b/i,
  // Named classic problems that lack an explicit coding verb. These are
  // unambiguously DSA/coding asks ("valid parentheses", "fizzbuzz") so the
  // planner must route them to the coding contract even when phrased bare.
  /\bvalid parentheses\b|\bbalanced parentheses\b|\bmatching brackets\b/i,
  /\bfizz\s?buzz\b/i,
  /\banagram\b|\bsubarray\b|\bsubstring\b/i,
  /\bmerge (?:two )?(?:sorted )?(?:arrays?|lists?)\b/i,
  /\b(?:detect|find)\b.*\bcycle\b|\blinked list cycle\b/i,
  /\blevel order\b|\bin\s?order\b|\bpre\s?order\b|\bpost\s?order\b|\btraversal\b/i,
  /\bgcd\b|\blcm\b|\bgreatest common divisor\b/i,
  /\bbubble sort\b|\bquick\s?sort\b|\bmerge sort\b|\binsertion sort\b/i,
];

const CODING_PATTERNS = [
  /\b(write|implement|code|program|function|class|method|solve)\b/i,
  /\bcode for\b|\bprogram for\b|\bfunction for\b|\balgorithm for\b/i,
  /\balgorithm\b|\bdebug this\b|\bfix (this|the) bug\b/i,
  /\bjavascript\b|\btypescript\b|\bpython\b|\bjava\b|\bc\+\+\b|\bsql\b/i,
  ...COMMON_CODING_PROBLEM_PATTERNS,
];

const SYSTEM_DESIGN_PATTERNS = [
  /\bsystem design\b|\bdesign (a|an|the)\b/i,
  /\bscalable\b|\bscale\b|\barchitecture\b|\bdistributed\b/i,
  /\brate limiter\b|\burl shortener\b|\bchat system\b|\bnotification system\b/i,
];

const DEBUGGING_PATTERNS = [
  /\bdebug\b|\broot cause\b|\bwhy.*(failing|crashing|broken)\b/i,
  /\berror\b|\bexception\b|\bstack trace\b|\bbug\b/i,
];

const NEGOTIATION_PATTERNS = [
  /\bsalary\b|\bcompensation\b|\bctc\b|\boffers?\b|\boffered\b|\bpay\b|\bequity\b|\bbonus\b|\braise\b/i,
  /\bexpected\s+(range|salary|compensation)\b|\bcurrent\s+(salary|ctc)\b/i,
  // Offer/counter-offer phrasing without an explicit "salary" noun. Deliberately
  // does NOT match a bare number alone ("100k array") — only negotiation verbs —
  // so a coding question that happens to mention a size isn't mis-routed.
  /\bcounter(?:\s*-?\s*offer|ing|\b)|\bnegotiat\w*\b|\blow\s?ball\b|\bwalk\s?away\b|\bbatna\b/i,
  /\b(lpa|\d\s?k)\b.*\b(counter|offer|salary|negotiat\w*|expect)\b|\b(counter|offer|salary|negotiat\w*|expect)\b.*\b(lpa|\d\s?k)\b/i,
];

const IDENTITY_PATTERNS = [
  /\bwhat(?:'s| is) my name\b/i,
  /\bwho am i\b/i,
  /\bintroduce yourself\b/i,
  /\btell me about yourself\b/i,
  /\bstate your name\b/i,
];

const JD_FIT_PATTERNS = [
  /\bwhy (this role|us|our company|are you a good fit)\b/i,
  /\bfit (for|this|the) (this |the )?role\b|\bmatch(?:es)? the job\b/i,
  /\b(why|how) (do |would |are )?you (a good )?fit\b/i,
  /\bgood fit for\b|\bright (fit|candidate) for\b|\bsuited (for|to) (this|the) (role|job|position)\b/i,
  /\bhow.*experience.*(role|job|position)\b/i,
];

const SKILLS_PATTERNS = [/\b(skills|tools|technologies|frameworks|tech stack)\b/i];
const PROJECT_PATTERNS = [/\b(project|projects|built|shipped|worked on)\b/i];
const EXPERIENCE_PATTERNS = [/\bexperience|background|previous role|last role|work history\b/i];
const BEHAVIORAL_PATTERNS = [/\btell me about a time\b|\bdescribe a situation\b|\bexample of when\b|\bconflict\b|\bfailure\b|\bchallenge\b/i];
const FOLLOW_UP_PATTERNS = [/\b(that|this) (project|approach|answer|solution)\b|\bcan you (expand|optimize|dry run|explain)\b|\bwhat about complexity\b|\bwhy did you choose\b/i];

const templateFor = (answerType: AnswerType): string => {
  switch (answerType) {
    case 'coding_question_answer':
    case 'dsa_question_answer':
      return CODING_TEMPLATE;
    case 'behavioral_interview_answer':
    case 'project_answer':
    case 'experience_answer':
      return BEHAVIORAL_TEMPLATE;
    case 'jd_fit_answer':
      return JD_FIT_TEMPLATE;
    case 'negotiation_answer':
      return NEGOTIATION_TEMPLATE;
    case 'system_design_answer':
      return SYSTEM_DESIGN_TEMPLATE;
    case 'debugging_question_answer':
      return DEBUGGING_TEMPLATE;
    case 'identity_answer':
    case 'profile_fact_answer':
    case 'skills_answer':
      return DIRECT_SHORT_TEMPLATE;
    default:
      return GENERAL_TEMPLATE;
  }
};

const requiredLayersFor = (answerType: AnswerType): ContextLayer[] => {
  switch (answerType) {
    case 'identity_answer':
      return ['stable_identity', 'resume'];
    case 'profile_fact_answer':
    case 'project_answer':
    case 'skills_answer':
    case 'experience_answer':
    case 'behavioral_interview_answer':
      return ['resume', 'custom_context', 'ai_persona'];
    case 'jd_fit_answer':
      return ['resume', 'jd', 'custom_context', 'ai_persona'];
    case 'coding_question_answer':
    case 'dsa_question_answer':
    case 'system_design_answer':
    case 'debugging_question_answer':
      return ['live_transcript', 'active_mode', 'screen_context', 'preferred_language'];
    case 'negotiation_answer':
      return ['negotiation', 'jd', 'custom_context', 'ai_persona'];
    case 'follow_up_answer':
      return ['live_transcript', 'prior_assistant_responses', 'active_mode'];
    default:
      return ['live_transcript', 'active_mode'];
  }
};

const forbiddenLayersFor = (answerType: AnswerType): ContextLayer[] => {
  switch (answerType) {
    case 'identity_answer':
      return ['jd', 'negotiation', 'reference_files'];
    case 'coding_question_answer':
    case 'dsa_question_answer':
    case 'system_design_answer':
    case 'debugging_question_answer':
      return ['resume', 'jd', 'negotiation', 'custom_context', 'reference_files'];
    case 'jd_fit_answer':
      return ['negotiation'];
    case 'negotiation_answer':
      return ['reference_files'];
    default:
      return [];
  }
};

export const isCodingAnswerType = (answerType: AnswerType): boolean =>
  answerType === 'coding_question_answer' || answerType === 'dsa_question_answer';

export const planAnswer = (input: PlanAnswerInput): AnswerPlan => {
  const rawQuestion = input.question || input.extractedQuestion?.latestQuestion || '';
  const question = rawQuestion.trim();
  const text = question.toLowerCase();
  const extractedType = input.extractedQuestion?.questionType;

  let answerType: AnswerType = 'general_meeting_answer';

  if (!question) {
    answerType = 'unknown_answer';
  } else if (includesAny(text, NEGOTIATION_PATTERNS)) {
    answerType = 'negotiation_answer';
  } else if (includesAny(text, IDENTITY_PATTERNS) || extractedType === 'identity') {
    answerType = 'identity_answer';
  } else if (includesAny(text, SYSTEM_DESIGN_PATTERNS)) {
    answerType = 'system_design_answer';
  } else if (includesAny(text, DEBUGGING_PATTERNS) && !includesAny(text, DSA_PATTERNS)) {
    answerType = 'debugging_question_answer';
  } else if (includesAny(text, DSA_PATTERNS)) {
    answerType = 'dsa_question_answer';
  } else if (includesAny(text, CODING_PATTERNS) || input.intentResult?.intent === 'coding') {
    answerType = 'coding_question_answer';
  } else if (includesAny(text, JD_FIT_PATTERNS) || extractedType === 'jd_alignment') {
    answerType = 'jd_fit_answer';
  } else if (includesAny(text, BEHAVIORAL_PATTERNS) || extractedType === 'behavioral') {
    answerType = 'behavioral_interview_answer';
  } else if (includesAny(text, PROJECT_PATTERNS)) {
    answerType = 'project_answer';
  } else if (includesAny(text, SKILLS_PATTERNS)) {
    answerType = 'skills_answer';
  } else if (includesAny(text, EXPERIENCE_PATTERNS) || extractedType === 'profile_detail') {
    answerType = 'experience_answer';
  } else if (includesAny(text, FOLLOW_UP_PATTERNS) || extractedType === 'follow_up') {
    answerType = 'follow_up_answer';
  } else if (input.source === 'manual_input') {
    answerType = 'unknown_answer';
  }

  const speakerPerspective = input.speakerPerspective
    || (input.source === 'what_to_answer' || input.source === 'transcript' ? 'interviewer' : 'user');
  const outputPerspective: OutputPerspective = speakerPerspective === 'interviewer'
    ? 'first_person_candidate'
    : input.source === 'manual_input'
      ? 'second_person_user'
      : 'assistant_explanation';

  const fastPathTypes: AnswerType[] = ['identity_answer', 'profile_fact_answer'];
  const latencyMs = isCodingAnswerType(answerType) || answerType === 'system_design_answer'
    ? 2500
    : fastPathTypes.includes(answerType)
      ? 800
      : 1500;

  return {
    answerType,
    source: input.source,
    speakerPerspective,
    outputPerspective,
    requiredContextLayers: requiredLayersFor(answerType),
    forbiddenContextLayers: forbiddenLayersFor(answerType),
    responseTemplate: templateFor(answerType),
    maxFirstUsefulTokenMs: latencyMs,
    maxInitialLatencyMs: latencyMs, // deprecated alias
    requiresLLM: !fastPathTypes.includes(answerType),
    canUseFastPath: fastPathTypes.includes(answerType),
    shouldShowImmediateScaffold: shouldScaffold(answerType),
    question,
    confidence: Math.max(input.intentResult?.confidence || input.extractedQuestion?.confidence || 0.7, 0),
  };
};

/**
 * Structured answer types whose UI must paint a deterministic section scaffold
 * BEFORE any model token. Coding/DSA use the six-section coding contract;
 * system-design and debugging use their own sectioned templates. For these, the
 * live path must never stream raw code-first tokens (REPORT hypothesis C1).
 */
export const shouldScaffold = (answerType: AnswerType): boolean =>
  answerType === 'coding_question_answer'
  || answerType === 'dsa_question_answer'
  || answerType === 'system_design_answer'
  || answerType === 'debugging_question_answer';

/**
 * Render the plan as the prompt's answer-contract block. When
 * `includeVerificationSpec` is true (code verification enabled) AND this is a
 * coding/DSA answer, the hidden <verification_spec> instruction is appended so
 * the model emits test cases; when false (kill-switch off), it's omitted so no
 * tokens are wasted on a spec nothing will run.
 */
export const formatAnswerPlanForPrompt = (plan: AnswerPlan, includeVerificationSpec = false): string => {
  const verificationBlock = (includeVerificationSpec && isCodingAnswerType(plan.answerType))
    ? `\n\n${CODING_VERIFICATION_INSTRUCTION}`
    : '';
  return `<answer_contract>
answerType: ${plan.answerType}
source: ${plan.source}
speakerPerspective: ${plan.speakerPerspective}
outputPerspective: ${plan.outputPerspective}
requiredContextLayers: ${plan.requiredContextLayers.join(', ') || 'none'}
forbiddenContextLayers: ${plan.forbiddenContextLayers.join(', ') || 'none'}
maxInitialLatencyMs: ${plan.maxInitialLatencyMs}

STRICT RESPONSE TEMPLATE:
${plan.responseTemplate}${verificationBlock}
</answer_contract>`;
};
