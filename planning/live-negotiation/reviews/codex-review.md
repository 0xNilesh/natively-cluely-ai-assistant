# Code Review — Live Salary Negotiation Coaching
## Reviewer: Senior Software Engineer
## Plan reviewed: `planning/live-negotiation/claude-plan.md`

---

## Executive Summary

The plan is well-structured and covers the core feature end-to-end. The state machine design is sound, the IPC boundary is clean, and the UI component is reasonable. However, there are a number of correctness bugs, silent failure modes, state management hazards, and integration gaps that would surface in real usage. The most critical issues are the broken prompt template in `LiveNegotiationAdvisor`, the shallow-copy problem on `getState()`, the silence timer race condition, and the unverified assumption about system audio STT routing.

---

## 1. Code Correctness

### 1.1 Broken prompt template variable in `LiveNegotiationAdvisor`

**Severity: Critical — will produce a broken LLM prompt on every call.**

The prompt string contains a literal placeholder comment:

```typescript
CURRENT NEGOTIATION STATE:
${state_xml_here}  // Replaced by getStateXML() output at call site
```

This is not valid TypeScript template interpolation. `state_xml_here` is not a variable in scope. The plan then patches this with a `replace()` call on the constructed string:

```typescript
const raw = await generateContentFn([{ text: prompt.replace('${state_xml_here}', state.getStateXML ? ...) }]);
```

This approach is fragile and will fail silently if the placeholder string doesn't match exactly (e.g., whitespace difference). The `NegotiationState` interface has no `getStateXML()` method — that method lives on the class `NegotiationConversationTracker`. The check `state.getStateXML ? (state as any).getStateXML() : JSON.stringify(state)` will always hit the `JSON.stringify(state)` branch because `getState()` returns a plain struct copy, not a class instance with methods. The full negotiation XML will never be injected; only raw JSON (without the formatted XML structure) will reach the LLM.

**Fix:** Either pass the XML string as a separate parameter to `generateLiveCoachingResponse`, or have the orchestrator call `tracker.getStateXML()` and pass the result in.

### 1.2 Regex flag reuse bug in `extractAmounts`

The plan reconstructs regex from patterns using:

```typescript
const regex = new RegExp(pattern.source, pattern.flags);
```

The source patterns are declared with the `g` (global) flag. When you use `RegExp.exec()` in a loop with a global regex, the regex maintains `lastIndex` state. However, since a new `RegExp` is being constructed per call, `lastIndex` resets to 0 each time `extractAmounts` is called — that part is fine. The real problem is the `between...and` pattern:

```
/between\s+(\d{2,3})[k]?\s+and\s+(\d{2,3})[k]?/gi
```

This pattern has two capture groups. In `extractAmounts`, the code uses `match[1]` which will only capture the first number in the range ("between 90k and 110k" → extracts 90k, silently drops 110k). For range offers this produces incorrect data — the plan intends to track ranges with `offerType: 'range_min' | 'range_max'` but the extraction never distinguishes them.

### 1.3 `normalizeAmount` mishandles dollar-sign amounts

```typescript
function normalizeAmount(raw: string): number {
  const clean = raw.replace(/[$,\s]/g, '');
  const num = parseFloat(clean);
  return num < 1000 ? num * 1000 : num;
}
```

For an input like `"$95,000"`, after stripping `$` and `,` this yields `"95000"` → `95000`. That is correct. But for `"$95k"`, stripping gives `"95k"`. `parseFloat("95k")` returns `95` (JavaScript silently ignores trailing non-numeric chars). Then `95 < 1000 → 95 * 1000 = 95000`. This works by accident. However, for `"$1.5M"` stripping gives `"1.5M"`, `parseFloat` returns `1.5`, and `1.5 * 1000 = 1500` — a $1.5M salary becomes $1,500. The plan's salary patterns don't include an "M" pattern, so this is a latent bug waiting for an edge case.

### 1.4 Phase transition for INACTIVE → PROBE is unreachable in practice

In `addRecruiterUtterance`, the INACTIVE → PROBE transition at the end:

```typescript
if (this.state.phase === 'INACTIVE') {
  this.transitionPhase('PROBE');
}
```

This check runs AFTER all the signal detection blocks. But each signal detection block calls `transitionPhase('ANCHOR')`, `transitionPhase('HOLD')`, etc. `transitionPhase` only moves forward, so by the time this INACTIVE check runs, the phase has already moved to ANCHOR or HOLD. The PROBE state is never actually entered via normal flow — only if `addRecruiterUtterance` is called with text that matches no patterns at all. This means `isActive()` returns false for the very first signal (since PROBE and later are all considered active), but the transition logic has the INACTIVE check after the signal checks rather than before. The ordering inverts the intended logic.

### 1.5 `OfferEvent.offerType` is always hardcoded to `'base'`

Both `addRecruiterUtterance` and `addUserUtterance` hardcode `offerType: 'base'`. The `OfferEvent` type defines `'base' | 'total' | 'range_min' | 'range_max' | 'ceiling' | 'unknown'` but the extraction logic never assigns anything other than `'base'`. The type modeling effort is wasted, and downstream use of `offerType` (e.g., distinguishing a ceiling from a base) will always see `'base'`.

### 1.6 `processQuestion` return shape vs. `KnowledgeOrchestrator` return type

Section 4e introduces a new return property `isLiveNegotiationCoaching: true` on the object returned from `processQuestion()`. However, `processQuestion()` presumably has a declared return type. Adding an ad-hoc field without updating the return type will either be a TypeScript error or, if the return type uses a loose shape, silently ignored by the renderer. The plan does not update the `KnowledgeOrchestrator` return type to include `isLiveNegotiationCoaching`.

---

## 2. Missing Error Handling

### 2.1 `navigator.clipboard?.writeText` is fire-and-forget

```typescript
const handleCopy = () => {
  navigator.clipboard?.writeText(exactScript);
  setCopied(true);
  ...
};
```

`writeText` returns a Promise. If the write fails (focus lost, permission denied in certain Electron security contexts), `setCopied(true)` still fires, showing the user a false "Copied" confirmation. The promise rejection is swallowed. In Electron with `contextIsolation: true` or strict CSP, clipboard access can fail silently.

### 2.2 IPC handler swallows errors without discriminating error types

```typescript
} catch (error: any) {
  return { success: false, error: error.message };
}
```

All errors are flattened to a string message. If the orchestrator throws a structured domain error (e.g., "no resume loaded"), the renderer has no way to distinguish "engine not ready" from "resume missing" from "LLM timeout." This makes it impossible to show meaningful error states in the UI.

### 2.3 `generateLiveCoachingResponse` catch block is too broad

The `try/catch` around the LLM call catches all exceptions including programming errors (null dereferences, type errors introduced by future refactors). These would silently return the fallback script with no log output, making bugs extremely difficult to diagnose in production.

### 2.4 No timeout on `generateContentFn`

The plan says "response generated within 3 seconds" as an acceptance criterion, but there is no timeout enforcement in the code. If the LLM hangs, `processQuestion()` hangs indefinitely, blocking the user's chat UI with no feedback. There is no `AbortController`, no `Promise.race` with a timeout, and no streaming fallback.

### 2.5 Missing null guard before `this.activeResume!` non-null assertion

In Section 4e:
```typescript
this.activeResume!,
```

This non-null assertion suppresses the TypeScript error but does not prevent a runtime crash if `activeResume` is null (e.g., user hasn't uploaded a resume yet). `generateLiveCoachingResponse` then immediately accesses `resumeDoc.structured_data` and `resume.experience` without null checks, causing an unhandled exception that the advisor's `catch` block silently swallows.

---

## 3. State Management Issues

### 3.1 `getState()` returns a shallow copy — nested objects are shared references

```typescript
getState(): NegotiationState {
  return { ...this.state };
}
```

The spread operator creates a shallow copy. `state.offers` (an `OfferState` object) and `state.offers.allEvents` (an array), as well as `state.benefitsMentioned` (an array), are passed by reference. Any consumer that writes to `coachingResponse.offers.allEvents.push(...)` or `state.benefitsMentioned.push(...)` will mutate the tracker's internal state directly. Since `processQuestion()` passes `this.negotiationTracker.getState()` to the advisor, and the advisor passes it to the prompt builder and the catch block, this is an active risk.

### 3.2 Silence timer race condition in `NegotiationCoachingCard`

```typescript
useEffect(() => {
  if (!showSilenceTimer) return;
  setSilenceSeconds(5);
  const interval = setInterval(...);
  return () => clearInterval(interval);
}, [showSilenceTimer]);
```

The `onSilenceTimerEnd` callback is called inside the `setSilenceSeconds` updater function:

```typescript
setSilenceSeconds(s => {
  if (s <= 1) {
    clearInterval(interval);
    onSilenceTimerEnd?.();  // Side effect inside state updater
    return 0;
  }
  return s - 1;
});
```

Calling side effects inside a React state updater is incorrect and violates React's rules. State updaters may be called multiple times in strict mode (React 18+ StrictMode double-invocation). This means `onSilenceTimerEnd` could fire twice, causing the parent to clear the timer flag twice and potentially triggering a message state update twice. The interval reference is captured in closure but `clearInterval(interval)` inside a state setter runs after the state has been committed, so the interval may fire one additional time after `s` reaches 0.

### 3.3 `onSilenceTimerEnd` missing from `useEffect` dependency array

The `useEffect` that runs the silence timer has `[showSilenceTimer]` as its dependency array but uses `onSilenceTimerEnd` inside the interval callback. If `onSilenceTimerEnd` changes (new function reference from a re-render), the interval will call the stale closure version, not the current one. With React's `useCallback`-less inline function in NativelyInterface, `onSilenceTimerEnd` will be a new reference on every render.

### 3.4 Tracker state mutation across concurrent `processQuestion` calls

`processQuestion()` is `async` and `addUserUtterance()` mutates tracker state synchronously before `processQuestion` awaits `generateLiveCoachingResponse`. If a second question is submitted while the LLM is awaiting a response, `addUserUtterance` will run again, potentially flipping `silenceTimerActive` before the first LLM call completes. The state snapshot passed to the first LLM call is `getState()` (a shallow copy taken at call time), but if the first await hasn't resolved and a second turn fires, the `silenceTimerActive` update from the second `addUserUtterance` could affect the first response's snapshot if the shallow copy issue (3.1) applies to that field (it doesn't in this case since booleans are primitives, but the pattern is still unsafe).

### 3.5 Tracker not reset on profile switch

Section 4g covers JD deletion but does not address the case where the user switches to a completely different profile (different resume, different company). If the app supports profile switching, the tracker would continue with stale salary context from the previous session.

---

## 4. Integration Gaps

### 4.1 System audio STT routing is unverified and deferred

Section 9 is the most critical unresolved integration gap. The plan correctly identifies the uncertainty:

> "If system audio STT results come in via a separate IPC event... add..."

This is speculative. The entire feature depends on recruiter speech reaching `addRecruiterUtterance()`, but the plan does not confirm where recruiter STT output is currently emitted in the real codebase. If `feedInterviewerUtterance` is currently called with the wrong source (user's own mic, or a combined transcript), the tracker will misattribute speech and generate nonsensical advice. This needs to be verified before any other work begins.

### 4.2 `buildLiveNegotiationSystemPrompt()` is imported but never connected to the streaming LLM call

Section 4e returns `systemPromptInjection: buildLiveNegotiationSystemPrompt()` as part of the orchestrator result. But the plan does not show how `NativelyInterface.tsx` or the LLM streaming path uses `systemPromptInjection`. If the renderer simply passes the JSON coaching response directly to the LLM as context (the current rendering path for normal messages), the live system prompt is never injected. The plan shows the coaching response being returned as `contextBlock: JSON.stringify(coachingResponse)` and then parsed in the UI — but the system prompt injection pathway is not traced through to the actual `chatWithGemini()` / streaming call.

### 4.3 The coaching response bypass skips the LLM entirely — the UI parsing approach is architecturally inconsistent

The plan returns the `LiveCoachingResponse` JSON as the `contextBlock` and then parses it in the UI to render the coaching card. But this bypasses the normal LLM response stream entirely — there is no AI-generated text streamed; instead, pre-structured JSON is injected into the message stream. This is fine architecturally, but Section 8c assumes the JSON will arrive as a streamed `lastMsg.text` that needs to be parsed. If the orchestrator returns early with a structured result (not a streaming response), the stream completion handler will never fire, and the detection logic in 8c will never execute. The plan does not define whether `processQuestion()` returning `isLiveNegotiationCoaching: true` triggers a streaming response or an immediate structured response, leaving a gap in the end-to-end flow.

### 4.4 `NegotiationPhase` type import path in `NegotiationCoachingCard`

```typescript
import { NegotiationPhase } from '../types/negotiation'; // Or inline the type
```

This import path (`../types/negotiation`) does not exist. The types are defined in `premium/electron/knowledge/types.ts`, which is a backend/electron-side file that the React renderer likely cannot import directly (it would cross the renderer/main process boundary and pull in Node.js-only modules). The plan acknowledges this with a comment ("Or inline the type") but does not resolve it. This will be a compilation error. The fix is to either duplicate the type in the renderer-side types or create a shared types package.

### 4.5 `getNegotiationScript()` is assumed to exist on `KnowledgeOrchestrator` but not defined

Section 4b and 4e both call `this.getNegotiationScript()`. This method is not listed in the plan's additions to `KnowledgeOrchestrator.ts`, suggesting it pre-exists. However, if it doesn't exist or has a different name, this will cause a compile error that only surfaces during full integration. The plan should explicitly confirm the method signature.

### 4.6 No mechanism to emit `onSilenceTimerEnd` back to the tracker

When `onSilenceTimerEnd` fires in the UI, it updates the message's local `showSilenceTimer` field. But the tracker's `silenceTimerActive` state on the main process side is never cleared. If the user asks another question after the timer ends, the tracker still has `silenceTimerActive: true`, causing the next coaching response to show the silence timer again unnecessarily. The plan mentions `clearSilenceTimer()` on the tracker but provides no IPC handler to call it from the renderer.

---

## 5. Testing Blind Spots

### 5.1 Multi-number utterances

What happens when a recruiter says "we can offer between 95k and 110k base, plus a 20k signing bonus"? The `extractAmounts` function will produce three amounts (95000, 110000, 20000 — or depending on regex ordering, potentially different values). All three are pushed as separate `OfferEvent` entries. `latestRecruiterAmount` will be set to whichever was processed last. There is no logic to distinguish a range from a bonus amount, and the phase will transition to ANCHOR on the first amount but there's no test for this multi-value case.

### 5.2 Phase transition with simultaneous signals

What if a recruiter pushback also includes a revised offer? "That's above our band, but we can stretch to 105k." This utterance hits both `PUSHBACK_SIGNALS` and `extractAmounts`. The amounts loop runs first (→ ANCHOR), then the pushback check fires (→ HOLD). The signal detection blocks are ordered with pushback checked before acceptance, but after amounts. The resulting phase (HOLD, since `transitionPhase` only moves forward and HOLD > ANCHOR in the order array) may be correct, but `lastRecruiterSignal` will be `'pushback'` even though an offer was also made. The acceptance criteria don't cover this compound case.

### 5.3 Non-USD currencies

The tracker hardcodes `currency: 'USD'` on all extracted events. The `OfferEvent` type includes a `currency` field but it is never populated from the text. The acceptance criteria include no test for INR, GBP, EUR amounts. A recruiter saying "we're offering ₹18 lakhs" or "£65k" will either extract incorrect numbers (lakh normalization: 18 * 1000 = 18000, far below the $20k floor, filtered out) or be treated as USD.

### 5.4 STT transcription errors / partial words

Real STT output contains errors: "ninety five K", "95-K", "ninety-five thousand dollars". The regex patterns require specific formatting and will miss natural-language numbers ("ninety five thousand"). No fuzzy matching or NLP fallback is planned. The acceptance criteria test clean, machine-formatted strings.

### 5.5 Negotiation activation for general salary questions

Section 4e gates live coaching behind `this.negotiationTracker.isActive()`. The acceptance criteria for Scenario 4 verify the fallback, but there is no test for the boundary: a user who says "what salary should I ask for?" before any recruiter speech, then the recruiter speaks, then the user asks again. The second ask should trigger live coaching. Is there a test for this re-trigger scenario?

### 5.6 Silence timer when `showSilenceTimer` toggles rapidly

If the user mentions a number, then immediately mentions another number (two rapid questions), `showSilenceTimer` will be true for both. The `useEffect` in `NegotiationCoachingCard` resets to 5 on every `showSilenceTimer` change, but since the value stays `true` (not toggling), the effect does not re-run. The timer does not reset for the second number mention unless the prop value first goes `false` then `true`.

### 5.7 Empty `exactScript` fallback display

If the LLM returns an empty string for `exactScript` (valid JSON, but empty), the card renders:
```
"
"
```
— an empty italic quote block. No acceptance criterion covers an empty script fallback display.

### 5.8 Tracker state after `reset()` mid-conversation

There is no test for what happens if `resetNegotiationSession()` is called from the IPC handler while the user is mid-negotiation. A pending `generateLiveCoachingResponse` call would still complete and return a response using the stale pre-reset state snapshot. The UI would render a coaching card for a negotiation session that the user just reset.

---

## 6. Specific Code-Level Improvements

### 6.1 Extract `getStateXML()` call to call site

Pass the XML as a parameter rather than relying on a runtime method check:

```typescript
// In orchestrator (Section 4e):
const coachingResponse = await generateLiveCoachingResponse(
    this.negotiationTracker.getState(),
    this.negotiationTracker.getStateXML(),  // <-- explicit XML
    question,
    ...
);

// In advisor signature:
export async function generateLiveCoachingResponse(
  state: NegotiationState,
  stateXML: string,             // <-- explicit, no runtime method check
  ...
```

### 6.2 Deep clone `getState()` to prevent mutation

```typescript
getState(): NegotiationState {
  return {
    ...this.state,
    offers: {
      ...this.state.offers,
      allEvents: [...this.state.offers.allEvents],
    },
    benefitsMentioned: [...this.state.benefitsMentioned],
  };
}
```

### 6.3 Move side effect out of state updater in silence timer

```typescript
useEffect(() => {
  if (!showSilenceTimer) return;
  setSilenceSeconds(5);
  const interval = setInterval(() => {
    setSilenceSeconds(prev => {
      if (prev <= 1) return 0;
      return prev - 1;
    });
  }, 1000);
  return () => clearInterval(interval);
}, [showSilenceTimer]);

// Separate effect to fire the callback when countdown reaches 0
useEffect(() => {
  if (silenceSeconds === 0 && showSilenceTimer) {
    onSilenceTimerEnd?.();
  }
}, [silenceSeconds, showSilenceTimer, onSilenceTimerEnd]);
```

### 6.4 Add a clipboard write failure handler

```typescript
const handleCopy = async () => {
  try {
    await navigator.clipboard.writeText(exactScript);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  } catch {
    // Clipboard unavailable — no false positive feedback
  }
};
```

### 6.5 Add LLM timeout to `generateLiveCoachingResponse`

```typescript
const timeoutPromise = new Promise<never>((_, reject) =>
  setTimeout(() => reject(new Error('LLM timeout')), 4000)
);
const raw = await Promise.race([
  generateContentFn([{ text: prompt }]),
  timeoutPromise,
]);
```

### 6.6 Guard `this.activeResume` before the non-null assertion

```typescript
if (!this.activeResume) {
  // Fall through to static path rather than crashing
  return this.buildStaticNegotiationContext(...);
}
```

### 6.7 Define a shared renderer-side `NegotiationPhase` type

Create `src/types/negotiation.ts` with the phase type re-exported from the component type, rather than importing from the electron-side `types.ts`:

```typescript
// src/types/negotiation.ts
export type NegotiationPhase =
  | 'INACTIVE' | 'PROBE' | 'ANCHOR' | 'COUNTER'
  | 'HOLD' | 'PIVOT_BENEFITS' | 'CLOSE';
```

### 6.8 Log parsing errors in the advisor

The `catch {}` block should at minimum log to allow post-hoc debugging:

```typescript
} catch (err) {
  console.error('[LiveNegotiationAdvisor] Failed to generate coaching response:', err);
  // ... fallback return
}
```

### 6.9 Add a `clearSilenceTimer` IPC handler

To allow the renderer to sync timer dismissal back to the tracker:

```typescript
safeHandle("profile:clear-silence-timer", async () => {
  appState.getKnowledgeOrchestrator()?.getNegotiationTracker().clearSilenceTimer();
  return { success: true };
});
```

---

## Summary Table

| Issue | Severity | Section |
|---|---|---|
| Broken `${state_xml_here}` placeholder — XML never injected | Critical | Section 3 |
| `getState()` shallow copy — nested objects shared by reference | High | Section 2 |
| `onSilenceTimerEnd` called inside React state updater (double-fire risk) | High | Section 7 |
| System audio STT routing unverified | High | Section 9 |
| `this.activeResume!` crashes if resume not loaded | High | Section 4 |
| `NegotiationPhase` import path doesn't exist in renderer | High | Section 7 |
| No LLM timeout enforcement | Medium | Section 3 |
| `offerType` always hardcoded to `'base'` | Medium | Section 2 |
| INACTIVE → PROBE transition logic ordering issue | Medium | Section 2 |
| `onSilenceTimerEnd` missing from useEffect dependency array | Medium | Section 7 |
| Clipboard write promise not awaited | Medium | Section 7 |
| `clearSilenceTimer` has no IPC path from renderer | Medium | Section 6/7 |
| `buildLiveNegotiationSystemPrompt` injection path not traced | Medium | Section 5 |
| Range amounts only capture first group | Low | Section 2 |
| Non-USD currency extraction not implemented | Low | Section 2 |
| Empty `exactScript` renders blank quoted block | Low | Section 7 |
