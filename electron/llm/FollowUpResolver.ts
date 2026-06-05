// electron/llm/FollowUpResolver.ts
//
// Resolves a SHORT BARE follow-up in the live transcript ("And SQL?", "What
// about complexity?", "Why?", "How so?", "And that project?") into a full,
// answerable question + the answer type it should inherit from the prior turn.
//
// The transcript extractor already resolves demonstrative follow-ups that name a
// topic ("how is IT developed?" → project "Natively"). This resolver covers the
// HARDER bare fragments that carry almost no signal on their own and MUST inherit
// the prior question's subject/answer-type to route correctly — otherwise they
// fall through to general_meeting/unknown and (worse) can pull the wrong context.
//
// It is deterministic and fast (regex + light token reuse) — no LLM. It returns
// `resolved.confidence === 0` when the fragment is not a recognisable follow-up,
// so the caller keeps the extractor's original routing.

import type { AnswerType } from './AnswerPlanner';

export interface FollowUpContext {
  /** The latest (possibly bare) interviewer fragment, lowercased is fine. */
  latestQuestion: string;
  /** The previous INTERVIEWER question (the one this fragment riffs on). */
  previousQuestion?: string;
  /** The answer type the previous turn was planned as, if known. */
  previousAnswerType?: AnswerType;
  /** A project/entity already on the table (from the extractor's followUpTarget). */
  lastEntity?: string;
  /** A skill already on the table (e.g. "Python" from "rate your Python"). */
  lastSkill?: string;
}

export interface ResolvedFollowUp {
  resolvedQuestion: string;
  resolvedAnswerType?: AnswerType;
  resolvedEntity?: string;
  resolvedSkill?: string;
  confidence: number; // 0 = not a follow-up we can resolve
  reason: string;
}

const NONE: ResolvedFollowUp = { resolvedQuestion: '', confidence: 0, reason: 'not_a_followup' };

const EXPAND_RE = /^(?:ok(?:ay)?,?\s*|so,?\s*|hmm,?\s*|right,?\s*)*(?:why|how so|how come|can you (?:expand|elaborate|go deeper)|expand|elaborate|tell me more|go on|continue|in more detail)\b[\s?.!]*$/i;
// "and <skill>?" / "what about <skill>?" — a topic shift to a new skill/tech.
const TOPIC_SHIFT_RE = /\b(?:and|what about|how about|what's your|and your)\s+([a-z0-9+#.\- ]{2,30}?)\s*\??$/i;

// Skill/tech tokens we recognise inside a topic-shift fragment.
const SKILL_TOKEN_RE = /\b(python|sql|java(?:script)?|typescript|react|node(?:\.?js)?|c\+\+|go(?:lang)?|rust|aws|gcp|azure|docker|kubernetes|graphql|rest|fastapi|django|flask|spring|pandas|numpy|spark|hadoop|tableau|power\s?bi|excel|tensorflow|pytorch|coding|backend|frontend|full[\s-]?stack|data|analytics|databases?|dashboards?|machine learning|ml|statistics?)\b/i;

const lc = (s?: string) => (s || '').trim().toLowerCase();

/** Did the previous turn establish a skill rating / skill experience subject? */
function prevWasSkill(ctx: FollowUpContext): boolean {
  const t = lc(ctx.previousQuestion);
  return ctx.previousAnswerType === 'skill_experience_answer'
    || ctx.previousAnswerType === 'skills_answer'
    || /\b(rate|out of (?:10|ten)|how (?:good|comfortable|proficient)|have you used|experience with|how have you used)\b/.test(t);
}
function prevWasCoding(ctx: FollowUpContext): boolean {
  return ctx.previousAnswerType === 'coding_question_answer' || ctx.previousAnswerType === 'dsa_question_answer'
    || /\b(solve|implement|write (?:code|a|the)|two sum|binary search|reverse|palindrome|leetcode)\b/.test(lc(ctx.previousQuestion));
}
function prevWasProject(ctx: FollowUpContext): boolean {
  return ctx.previousAnswerType === 'project_answer' || ctx.previousAnswerType === 'project_followup_answer'
    || !!ctx.lastEntity || /\bproject|built|developed|natively\b/.test(lc(ctx.previousQuestion));
}
function prevWasJdFit(ctx: FollowUpContext): boolean {
  return ctx.previousAnswerType === 'jd_fit_answer' || /\bfit|hire|role|why (?:this|you)|data analyst\b/.test(lc(ctx.previousQuestion));
}
function prevWasTechnicalConcept(ctx: FollowUpContext): boolean {
  return ctx.previousAnswerType === 'technical_concept_answer'
    || ctx.previousAnswerType === 'system_design_answer'
    || ctx.previousAnswerType === 'debugging_question_answer'
    || /\b(explain|what is|how does|difference between|bfs|dfs|deadlock|complexity|rest|graphql|index)\b/.test(lc(ctx.previousQuestion));
}

// A project DRILL-IN: a short fragment that asks HOW/WHY/WHAT about a project
// already on the table ("how is it developed?", "how was it built?", "that
// project?", "what stack?", "your role?"). Resolves to project_followup on the
// resolved entity (the prior turn's project).
const PROJECT_DRILLIN_RE = /^(?:ok(?:ay)?,?\s*|so,?\s*|and,?\s*)*(?:how (?:is|was|are|were) (?:it|that|this)|how (?:is|was) (?:it|that) (?:developed|built|made|designed|implemented)|that project|the project|what (?:stack|backend|database|tech)|your role|why did you build|how did you (?:build|make|optimi[sz]e))\b/i;

export function resolveFollowUp(ctx: FollowUpContext): ResolvedFollowUp {
  const q = lc(ctx.latestQuestion);
  if (!q) return NONE;
  // Long, self-contained questions are not bare follow-ups.
  const wordCount = q.split(/\s+/).filter(Boolean).length;
  if (wordCount > 8) return NONE;

  // 1. TOPIC SHIFT to a new skill/tech: "And SQL?", "what about Python?".
  const shift = q.match(TOPIC_SHIFT_RE);
  if (shift) {
    const skillRaw = shift[1].trim();
    const skillMatch = skillRaw.match(SKILL_TOKEN_RE);
    if (skillMatch && prevWasSkill(ctx)) {
      const skill = skillMatch[0];
      // Inherit the EXACT prior framing (rating vs experience) with the new skill.
      const wasRating = /\brate|out of (?:10|ten)|scale\b/.test(lc(ctx.previousQuestion));
      return {
        resolvedQuestion: wasRating ? `Rate your ${skill} skills out of 10.` : `What is your experience with ${skill}?`,
        resolvedAnswerType: 'skill_experience_answer',
        resolvedSkill: skill,
        confidence: 0.9,
        reason: 'topic_shift_skill',
      };
    }
    // "what about data?" after a JD-fit/role discussion → still a fit question.
    if (/\b(data|analytics|stakeholders?|metrics?)\b/.test(skillRaw) && prevWasJdFit(ctx)) {
      return {
        resolvedQuestion: `How does my ${skillRaw} experience fit this role?`,
        resolvedAnswerType: 'jd_fit_answer',
        confidence: 0.7,
        reason: 'topic_shift_jdfit',
      };
    }
    // "what about <skill>?" with a recognised skill but unclear prior → skill experience.
    if (skillMatch) {
      return {
        resolvedQuestion: `What is your experience with ${skillMatch[0]}?`,
        resolvedAnswerType: 'skill_experience_answer',
        resolvedSkill: skillMatch[0],
        confidence: 0.6,
        reason: 'topic_shift_skill_weak',
      };
    }
  }

  // 1b. PROJECT DRILL-IN: "how is it developed?", "that project?", "what stack?",
  //     "your role?" — about the project already on the table.
  if (PROJECT_DRILLIN_RE.test(q) && (ctx.lastEntity || prevWasProject(ctx))) {
    return {
      resolvedQuestion: ctx.lastEntity
        ? `${ctx.latestQuestion.replace(/\b(it|that|this)\b/i, ctx.lastEntity).trim()}`.replace(/\?*$/, '?')
        : 'Can you go deeper on that project?',
      resolvedAnswerType: 'project_followup_answer',
      resolvedEntity: ctx.lastEntity,
      confidence: 0.85,
      reason: 'project_drillin',
    };
  }

  // 2. EXPAND on the prior answer: "Why?", "How so?", "Can you expand?".
  if (EXPAND_RE.test(q)) {
    if (prevWasCoding(ctx)) {
      // "what about complexity?" / "why?" after a coding answer → coding/technical
      // follow-up, profile STILL forbidden.
      const aboutComplexity = /\bcomplexity\b/.test(q);
      return {
        resolvedQuestion: aboutComplexity
          ? `What is the time and space complexity of the previous solution?`
          : `Can you explain the previous solution in more detail?`,
        resolvedAnswerType: 'technical_concept_answer',
        confidence: 0.8,
        reason: 'expand_coding',
      };
    }
    if (prevWasProject(ctx)) {
      return {
        resolvedQuestion: ctx.lastEntity
          ? `Can you expand on ${ctx.lastEntity}?`
          : `Can you expand on that project?`,
        resolvedAnswerType: 'project_followup_answer',
        resolvedEntity: ctx.lastEntity,
        confidence: 0.75,
        reason: 'expand_project',
      };
    }
    if (prevWasJdFit(ctx)) {
      return { resolvedQuestion: `Can you expand on why you fit this role?`, resolvedAnswerType: 'jd_fit_answer', confidence: 0.7, reason: 'expand_jdfit' };
    }
    if (prevWasTechnicalConcept(ctx)) {
      // "Explain BFS." → "How so?" / "Why?" — expand the CONCEPT, profile still
      // forbidden. Use the prior question as the topic.
      return {
        resolvedQuestion: ctx.previousQuestion ? `Can you explain that in more detail: ${ctx.previousQuestion}` : 'Can you explain that in more detail?',
        resolvedAnswerType: 'technical_concept_answer',
        confidence: 0.7,
        reason: 'expand_technical',
      };
    }
    if (ctx.previousAnswerType) {
      return { resolvedQuestion: ctx.previousQuestion ? `Can you expand on: ${ctx.previousQuestion}` : `Can you expand on that?`, resolvedAnswerType: ctx.previousAnswerType, confidence: 0.6, reason: 'expand_inherit' };
    }
  }

  // 3. "what about complexity?" without an EXPAND lead but after coding.
  if (/\bcomplexity\b/.test(q) && prevWasCoding(ctx)) {
    return { resolvedQuestion: `What is the time and space complexity of the previous solution?`, resolvedAnswerType: 'technical_concept_answer', confidence: 0.8, reason: 'complexity_followup' };
  }

  return NONE;
}
