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
  | 'project_followup_answer'
  | 'coding_question_answer'
  | 'dsa_question_answer'
  | 'technical_concept_answer'
  | 'system_design_answer'
  | 'debugging_question_answer'
  | 'negotiation_answer'
  | 'sales_answer'
  | 'product_candidate_mix_answer'
  | 'lecture_answer'
  | 'follow_up_answer'
  | 'unknown_answer'
  | 'general_meeting_answer';

export type AnswerSource = 'manual_input' | 'what_to_answer' | 'transcript' | 'system';
export type SpeakerPerspective = 'candidate' | 'interviewer' | 'user' | 'assistant' | 'unknown';
export type OutputPerspective = 'first_person_candidate' | 'second_person_user' | 'assistant_explanation';

// Phase 2: voice is SEPARATE from profile-context usage. A question can need the
// candidate's first-person interview voice WITHOUT needing any profile facts
// (e.g. "how would you use GraphQL?" — speak as the candidate, but invent no
// resume). `outputPerspective` (above) is kept as a backward-compatible alias of
// `voicePerspective` for existing call sites.
export type VoicePerspective =
  | 'first_person_candidate'   // speak AS the candidate ("I would…", "I built…")
  | 'second_person_user'       // assistant telling the user about themselves ("Your name is…")
  | 'assistant_explanation'    // neutral explanation (coding, teaching, sales, lecture)
  | 'third_person_summary';    // summarising others (meeting recap)

// Phase 2: whether the user's PROFILE (resume/JD/projects/experience) may ground
// the answer. Decoupled from voice. `forbidden` is a HARD rule the execution
// path enforces (coding/technical/sales/lecture get NO profile, spec §8.3).
export type ProfileContextPolicy =
  | 'required'    // the answer is ABOUT the user — profile MUST ground it
  | 'allowed'     // profile may help but isn't mandatory (negotiation evidence, general)
  | 'forbidden';  // profile must NOT be injected (coding/technical/sales/lecture)
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
  /** @deprecated Backward-compatible alias of `voicePerspective` (Phase 2). */
  outputPerspective: OutputPerspective;
  /** Phase 2: how the answer should SPEAK (voice), independent of profile usage. */
  voicePerspective: VoicePerspective;
  /** Phase 2: whether the user's PROFILE may ground the answer (required|allowed|forbidden). */
  profileContextPolicy: ProfileContextPolicy;
  /**
   * Phase 5: the project/entity a follow-up resolves to ("how is IT developed?"
   * → "Natively"). Set for project_followup_answer; undefined otherwise. Used to
   * scope grounding to the right project node without re-asking the model.
   */
  resolvedEntity?: string;
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

// Phase 3: a dedicated PROJECT template — project questions are NOT behavioral
// STAR stories. Name the project, what was built, the (grounded) stack, the
// candidate's personal role, and a grounded outcome — never an invented metric.
const PROJECT_TEMPLATE = `Use exactly these sections:

Best / Relevant Project:
[Directly name the project from the grounded profile.]

What I Built:
[One concise first-person explanation of what the project is.]

Tech Stack:
[Technologies used — ONLY those present in the grounded project facts.]

My Role:
[What the candidate personally did. First person.]

Impact / Why It Matters:
[A grounded outcome or value. NEVER invent metrics, percentages, or numbers.]

Speakable Final Answer:
[A 2-4 sentence first-person version the candidate can say aloud.]`;

// Phase 5: project FOLLOW-UP — drilling into a project already named. Answer the
// specific drill-in (how built / role / stack / hardest part / why / learnings)
// in first person, grounded ONLY in that project's facts and the prior turn.
const PROJECT_FOLLOWUP_TEMPLATE = `You are answering a live FOLLOW-UP about a specific project the candidate already mentioned.

Rules:
- Answer the EXACT drill-in asked (how it was built, your role, the tech stack, the hardest part, why you built it, what you learned, optimisation) in FIRST PERSON.
- Stay on the SAME project being discussed; do not switch projects.
- Use ONLY grounded project facts. Never invent metrics, dates, team sizes, or technologies that are not in the project's facts.
- Keep it concise and speakable (2-5 sentences). No headers unless the question asks for a breakdown.`;

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
  // Frameworks / cloud / data-eng subjects that appear in "explain X" concept
  // asks (benchmark 2026-06-05): FastAPI, AWS EC2/S3/Lambda, indexing, dashboard,
  // pandas/numpy/spark/hadoop, A/B testing, retention/ETL/pipeline.
  /\b(fastapi|flask|django|express|node\.?js|react|next\.?js|spring)\b/i,
  /\b(aws|ec2|s3|lambda|azure|gcp|kubernetes|docker|redis|kafka)\b/i,
  /\b(indexing|pandas|numpy|spark|hadoop|etl|dataframe)\b/i,
  /\b(a\/b test|ab test|retention|cohort|regression|classification|clustering)\b/i,
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
  // A bare language name is NOT a coding signal on its own — "how would you use
  // SQL", "explain SQL", "have you used Python" are concept/experience asks, not
  // "write code" tasks. Only treat a language as coding when paired with an
  // explicit coding verb so the bare name can't hijack technical_concept /
  // skill_experience / jd_fit routing (benchmark 2026-06-05).
  /\b(write|implement|code|coding|program|snippet|function|script|reverse|sort|parse)\b[\w ,'-]*\b(javascript|typescript|python|java|c\+\+|sql|go|golang|rust)\b/i,
  /\bin (javascript|typescript|python|java|c\+\+|sql|golang|rust)\b[\w ,'-]*\b(write|code|implement|function|program)\b/i,
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
  /\bexpected\s+(range|salary|compensation|package|pay|ctc)\b|\bcurrent\s+(salary|ctc|package)\b/i,
  // "expected/expecting package", "how much package", "what package" — comp asks
  // that use "package" as the salary noun (benchmark 2026-06-05). Requires the
  // expect/how-much framing so "tech stack package" or an npm "package" never trips.
  /\b(expecting|expect|how much|what(?:'s| is)?)\s+(your\s+)?(expected\s+)?package\b/i,
  /\bpackage\s+(are|you|expectation|expecting)\b/i,
  // Offer/counter-offer phrasing without an explicit "salary" noun. Deliberately
  // does NOT match a bare number alone ("100k array") — only negotiation verbs —
  // so a coding question that happens to mention a size isn't mis-routed.
  /\bcounter(?:\s*-?\s*offer|ing|\b)|\bnegotiat\w*\b|\blow\s?ball\b|\bwalk\s?away\b|\bbatna\b/i,
  /\b(lpa|\d\s?k)\b.*\b(counter|offer|salary|negotiat\w*|expect)\b|\b(counter|offer|salary|negotiat\w*|expect)\b.*\b(lpa|\d\s?k)\b/i,
  // High-signal compensation PUSHBACK phrasings the interviewer uses ("our budget
  // is lower", "can you come down", "that's higher than we budgeted"). Specific
  // enough to avoid colliding with a PM's "project budget" — requires the comp
  // direction verb. Mirrors the premium classifier's stickiness vocabulary.
  /\bbudget is (lower|tight|limited|less|under|capped|fixed|only|around|\$|\d)\b/i,
  /\b(come down|go lower|do better) (on|with)\b|\bcan you come down\b|\bmeet (me )?in the middle\b/i,
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
  // "Walk me through your background/career/journey" — the intro/identity ask
  // (spec groups it with identity). First-person, profile required.
  /\bwalk me through your (background|experience|resume|cv|career|journey|profile)\b/i,
  // Natural intro/identity phrasings (benchmark 2026-06-05): "give me a quick
  // introduction", "what should I call you?", "how would you describe yourself
  // (professionally)?", "(can you )summarize who you are", "introduce yourself".
  /\b(give|tell)\s+(me\s+)?(a\s+)?(quick\s+|brief\s+|short\s+)?(introduction|intro|overview of yourself|rundown)\b/i,
  /\bwhat should (i|we) call you\b/i,
  /\b(how (would|do) you )?describe yourself\b/i,
  /\b(summari[sz]e|describe|tell me about) who you are\b/i,
  /\bcan you (introduce|tell me about) yourself\b/i,
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
  // "Why should we hire you?" and its variants — the canonical fit/sell question
  // (live regression 2026-06-05). Profile + JD, NOT a generic meeting answer.
  /\bwhy should (we|i|they|you) (hire|pick|choose|select|consider|take|go with|bring (on|in))\b/i,
  /\bwhat makes (you|me) (a |an |the )?(good|great|right|ideal|strong|best|perfect|standout|qualified|suitable) (fit|candidate|choice|hire|person|applicant)?\b/i,
  /\bwhat makes (you|me) (suitable|qualified|fit|right)\b/i,
  /\bwhy are (you|i)\b.*\b(right|best|good|ideal|strong|qualified|suitable)\b.*\b(candidate|fit|person|choice|applicant|role|job|position)\b/i,
  /\bwhy (do|would) (we|they) (need|want) (you|to hire)\b/i,
  /\bwhy are (you|i) qualified\b/i,
  // "How good are you FOR this job/role", "are you good/suitable/qualified/right
  // for this job/role/position" — casual fit phrasings (live audit 2026-06-05).
  /\bhow (good|suitable|qualified|fit) (are|r) (you|u) for (this|the|a|our)\b/i,
  /\bare (you|u) (good|suitable|qualified|right|fit|a good fit|the right (fit|candidate|person)) (for|to)\b/i,
  /\bare (you|u) (a )?(good|right|strong|ideal) (fit|match|candidate) (for|to)\b/i,
  // "how does your background/experience/skills match/align/fit this role"
  /\bhow (does|do|would|can) (your|my|the) (background|experience|skills?|profile|resume|qualifications?) (match|align|fit|suit|relate|map)\b/i,
  // MOTIVATION + CONTRIBUTION + fit-confidence phrasings (benchmark 2026-06-05):
  // "why do you want this job/role?", "what excites you about this role?", "how
  // can you contribute?", "what value can you bring?", "what makes you confident
  // you can do this job?", "do you think this role matches your profile?", "where
  // do you see overlap?", "how close is your background to what we're looking
  // for?". All are role-fit asks → resume+JD, first person.
  /\bwhy do (you|i) want (this|the|to work)\b/i,
  /\bwhat (excites|interests|draws|attracts) (you|me) (about|to)\b.*\b(role|job|position|company|team)\b/i,
  /\bhow (can|would|will) (you|i) (contribute|add value|help|benefit|impact)\b/i,
  /\bwhat (value|impact|contribution) (can|would|will|do) (you|i) (bring|add|make|provide|offer)\b/i,
  /\bwhat makes (you|me) confident\b/i,
  /\bdo you think (this|the) (role|job|position) (matches|fits|suits|aligns)\b/i,
  /\bwhere do (you|i) see (overlap|alignment|a (good )?(fit|match))\b/i,
  /\bhow (close|well) (is|does) (your|my) (background|experience|profile)\b/i,
  // Opinion-about-the-role → still a fit question ("what do you think about this
  // job/role/position/opportunity?") (benchmark 2026-06-05).
  /\bwhat do you think (about|of) (this|the) (job|role|position|opportunity|company)\b/i,
  /\bhow do you feel about (this|the) (job|role|position|opportunity)\b/i,
  // Casual / indirect fit phrasings that fell to unknown (benchmark 2026-06-05):
  // "convince me you are right (for this role)", "in what ways are you a match",
  // "are you the candidate we should pick", "do you fit what this Data Analyst
  // position needs", "how good are you actually for this analyst thing", "why you
  // for this job not generally this one".
  /\bconvince me\b/i,
  /\bin what ways are (you|i) (a )?(match|fit|suitable|qualified)\b/i,
  /\b(are|why are) (you|i) the (candidate|person|one) (we|they|i) should (pick|choose|select|hire|take)\b/i,
  /\bdo (you|i) fit what (this|the)\b/i,
  /\bfit what (this|the) [\w ]*(role|position|job|analyst|team) (needs?|wants?|requires?|is looking for)\b/i,
  /\bhow good are (you|u|i)\b.*\b(for this|this job|this role|this analyst|this position|this thing)\b/i,
  /\bwhy (you|u|me)\b.*\b(for this|this job|this role|this one|this position)\b/i,
  // Engineering→data-analyst BRIDGE challenges (benchmark 2026-06-05): the
  // interviewer pushes that the background doesn't match. Still a fit question —
  // answer must bridge the experience to the role honestly.
  /\b(connect|bridge|relate|map|link) (it|this|that|them|the two|your (experience|background|skills?))\b/i,
  /\b(data analyst|analyst|data)\b.*\b(connect|bridge|relate|link)\b|\b(connect|bridge|relate|link)\b.*\b(data analyst|analyst|data|role|job)\b/i,
  /\b(full[- ]?stack|engineering|engineer|backend|software)\b.*\b(different|not|but|vs|versus)\b.*\b(data analyst|analyst|data)\b/i,
  /\b(full[- ]?stack|engineering|engineer|backend|software)\b.*\b(data analyst|analyst)\b.*\b(connect|explain|bridge|why)\b/i,
  /\b(why|how) (is|does) (natively|this project|that project|your project|it)\b.*\b(relevant|prove|matter|fit|qualify|show)\b.*\b(analyst|data|role|job)?/i,
  /\b(prove|show|demonstrate) (you can|i can|that you|that i)\b.*\b(analyst|data analyst|this role|this job)\b/i,
  /\b(seem|seems|look|looks).*(engineering|engineer|technical|full[- ]?stack|not).*(why|convince|but)\b/i,
  /\b(don'?t|do not) seem like\b.*\b(analyst|fit|right)\b/i,
  /\bwhy (data|analyst|analytics)\b\??$/i,
  // Gap / readiness for the role (still JD-fit, resume+JD+gap): "what gap do you
  // have for this role", "where are you weak for this JD", "if we need SQL daily
  // how ready are you", "strongest/weakest matching skill for the JD".
  /\b(what|where|which) (gap|gaps|weak|weakness)\b.*\b(role|job|jd|position|this)\b/i,
  /\bwhat will (you|i) need to learn\b/i,
  /\b(strongest|weakest|best|main) (matching )?skill\b.*\b(jd|role|job|position)\b/i,
  /\bif (we|they) need\b.*\bhow ready\b/i,
  /\bhow ready are (you|i)\b/i,
  /\bif (we|they) need [\w ]+,? where do (you|i) stand\b/i,
  // Remaining natural/noisy fit phrasings (benchmark 2026-06-05):
  /\bwhere are (you|i) weak\b/i,
  /\bweak (for|on) (this|the) (jd|role|job|position)\b/i,
  /\bso why this (job|role|position)\b/i,            // "okay cool yeah, so why this job?"
  /\bwhy this (job|role|position)\b/i,
  /\bcompare (yourself|myself) (to|with|against) (other |the other )?(candidates?|applicants?|people)\b/i,
];

const SKILLS_PATTERNS = [
  /\b(skills|tools|technologies|frameworks|tech stack)\b/i,
  // "what programming/coding languages do you know/use?" (benchmark 2026-06-05).
  /\b(programming|coding) languages?\b/i,
  /\bwhat languages do (you|i)\b/i,
];
// Spec Case F exception: "have you used / worked with / do you know <tech>" is a
// SKILL-EXPERIENCE question about the USER (profile YES, first person) — NOT a
// generic technical concept. This must be checked BEFORE coding/DSA patterns so
// "have you used a hashmap?" routes to skills, not to the coding contract.
const SKILL_EXPERIENCE_PATTERNS = [
  /\bhave you (ever )?(used|worked with|worked on|built|built with|written|coded in|programmed in|implemented|done|created|handled|analy[sz]ed|normali[sz]ed|deployed|designed|managed)\b/i,
  /\bdo you (know|have experience (with|in)|use)\b/i,
  /\bare you (familiar|comfortable|proficient|experienced) (with|in)\b/i,
  /\byour experience (with|in|using)\b/i,
  /\bhow (much |many years )?(experience|familiar).*\b(with|in|using)\b/i,
  /\bever (used|worked with|built)\b/i,
  // "Did you actually use X / use X or just know it", "did you work with X" —
  // past-experience probes (benchmark 2026-06-05 would-vs-have, honest-evidence).
  /\bdid you (actually |really |ever )?(use|work with|work on|build|implement|write|do|handle|analy[sz]e|deal with)\b/i,
  /\b(used|worked with) [\w ]+ or just (know|knew|theoretical|theory)\b/i,
  /\bexperienced or just theoretical\b/i,
  // "How HAVE you used X", "where HAVE you used X" — explicit past usage (vs the
  // hypothetical "how WOULD you use X" which is technical_concept).
  /\bhow have (you|i) used\b/i,
  /\bwhere have (you|i) (used|worked|applied)\b/i,
];
// SKILL SELF-RATING (live regression 2026-06-05): "how would you rate your
// expertise in Python", "how good are you at React", "out of 10 rate yourself",
// "what are your coding levels", "on a scale of 1-10 how proficient are you".
// These are about the USER's own proficiency — profile, first person — NOT a
// request to WRITE code and NOT compensation. Kept SEPARATE from
// SKILL_EXPERIENCE_PATTERNS because the rating branch must win even when the
// question contains the bare word "scale" (which otherwise trips
// SYSTEM_DESIGN_PATTERNS); a self-rating question is never a system-design ask.
const SKILL_RATING_PATTERNS = [
  /\b(rate|assess)\s+(your|my)self\b/i,
  /\bhow would (you|i) rate\b/i,
  // "what is your confidence?" / "how confident are you?" — a self-assessment of
  // the candidate's own proficiency (Issue 8).
  /\bwhat(?:'s| is)\s+(your|my)\s+confidence\b/i,
  /\bhow confident are (you|u|i)\b/i,
  // "how good/skilled/proficient are you AT/IN/WITH <skill>" — require the skill
  // preposition so "how good are you FOR THIS JOB" falls through to jd_fit, not
  // skill-rating (live audit 2026-06-05 collision).
  /\bhow\s+(good|skilled|proficient|strong|experienced|comfortable|confident)\s+(are|am)\s+(you|i)\s+(at|in|with|on|using)\b/i,
  /\b(your|my)\s+(coding|skill|skills|technical|proficiency)\s+levels?\b/i,
  /\bcoding\s+levels?\b/i,
  /\bon a scale\b/i,
  /\brate\s+(yourself|myself|your|my)\b/i,
  /\b(your|my)\s+(expertise|proficiency|competency)\s+(in|with|level)\b/i,
  // "rate your Python skills out of 10", "how would you rate your SQL skills" —
  // a skill name may sit between rate/your and skills (benchmark 2026-06-05).
  /\b(rate|how would you rate)\s+(your|my)\s+[\w+#.]+\s+(skills?|expertise|level)\b/i,
  // Bare / fragmentary self-rating in a live transcript (benchmark 2026-06-05):
  // "So Python, like out of 10?", "Okay, out of ten?", "your coding level, 10
  // scale, what?", "What are your levels at, like Python SQL coding?". The
  // "out of N" / "N scale" / "levels at" framing is a proficiency rating, never
  // a coding task or compensation.
  /\bout of (10|ten)\b/i,
  /\b(10|ten)\s*scale\b|\bscale of (10|ten)\b/i,
  /\b(your|my) (coding |skill )?levels? (at|are|is)\b/i,
  /\bwhat (are|is) (your|my) levels?\b/i,
  /\blike\b.*\bout of (10|ten)\b/i,
  /\bjust rate (coding|python|sql|my|your|me)\b/i,
  // "rate <skill>" / "rate me on <skill>" without your/my — "rate Python", "if I
  // ask you to rate Python" (benchmark 2026-06-05). Skill-rating, not coding.
  /\brate\s+(me\s+(on|in)\s+)?(python|sql|java|javascript|typescript|react|node|coding|programming|data|analytics|excel|tableau|full[- ]?stack|backend|frontend)\b/i,
  /\bask (you )?to rate\b/i,
];
// Generic technical-concept questions ("explain BFS", "what is a deadlock") —
// no profile, generic_ai voice. Distinct from coding (which asks to WRITE code)
// and from skill_experience (which asks about the USER). Checked only when there
// is no coding verb and no skill-experience framing.
const TECHNICAL_CONCEPT_PATTERNS = [
  /\b(explain|what(?:'s| is| are)|describe|how does|how do|define|difference between|compare)\b/i,
];
// Phase 2: HYPOTHETICAL technical application — "how would you use X", "how would
// you design Y", "what's your approach to Z". The candidate answers in FIRST
// PERSON ("I would use GraphQL when…") but invents NO resume facts: this is a
// technical answer (profileContextPolicy = forbidden) spoken in candidate voice.
// Distinct from skill_experience ("how HAVE you used X" → profile required).
const HYPOTHETICAL_TECH_PATTERNS = [
  /\bhow would (you|i)\s+(use|approach|implement|design|build|handle|structure|architect|optimi[sz]e|solve|tackle|model|set ?up|integrate|scale|test|debug|secure|clean|validate|analy[sz]e|query|explain|process|transform|visuali[sz]e|aggregate|join|filter|measure|investigate|diagnose)\b/i,
  /\bhow might (you|i)\b/i,
  /\bwhat(?:'s| is| would be)?\s+your approach to\b/i,
  /\bif you (were|had) to\b/i,
  /\bwould you (use|choose|pick|prefer|recommend)\b/i,
];
const isHypotheticalTech = (text: string): boolean => includesAny(text, HYPOTHETICAL_TECH_PATTERNS);
const PROJECT_PATTERNS = [
  /\b(project|projects|built|shipped|worked on)\b/i,
  // "Tell me about Natively", "explain Natively", "what is Natively", "talk about
  // Natively" — direct asks about a named project (benchmark 2026-06-05). The
  // known project entity is resolved at runtime; here we recognise the intent.
  /\b(tell me about|talk about|explain|describe|walk me through|what(?:'s| is)?)\s+natively\b/i,
  /\bwhat (did|have) you (build|built|made|create|created|develop)\b/i,
  /\bwhat (was|is) your (best|strongest|most important|favou?rite|biggest) (project|work)\b/i,
];
// Phase 5: project/entity FOLLOW-UP — once a project is on the table, an
// interviewer drills in ("how is it developed?", "what was your role?", "what
// tech did you use?", "hardest part?", "why did you build it?", "what did you
// learn?"). These resolve to a specific project (explicit name here, or the
// prior turn's project via extractedQuestion.followUpTarget) and ground in that
// project's resume facts — first person, never negotiation/JD/sales/lecture.
const PROJECT_FOLLOWUP_PATTERNS = [
  /\bhow (is|was|are|were)\s+.{1,40}?\s+(developed|built|made|implemented|architected|designed|created|structured|engineered)\b/i,
  /\bwhat (was|is) (your|my) role (in|on|for|at)\b/i,
  /\bwhat (tech stack|technologies|tools|languages|frameworks|stack|tech) (did|do|does|was|were) (you|i|it|used)\b/i,
  /\bwhat was the hardest (part|challenge|thing)\b/i,
  /\bwhy did (you|i) (build|make|create|choose|pick|use)\b/i,
  /\bhow did (you|i) (optimi[sz]e|scale|test|build|implement|design|handle|architect|secure|deploy)\b/i,
  /\bwhat did (you|i) learn\b/i,
  /\b(explain|tell me (more |about )|describe|walk me through)\s+(that|this|the|your|it)\b.*\b(project|more|further|again|in detail)\b/i,
  // Drill-ins anchored by "there"/"in it"/"on it" on the project under discussion
  // (benchmark 2026-06-05): "what backend did you use there?", "what was the
  // database there?", "how did you handle latency there?", "what was the
  // architecture there?". The trailing locative refers to the active project.
  /\bwhat (backend|database|frontend|stack|tech|framework|language|architecture|infra|infrastructure|api) (did|was|were) (you|it)?\s*(use[d]?|there|built)?\b.*\bthere\b/i,
  /\bwhat (was|were) the (backend|database|frontend|architecture|stack|tech|infra) there\b/i,
  /\bhow did you (handle|manage|deal with|solve|optimi[sz]e|build|design) [\w ]+ there\b/i,
  /\b(did|how did) you (work with|use|build|handle|coordinate)\b.*\b(there|in (it|that|the project)|on (it|that|the project))\b/i,
  // Personal-contribution drill-ins on the project ("what did you personally
  // contribute", "what did others do and what did you do", "what was the
  // measurable result"). First-person project ownership, never negotiation.
  /\bwhat did you (personally )?(contribute|do|build|own|lead)\b/i,
  /\bwhat (was|were) (the )?(measurable )?(result|impact|outcome|metric)s?\b/i,
];
const EXPERIENCE_PATTERNS = [
  /\bexperience|background|previous role|last role|work history|internship|interned|worked at|time at\b/i,
  // "what do you currently do?", "what are you working on (now)?", "what's your
  // current role/job?" (benchmark 2026-06-05) — present-tense experience asks.
  /\bwhat do you (currently|now) do\b/i,
  /\bwhat(?:'s| is) your current (role|job|position|title)\b/i,
  /\bwhat are you (currently )?working on\b/i,
];
const BEHAVIORAL_PATTERNS = [
  /\btell me about a time\b|\bdescribe a situation\b|\bexample of when\b|\bconflict\b|\bfailure\b|\bchallenge\b/i,
  // Strength/weakness — classic behavioral self-reflection (benchmark 2026-06-05).
  /\b(your|my) (biggest |greatest |main )?(strength|weakness|strengths|weaknesses)\b/i,
  /\bwhat are you (good|bad) at\b/i,
  // "Give me an example of X", "tell me a story where/about", "tell me a
  // time/failure/conflict" — STAR prompts that lack the literal "a time" phrasing
  // (benchmark 2026-06-05): ownership, teamwork, leadership, ambiguity, pressure,
  // coordination, deadline.
  /\b(give me|share|tell me|do you have) (an?|one|a single) ?(example|instance|story|case)\b/i,
  /\btell me (a|one|about a) (story|time|failure|conflict|situation|deadline)\b/i,
  /\btell me about (your |how you )?(handle|handling|deal with|dealing with|manage|managing)?\s*(teamwork|leadership|ownership|coordination|pressure|ambiguity|conflict|uncertainty|a deadline|deadlines|failure|stress)\b/i,
  /\b(handling|dealing with|managing|under) (ambiguity|pressure|uncertainty|conflict|stress|a deadline|deadlines)\b/i,
  /\b(can you )?talk (more )?about your (project )?coordination\b/i,
  /\bproject coordinati(on|vely)\b/i,
  /\bproof of\b|\bprove[sd]? (your|my|analytical|that you|i)\b|\bthat proves?\b/i,
];
// MEETING / lecture-recap questions about the CONVERSATION, not the candidate —
// must route to general_meeting_answer (profile/JD/negotiation FORBIDDEN), never
// unknown_answer or a profile answer (benchmark 2026-06-05 context leaks).
const MEETING_PATTERNS = [
  /\b(action items?|next steps?|to-?dos?)\b/i,
  /\bwhat did we (decide|agree|conclude|discuss|cover|say)\b/i,
  /\bwhat (was|were) (decided|agreed|discussed|the takeaways?)\b/i,
  /\bsummari[sz]e (the )?(last|previous|past)\b|\bsummari[sz]e (the )?(meeting|call|discussion|conversation)\b/i,
  /\bwhat (was|is) the customer (asking|saying|wanting)\b/i,
  /\bwhat should i (say|do|answer) (next )?(in this|in the) (meeting|call)\b/i,
  /\bwhat did (the )?(interviewer|client|customer|they) mean\b/i,
  /\brecap\b|\bcatch me up\b/i,
];
// Profile FACT lookups (education, target role) — short factual answers
// (benchmark 2026-06-05): "where did you study?", "what role are you applying
// for?", "what's your degree?".
const PROFILE_FACT_PATTERNS = [
  /\bwhere did (you|i) (study|go to (school|college|university)|graduate)\b/i,
  /\bwhat (role|job|position) (are|am) (you|i) (applying|interviewing) for\b/i,
  /\bwhat(?:'s| is) (your|my) (degree|major|gpa|qualification)\b/i,
];
// Sales: pricing/product/competitor/objection questions (spec Case G). Uses sales
// context, NOT resume/JD/negotiation. The active mode also signals sales, but the
// answerType lets the selector exclude resume/salary regardless of mode.
const SALES_PATTERNS = [
  /\b(pricing|price|cost|expensive|cheaper|discount|quote|deal|contract)\b/i,
  /\bcompare(?:d)?\s+(?:to|with|against)\s+(?:your\s+|the\s+|other\s+)?competitors?\b|\bvs\.?\s+(?:a\s+)?competitors?\b|\bcompetitors?\b/i,
  /\b(your|the) product\b.*\b(do|offer|cost|price|compare|better|why)\b/i,
  /\bwhy (should|would) (i|we) (buy|choose|pick|go with)\b/i,
  /\b(roi|return on investment|value proposition|use case)\b/i,
];
// PRODUCT + CANDIDATE MIX (Issue 5): "why is your PROFILE good for selling this
// product?", "why are you CREDIBLE to sell this?", "why are you the right FOUNDER
// for this product?". These mix candidate credibility with a product/sales
// frame — they must NOT route to profile_fact (which would dump the résumé).
// Founder credibility is allowed, but as framing (persona/custom), not a profile
// list — the layer table forbids resume/jd/negotiation.
const PRODUCT_CANDIDATE_MIX_PATTERNS = [
  /\bwhy (is|are) (your|you)\b.*\b(profile|background|experience|credible|qualified|right (founder|person))\b.*\b(sell|selling|sell this|this product|pitch|founder)\b/i,
  /\bwhy (are|r) (you|u)\b.*\b(credible|the right founder|qualified)\b.*\b(sell|selling|this product|pitch)\b/i,
  /\bwhy (are|r) (you|u) the right founder\b/i,
  /\b(your|you) (profile|background|credibility)\b.*\b(good for|right for) (selling|pitching|this product)\b/i,
  /\bwhy (should|would) (i|we|they) (buy from|trust) (you|your)\b/i,
];
// Lecture: questions about lecture/slide/lecture material (spec Case H). Uses
// lecture materials + screen + reference files, NOT resume/JD/negotiation.
const LECTURE_PATTERNS = [
  /\b(this slide|the slide|lecture slide|this diagram|the diagram|the professor|the lecturer|the lecture|lecture)\b/i,
  /\bwhat (did|does) (the )?(professor|lecturer|teacher) (mean|say)\b/i,
  /\bon (the|this) (slide|board|screen)\b/i,
];
const FOLLOW_UP_PATTERNS = [
  /\b(that|this) (project|approach|answer|solution)\b|\bcan you (expand|optimize|dry run|explain)\b|\bwhat about complexity\b|\bwhy did you choose\b/i,
  // VOICE-CONTROL / EVIDENCE-CONTROL coaching directives (Issue 8) — "answer like
  // a candidate, not like an assistant", "say what I should say but in my voice",
  // "make it sound confident but don't lie", "if no metric is there answer
  // without fake metric". These modify HOW the prior answer is delivered; they
  // resolve against the prior turn in the live path.
  /\banswer (like|as) a candidate\b|\bnot (like|as) an? assistant\b/i,
  /\bsay what i should say\b|\bin my (own )?voice\b/i,
  /\b(without|no) (fake|made[- ]?up|invented) (metric|number|stat)/i,
  /\bif no metric is there\b/i,
  /\bsound confident but (don'?t|do not) lie\b/i,
  /\bmake it (sound )?(confident|natural|concise)\b/i,
  // BARE follow-up fragments (Issue 8) — "why?", "how so?", "and X?", "what about
  // X?". On their own they're ambiguous, but they are ALWAYS follow-ups (never a
  // standalone question), so route to follow_up_answer instead of unknown. In the
  // live path the FollowUpResolver runs first and resolves them to a concrete
  // type using the prior turn; this is the no-prior-context floor.
  /^(?:(?:ok(?:ay)?|so|hmm|right|alright|cool|yeah)[\s,]*)*(?:why|how so|how come)\b[\s?.!]*$/i,
  /^(?:(?:ok(?:ay)?|so|hmm|right|yeah|cool)[\s,]*)*(?:and|what about|how about)\s+[\w +#.]{1,30}\??$/i,
];

const templateFor = (answerType: AnswerType): string => {
  switch (answerType) {
    case 'coding_question_answer':
    case 'dsa_question_answer':
      return CODING_TEMPLATE;
    case 'behavioral_interview_answer':
    case 'experience_answer':
      return BEHAVIORAL_TEMPLATE;
    case 'project_answer':
      // Phase 3: dedicated project structure (NOT behavioral STAR).
      return PROJECT_TEMPLATE;
    case 'project_followup_answer':
      // Phase 5: concise first-person drill-in on the resolved project.
      return PROJECT_FOLLOWUP_TEMPLATE;
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
    case 'product_candidate_mix_answer':
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
    case 'project_followup_answer':
      // Drill-in on a project: the project's resume facts + the prior assistant
      // turn (to resolve "it"/"that") + custom context + persona style.
      return ['resume', 'prior_assistant_responses', 'custom_context', 'ai_persona'];
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
    case 'product_candidate_mix_answer':
      // Sales/product context + persona/custom for FOUNDER credibility framing —
      // NOT the résumé (no full profile dump in a selling answer).
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
    case 'project_followup_answer':
      // A project drill-in stays on the project's own facts: never negotiation,
      // and not the JD (unrelated to "how was it built / what was your role").
      return ['negotiation', 'jd', 'reference_files'];
    case 'jd_fit_answer':
      return ['negotiation'];
    case 'negotiation_answer':
      return ['reference_files'];
    case 'sales_answer':
      // Sales answers must not pull the user's resume/JD or negotiation/salary.
      return ['resume', 'jd', 'negotiation'];
    case 'product_candidate_mix_answer':
      // Founder/credibility-for-selling: no résumé/JD DUMP, no salary. Credibility
      // comes from persona/custom-context framing, not a profile list.
      return ['resume', 'jd', 'negotiation'];
    case 'lecture_answer':
      // Lecture answers must not pull resume/JD/negotiation.
      return ['resume', 'jd', 'negotiation'];
    case 'general_meeting_answer':
      // Meeting recap ("action items?", "what did we decide?", "what was the
      // customer asking?") is about the CONVERSATION — never the candidate's
      // profile. Forbid resume/JD/negotiation so the knowledge intercept can't
      // inject the résumé (benchmark 2026-06-05 context-leak).
      return ['resume', 'jd', 'negotiation'];
    default:
      return [];
  }
};

export const isCodingAnswerType = (answerType: AnswerType): boolean =>
  answerType === 'coding_question_answer' || answerType === 'dsa_question_answer';

// Phase 2: answer types that speak AS the candidate (first person live / second
// person manual). Profile-directed asks + negotiation (the candidate negotiates).
const CANDIDATE_VOICE_TYPES: ReadonlySet<AnswerType> = new Set<AnswerType>([
  'identity_answer', 'profile_fact_answer', 'project_answer', 'project_followup_answer',
  'skills_answer', 'skill_experience_answer', 'experience_answer', 'jd_fit_answer',
  'behavioral_interview_answer', 'negotiation_answer',
]);

// Phase 2: the profile-context policy per answer type. `forbidden` is the hard
// leak rule (coding/technical/sales/lecture get NO profile, spec §8.3); `required`
// means the answer is about the user and MUST be grounded; `allowed` means profile
// may help but isn't mandatory (negotiation leverage, generic meeting).
export const profileContextPolicyFor = (answerType: AnswerType): ProfileContextPolicy => {
  switch (answerType) {
    case 'coding_question_answer':
    case 'dsa_question_answer':
    case 'technical_concept_answer':
    case 'system_design_answer':
    case 'debugging_question_answer':
    case 'sales_answer':
    case 'product_candidate_mix_answer':
    case 'lecture_answer':
    case 'general_meeting_answer':
      // Meeting recap is about the conversation, not the candidate — no profile.
      return 'forbidden';
    case 'identity_answer':
    case 'profile_fact_answer':
    case 'project_answer':
    case 'project_followup_answer':
    case 'skills_answer':
    case 'skill_experience_answer':
    case 'experience_answer':
    case 'jd_fit_answer':
    case 'behavioral_interview_answer':
      return 'required';
    case 'negotiation_answer':
    case 'follow_up_answer':
    case 'unknown_answer':
    // NOTE: general_meeting_answer is handled in the 'forbidden' group above
    // (meeting recaps must never pull the profile) — do not re-add it here.
    default:
      return 'allowed';
  }
};

// Phase 5: pull a likely project/entity NAME out of a follow-up question
// ("how is Natively developed?" → "Natively", "what was your role in SQL-Copilot?"
// → "SQL-Copilot"). Deterministic, conservative: prefers a capitalized /
// hyphenated token after a project preposition; never invents. Returns '' when
// the question only uses a pronoun ("it"/"that") — the orchestrator then resolves
// from the prior turn instead.
const PROJECT_ENTITY_RE = /\b(?:in|on|for|about|of|is|was|did)\s+([A-Z][A-Za-z0-9]*(?:[-_ ][A-Z0-9][A-Za-z0-9]*){0,3})\b/;
const ENTITY_STOPWORDS = new Set(['I', 'You', 'We', 'It', 'That', 'This', 'The', 'My', 'Your', 'A', 'An', 'Their', 'Our', 'His', 'Her']);
// Common TECHNOLOGY nouns that are NOT project names. A capitalized tech token
// after a preposition ("optimize binary search in Postgres") must NOT be treated
// as a project entity, or it would bypass the DSA/coding guard and leak the
// resume into a pure coding answer (code-review 2026-06-05, HIGH, invariant #1).
const TECH_NOT_ENTITY = new Set([
  'postgres', 'postgresql', 'mysql', 'sqlite', 'mongo', 'mongodb', 'redis', 'kafka',
  'rabbitmq', 'elasticsearch', 'python', 'java', 'javascript', 'typescript', 'golang',
  'rust', 'react', 'angular', 'vue', 'node', 'nodejs', 'express', 'django', 'flask',
  'fastapi', 'spring', 'aws', 'gcp', 'azure', 'docker', 'kubernetes', 'k8s', 'graphql',
  'rest', 'grpc', 'sql', 'nosql', 'pandas', 'numpy', 'spark', 'hadoop', 'tableau',
  'excel', 'powerbi', 'linux', 'nginx', 'terraform',
]);
export const extractProjectEntity = (question: string): string => {
  const m = question.match(PROJECT_ENTITY_RE);
  if (!m) return '';
  // Strip any LEADING stopword tokens ("The Project" → "Project", "My Project" →
  // "Project") so a determiner/possessive prefix doesn't leak as the entity. If
  // nothing survives, there's no real named entity — return '' and let the
  // orchestrator resolve from the prior turn instead.
  const tokens = m[1].trim().split(/\s+/);
  while (tokens.length && ENTITY_STOPWORDS.has(tokens[0])) tokens.shift();
  const candidate = tokens.join(' ');
  // A bare common word like "Project" alone isn't a usable project NAME either.
  if (!candidate || /^(Project|Projects|Role|Thing|Part|Work)$/i.test(candidate)) return '';
  // A bare technology token is NOT a project entity (see TECH_NOT_ENTITY above).
  if (tokens.length === 1 && TECH_NOT_ENTITY.has(candidate.toLowerCase())) return '';
  return candidate;
};

// A project follow-up has explicit project CONTEXT when the prior turn resolved a
// project (followUpTarget) OR the question names a project after a project
// preposition ("in/on/for <Name>"). When true, a project-drill-in verb is
// unambiguously about that project even if the name contains a tech token
// (SQL-Copilot). A bare generic subject ("optimize binary search") yields no
// entity here, so the technical guards still apply.
const followUpHasProjectContext = (input: PlanAnswerInput, rawQuestion: string): boolean => {
  if (input.extractedQuestion?.followUpTarget) return true;
  if (extractProjectEntity(rawQuestion) !== '') return true;
  // A trailing locative pronoun ("…there?", "…in it?", "…on that project?")
  // anchors the drill-in to the project already under discussion — treat it as
  // explicit project context so a technical noun (database/latency/backend) in
  // the question doesn't bounce it out of project_followup (benchmark 2026-06-05).
  return /\b(there|in it|on it|in that|on that|in the project|on the project)\b\s*\??$/i.test(rawQuestion.trim());
};

// Phase 2: profile-aware fallback for questions that matched NO explicit pattern.
// Conservative by design — only pulls an unmatched question into a profile answer
// type when it is clearly DIRECTED AT THE CANDIDATE (second/first person about
// them) in a manual/interview context. Everything else stays unknown_answer
// (profileContextPolicy 'allowed' — no forced profile, no leak).
const SELF_REFERENTIAL_RE = /\b(you|your|yours|yourself|u|ur)\b/i;          // interviewer→candidate
const FIRST_PERSON_RE = /\b(i|i'?m|i'?ve|my|me|mine|myself)\b/i;            // user→self ("what should I say")
// "What should I say/answer if they ask X" — indirect recruiter coaching. We
// route by the EMBEDDED ask so the right profile context is selected.
const INDIRECT_COACHING_RE = /\bwhat (should|do|would) (i|you) (say|answer|tell them|respond)\b/i;
const classifyUnmatchedFallback = (text: string, input: PlanAnswerInput): AnswerType => {
  const interview = input.source === 'what_to_answer' || input.source === 'transcript';
  const manual = input.source === 'manual_input';
  const hasProfile = input.hasCandidateProfile !== false; // default-allow when unknown
  // Only engage the profile fallback in a manual/interview context with a profile.
  if (!(interview || manual) || !hasProfile) {
    return manual ? 'unknown_answer' : 'general_meeting_answer';
  }
  // Vague opinion / discourse questions ("so what do you think about all this?",
  // "how about that?") contain "you" but are NOT about the candidate's profile —
  // they must stay neutral, not pull profile. Require the question to reference a
  // candidate ATTRIBUTE or be an explicit coaching ask before engaging profile.
  // NOTE: bare "data" is deliberately EXCLUDED (it appears in non-candidate
  // analyst chatter — "send me the data", "the data pipeline is down"); only the
  // role-framed "data analyst"/"analytics" qualify (code-review 2026-06-05, MED).
  const CANDIDATE_ATTRIBUTE_RE = /\b(experience|background|skill|skills|project|projects|role|job|fit|hire|qualif|strength|weakness|study|studied|education|degree|college|university|intern|work|built|build|develop|languages?|tools?|tech|stack|rate|level|expertise|proficien|company|companies|career|resume|cv|profile|data analyst|analytics)\b/i;
  const candidateDirected =
    (SELF_REFERENTIAL_RE.test(text) && CANDIDATE_ATTRIBUTE_RE.test(text))
    || (FIRST_PERSON_RE.test(text) && CANDIDATE_ATTRIBUTE_RE.test(text))
    || INDIRECT_COACHING_RE.test(text);
  if (!candidateDirected) {
    // Not clearly about the candidate — keep neutral (no forced profile).
    return manual ? 'unknown_answer' : 'general_meeting_answer';
  }
  // Candidate-directed but unmatched. Pick the nearest SAFE profile bucket by
  // light keyword lean; default to profile_fact_answer (resume-grounded, concise,
  // first-person, NO jd/negotiation) — the safest "about me" answer.
  if (/\b(job|role|position|fit|hire|company|this (one|role|job)|qualified|suitable)\b/i.test(text)) return 'jd_fit_answer';
  if (/\b(project|built|build|developed|natively|app|system|architecture|stack|backend|database)\b/i.test(text)) return 'project_answer';
  if (/\b(rate|out of (10|ten)|level|scale|score)\b/i.test(text)) return 'skill_experience_answer';
  if (/\b(strength|weakness|example|story|time|teamwork|leadership|conflict|failure|pressure|ownership)\b/i.test(text)) return 'behavioral_interview_answer';
  if (/\b(experience|background|intern|internship|worked|company|role|did you do)\b/i.test(text)) return 'experience_answer';
  if (/\b(skill|skills|language|tool|tech|technolog|good at)\b/i.test(text)) return 'skills_answer';
  return 'profile_fact_answer';
};

export const planAnswer = (input: PlanAnswerInput): AnswerPlan => {
  const rawQuestion = input.question || input.extractedQuestion?.latestQuestion || '';
  const question = rawQuestion.trim();
  const text = question.toLowerCase();
  // "tech stack" / "technology stack" is a phrase, not the DSA `stack` data
  // structure — neutralize it so the project-followup DSA-exclusion guard below
  // doesn't mis-fire on "what tech stack did you use?".
  // Neutralize "tech stack" / "technology stack" AND bare "full-stack" so the
  // DSA `\bstack\b` data-structure pattern can't fire on them ("you said full
  // stack, but this is data analyst" must not become a stack/DSA question).
  const textNoTechStack = text
    .replace(/\b(tech|technology|technical)\s+stack\b/g, 'techstack')
    .replace(/\bfull[- ]?stack\b/g, 'fullstack');
  const extractedType = input.extractedQuestion?.questionType;

  let answerType: AnswerType = 'general_meeting_answer';

  // Skill-experience framing ("have you used X?", "do you know X?") is about the
  // USER, so it must win BEFORE coding/DSA/technical patterns — otherwise
  // "have you used a hashmap?" mis-routes to the coding contract. It still yields
  // to explicit negotiation/identity (those are higher-priority profile asks).
  // "what tech stack / technologies / backend / database / framework DID YOU USE"
  // is a project ARCHITECTURE follow-up, not a generic skill-experience probe —
  // exclude it here so the project_followup branch (checked later) wins and
  // grounds in the specific project (ProfileRoutingMatrix invariant).
  // Project ARCHITECTURE drill-in (tech stack / backend / database of a project) —
  // NOT a generic "what languages do you know" skills question, so `languages`/
  // `tools` are deliberately excluded here.
  const isProjectStackQuestion = /\b(tech ?stack|technolog\w+|backend|database|frontend|framework|infra\w*|architecture|stack) (did|do|does|was|were)\b/i.test(textNoTechStack)
    || /\bwhat (tech ?stack|technolog\w+|backend|database|frontend|framework|stack) (did|do)\b/i.test(text);
  // PROJECT-framed asks must not be captured by the broadened skill-experience
  // "have/did you build/do/develop" patterns — they belong to project_answer /
  // project_followup (ProfileRoutingMatrix invariants). Exclude when the question
  // is about "projects", names/pronouns a project ("build IT", "develop THAT"),
  // or is a project drill-in ("why did you build it", "how did you optimise the
  // pipeline"). Bare skill probes ("have you built dashboards?") still match.
  // A project DRILL-IN ("what projects have you done", "build IT", "develop THAT
  // project") should defer to project routing. But a SKILL-experience probe that
  // merely mentions "project(s)" as a scope ("have you written SQL in your
  // projects?", "have you used BFS in a project?") is still skill_experience —
  // so only exclude when there's NO explicit have/did-you-use skill framing.
  // A "have/did you USE <skill>" probe (with the use-verb LEADING the question)
  // is skill_experience even when it mentions "project" as scope ("have you used
  // BFS in a project?", "have you written SQL in your projects?"). But a question
  // that LEADS with "what projects" or drills into a specific project ("why did
  // you build it?") is project routing. Distinguish by whether the use-verb opens
  // the question vs. "project" being the subject.
  const leadsWithUseVerb = /^(have|did|do)\s+you\s+(ever\s+)?(used?|worked|written|wrote|implement|implemented|deploy|deployed|design|designed|know|knew)\b/i.test(text.trim());
  const isProjectFramed = (
    /\bwhat\s+projects?\b/i.test(text)
    || /\b(build|built|develop|developed|made|make|create|created|optimi[sz]e[d]?|design(ed)?)\s+(it|that|this|the (project|app|system|pipeline|product|tool))\b/i.test(text)
    || includesAny(text, PROJECT_FOLLOWUP_PATTERNS)
  ) && !leadsWithUseVerb;
  const hasSkillExperienceFraming = includesAny(text, SKILL_EXPERIENCE_PATTERNS) && !isProjectStackQuestion && !isProjectFramed;
  // Skill self-rating ("rate yourself out of 10", "how good are you at X",
  // "your coding levels", "on a scale of 1-10 how proficient are you"). About the
  // USER's proficiency → skill_experience. Checked as its own branch (no
  // system-design exclusion) because "scale" collides with SYSTEM_DESIGN_PATTERNS
  // yet a self-rating is never a system-design question.
  const hasSkillRatingFraming = includesAny(text, SKILL_RATING_PATTERNS);

  // A CODING TASK that merely mentions a comp word as DATA ("write a SQL query
  // for the second highest SALARY", "function to compute BONUS") is NOT a
  // negotiation question — the explicit code verb wins. Guard the negotiation
  // branch so a "salary"/"bonus" COLUMN in a coding ask doesn't mis-route to
  // compensation (benchmark 2026-06-05: salary-false-positive category).
  // Explicit code-writing verbs. NOTE: "query" is intentionally EXCLUDED — "how
  // would you use a GraphQL query" / "query data using GraphQL" is a hypothetical
  // concept ask, not a code-writing task. A genuine "write a SQL query" is caught
  // by the write/COMMON_CODING patterns instead.
  // NOTE: compute/return/print are EXCLUDED here (code-review 2026-06-05, MED) —
  // they'd wrongly veto a real comp question ("compute my total compensation").
  // Genuine SQL/coding "salary" cases are caught by the write/COMMON_CODING/DSA
  // signals instead.
  const hasExplicitCodingVerb = /\b(write|implement|code|program|function|solve)\b/i.test(text)
    || includesAny(text, COMMON_CODING_PROBLEM_PATTERNS) || includesAny(textNoTechStack, DSA_PATTERNS);
  // Strict "write code" verbs only (no DSA-term inference). Used to gate the
  // HYPOTHETICAL branch: "how would you use BFS?" is a concept (BFS is a DSA term
  // but there's no write-verb), so it must NOT be blocked from technical_concept.
  const hasWriteCodeVerb = /\b(write|implement|code|program|solve)\b/i.test(text)
    || includesAny(text, COMMON_CODING_PROBLEM_PATTERNS);

  // EXPLICIT comp NEGATION + a skill-rating cue ("rate Python but NOT salary",
  // "do NOT give salary, just rate coding", "your level, NOT salary, coding
  // level") — the user is steering AWAY from compensation toward a skill rating.
  // Suppress the negotiation branch so the salary word inside the negation doesn't
  // mis-route (benchmark 2026-06-05 salary-false-positive category).
  const negatesSalary = /\b(not|no|don'?t|without|never|skip|avoid|exclude)\b[\w ,'-]*\b(salary|compensation|package|ctc|pay|money|offer)\b/i.test(text)
    || /\b(salary|compensation|package|ctc|pay)\b[\w ,'-]*\b(not|no|don'?t)\b/i.test(text);
  const hasRatingCue = includesAny(text, SKILL_RATING_PATTERNS);

  if (!question) {
    answerType = 'unknown_answer';
  } else if (includesAny(text, NEGOTIATION_PATTERNS) && !hasExplicitCodingVerb && !(negatesSalary && hasRatingCue)) {
    answerType = 'negotiation_answer';
  } else if (includesAny(text, IDENTITY_PATTERNS) || extractedType === 'identity') {
    answerType = 'identity_answer';
  } else if (hasSkillRatingFraming) {
    // Self-rating of a skill → first-person profile answer (wins over coding's
    // bare-language-name match and over system-design's "scale" collision).
    answerType = 'skill_experience_answer';
  } else if (hasSkillExperienceFraming && !includesAny(text, SYSTEM_DESIGN_PATTERNS)) {
    // "Have you used WebRTC / a hashmap / AWS?" → profile skill-experience answer
    // in first person. Wins over coding/DSA/technical-concept routing below.
    answerType = 'skill_experience_answer';
  } else if (includesAny(text, PROJECT_FOLLOWUP_PATTERNS)
             // An EXPLICIT project entity ("...in SQL-Copilot?", "...role in
             // Natively?") OR a resolved prior-turn target makes this an
             // unambiguous project follow-up — even if the project NAME contains a
             // technology token (SQL-Copilot has "sql"). In that case we skip the
             // technical-subject guards. Otherwise (a bare drill-in verb on a
             // generic subject — "how did you optimize binary search?"), the
             // guards below keep it OUT of project_followup so coding/DSA answers
             // never use the profile (code-review 2026-06-05, HIGH).
             // HARD precondition (code-review 2026-06-05, HIGH, invariant #1): a
             // write-code verb or a named DSA problem ALWAYS keeps a question out
             // of project_followup, even if a project entity was extracted — so
             // "how did you optimize binary search in Postgres?" can never inject
             // the resume into a coding answer. Real project drill-ins ("what was
             // your role in SQL-Copilot?") carry neither a write verb nor a DSA
             // term, so they're unaffected.
             && !hasWriteCodeVerb
             && (followUpHasProjectContext(input, question)
                 || (!includesAny(textNoTechStack, DSA_PATTERNS)
                     && !includesAny(text, CODING_PATTERNS)
                     && !isLikelyTechnicalConcept(textNoTechStack)))) {
    // Phase 5: a drill-in on a project already on the table ("how is it built?",
    // "what was your role?", "what tech stack did you use?", "hardest part?",
    // "why did you build it?", "what did you learn?"). These are PROFILE questions
    // about the candidate's own work — they win BEFORE BEHAVIORAL (a project
    // "hardest part" is not a generic STAR story) and resolve to a specific
    // project, grounding in its resume facts.
    //
    // GUARD (code-review 2026-06-05, HIGH): a project-drill-in verb attached to a
    // GENERIC technical subject is NOT a project follow-up — "how did you optimize
    // BINARY SEARCH?", "how did you implement BFS?" must stay coding/DSA with NO
    // profile. So we explicitly EXCLUDE any question that carries a DSA term, a
    // coding verb, or a technical-concept subject; those fall through to the
    // technical/DSA/coding cluster below (profileContextPolicy = forbidden). This
    // keeps the "coding answers never use resume" invariant intact. ("what tech
    // STACK did you use?" survives: `stack` here is matched by the followup
    // pattern, and DSA's bare `stack` is gated by this being a personal "did you
    // use" phrasing — verified by ProfileRoutingMatrix over-capture guards.)
    answerType = 'project_followup_answer';
  } else if (
    // HIGH-CONFIDENCE JD-FIT BRIDGE — the interviewer challenges that the
    // candidate's background (full-stack/engineering) doesn't match the data-
    // analyst role and asks them to connect/explain the fit. This is a fit
    // question (resume+JD), NOT a generic "explain X" concept, so it must beat
    // the technical_concept branch below (benchmark 2026-06-05).
    /\b(full[- ]?stack|engineering|engineer|backend|software)\b/i.test(text)
    && /\b(data analyst|analyst|data)\b/i.test(text)
    && /\b(connect|bridge|relate|link|explain the connection|why (data|analyst)|different|convince)\b/i.test(text)) {
    answerType = 'jd_fit_answer';
  } else if (includesAny(text, MEETING_PATTERNS)) {
    // Meeting/conversation recap ("action items?", "what did we decide?",
    // "summarise the last 5 min", "what was the customer asking?") — about the
    // CONVERSATION, never the candidate. Routed here (profile FORBIDDEN) instead
    // of falling through to unknown and leaking profile context.
    answerType = 'general_meeting_answer';
  } else if (includesAny(text, PRODUCT_CANDIDATE_MIX_PATTERNS)) {
    // "Why is your profile good for selling this product?" — credibility-for-
    // selling. NOT profile_fact (no résumé dump): the layer table forbids
    // resume/jd/negotiation; founder framing comes from persona/custom context.
    answerType = 'product_candidate_mix_answer';
  } else if (includesAny(text, SALES_PATTERNS)) {
    answerType = 'sales_answer';
  } else if (includesAny(text, LECTURE_PATTERNS)) {
    answerType = 'lecture_answer';
  } else if (includesAny(text, SYSTEM_DESIGN_PATTERNS)) {
    answerType = 'system_design_answer';
  } else if (includesAny(text, DEBUGGING_PATTERNS) && !includesAny(textNoTechStack, DSA_PATTERNS)) {
    answerType = 'debugging_question_answer';
  } else if (isHypotheticalTech(text) && !hasWriteCodeVerb) {
    // HYPOTHETICAL application — "how would you use GraphQL?", "how would you
    // clean a messy dataset?", "how would you approach a data analysis task?",
    // "how would you optimise a slow API?" (Phase 2 + benchmark 2026-06-05). The
    // candidate answers in FIRST PERSON but invents NO resume facts — a technical
    // answer (profile forbidden) in candidate voice. This now fires for ANY
    // "how would you …" application even without a DSA/technical-subject keyword,
    // as long as there's no explicit code verb (write/implement/solve/query →
    // those are genuine coding tasks and fall through to DSA/CODING below). A
    // bare language name ("how would you use SQL") no longer mis-routes to coding.
    answerType = 'technical_concept_answer';
  } else if (
    // Explicit "answer GENERICALLY / DON'T use my resume" steer on an explain/
    // tell-me ask — the user wants a neutral concept answer even though a skill
    // word + "my resume" appears (benchmark 2026-06-05 context-confusing traps:
    // "explain SQL but don't use my resume", "tell me about Python but explain it
    // generally"). Concept wins, profile forbidden.
    (includesAny(text, TECHNICAL_CONCEPT_PATTERNS) || /\btell me about\b/i.test(text))
    && /\b(generally|in general|don'?t use my (resume|profile|cv)|without my (resume|profile)|explain it generally|generic(ally)?)\b/i.test(text)
    && !hasWriteCodeVerb) {
    answerType = 'technical_concept_answer';
  } else if (includesAny(text, TECHNICAL_CONCEPT_PATTERNS) &&
             !includesAny(text, CODING_PATTERNS) &&
             (includesAny(textNoTechStack, DSA_PATTERNS) || isLikelyTechnicalConcept(text))) {
    // "Explain BFS", "what is a deadlock", "difference between TCP and UDP" —
    // generic technical CONCEPT, NO profile (spec Case F). Checked before
    // DSA/coding: a DSA noun with explain/what-is framing and NO coding verb is a
    // concept, not a coding task.
    answerType = 'technical_concept_answer';
  } else if (includesAny(textNoTechStack, DSA_PATTERNS)) {
    // Named DSA problem ("two sum", "reverse a linked list", "solve two sum").
    // Kept BEFORE generic CODING so the specific DSA label/template wins.
    answerType = 'dsa_question_answer';
  } else if (includesAny(text, CODING_PATTERNS) || input.intentResult?.intent === 'coding') {
    answerType = 'coding_question_answer';
  } else if (includesAny(text, JD_FIT_PATTERNS) || extractedType === 'jd_alignment') {
    answerType = 'jd_fit_answer';
  } else if (includesAny(text, BEHAVIORAL_PATTERNS) || extractedType === 'behavioral') {
    answerType = 'behavioral_interview_answer';
  } else if (includesAny(text, PROFILE_FACT_PATTERNS)) {
    // Short factual profile lookups (education, target role, degree) — benchmark
    // 2026-06-05. Profile required, concise direct answer.
    answerType = 'profile_fact_answer';
  } else if (includesAny(text, PROJECT_PATTERNS)) {
    answerType = 'project_answer';
  } else if (includesAny(text, SKILLS_PATTERNS)) {
    answerType = 'skills_answer';
  } else if (includesAny(text, EXPERIENCE_PATTERNS) || extractedType === 'profile_detail') {
    answerType = 'experience_answer';
  } else if (includesAny(text, FOLLOW_UP_PATTERNS) || extractedType === 'follow_up') {
    answerType = 'follow_up_answer';
  } else {
    // PROFILE-AWARE FALLBACK (Phase 2). Nothing above matched. In a manual or
    // interview context with a profile available, an unmatched but clearly
    // candidate-directed question ("you/your/I/my", or a short interview-style
    // fragment) must NOT collapse to unknown_answer — that strips profile/JD
    // context and cascades into route/voice failures. Route it to the nearest
    // SAFE profile answer type. Generic non-candidate questions still go to
    // unknown (profileContextPolicy 'allowed', no forced profile).
    const fb = classifyUnmatchedFallback(text, input);
    answerType = fb;
  }

  const speakerPerspective = input.speakerPerspective
    || (input.source === 'what_to_answer' || input.source === 'transcript' ? 'interviewer' : 'user');

  // Phase 2: VOICE (how to speak) is computed SEPARATELY from PROFILE-CONTEXT
  // POLICY (whether profile facts may ground the answer). The classic conflation
  // bug: "how would you use GraphQL?" needs first-person candidate VOICE but NO
  // profile facts. The hypothetical-technical flag captures exactly that case.
  const hypotheticalTech = answerType === 'technical_concept_answer' && isHypotheticalTech(text);
  const interviewerAsked = speakerPerspective === 'interviewer'
    || input.source === 'what_to_answer' || input.source === 'transcript';

  const profileContextPolicy = profileContextPolicyFor(answerType);

  const voicePerspective: VoicePerspective = (() => {
    if (CANDIDATE_VOICE_TYPES.has(answerType)) {
      // Profile-directed answer types speak AS the candidate live, or tell the
      // user about themselves in a manual chat.
      if (interviewerAsked) return 'first_person_candidate';
      if (input.source === 'manual_input') return 'second_person_user';
      return 'assistant_explanation';
    }
    // Hypothetical technical ("how would you use X") in a live/interview setting
    // → candidate voice, even though profile is forbidden. Manual/teaching → neutral.
    if (hypotheticalTech && interviewerAsked) return 'first_person_candidate';
    // Coding / "explain X" technical / sales / lecture / general → neutral voice.
    return 'assistant_explanation';
  })();

  // Backward-compatible alias for existing call sites (third_person collapses to
  // the neutral assistant voice for the legacy 3-value type).
  const outputPerspective: OutputPerspective =
    voicePerspective === 'first_person_candidate' ? 'first_person_candidate'
      : voicePerspective === 'second_person_user' ? 'second_person_user'
        : 'assistant_explanation';

  // Phase 5: resolve which project a follow-up is about — the prior turn's target
  // (from the transcript extractor) or an explicit name in the question. Used to
  // scope grounding; never fabricated.
  const resolvedEntity = answerType === 'project_followup_answer'
    ? (input.extractedQuestion?.followUpTarget || extractProjectEntity(question) || undefined)
    : undefined;

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
    voicePerspective,
    profileContextPolicy,
    resolvedEntity,
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
  // Phase 2: a single explicit directive that translates the voice/policy split
  // into model instructions — this is what makes "how would you use GraphQL?"
  // answer in first person WITHOUT inventing resume facts.
  const voiceLine = plan.voicePerspective === 'first_person_candidate'
    ? 'Speak in the FIRST PERSON as the candidate ("I would…", "I built…").'
    : plan.voicePerspective === 'second_person_user'
      ? 'Address the user about themselves in the second person ("Your …").'
      : 'Answer in a neutral, explanatory voice. Do not roleplay as the candidate.';
  const policyLine = plan.profileContextPolicy === 'required'
    ? 'Ground every concrete claim in the provided profile facts. Never invent names, numbers, metrics, companies, or technologies that are not in those facts.'
    : plan.profileContextPolicy === 'forbidden'
      ? 'Do NOT use or reference the resume, JD, projects, or any personal profile context. Answer from general knowledge only.'
      : 'Use profile facts only where directly relevant; never fabricate.';
  const entityLine = plan.resolvedEntity
    ? `\nresolvedEntity: ${plan.resolvedEntity} (answer about THIS project; stay on it)`
    : '';
  return `<answer_contract>
answerType: ${plan.answerType}
source: ${plan.source}
speakerPerspective: ${plan.speakerPerspective}
outputPerspective: ${plan.outputPerspective}
voicePerspective: ${plan.voicePerspective}
profileContextPolicy: ${plan.profileContextPolicy}${entityLine}
requiredContextLayers: ${plan.requiredContextLayers.join(', ') || 'none'}
forbiddenContextLayers: ${plan.forbiddenContextLayers.join(', ') || 'none'}
maxInitialLatencyMs: ${plan.maxInitialLatencyMs}

VOICE: ${voiceLine}
GROUNDING: ${policyLine}

STRICT RESPONSE TEMPLATE:
${plan.responseTemplate}${verificationBlock}
</answer_contract>`;
};
