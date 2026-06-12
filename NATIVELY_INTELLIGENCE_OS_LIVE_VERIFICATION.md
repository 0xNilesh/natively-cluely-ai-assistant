# Natively Intelligence OS — Live Verification (Phase 15)

**Date:** 2026-06-13
**Branch:** `feature/intelligence-os-live-wiring`
**Scope:** Verification of the live-wiring work (Phases 1–14) that connected the tested
`electron/intelligence/` library into the real app behind feature flags.

> **Honest framing.** This verification was performed in a **headless environment (no GUI)**. So the
> automated gates and the per-phase test-engineer verifications are **executed and green**, while the
> interactive "open the app and type X" script below is provided for a human to run with the flags
> enabled. Each manual case is annotated with the automated test that already covers its logic, so
> "not yet run in the GUI" ≠ "unverified" — the underlying behavior is unit/integration-proven.

---

## A. Automated gates (executed, green)

| Gate | Command | Result |
|---|---|---|
| Typecheck (electron) | `npm run typecheck:electron` | ✅ **0 errors** |
| Typecheck (renderer) | `npx tsc --noEmit -p tsconfig.json` | ✅ **0 errors** |
| Build | `npm run build:electron` | ✅ clean |
| Intelligence suite | `node --test "electron/intelligence/__tests__/**/*.test.mjs"` | ✅ **435 pass / 0 fail / 9 todo** |
| LLM baseline | `node --test "electron/llm/__tests__/**" "…/codeVerification/__tests__/**"` | ✅ **1656 pass / 0 fail / 10 skipped** |
| IntelligenceEngine services | `node --test electron/services/__tests__/IntelligenceEngine*.test.mjs` | ✅ **33 / 0** |
| Meeting pipeline | `node --test electron/services/__tests__/MeetingPersistenceRace.test.mjs electron/services/__tests__/PostCall*.test.mjs` | ✅ **15 / 0** |

**Baseline integrity:** the pre-existing `test:llm` baseline held at **1656 pass / 0 fail** through all 14
wiring phases — zero regressions. The 9 intelligence "todo" are pre-existing Phase-2 placeholders; the
10 LLM "skipped" are pre-existing Go/Java toolchain-gated codeVerification tests. The full services
suite has 41 pre-existing environmental failures (better-sqlite3 ABI / audio-UI / embedding stubs)
that are **identical with and without** this work (verified by stash-compare) and **0 are
intelligence/meeting-related**.

**Per-phase verification:** each of the 14 wiring phases was independently reviewed by a `test-engineer`
agent (PASS verdict) with a dedicated wiring test file:
`TraceWiringObserveOnly`, `DurableMemoryWiring`, `PerspectiveGuardWiring`, `WtaOutputShapeWiring`,
`ContextRouterShadowWiring`, `LiveBrainShadowWiring`, `V2ShadowAssemblyWiring`,
`MeetingMemoryWiringExtraction`, `GlobalSearchHandlerLogic`, `InMeetingSearchHandlerLogic`,
`ConversationMemoryWiring`, `LectureDiagramHandlerLogic`, `HindsightRetainWiring`, `FlagSettingsRoundTrip`.

---

## B. How to run the manual script (enable the flags first)

All flags default OFF. To exercise the live behavior, set the env vars (or toggle via the new
`intelligence-flags:set` IPC / a future dev settings panel) and launch the app:

```bash
NATIVELY_DURABLE_MEMORY_WINDOW=1 \
NATIVELY_PROFILE_TREE_V2=1 \
NATIVELY_ANSWER_DIVERSITY_GUARD=1 \
NATIVELY_CONTEXT_ROUTER_V2=1 \
NATIVELY_LIVE_TRANSCRIPT_BRAIN=1 \
NATIVELY_PROMPT_ASSEMBLER_V2=1 \
NATIVELY_MEETING_MEMORY_V2=1 \
NATIVELY_GLOBAL_SEARCH_V2=1 \
NATIVELY_IN_MEETING_SEARCH_V2=1 \
NATIVELY_CONVERSATION_MEMORY_V2=1 \
NATIVELY_LECTURE_INTELLIGENCE_V2=1 \
NATIVELY_DIAGRAM_INTELLIGENCE=1 \
NATIVELY_INTELLIGENCE_TRACE=1 \
npm start
```

(Hindsight flags intentionally omitted — they need a running server; see `docs/HINDSIGHT_LOCAL_SETUP.md`.)

---

## C. Manual test script (run in the GUI; each case cites its automated coverage)

### Profile identity
| Ask | Expected | Automated coverage |
|---|---|---|
| introduce yourself / who are you / what is your name / what's my full name / tell me about yourself / walk me through your background / what projects have I built / what is my best project | Candidate identity; **no "I'm Natively"**; no "I don't know" if a profile is loaded; trace shows ProfileTree/fast-path | `ProfileIdentityBaseline`, `PerspectiveGuardWiring`, `ProfileTreeService` |

### App identity
| Ask | Expected | Automated coverage |
|---|---|---|
| what is Natively / are you an AI / what model are you / who built Natively | App identity allowed; NOT confused with candidate identity | `ProfileIdentityBaseline` (assistant-meta bails), `PerspectiveGuardWiring` (app questions exempt) |

### Answer repetition
| Ask (repeat variants) | Expected | Automated coverage |
|---|---|---|
| why should we hire you / …briefly / …in one sentence / what gap do you have | No repeated exact opening; no empty `*` bullets; no unwanted "Speakable Final Answer" | `OutputArtifactBaseline`, `WtaOutputShapeWiring` (WTA path), existing `answerPolish` (manual path, already live) |

### Sales
| Ask | Expected | Automated coverage |
|---|---|---|
| why is your product expensive / can you reduce the price / what does your product do | Sales/product perspective; **no candidate resume** unless asked | `ModeBoundaryBaseline` (sales → profile forbidden), `ContextFusionEngine` (mode contamination) |

### Lecture + diagram (lecture mode)
| Ask | Expected | Automated coverage |
|---|---|---|
| create notes from this lecture / generate a TCP handshake diagram / create flashcards / generate likely exam questions | Lecture notes (no interview/sales framing); valid Mermaid labeled **ai_reconstructed** (never "exact") | `LectureDiagramHandlerLogic`, `LectureIntelligence`, `DiagramIntelligence` |

### WTA (live transcript)
| Setup → action | Expected | Automated coverage |
|---|---|---|
| Transcript: "explain your Redis project and why you chose Redis" → click What-to-answer | Answer addresses the Redis project; trace shows live transcript window | `LiveBrainShadowWiring`, `LiveTranscriptBrain*`, existing WTA tests |

### Long-range memory (durable window)
| Setup → ask | Expected | Automated coverage |
|---|---|---|
| Start: "the client is Mark and the topic is Redis scaling." Wait > 2 min. Ask: "what was the client and topic?" | With `NATIVELY_DURABLE_MEMORY_WINDOW=1`: recalls **Mark + Redis scaling** | `DurableMemoryWiring` (reproduces bug + proves fix on the REAL SessionTracker) |

### Same-session follow-up (manual)
| Sequence | Expected | Automated coverage |
|---|---|---|
| Ask a question, get an answer, then "make that shorter" / "why?" / "go on" | Resolves against the prior turn (not a generic clarification) | `ConversationMemoryWiring` |

### Search
| Ask (renderer search pill) | Expected | Automated coverage |
|---|---|---|
| literal-search "Redis" / "pricing objection" | Real local-DB results (opens top meeting), not the AI passthrough | `GlobalSearchHandlerLogic` |
| in-meeting search "pricing" (via IPC) | Fast, timestamped, speaker-attributed snippets | `InMeetingSearchHandlerLogic` |

---

## D. What is genuinely live vs observe-only (honest map)

**Ships real flag-gated capability** (changes the answer/result when enabled):
- Phase 2 durable memory fix, Phase 4 WTA answer polish, Phase 8 meeting-memory persistence,
  Phase 9 global search, Phase 10 in-meeting search, Phase 11 conversation memory,
  Phase 12 lecture/diagram IPCs, Phase 3 perspective guard (widens an existing safety strip).

**Observe-only / shadow** (records telemetry/trace, never changes the answer — de-risks a future cutover):
- Phase 1 IntelligenceTrace, Phase 5 ContextRouter shadow, Phase 6 LiveTranscriptBrain parity,
  Phase 7 PromptAssemblerV2 inclusion-report shadow.

**Wiring + safe-disabled path only** (no working feature without external setup):
- Phase 13 Hindsight retain — Noop until the client is installed + a server runs.

**Backend contract, UI deferred:**
- Phase 12 lecture/diagram IPCs and Phase 9/10 search have backend IPCs + typed preload but the
  renderer panels (lecture notes view, in-meeting search box) are separate UI features. Phase 9's
  literal-search reroute IS wired into `Launcher.tsx`.
- Phase 14 flag toggling has the IPC contract; a React settings panel is a separate feature.

---

## E. Remaining for a full GUI sign-off (human, with a built app)

1. Launch the app with the flags above and walk section C.
2. With `NATIVELY_INTELLIGENCE_TRACE=1`, confirm trace records appear for manual + WTA answers
   (and contain no raw query/PII — hashed only).
3. For Hindsight (optional): follow `docs/HINDSIGHT_LOCAL_SETUP.md`, then enable
   `NATIVELY_HINDSIGHT_MEMORY=1` + `NATIVELY_HINDSIGHT_POST_MEETING_RETAIN=1` and confirm a meeting
   summary is retained (and that the app still works identically with them off).

**Status:** automated verification COMPLETE and green; interactive GUI walk-through is the one
remaining human step (cannot be executed headless).
