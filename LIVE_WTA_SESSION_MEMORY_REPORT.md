# Live WTA Session-Memory Report — 2026-06-07c

## Scope

The "What to answer?" (WTA) live-transcript path is the surface where SessionMemory is
wired, because it is the only one with real multi-turn history (the live meeting
transcript). This report covers that integration.

## Flow (flag ON)

```
live interviewer turn (transcript)
→ extractLatestQuestion (deterministic, last ~180s answer window)
→ [LIVE SESSION MEMORY] build SessionMemory from a WIDE 7200s window of turns,
    converting SessionTracker ms timestamps → SECONDS (Math.floor(ts/1000))
→ plan the latest question to get its intent → effectiveMemoryMode
    (coding/technical question → 'coding' boundary; comp → 'negotiation')
→ resolveLiveFollowup → resolveSessionFollowup:
      • recall the salient entity for a demonstrative ("that project" → Natively)
      • inherit the prior turn's type for a bare follow-up ("And SQL?")
      • context-free bare follow-up with no prior → safe clarification (emit + return)
→ planAnswer on the resolved question
→ streamContextPolicy / build allowed context (forbidden layers excluded)
→ deterministic fast-path OR LLM
→ ProfileOutputValidator + candidate sanitizer
→ stream final answer
```

Flag OFF → the proven single-prior-turn `resolveFollowUpOrClarify` path runs unchanged.

## What the WTA path now does correctly

| capability | behavior |
|---|---|
| immediate follow-up | "How did you build it?" → resolves the just-named project |
| delayed (after filler) | "tech stack there?" 8 turns later → still the project |
| **1-hour recall** | "hardest part of that project?" at minute 62 → the project (ms→s fix) |
| skill follow-up | "And SQL?" / "how is your SQL?" → SQL skill experience |
| correction | "actually use TalentScope" → later follow-ups use TalentScope |
| competing entities | two projects → "that project" = the most recent |
| **coding boundary** | a coding/SQL question in an interview → NO project recall (effectiveMemoryMode) |
| **salary boundary** | comp never recalled into a coding/technical answer (double-gated) |
| context-free bare | "why?" with no prior → clarification, never "I'm Natively" |
| candidate voice | first-person preserved; assistant-meta stripped by the sanitizer |

## Validation

- **Live-session-memory benchmark** (`run_live_session_memory_eval.ts`, flag forced
  ON) drives the EXACT `resolveLiveFollowup` orchestrator over 100 scenarios / 364
  checks with engine-epoch second timestamps (mirrors the ms→s unit path): **100%
  scenarios, 100% checks, 0 context-leaks, resolve p95 1ms**.
- **Unit tests** (`LiveSessionMemory2026_06_07c.test.mjs`, 32 subtests): the 12 live
  edge cases, the ms→seconds engine-adapter guard (62-min recall survives; raw-ms
  proves the bug), effectiveMemoryMode coding/comp boundaries, context-free detection.
- **Electron-runtime smoke**: 6/6 (modules load + resolve correctly under the Electron
  binary with the flag on).
- **Multimode-1000 (flag ON)**: 100% clean-row pass, route 100%, safety 100%, 0 leaks
  — the wiring does not regress WTA answer quality.

## Privacy

- SessionMemory stores short tokens, never raw turns; debug logs are marker-only.
- Salary auto-promoted to comp (value-level) + comp gated to negotiation only.
- The wide 7200s window feeds extracted tokens (a name, a skill) into mode-gated
  recall — never raw transcript into the prompt.

## Verdict

The WTA live path is **production-ready behind the default-OFF flag**. Long-range
recall works (unit bug fixed), all mode boundaries hold (coding/comp via question
intent), and the proven path is preserved when the flag is off.
