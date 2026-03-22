# Section 04 — KnowledgeOrchestrator Integration

**Files modified:**
- `premium/electron/knowledge/KnowledgeOrchestrator.ts`
- `electron/LLMHelper.ts`

**Depends on:** Section 01 (Types), Section 02 (Tracker), Section 03 (Advisor), Section 05 (ContextAssembler — for `buildLiveNegotiationSystemPrompt`)

---

## Overview

This section wires the `NegotiationConversationTracker` and `LiveNegotiationAdvisor` into the existing orchestrator pipeline. The live negotiation path short-circuits the normal LLM flow: when the tracker is active and a NEGOTIATION intent is detected, the advisor generates a `LiveCoachingResponse` directly and returns it via `liveNegotiationResponse` in the `PromptAssemblyResult`. `LLMHelper` detects this field and yields a special token instead of calling the LLM again.

---

## 4a. Imports and Private Field

In `KnowledgeOrchestrator.ts`, add the following imports alongside existing imports at the top of the file:

```typescript
import { NegotiationConversationTracker } from './NegotiationConversationTracker';
import { generateLiveCoachingResponse } from './LiveNegotiationAdvisor';
```

Add the private field alongside the other private fields (approximately line 35):

```typescript
private negotiationTracker: NegotiationConversationTracker;
```

In the constructor, after other field initializations (approximately line 43):

```typescript
this.negotiationTracker = new NegotiationConversationTracker();
```

---

## 4b. Seed User Target from Negotiation Script in `refreshCache()`

After the negotiation script is loaded from the DB or AOT pipeline in `refreshCache()`, seed the tracker's user target so it knows the goal before any recruiter speaks:

```typescript
// After negotiation script is retrieved
const script = this.getNegotiationScript();
if (script?.salary_range?.max) {
  this.negotiationTracker.setUserTarget(script.salary_range.max);
}
```

This ensures that even if the user never verbally states their target number, the tracker has a reference point from the pre-computed script.

---

## 4c. Wire `feedInterviewerUtterance`

Find the existing `feedInterviewerUtterance` method. It currently calls `this.depthScorer.addUtterance(text)`. Add the tracker call immediately after:

```typescript
feedInterviewerUtterance(text: string): void {
  this.depthScorer.addUtterance(text);
  // NEW: Feed recruiter speech into negotiation tracker
  this.negotiationTracker.addRecruiterUtterance(text);
}
```

This is the primary ingestion point for recruiter speech. System audio STT transcripts must be routed here (verified in Section 00).

---

## 4d. Wire User Utterances in `processQuestion()`

Near the top of `processQuestion()`, before the intent detection check, add:

```typescript
// Feed user's question to tracker for user-side number detection (silence timer)
this.negotiationTracker.addUserUtterance(question);
```

This allows the tracker to detect when the user has stated a specific salary number (which triggers the silence timer), and updates `userTarget` if the user names a number before the tracker has one.

---

## 4e. Live Negotiation Path in `processQuestion()` — CRITICAL (ERRATA Fix 1)

**WARNING:** Do NOT return `JSON.stringify(coachingResponse)` as `contextBlock`. This causes a double LLM call which destroys the coaching data. Instead, use the `liveNegotiationResponse` field on `PromptAssemblyResult` (defined in Section 05).

In the `NEGOTIATION` intent handler block (around the existing salary intelligence injection), add the live path BEFORE the existing static fallback:

```typescript
if (intent === IntentType.NEGOTIATION) {
  // Live negotiation path: only when tracker has seen recruiter speech
  if (this.negotiationTracker.isActive()) {
    // Null guards (Fix 7)
    if (!this.activeResume) return null;
    if (!this.generateContentFn) return null;

    const dossier = this.activeJD
      ? this.companyResearch.getCachedDossier(
          (this.activeJD.structured_data as StructuredJD).company || ''
        )
      : null;
    const script = this.getNegotiationScript();

    const coachingResponse = await generateLiveCoachingResponse(
      this.negotiationTracker,   // Pass tracker INSTANCE (Fix 2 — not .getState())
      question,
      this.activeResume,
      this.activeJD,
      dossier,
      script,
      this.generateContentFn
    );

    // Return with liveNegotiationResponse — NOT contextBlock (Fix 1)
    return {
      systemPromptInjection: '',
      contextBlock: '',
      isIntroQuestion: false,
      liveNegotiationResponse: coachingResponse,
    };
  }

  // Fallback: existing static salary_intelligence injection — unchanged
  // ...existing code continues here...
}
```

**Key points:**
- `liveNegotiationResponse` is passed through `PromptAssemblyResult` without being serialized.
- The LLM is never called for this path. `LLMHelper` short-circuits in step 4f below.
- The null guards from Fix 7 prevent crashes when resume or LLM function is unavailable.

---

## 4f. Short-Circuit in `LLMHelper.streamChat()` and `chatWithGemini()`

In `electron/LLMHelper.ts`, in both `streamChat()` (the streaming path) and `chatWithGemini()` (the Gemini path), find the point where the `knowledgeResult` from `processQuestion()` is used — immediately after the knowledge result is obtained and before any LLM call is made — and add the short-circuit:

```typescript
// Short-circuit: if coaching response is pre-computed, emit it directly
if (knowledgeResult?.liveNegotiationResponse) {
  const data = knowledgeResult.liveNegotiationResponse;
  yield JSON.stringify({ __negotiationCoaching: data });
  return;
}
```

**Why this works:**
- The renderer's stream token handler checks each incoming token for the `__negotiationCoaching` key.
- When found, it renders a `NegotiationCoachingCard` instead of treating it as markdown text.
- No second LLM call is made. The coaching data generated by `LiveNegotiationAdvisor` reaches the UI unchanged.

---

## 4g. New Public Methods

Add these two public methods to `KnowledgeOrchestrator`:

```typescript
getNegotiationTracker(): NegotiationConversationTracker {
  return this.negotiationTracker;
}

resetNegotiationSession(): void {
  this.negotiationTracker.reset();
}
```

These are called by the IPC handlers in Section 06 to expose tracker state and reset capability to the renderer.

---

## 4h. Reset Tracker on JD Delete or Replace

In `deleteDocumentsByType()` and in any code path where the active JD is replaced or cleared, add:

```typescript
this.negotiationTracker.reset();
```

This ensures the negotiation tracker doesn't carry over state from a previous job's conversation when the user switches jobs.

---

## Acceptance Criteria

- [ ] `feedInterviewerUtterance("budget is 95k")` causes `negotiationTracker.getState().phase === 'ANCHOR'` and `latestRecruiterAmount === 95000`
- [ ] `processQuestion("what should I say?")` with active tracker returns an object with `liveNegotiationResponse` set and `contextBlock === ''`
- [ ] `processQuestion` without an active tracker falls through to existing static `salary_intelligence` injection — no regression
- [ ] No double LLM call: `streamChat` short-circuits when `liveNegotiationResponse` is present
- [ ] `streamChat` yields exactly one token: `JSON.stringify({ __negotiationCoaching: ... })` and then returns
- [ ] `chatWithGemini` applies the same short-circuit
- [ ] `resetNegotiationSession()` resets tracker to INACTIVE phase
- [ ] `getNegotiationTracker()` returns the live tracker instance
- [ ] Null guards prevent crash when `activeResume` is null or `generateContentFn` is undefined
- [ ] Tracker resets when JD is deleted or replaced
- [ ] `setUserTarget` is called with `script.salary_range.max` during `refreshCache()` when script is available
