# Integration Notes — External Review Feedback

## Integrating

### 1. processQuestion() return flow — CRITICAL BUG (both reviewers)
**Issue:** Plan returns `JSON.stringify(coachingResponse)` as `contextBlock`, which gets fed back into a *second* LLM call as raw context, producing garbage output.
**Fix:** Extend `PromptAssemblyResult` with an optional `liveNegotiationResponse?: LiveCoachingResponse` field. In `streamChat()` and `chatWithGemini()`, detect this field and short-circuit the LLM call — yield the coaching data directly to the renderer, exactly like the `isIntroQuestion` → `introResponse` pattern already does.

### 2. Broken prompt template — CRITICAL BUG (both reviewers)
**Issue:** `${state_xml_here}` in the advisor prompt is a string literal, not a real interpolation. The `.replace()` workaround calls `state.getStateXML()` on a plain struct (not the class), always returns `undefined`, falls back to ugly JSON.
**Fix:** LiveNegotiationAdvisor receives the tracker instance (not just `.getState()`), calls `tracker.getStateXML()` directly in the template literal.

### 3. STT routing verification — CRITICAL BLOCKER (Gemini)
**Issue:** The entire feature depends on recruiter speech reaching `addRecruiterUtterance()`, but plan marks it "needs verification."
**Fix:** Elevate Section 9 to a pre-requisite investigation step with explicit acceptance criteria. Block all other sections on this confirmation.

### 4. `addUserUtterance` false positive silence timer (Gemini)
**Issue:** Any user message containing a number (e.g., "I have 130k test cases") triggers the silence timer.
**Fix:** Gate silence timer trigger behind `isActive() && phase !== 'INACTIVE'` AND require the number to be in a plausible salary range AND the user must be responding to a negotiation context (check for salary-adjacent words in the same utterance).

### 5. Phase state machine too rigid — CRITICAL LOGIC BUG (Gemini)
**Issue:** After HOLD/PIVOT_BENEFITS, if recruiter comes back with a better offer, tracker stays stuck and gives wrong advice.
**Fix:** Allow HOLD → COUNTER transition when a new recruiter offer is detected. PIVOT_BENEFITS → COUNTER also re-enabled for new offers. Keep CLOSE as terminal. Only INACTIVE/PROBE transitions are strictly forward-only.

### 6. Shallow copy on `getState()` (Codex)
**Issue:** Spread only copies top level; `allEvents` and `benefitsMentioned` are live references.
**Fix:** Deep copy arrays: `offers: { ...state.offers, allEvents: [...state.offers.allEvents] }` and `benefitsMentioned: [...state.benefitsMentioned]`.

### 7. `this.activeResume!` non-null assertion crash (Codex)
**Issue:** Crashes if called before resume is loaded.
**Fix:** Add explicit null check: `if (!this.activeResume) return null;` before calling the advisor.

### 8. `NegotiationPhase` import path in UI (both reviewers)
**Issue:** Import from `../types/negotiation` — that file doesn't exist.
**Fix:** Import `NegotiationPhase` from types defined inline in `NegotiationCoachingCard.tsx` or re-export from the existing `src/types/` directory.

### 9. INACTIVE → PROBE transition unreachable (Codex)
**Issue:** In `addRecruiterUtterance()`, the INACTIVE → PROBE check runs AFTER signal processing; signals may transition phase before the INACTIVE gate fires.
**Fix:** Move INACTIVE → PROBE activation to the TOP of `addRecruiterUtterance()`, before any signal processing.

### 10. LLM timeout missing (both reviewers)
**Issue:** No timeout on advisor LLM call, can hang indefinitely.
**Fix:** Wrap `generateContentFn` call in a `Promise.race` with a 5-second timeout. On timeout, fall back to the pre-computed script immediately.

### 11. `onSilenceTimerEnd` called inside React state updater (Codex)
**Issue:** React violation — callbacks from inside state updaters can fire twice in StrictMode.
**Fix:** Move `onSilenceTimerEnd()` call outside the `setSilenceSeconds` updater, using a ref to track when the timer hits 0.

### 12. `useEffect` missing dependency `onSilenceTimerEnd` (Codex)
**Fix:** Either wrap `onSilenceTimerEnd` in `useCallback` at the call site, or use a ref to store it inside the component.

---

## Not Integrating

### Latency claim "nearly impossible at P95" (Gemini)
Gemini claims the extra LLM round trip makes 3s impossible. This is accurate at P95 for slow providers. However: (1) the advisor prompt is small and focused; (2) the short-circuit fix (no double LLM call) removes the bottleneck. Accept P50 < 3s, update criterion to "typically within 3-4 seconds" and add a skeleton loader.

### STT partial result debouncing (Gemini)
Valid concern but adds scope. Existing `feedInterviewerUtterance()` doesn't debounce for depth scorer either, and it's fine. The regex extraction is fast; duplicate calls are idempotent for amounts already seen. Defer to a follow-up.

### Non-USD currency handling (Codex)
Valid but out of scope for initial implementation. The tracker defaults to USD; currency will be improved when salary data from dossier is available.
