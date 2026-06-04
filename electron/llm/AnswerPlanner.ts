import type { IntentResult } from './IntentClassifier';
import type { ExtractedQuestion } from './transcriptQuestionExtractor';
import { CODING_CONTRACT, CODING_VERIFICATION_INSTRUCTION } from './codingContract';

export type AnswerType =
  | 'identity_answer'
  | 'profile_fact_answer'
  | 'project_answer'
  | 'skills_answer'
  | 'skill_experience_answer'
  | 'experience_answer'
  | 'jd_fit_answer'
  | 'behavioral_interview_answer'
  | 'coding_question_answer'
  | 'dsa_question_answer'
  | 'technical_concept_answer'
  | 'system_design_answer'
  | 'debugging_question_answer'
  | 'negotiation_answer'
  | 'sales_answer'
  | 'lecture_answer'
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

// CS/technical subject terms that, when combined with explain/what-is framing,
// mark a generic technical-concept question (no profile). Deliberately broad —
// the gate is "explain/what-is + (a DSA term OR one of these)", so a plain
// profile question like "what is my name" never reaches here (IDENTITY wins
// first), and "what projects have I done" lacks both a DSA term and these.
const TECHNICAL_SUBJECT_PATTERNS = [
  /\b(deadlock|mutex|semaphore|thread|process|concurrency|race condition)\b/i,
  /\b(tcp|udp|http|https|dns|ip|osi|latency|throughput|socket)\b/i,
  /\b(database|index|normalization|acid|transaction|sharding|replication)\b/i,
  /\b(amortized|complexity|big[- ]?o|asymptotic|np[- ]?complete)\b/i,
  /\b(closure|hoisting|prototype|garbage collection|event loop|promise|async)\b/i,
  /\b(rest|graphql|grpc|microservice|monolith|cache|cdn|load balanc)\b/i,
  /\b(encryption|hashing|oauth|jwt|tls|ssl|cors|xss|csrf|sql injection)\b/i,
  /\b(pointer|reference|stack|heap|recursion|iteration|polymorphism|inheritance)\b/i,
];
const isLikelyTechnicalConcept = (text: string): boolean => includesAny(text, TECHNICAL_SUBJECT_PATTERNS);

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
  // Both "my name" (manual/user asking) and "your name" (interviewer asking the
  // candidate) — spec §1/§11 require both. The candidate-voice perspective is
  // decided separately from the answerType, so "your name" still answers
  // "My name is ..." in first person when an interviewer asks.
  /\bwhat(?:'s| is) (my|your) name\b/i,
  /\bwho am i\b/i,
  /\bwho are you\b/i,
  /\bintroduce yourself\b/i,
  /\btell me about yourself\b/i,
  /\bstate your name\b/i,
  /\bwhat(?:'s| is) your (full )?name\b/i,
];

const JD_FIT_PATTERNS = [
  /\bwhy (this role|this company|us|our company|are you a good fit)\b/i,
  // "Why do you want to work here / for us / at <company>" — the canonical
  // company-motivation interview question (spec §11.11). Profile + JD/company
  // context, NOT a generic meeting answer.
  /\bwhy (do|would) (you|i) want to (work|join)\b/i,
  /\bwhy (do you )?want to work (here|with us|for us|for this)\b/i,
  /\bfit (for|this|the) (this |the )?role\b|\bmatch(?:es)? the job\b/i,
  /\b(why|how) (do |would |are )?(you|i) (a good )?fit\b/i,
  /\bhow (do|would|can) (i|you) fit\b/i,
  /\bgood fit for\b|\bright (fit|candidate) for\b|\bsuited (for|to) (this|the) (role|job|position)\b/i,
  /\bhow.*experience.*(role|job|position)\b/i,
  // "how do I fit this <role> JD/role/position" and tailoring asks against the JD.
  /\bfit (this|the|that) (data analyst |[a-z ]+)?(role|job|position|jd|description)\b/i,
  /\b(tailor|match|align) (my |the )?(answer|resume|experience|skills?|background).*(jd|job|role|position)\b/i,
  /\b(gaps?|strengths?).*(this|the).*(jd|role|job|position|data analyst)\b/i,
];

const SKILLS_PATTERNS = [/\b(skills|tools|technologies|frameworks|tech stack)\b/i];
// Spec Case F exception: "have you used / worked with / do you know <tech>" is a
// SKILL-EXPERIENCE question about the USER (profile YES, first person) — NOT a
// generic technical concept. This must be checked BEFORE coding/DSA patterns so
// "have you used a hashmap?" routes to skills, not to the coding contract.
const SKILL_EXPERIENCE_PATTERNS = [
  /\bhave you (ever )?(used|worked with|worked on|built with|written|coded in|programmed in)\b/i,
  /\bdo you (know|have experience (with|in)|use)\b/i,
  /\bare you (familiar|comfortable|proficient|experienced) (with|in)\b/i,
  /\byour experience (with|in|using)\b/i,
  /\bhow (much |many years )?(experience|familiar).*\b(with|in|using)\b/i,
  /\bever (used|worked with|built)\b/i,
];
// Generic technical-concept questions ("explain BFS", "what is a deadlock") —
// no profile, generic_ai voice. Distinct from coding (which asks to WRITE code)
// and from skill_experience (which asks about the USER). Checked only when there
// is no coding verb and no skill-experience framing.
const TECHNICAL_CONCEPT_PATTERNS = [
  /\b(explain|what(?:'s| is| are)|describe|how does|how do|define|difference between|compare)\b/i,
];
const PROJECT_PATTERNS = [/\b(project|projects|built|shipped|worked on)\b/i];
const EXPERIENCE_PATTERNS = [/\bexperience|background|previous role|last role|work history|internship|interned|worked at|time at\b/i];
const BEHAVIORAL_PATTERNS = [/\btell me about a time\b|\bdescribe a situation\b|\bexample of when\b|\bconflict\b|\bfailure\b|\bchallenge\b/i];
// Sales: pricing/product/competitor/objection questions (spec Case G). Uses sales
// context, NOT resume/JD/negotiation. The active mode also signals sales, but the
// answerType lets the selector exclude resume/salary regardless of mode.
const SALES_PATTERNS = [
  /\b(pricing|price|cost|expensive|cheaper|discount|quote|deal|contract)\b/i,
  /\bcompare(?:d)? to (your )?competitor|vs\.? (a )?competitor|competitor\b/i,
  /\b(your|the) product\b.*\b(do|offer|cost|price|compare|better|why)\b/i,
  /\bwhy (should|would) (i|we) (buy|choose|pick|go with)\b/i,
  /\b(roi|return on investment|value proposition|use case)\b/i,
];
// Lecture: questions about lecture/slide/lecture material (spec Case H). Uses
// lecture materials + screen + reference files, NOT resume/JD/negotiation.
const LECTURE_PATTERNS = [
  /\b(this slide|the slide|lecture slide|this diagram|the diagram|the professor|the lecturer|the lecture|lecture)\b/i,
  /\bwhat (did|does) (the )?(professor|lecturer|teacher) (mean|say)\b/i,
  /\bon (the|this) (slide|board|screen)\b/i,
];
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
    case 'technical_concept_answer':
      // Generic technical explanation — no profile, no persona. Same shape as
      // general but explicitly free of candidate framing.
      return GENERAL_TEMPLATE;
    case 'identity_answer':
    case 'profile_fact_answer':
    case 'skills_answer':
    case 'skill_experience_answer':
      return DIRECT_SHORT_TEMPLATE;
    case 'sales_answer':
    case 'lecture_answer':
      return GENERAL_TEMPLATE;
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
    case 'skill_experience_answer':
    case 'experience_answer':
    case 'behavioral_interview_answer':
      return ['resume', 'custom_context', 'ai_persona'];
    case 'jd_fit_answer':
      return ['resume', 'jd', 'custom_context', 'ai_persona'];
    case 'coding_question_answer':
    case 'dsa_question_answer':
    case 'technical_concept_answer':
    case 'system_design_answer':
    case 'debugging_question_answer':
      return ['live_transcript', 'active_mode', 'screen_context', 'preferred_language'];
    case 'negotiation_answer':
      return ['negotiation', 'jd', 'custom_context', 'ai_persona'];
    case 'sales_answer':
      return ['custom_context', 'reference_files', 'active_mode', 'ai_persona'];
    case 'lecture_answer':
      return ['live_transcript', 'screen_context', 'reference_files', 'active_mode'];
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
    case 'technical_concept_answer':
    case 'system_design_answer':
    case 'debugging_question_answer':
      // Spec §8.3: generic coding/technical answers must NOT use any profile.
      return ['resume', 'jd', 'negotiation', 'custom_context', 'reference_files'];
    case 'skill_experience_answer':
    case 'skills_answer':
    case 'profile_fact_answer':
      // About the user's own facts — resume YES, but not JD/negotiation (spec §8:
      // negotiation context only for salary answers).
      return ['jd', 'negotiation', 'reference_files'];
    case 'project_answer':
    case 'experience_answer':
    case 'behavioral_interview_answer':
      // Profile narrative answers — never the negotiation/salary layer.
      return ['negotiation'];
    case 'jd_fit_answer':
      return ['negotiation'];
    case 'negotiation_answer':
      return ['reference_files'];
    case 'sales_answer':
      // Sales answers must not pull the user's resume/JD or negotiation/salary.
      return ['resume', 'jd', 'negotiation'];
    case 'lecture_answer':
      // Lecture answers must not pull resume/JD/negotiation.
      return ['resume', 'jd', 'negotiation'];
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

  // Skill-experience framing ("have you used X?", "do you know X?") is about the
  // USER, so it must win BEFORE coding/DSA/technical patterns — otherwise
  // "have you used a hashmap?" mis-routes to the coding contract. It still yields
  // to explicit negotiation/identity (those are higher-priority profile asks).
  const hasSkillExperienceFraming = includesAny(text, SKILL_EXPERIENCE_PATTERNS);

  if (!question) {
    answerType = 'unknown_answer';
  } else if (includesAny(text, NEGOTIATION_PATTERNS)) {
    answerType = 'negotiation_answer';
  } else if (includesAny(text, IDENTITY_PATTERNS) || extractedType === 'identity') {
    answerType = 'identity_answer';
  } else if (hasSkillExperienceFraming && !includesAny(text, SYSTEM_DESIGN_PATTERNS)) {
    // "Have you used WebRTC / a hashmap / AWS?" → profile skill-experience answer
    // in first person. Wins over coding/DSA/technical-concept routing below.
    answerType = 'skill_experience_answer';
  } else if (includesAny(text, SALES_PATTERNS)) {
    answerType = 'sales_answer';
  } else if (includesAny(text, LECTURE_PATTERNS)) {
    answerType = 'lecture_answer';
  } else if (includesAny(text, SYSTEM_DESIGN_PATTERNS)) {
    answerType = 'system_design_answer';
  } else if (includesAny(text, DEBUGGING_PATTERNS) && !includesAny(text, DSA_PATTERNS)) {
    answerType = 'debugging_question_answer';
  } else if (includesAny(text, TECHNICAL_CONCEPT_PATTERNS) &&
             !includesAny(text, CODING_PATTERNS) &&
             (includesAny(text, DSA_PATTERNS) || isLikelyTechnicalConcept(text))) {
    // "Explain BFS", "what is a deadlock", "difference between TCP and UDP" —
    // generic technical CONCEPT, NO profile, generic_ai voice (spec Case F).
    // Checked before DSA/coding: a DSA noun with explain/what-is framing and NO
    // coding verb ("write/implement/solve") is a concept, not a coding task.
    answerType = 'technical_concept_answer';
  } else if (includesAny(text, DSA_PATTERNS)) {
    // Named DSA problem ("two sum", "reverse a linked list", "solve two sum").
    // Kept BEFORE generic CODING so the specific DSA label/template wins.
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
  // Generic technical/coding/sales/lecture answers are NEVER the candidate's
  // first-person voice — even when an interviewer asks them. "Explain BFS" from
  // an interviewer wants a technical explanation, not "I would say BFS is...".
  // Only profile-directed answer types speak as the candidate (spec §5 perspective).
  const nonCandidateVoiceTypes: AnswerType[] = [
    'coding_question_answer', 'dsa_question_answer', 'technical_concept_answer',
    'system_design_answer', 'debugging_question_answer', 'sales_answer',
    'lecture_answer', 'general_meeting_answer',
  ];
  const outputPerspective: OutputPerspective = nonCandidateVoiceTypes.includes(answerType)
    ? (input.source === 'manual_input' ? 'assistant_explanation' : 'assistant_explanation')
    : speakerPerspective === 'interviewer'
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
