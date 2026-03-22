# Section 05 — ContextAssembler Update

**File modified:** `premium/electron/knowledge/ContextAssembler.ts`

**Depends on:** Section 04 (KnowledgeOrchestrator Integration — consumes `buildLiveNegotiationSystemPrompt`)

---

## Overview

Two additions to `ContextAssembler.ts`:

1. A new exported function `buildLiveNegotiationSystemPrompt()` that returns a system prompt string tuned for live negotiation coaching — directive, number-aware, and brevity-constrained.
2. The `liveNegotiationResponse` field on the `PromptAssemblyResult` interface, which is the carrier for the pre-computed `LiveCoachingResponse` through the pipeline without triggering a second LLM call.
3. A small helper `isLiveNegotiationContext()` used by the orchestrator to decide which system prompt to inject.

---

## 5a. Extend `PromptAssemblyResult` Interface

Find the `PromptAssemblyResult` interface in `ContextAssembler.ts` and add the optional field:

```typescript
interface PromptAssemblyResult {
  systemPromptInjection: string;
  contextBlock: string;
  isIntroQuestion: boolean;
  introResponse?: string;
  liveNegotiationResponse?: LiveCoachingResponse;  // ← ADD THIS
}
```

Also add the import for `LiveCoachingResponse` at the top of the file if not already present:

```typescript
import { LiveCoachingResponse } from './types';
```

**Why this field exists:**
The live negotiation path in `KnowledgeOrchestrator.processQuestion()` generates a `LiveCoachingResponse` via `LiveNegotiationAdvisor` and needs to pass it to `LLMHelper` without serializing it into `contextBlock` (which would cause a second LLM call). This field is the zero-overhead carrier.

---

## 5b. Add `buildLiveNegotiationSystemPrompt()`

Add this exported function to `ContextAssembler.ts`:

```typescript
export function buildLiveNegotiationSystemPrompt(): string {
  return `You are an expert salary negotiation coach providing real-time guidance.

LIVE NEGOTIATION MODE — ACTIVE.

Your role:
- The user is on a live call with a recruiter RIGHT NOW.
- You have context about the current negotiation state, their offer history, and the user's target.
- Provide precision coaching — not general advice.

Format rules:
- ALWAYS lead with a tactical note (1-2 sentences): what just happened + why this specific move is right.
- THEN provide the exact words to say — format as a direct quote the user can speak.
- Use REAL numbers. If you know their offer was $95,000 and the target is $130,000, say those exact numbers.
- Keep everything under 150 words total. They are on a call.
- Do NOT use brackets, placeholders, or [AMOUNT] style tokens.
- Never reveal you are an AI or that scripts exist.
- This is critical: be directive, not advisory. Say "Say: '...'" not "You might consider saying..."`;
}
```

**Note:** Although the live negotiation path short-circuits before a second LLM call (so this system prompt is never actually sent to an LLM for the coaching card), this function is available for any future hybrid path where the coaching response needs to be refined by the LLM, and for testing purposes.

---

## 5c. Add `isLiveNegotiationContext()` Helper

Add this small helper alongside the other context-detection helpers in the file:

```typescript
export function isLiveNegotiationContext(trackerActive: boolean): boolean {
  return trackerActive;
}
```

Called from `KnowledgeOrchestrator` when deciding whether to inject the live negotiation system prompt. Kept as a function (rather than inline `trackerActive`) to make the call site readable and allow future conditions to be added here without touching the orchestrator.

---

## Acceptance Criteria

- [ ] `PromptAssemblyResult` interface compiles with `liveNegotiationResponse?: LiveCoachingResponse` field
- [ ] `LiveCoachingResponse` import resolves from `./types` with no TypeScript error
- [ ] `buildLiveNegotiationSystemPrompt()` returns a non-empty string
- [ ] The system prompt string contains the phrase "LIVE NEGOTIATION MODE" (used as a smoke-test marker)
- [ ] `isLiveNegotiationContext(true)` returns `true`, `isLiveNegotiationContext(false)` returns `false`
- [ ] No changes to any existing exports or interfaces — purely additive
- [ ] Non-negotiation prompts are unaffected (existing `PromptAssemblyResult` consumers continue to work since the new field is optional)
