# Live Manual Session-Memory Report — 2026-06-07c

## Honest scope

The manual chat path (`gemini-chat-stream` in `ipcHandlers.ts`) is **single-shot**:
its IPC handler receives only `(message, imagePaths?, context?)` — NO conversation
history is threaded to it. There is therefore **no multi-turn session to recall
from** in manual mode, so the long-range SessionMemory recall (which the WTA live
transcript path uses) does not apply here. This report documents what manual mode does
instead, so the integration is not overclaimed.

## What manual mode does (and why it's correct without SessionMemory)

| concern | manual-mode behavior |
|---|---|
| bare follow-up ("why?", "and?", "continue") | when no `context` is provided, returns the deterministic **context-free clarification** (`buildContextFreeClarification('manual')`) — never "I'm Natively", never a profile dump, never a false refusal |
| follow-up WITH pasted context | a provided `context` string counts as prior context, so the message flows through the normal planner path |
| candidate answers | the **candidate sanitizer** strips assistant-meta tails (and self-referential "AI assistant") with a deterministic profile fallback if emptied |
| profile facts | the deterministic profile fast-path answers identity/skills/projects/JD-fit without an LLM round-trip |
| coding / technical | profile-forbidden; the strip-repair removes any stray profile/Natively token |

## Why SessionMemory is not wired into manual mode

A manual `gemini-chat-stream` call has no `turns[]` to build a SessionMemory from. The
only way to give manual chat long-range memory would be to thread the renderer's chat
history into the IPC call — a larger UI/IPC change outside this pass and not required:
manual mode's bare-follow-up clarification already produces the safe behavior the
directive requires ("no-context bare follow-up → clarification, not Natively
identity"). The config header states this explicitly so the WTA-only wiring is not
misread as covering manual.

## Validation

- The manual bare-follow-up clarification + sanitizer are exercised by the
  multimode-1000 manual cases (the runner mirrors `ipcHandlers`): a manual "why?" →
  "Can you clarify what you want me to explain?" (verified, 0 identity leaks); a
  candidate answer with an "AI assistant" tail → sanitized.
- `ContextFreeFollowup2026_06_07c.test.mjs` + `CandidateSanitizer2026_06_07c.test.mjs`
  cover the manual surface deterministically.

## Verdict

Manual mode is **production-ready and unaffected by the flag**: it returns safe
clarifications for context-free bare follow-ups and sanitizes candidate answers today,
with no dependency on SessionMemory (which has no multi-turn substrate to use in a
single-shot handler). If manual chat history is threaded to the handler in a future
pass, `resolveLiveFollowup` can be wired in identically to the WTA path.
