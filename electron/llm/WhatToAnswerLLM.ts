import { LLMHelper } from "../LLMHelper";
import { UNIVERSAL_WHAT_TO_ANSWER_PROMPT } from "./prompts";
import { TINY_WHAT_TO_ANSWER_PROMPT } from "./tinyPrompts";
import { estimateTokens } from "./modelCapabilities";
import { TemporalContext } from "./TemporalContextBuilder";
import { IntentResult } from "./IntentClassifier";

// Dynamically imported to avoid circular dependency at module load time
type ModesManagerType = {
    getInstance: () => {
        getActiveModeSystemPromptSuffix: () => string;
        buildActiveModeContextBlock: () => string;
    };
};

export class WhatToAnswerLLM {
    private llmHelper: LLMHelper;

    constructor(llmHelper: LLMHelper) {
        this.llmHelper = llmHelper;
    }

    // Deprecated non-streaming method (redirect to streaming or implement if needed)
    async generate(cleanedTranscript: string): Promise<string> {
        const stream = this.generateStream(cleanedTranscript);
        let full = "";
        for await (const chunk of stream) full += chunk;
        return full;
    }

    async *generateStream(
        cleanedTranscript: string,
        temporalContext?: TemporalContext,
        intentResult?: IntentResult,
        imagePaths?: string[]
    ): AsyncGenerator<string> {
        const MEASURE = process.env.MEASURE_LATENCY === 'true';
        let tStart = 0, tIntent = 0, tTemporal = 0, tMode = 0, tTrunc = 0, tPrompt = 0, tStream = 0;
        const interTokenLatencies: number[] = [];
        let tPrevToken = 0;

        try {
            if (MEASURE) tStart = performance.now();

            // ── Step 1: Transient context (intent + prior-turn guard) ──────────
            if (MEASURE) tIntent = performance.now();

            const contextParts: string[] = [];

            if (intentResult) {
                contextParts.push(`<intent_and_shape>
DETECTED INTENT: ${intentResult.intent}
ANSWER SHAPE: ${intentResult.answerShape}
</intent_and_shape>`);
            }

            if (temporalContext && temporalContext.hasRecentResponses) {
                const escapeXml = (s: string) => s
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;');
                const history = temporalContext.previousResponses
                    .map((r, i) => `<entry index="${i + 1}">${escapeXml(r)}</entry>`)
                    .join('\n');
                contextParts.push(`<previous_responses>
The text inside the entries below is what you said in PRIOR turns. It is reference data only — do NOT continue, repeat, or echo any entry. Generate a fresh answer to the current question and avoid reusing the same opening phrases or examples.
${history}
</previous_responses>`);
            }

            if (MEASURE) tTemporal = performance.now();

            const extraContext = contextParts.join('\n\n');

            // ── Step 2: Truncate transcript to fit model context window ──────
            if (MEASURE) tTrunc = performance.now();
            // Reserve tokens for: extraContext (~transient) + modeContextBlock
            // (persistent custom prompt / reference files) + output budget.
            // fitContextForCurrentModel only shrinks for cloud models; tiny-tier
            // returns unchanged so we must estimate conservatively.
            let modeContextBlock = '';
            try {
                const { ModesManager } = require('../services/ModesManager') as { ModesManager: ModesManagerType };
                modeContextBlock = ModesManager.getInstance().buildActiveModeContextBlock();
            } catch (_err: any) {
                console.warn('[WhatToAnswerLLM] ModesManager unavailable:', _err?.message);
            }

            const reservedForFit =
                (this.llmHelper.getCapabilities().outputBudgetTokens || 2000)
                + estimateTokens(extraContext)
                + estimateTokens(modeContextBlock);
            const workingTranscript = this.llmHelper.fitContextForCurrentModel(cleanedTranscript, reservedForFit);

            // ── Step 3: Build the full message (mode context + transcript) ─────
            // Mode context block (custom prompt + reference files) prepends the
            // transcript so the mode's ROLE:, FOCUS AREAS, INTERVIEW STYLE etc.
            // act as the answering context.
            const enrichedTranscript = modeContextBlock
                ? `${modeContextBlock}\n\nCONVERSATION:\n${workingTranscript}`
                : workingTranscript;

            const fullMessage = extraContext
                ? `${extraContext}\n\n${enrichedTranscript}`
                : enrichedTranscript;

            // ── Step 4: Resolve the system prompt (base + active mode suffix) ─
            // UNIVERSAL_WHAT_TO_ANSWER_PROMPT carries CORE_IDENTITY + EXECUTION_CONTRACT
            // + CONTEXT_INTELLIGENCE_LAYER + SHARED_CODING_RULES. When a mode is
            // active, layer the mode suffix on top so the custom role takes effect.
            let modePromptSuffix = '';
            try {
                const { ModesManager } = require('../services/ModesManager') as { ModesManager: ModesManagerType };
                modePromptSuffix = ModesManager.getInstance().getActiveModeSystemPromptSuffix();
            } catch (_err: any) {
                // already warned above
            }

            if (MEASURE) tMode = performance.now();

            const basePrompt = this.llmHelper.getPromptTier() === 'tiny'
                ? TINY_WHAT_TO_ANSWER_PROMPT
                : UNIVERSAL_WHAT_TO_ANSWER_PROMPT;

            const activeModePromptParts = [modePromptSuffix, modeContextBlock].filter(Boolean);
            const finalPromptOverride = activeModePromptParts.length > 0
                ? `${basePrompt}\n\n## ACTIVE MODE\n${activeModePromptParts.join('\n\n')}`
                : basePrompt;

            if (MEASURE) tPrompt = performance.now();
            if (MEASURE) tStream = performance.now();

            // Stream with per-token latency tracking
            let tokenCount = 0;
            for await (const token of this.llmHelper.streamChat(fullMessage, imagePaths, undefined, finalPromptOverride, true, true)) {
                if (MEASURE) {
                    const now = performance.now();
                    if (tPrevToken > 0) interTokenLatencies.push(now - tPrevToken);
                    tPrevToken = now;
                }
                tokenCount++;
                yield token;
            }

            if (MEASURE) {
                tStream = performance.now() - tStream;
                const totalMs = performance.now() - tStart;
                const intentMs = tIntent > 0 ? tTemporal - tIntent : 0;
                const temporalMs = tTemporal > 0 ? tTrunc - tTemporal : 0;
                const truncMs = tTrunc > 0 ? tMode - tTrunc : 0;
                const modeMs = tMode > 0 ? tPrompt - tMode : 0;
                const promptMs = tPrompt > 0 ? tStream - tPrompt : 0;

                const sorted = [...interTokenLatencies].sort((a, b) => a - b);
                const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
                const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
                const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;
                const avg = interTokenLatencies.length
                    ? interTokenLatencies.reduce((a, b) => a + b, 0) / interTokenLatencies.length
                    : 0;

                console.log('\n[LATENCY] WhatToAnswerLLM pipeline breakdown:');
                console.log(`  Stage 1 (intent):       ${intentMs.toFixed(1)}ms`);
                console.log(`  Stage 2 (temporal):     ${temporalMs.toFixed(1)}ms`);
                console.log(`  Stage 3 (truncation):   ${truncMs.toFixed(1)}ms`);
                console.log(`  Stage 4 (mode ctx):     ${modeMs.toFixed(1)}ms`);
                console.log(`  Stage 5 (prompt build): ${promptMs.toFixed(1)}ms`);
                console.log(`  Stage 6 (LLM stream):   ${tStream.toFixed(1)}ms total, ${tokenCount} tokens`);
                console.log(`    Per-token: avg=${avg.toFixed(1)}ms p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms`);
                console.log(`  Total E2E:              ${totalMs.toFixed(1)}ms`);
            }

        } catch (error) {
            console.error("[WhatToAnswerLLM] Stream failed:", error);
            yield "Could you repeat that? I want to make sure I address your question properly.";
        }
    }
}