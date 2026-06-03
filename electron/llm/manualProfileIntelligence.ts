import { createHash } from 'crypto';
import type { AnswerType } from './AnswerPlanner';

export type ManualProfileSource = 'manual_input' | 'what_to_answer' | 'transcript' | 'system';

type MaybeStructured<T> = T | null | undefined;

type SkillItem = string | { name?: unknown; skill?: unknown };

interface ProfileIdentity {
  name?: unknown;
}

interface ProfileExperience {
  role?: unknown;
  title?: unknown;
  position?: unknown;
  company?: unknown;
  organization?: unknown;
  employer?: unknown;
  bullets?: unknown;
  highlights?: unknown;
  responsibilities?: unknown;
}

interface ProfileProject {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  summary?: unknown;
  technologies?: unknown;
  tech_stack?: unknown;
  tools?: unknown;
}

interface ProfileEducation {
  degree?: unknown;
  field?: unknown;
  major?: unknown;
  institution?: unknown;
  school?: unknown;
  university?: unknown;
}

export interface StructuredProfileFacts {
  identity?: ProfileIdentity;
  name?: unknown;
  personal?: ProfileIdentity;
  skills?: unknown;
  experience?: unknown;
  projects?: unknown;
  education?: unknown;
}

export interface StructuredJobFacts {
  title?: unknown;
  role?: unknown;
  position?: unknown;
  jobTitle?: unknown;
}

export interface ManualProfileFastPathInput {
  question: string;
  profile: MaybeStructured<StructuredProfileFacts>;
  jobDescription?: MaybeStructured<StructuredJobFacts>;
  source?: ManualProfileSource;
}

export interface ManualProfileRouteResult {
  answer: string;
  answerType: AnswerType;
  selectedContextLayers: string[];
  excludedContextLayers: string[];
  profileFactsReady: boolean;
  usedDeterministicFastPath: boolean;
  providerUsed: boolean;
  promptContainsProfileContext?: boolean;
}

export interface ManualProfileRouteLogInput {
  source: ManualProfileSource;
  question: string;
  route: ManualProfileRouteResult | null;
  profileFactsReady: boolean;
}

export interface ManualProfileRouteLog {
  source: ManualProfileSource;
  questionHash: string;
  answerType: AnswerType | 'unknown_answer';
  selectedContextLayers: string[];
  excludedContextLayers: string[];
  profileFactsReady: boolean;
  usedDeterministicFastPath: boolean;
  providerUsed: boolean;
  promptContainsProfileContext?: boolean;
}

const normalize = (question: string): string => question.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const hasAny = (text: string, patterns: RegExp[]): boolean => patterns.some((pattern) => pattern.test(text));
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value.filter(Boolean) : [];
const clean = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const firstNonEmpty = (...values: unknown[]): string => values.map(clean).find(Boolean) || '';

const ASSISTANT_IDENTITY_PATTERNS = [
  /^(who|what)\s+(are|r)\s+(you|u)\b/,
  /^are\s+you\s+(an?\s+)?(ai|assistant|bot|llm|model)\b/,
  /^what\s+is\s+natively\b/,
  /^who\s+(made|built|created|developed|trained)\s+(you|this|natively)\b/,
  /^what\s+model\s+(are\s+you|do\s+you\s+use)\b/,
  /^what\s+is\s+your\s+name\b/,
  /^what\s+s\s+your\s+name\b/,
];

const NAME_PATTERNS = [
  /\bwhat\s+is\s+my\s+name\b/,
  /\bwhat\s+s\s+my\s+name\b/,
  /\bwho\s+am\s+i\b/,
  /\bstate\s+my\s+name\b/,
];

const EXPERIENCE_PATTERNS = [
  /\b(my|your)\s+experiences?\b/,
  /\bexperience\s+do\s+i\s+have\b/,
  /\bwork\s+experience\b/,
  /\bwork\s+history\b/,
  /\bprevious\s+roles?\b/,
  /\bbackground\b/,
];

const PROJECT_PATTERNS = [
  /\b(my|your)\s+projects?\b/,
  /\bprojects?\s+have\s+(i|you)\s+(done|built|worked\s+on|shipped)\b/,
  /\bwhat\s+all\s+projects?\b/,
  /\bthings\s+(i|you)\s+(built|shipped)\b/,
];

const SKILL_PATTERNS = [
  /\b(my|your)\s+skills?\b/,
  /\bskills?\s+do\s+i\s+have\b/,
  /\btech\s+stack\b/,
  /\btools?\s+(do\s+i|have\s+you)\b/,
  /\btechnologies?\b/,
];

const EDUCATION_PATTERNS = [
  /\b(my|your)\s+education\b/,
  /\bwhere\s+did\s+i\s+(go\s+to\s+school|study)\b/,
  /\bdegree\b/,
  /\bschool\b/,
  /\buniversity\b/,
];

const ROLE_PATTERNS = [
  /\brole\s+am\s+i\s+applying\s+for\b/,
  /\bwhat\s+(job|position|role)\b.*\b(applying|targeting)\b/,
  /\btarget\s+(role|job|position)\b/,
];

const profileName = (profile: MaybeStructured<StructuredProfileFacts>): string => firstNonEmpty(
  profile?.identity?.name,
  profile?.name,
  profile?.personal?.name,
);

const jdTitle = (jd: MaybeStructured<StructuredJobFacts>): string => firstNonEmpty(jd?.title, jd?.role, jd?.position, jd?.jobTitle);

const formatInlineList = (items: string[], max = 8): string => {
  const values = items.map(clean).filter(Boolean).slice(0, max);
  if (values.length === 0) return '';
  if (values.length === 1) return values[0];
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
};

const profileExperience = (profile: MaybeStructured<StructuredProfileFacts>): ProfileExperience[] =>
  asArray(profile?.experience) as ProfileExperience[];
const profileProjects = (profile: MaybeStructured<StructuredProfileFacts>): ProfileProject[] =>
  asArray(profile?.projects) as ProfileProject[];
const profileEducation = (profile: MaybeStructured<StructuredProfileFacts>): ProfileEducation[] =>
  asArray(profile?.education) as ProfileEducation[];
const profileSkills = (profile: MaybeStructured<StructuredProfileFacts>): SkillItem[] =>
  asArray(profile?.skills) as SkillItem[];

const formatExperience = (profile: MaybeStructured<StructuredProfileFacts>): string => {
  const entries = profileExperience(profile);
  if (entries.length === 0) return '';
  const lines = entries.slice(0, 5).map((entry) => {
    const role = firstNonEmpty(entry.role, entry.title, entry.position);
    const company = firstNonEmpty(entry.company, entry.organization, entry.employer);
    const bullets = asArray(entry.bullets || entry.highlights || entry.responsibilities).map(clean).filter(Boolean);
    const headline = [role, company ? `at ${company}` : ''].filter(Boolean).join(' ');
    const detail = bullets[0] ? ` — ${bullets[0]}` : '';
    return headline ? `${headline}${detail}` : clean(entry);
  }).filter(Boolean);
  return lines.length ? `Your experience includes ${lines.join('; ')}.` : '';
};

const formatProjects = (profile: MaybeStructured<StructuredProfileFacts>): string => {
  const entries = profileProjects(profile);
  if (entries.length === 0) return '';
  const lines = entries.slice(0, 6).map((project) => {
    const name = firstNonEmpty(project.name, project.title);
    const description = firstNonEmpty(project.description, project.summary);
    const tech = formatInlineList(asArray(project.technologies || project.tech_stack || project.tools).map(clean).filter(Boolean), 4);
    if (!name) return clean(project);
    return `${name}${description ? ` — ${description}` : ''}${tech ? ` (${tech})` : ''}`;
  }).filter(Boolean);
  return lines.length ? `Your projects include ${lines.join('; ')}.` : '';
};

const formatSkills = (profile: MaybeStructured<StructuredProfileFacts>): string => {
  const skills = profileSkills(profile).map((skill) => typeof skill === 'string' ? skill : firstNonEmpty(skill.name, skill.skill)).filter(Boolean);
  return skills.length ? `Your skills include ${formatInlineList(skills, 12)}.` : '';
};

const formatEducation = (profile: MaybeStructured<StructuredProfileFacts>): string => {
  const entries = profileEducation(profile);
  if (entries.length === 0) return '';
  const lines = entries.slice(0, 3).map((edu) => {
    const degree = [firstNonEmpty(edu.degree), firstNonEmpty(edu.field, edu.major)].filter(Boolean).join(' in ');
    const institution = firstNonEmpty(edu.institution, edu.school, edu.university);
    return [degree, institution ? `from ${institution}` : ''].filter(Boolean).join(' ');
  }).filter(Boolean);
  return lines.length ? `Your education includes ${lines.join('; ')}.` : '';
};

export const isAssistantIdentityQuestion = (question: string): boolean => {
  const q = normalize(question);
  return hasAny(q, ASSISTANT_IDENTITY_PATTERNS);
};

export const isCandidateProfileQuestion = (question: string): boolean => {
  if (isAssistantIdentityQuestion(question)) return false;
  const q = normalize(question);
  return hasAny(q, [
    ...NAME_PATTERNS,
    ...EXPERIENCE_PATTERNS,
    ...PROJECT_PATTERNS,
    ...SKILL_PATTERNS,
    ...EDUCATION_PATTERNS,
    ...ROLE_PATTERNS,
  ]);
};

export const profileFactsReady = (profile: MaybeStructured<StructuredProfileFacts>): boolean => Boolean(
  profile && (
    profileName(profile) ||
    profileExperience(profile).length > 0 ||
    profileProjects(profile).length > 0 ||
    profileSkills(profile).length > 0 ||
    profileEducation(profile).length > 0
  ),
);

const makeRoute = (
  answer: string,
  answerType: AnswerType,
  selectedContextLayers: string[],
): ManualProfileRouteResult => ({
  answer,
  answerType,
  selectedContextLayers,
  excludedContextLayers: ['assistant_identity'],
  profileFactsReady: true,
  usedDeterministicFastPath: true,
  providerUsed: false,
});

export const tryBuildManualProfileFastPathAnswer = ({
  question,
  profile,
  jobDescription,
  source = 'manual_input',
}: ManualProfileFastPathInput): ManualProfileRouteResult | null => {
  const firstPerson = source === 'what_to_answer' || source === 'transcript';
  if (!firstPerson && isAssistantIdentityQuestion(question)) return null;

  const q = normalize(question);

  if (hasAny(q, ROLE_PATTERNS)) {
    const title = jdTitle(jobDescription);
    if (!title) return null;
    return makeRoute(
      firstPerson ? `I am applying for the ${title} role.` : `You are applying for the ${title} role.`,
      'jd_fit_answer',
      ['jd'],
    );
  }

  if (!profileFactsReady(profile)) return null;

  const isNameQuestion = hasAny(q, NAME_PATTERNS)
    || (firstPerson && /\bwhat\s+(is|s)\s+your\s+name\b/.test(q));
  if (isNameQuestion) {
    const name = profileName(profile);
    if (!name) return null;
    return makeRoute(
      firstPerson ? `My name is ${name}.` : `Your name is ${name}.`,
      'identity_answer',
      ['stable_identity', 'resume'],
    );
  }

  if (hasAny(q, EXPERIENCE_PATTERNS)) {
    const answer = formatExperience(profile);
    if (!answer) return null;
    return makeRoute(firstPerson ? answer.replace(/^Your experience includes/i, 'My experience includes') : answer, 'experience_answer', ['resume']);
  }

  if (hasAny(q, PROJECT_PATTERNS)) {
    const answer = formatProjects(profile);
    if (!answer) return null;
    return makeRoute(firstPerson ? answer.replace(/^Your projects include/i, 'My projects include') : answer, 'project_answer', ['resume', 'projects']);
  }

  if (hasAny(q, SKILL_PATTERNS)) {
    const answer = formatSkills(profile);
    if (!answer) return null;
    return makeRoute(firstPerson ? answer.replace(/^Your skills include/i, 'My skills include') : answer, 'skills_answer', ['resume']);
  }

  if (hasAny(q, EDUCATION_PATTERNS)) {
    const answer = formatEducation(profile);
    if (!answer) return null;
    return makeRoute(firstPerson ? answer.replace(/^Your education includes/i, 'My education includes') : answer, 'profile_fact_answer', ['resume']);
  }

  return null;
};

export const logManualProfileRoute = ({
  source,
  question,
  route,
  profileFactsReady,
}: ManualProfileRouteLogInput): ManualProfileRouteLog => ({
  source,
  questionHash: createHash('sha256').update(question).digest('hex').slice(0, 12),
  answerType: route?.answerType ?? 'unknown_answer',
  selectedContextLayers: route?.selectedContextLayers ?? [],
  excludedContextLayers: route?.excludedContextLayers ?? [],
  profileFactsReady,
  usedDeterministicFastPath: route?.usedDeterministicFastPath ?? false,
  providerUsed: route?.providerUsed ?? false,
  promptContainsProfileContext: route?.promptContainsProfileContext,
});
