// electron/knowledge/ContextAssembler.ts
// Just-In-Time context building replacing static pre-computed personas

import { KnowledgeStatus, ScoredNode, DocType, KnowledgeDocument, StructuredResume, StructuredJD, LiveCoachingResponse } from './types';
import { formatContextBlock } from './HybridSearchEngine';
import { escapeXml } from './NegotiationConversationTracker';

export interface PromptAssemblyResult {
    systemPromptInjection: string;
    contextBlock: string;
    isIntroQuestion: boolean;
    introResponse?: string;
    liveNegotiationResponse?: LiveCoachingResponse;
}

const INTRO_PATTERNS = [
    'introduce yourself',
    'tell me about yourself',
    'who are you',
    'what do you do',
    'describe yourself',
    'about yourself',
    'tell me who you are',
    'give me your introduction',
    'walk me through your background',
    'brief introduction',
    'self introduction'
];

const GREETING_PATTERNS = [
    'hello', 'hi', 'hey', 'good morning', 'good afternoon', 'good evening',
    'howdy', 'what\'s up', 'sup', 'yo'
];

/**
 * Checks if the user is asking an intro question.
 */
function isIntroQuestion(questionLower: string): boolean {
    return INTRO_PATTERNS.some(pattern => questionLower.includes(pattern));
}

/**
 * Checks if the message is a bare greeting ("hi", "hello") — not an intro request.
 */
function isBareGreeting(questionLower: string): boolean {
    const trimmed = questionLower.replace(/[!?.,']/g, '').trim();
    return GREETING_PATTERNS.includes(trimmed) ||
        GREETING_PATTERNS.some(g => trimmed === `${g} there`) ||
        trimmed.length <= 12 && GREETING_PATTERNS.some(g => trimmed.startsWith(g));
}

/**
 * Build an identity header on-the-fly based on the active resume and active JD.
 * IMPORTANT: Does NOT say "You are [Name]" — that makes the LLM act as a chatbot.
 * Instead frames the LLM as the person's inner voice / consciousness.
 */
function buildIdentityHeader(resumeDoc: KnowledgeDocument | null, jdDoc: KnowledgeDocument | null): string {
    if (!resumeDoc) return '';

    const resume = resumeDoc.structured_data as StructuredResume;
    const name = resume.identity.name;
    const role = resume.experience?.[0]?.role || 'Professional';

    let targetContext = '';
    let toneModifier = '';

    if (jdDoc) {
        const jd = jdDoc.structured_data as StructuredJD;
        const levelStr = jd.level ? jd.level.charAt(0).toUpperCase() + jd.level.slice(1) + '-level' : '';
        targetContext = ` The candidate is interviewing for the ${levelStr} position of ${jd.title} at ${jd.company}.`;

        // Tone modifiers based on JD signals
        const kwLower = (jd.keywords || []).map((k: string) => k.toLowerCase()).join(' ');
        const descLower = (jd.description_summary || '').toLowerCase();
        const combined = kwLower + ' ' + descLower;

        if (combined.includes('startup') || combined.includes('fast-paced')) {
            toneModifier = ' Use a product-focused, pragmatic tone.';
        } else if (combined.includes('research') || combined.includes('academic')) {
            toneModifier = ' Use a detail-oriented, citation-friendly tone.';
        } else if (jd.level === 'staff' || jd.level === 'principal') {
            toneModifier = ' Use a leadership-focused, strategic tone.';
        } else if (jd.level === 'senior') {
            toneModifier = ' Use a concise, technically deep tone.';
        }
    }

    return `You generate interview-ready speech for ${name}, who works as a ${role}.${targetContext}${toneModifier}`;
}

/**
 * Build the system prompt rules block.
 */
function buildKnowledgeSystemPrompt(identityHeader: string, hasJD: boolean, toneXML?: string): string {
    // P2-10: candidateName originates from resume.identity.name (user-supplied text).
    // Escape XML-special characters before interpolating into the system prompt block.
    const rawName = identityHeader.includes('for ') ? identityHeader.split('for ')[1]?.split(',')[0] || 'the candidate' : 'the candidate';
    const candidateName = escapeXml(rawName);
    const baseRules = `- You are the candidate's INNER VOICE — think of yourself as their consciousness during an interview.
- Generate ONLY what ${candidateName} should SAY OUT LOUD.
- Always speak in first person ("I", "my", "I've").
- Sound like a real human professional in a conversation — confident, natural, not robotic.
- Never say "How can I assist you?", "How can I help?", "What would you like to know?", or any assistant/chatbot phrase.
- Never introduce yourself unprompted. Only give an introduction when explicitly asked ("tell me about yourself").
- Never mention being an AI, a system, or having a resume. You ARE the person.
- Use the provided context (Resume and/or JD) as your memory — speak from it naturally.
- Do not fabricate experience. If you lack direct experience, pivot to transferable skills confidently.
- Keep answers concise and speakable (~20-30 seconds unless coding).
- IMPORTANT: Carefully distinguish between different context sections. Work experience (<candidate_experience>) is different from side projects (<candidate_projects>), education (<candidate_education>), achievements (<candidate_achievements>), certifications (<candidate_certifications>), and leadership (<candidate_leadership>).
- When asked about "projects", ONLY reference items from <candidate_projects>, NOT from <candidate_experience> (those are jobs/roles, not projects).
- When asked about "experience" or "work history", reference <candidate_experience> entries.
- When asked about "education", reference <candidate_education> entries.
- When listing items (e.g. "what projects have you worked on?"), include ALL relevant items from the appropriate section, not just the first one.`;

    const jdRules = hasJD ? `
- When giving company or compensation facts, cite sources in a "Sources" section at the end.
- If you present salary ranges or market data, include a confidence level (low/medium/high) and the source.
- Do not fabricate numbers, timelines, or projects.` : '';

    const salaryRules = `
- When answering salary or compensation questions, use data from <salary_intelligence> if available.
- Always state the confidence level when citing salary ranges (e.g., "Based on market data for this region, I'd expect..." for medium confidence).
- Frame salary expectations confidently, anchoring to the upper end of the range.
- If a pre-computed negotiation script is available in <salary_intelligence>, use it as a guide for your response — adapt the opening line and justification naturally.
- If no salary data is available, deflect gracefully by focusing on your value and experience (e.g., "I'm open to discussing compensation that reflects my experience in [domain]...").
- Never reveal that you have pre-computed data or scripts. Speak as if you know your own worth naturally.`;

    const toneBlock = toneXML ? `\n\n${toneXML}` : '';

    return `${identityHeader}

<knowledge_engine_rules>
${baseRules}${jdRules}${salaryRules}
</knowledge_engine_rules>${toneBlock}`;
}

/**
 * Generates an intro on the fly for "tell me about yourself" questions.
 * Produces natural, human speech — NOT a chatbot introduction.
 */
async function generateJitIntro(
    resumeDoc: KnowledgeDocument,
    jdDoc: KnowledgeDocument | null,
    generateContentFn: (contents: any[]) => Promise<string>
): Promise<string> {
    const resume = resumeDoc.structured_data as StructuredResume;
    const latestRole = resume.experience?.[0];
    const skills = resume.skills?.slice(0, 5).join(', ') || '';

    let prompt = `Generate a natural, spoken interview self-introduction for a candidate named ${resume.identity.name}.

This should sound like a REAL PERSON speaking in an interview — relaxed, confident, conversational.

Candidate background:
- Current/Latest role: ${latestRole?.role || 'Professional'} at ${latestRole?.company || 'a company'}
- Total roles: ${resume.experience?.length || 0}
- Key skills: ${skills}`;

    if (jdDoc) {
        const jd = jdDoc.structured_data as StructuredJD;
        prompt += `\n- Interviewing for: ${jd.title} at ${jd.company}`;
        prompt += `\n\nSubtly connect their background to the target role without being obvious about it.`;
    }

    prompt += `\n\nRULES:
- First person ("I", "my", "I've")
- ~80-120 words, speakable in ~30-40 seconds
- Start with something natural like "Sure, so I..." or "Yeah, so I currently..." or just jump straight in
- Focus on: what they do now → 1-2 highlights from their career → what excites them about this opportunity
- Sound like a confident professional talking, NOT reading a bio
- NO "How can I assist you" or "What would you like to know?"
- NO "I'm excited to be here today" or overly formal phrasing
- NO self-referential phrases like "as my resume shows" or "as mentioned in my CV"
- NO offer to help or ask questions back
- End naturally — just stop talking, don't add a question or offer

BAD example (DO NOT generate anything like this):
"Hello, it's nice to meet you. I'm [Name] and I'm excited to be here today to discuss the [Role] position. How can I assist you today?"

GOOD example pattern:
"Sure — so I'm currently working as a [role] at [company], where I've been focused on [key thing]. Before that, I spent [time] at [company] doing [key achievement]. I've been mostly working in [domain] and [domain], and the [target role] here really caught my eye because [natural reason]."\n\nOutput ONLY the spoken text. No quotes, no labels, no markdown.`;

    try {
        const response = await generateContentFn([{ text: prompt }]);
        return response.trim();
    } catch {
        return `Sure — so I'm currently working as a ${latestRole?.role || 'developer'} at ${latestRole?.company || 'my current company'}, and I've been in this space for a few years now.`;
    }
}

/**
 * Handle bare greetings ("hi", "hello") with a natural human response.
 */
function handleBareGreeting(resumeDoc: KnowledgeDocument | null): string {
    const name = resumeDoc ? (resumeDoc.structured_data as StructuredResume).identity.name?.split(' ')[0] : '';
    // Natural human greeting — no "How can I assist you?"
    const greetings = [
        `Hey, thanks for having me${name ? `. I'm ${name}` : ''}.`,
        `Hi there${name ? `, I'm ${name}` : ''}. Good to be here.`,
        `Hey! Good to meet you.`,
    ];
    return greetings[Math.floor(Math.random() * greetings.length)];
}

/**
 * Assembles the final prompt context for the LLM based on user query.
 */
export async function assemblePromptContext(
    question: string,
    resumeDoc: KnowledgeDocument | null,
    jdDoc: KnowledgeDocument | null,
    relevantNodes: ScoredNode[],
    generateContentFn: ((contents: any[]) => Promise<string>) | null,
    toneXML?: string
): Promise<PromptAssemblyResult> {
    const questionLower = question.toLowerCase().trim();

    // Handle bare greetings ("hi", "hello") — short natural response, no intro
    if (isBareGreeting(questionLower)) {
        return {
            systemPromptInjection: '',
            contextBlock: '',
            isIntroQuestion: true,
            introResponse: handleBareGreeting(resumeDoc)
        };
    }

    // Handle intro questions ("tell me about yourself")
    const isIntro = isIntroQuestion(questionLower);
    if (isIntro && resumeDoc && generateContentFn) {
        console.log('[ContextAssembler] Generating Just-In-Time Intro...');
        const introResponse = await generateJitIntro(resumeDoc, jdDoc, generateContentFn);
        return {
            systemPromptInjection: '',
            contextBlock: '',
            isIntroQuestion: true,
            introResponse
        };
    }

    // Assemble Knowledge Blocks for normal questions
    const contextBlock = formatContextBlock(relevantNodes);

    // Build the dynamic system prompt
    const identityHeader = buildIdentityHeader(resumeDoc, jdDoc);
    const systemPromptInjection = buildKnowledgeSystemPrompt(identityHeader, jdDoc !== null, toneXML);

    return {
        systemPromptInjection,
        contextBlock,
        isIntroQuestion: false
    };
}

export function buildLiveNegotiationSystemPrompt(): string {
  return `You are an expert salary negotiation coach providing real-time guidance.

LIVE NEGOTIATION MODE — ACTIVE.

Your role:
- The user is on a live call with a recruiter RIGHT NOW.
- You have full context about the current negotiation: offer history, phase, and the user's target.
- Provide precision coaching — not general advice.

Format rules (CRITICAL):
- Lead with a tactical note (1-2 sentences): what just happened + why this specific move is right.
- Then the exact words to say.
- Use REAL numbers. If offer is $95,000 and target is $130,000, say those exact numbers.
- Keep total response under 150 words. They are on a live call.
- Never use [X], [amount], or placeholders.
- Never reveal you are an AI or that scripts exist.
- Be directive: say "Say: '...'" not "You might consider..."`;
}
