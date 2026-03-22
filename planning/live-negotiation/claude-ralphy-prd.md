# PRD: Live Salary Negotiation Coaching

**Project:** Natively AI Interview Assistant
**Feature:** Real-time salary negotiation coaching via conversation tracking

## How to use

```
ralphy --prd planning/live-negotiation/claude-ralphy-prd.md
```

## What we're building

When a recruiter makes an offer on a live call, Natively currently has no awareness of it — it injects a static pre-computed salary script regardless of what was actually said. This feature fixes that by listening to the recruiter's words via system audio STT, tracking the negotiation phase turn-by-turn (first offer, pushback, benefits pivot, acceptance), and generating a real-time coaching card with a one-click-copy exact script the user can speak verbatim. A 5-second silence timer fires when the user names their number, reinforcing the core negotiation tactic of holding silence after anchoring. The result is a dynamic, conversation-aware coach that replaces the static script and reacts in real time to exactly what the recruiter says.

## Tech stack

- Electron + React + TypeScript
- Working dir: /Users/evin/natively-cluely-ai-assistant

## Quality gate

Run after each section:

```bash
npx tsc --noEmit && npx tsc -p tsconfig.node.json --noEmit
```

Zero errors required before proceeding.

## Implementation tasks (implement in order)

- [ ] Section 00: STT Routing Verification
- [ ] Section 01: Types
- [ ] Section 02: NegotiationConversationTracker
- [ ] Section 03: LiveNegotiationAdvisor
- [ ] Section 04: KnowledgeOrchestrator Integration
- [ ] Section 05: ContextAssembler Update
- [ ] Section 06: IPC Handlers & Preload
- [ ] Section 07: NegotiationCoachingCard UI
- [ ] Section 08: NativelyInterface Integration

## Section files

```
planning/live-negotiation/sections/section-00-stt-routing-verification.md
planning/live-negotiation/sections/section-01-types.md
planning/live-negotiation/sections/section-02-negotiation-conversation-tracker.md
planning/live-negotiation/sections/section-03-live-negotiation-advisor.md
planning/live-negotiation/sections/section-04-knowledge-orchestrator-integration.md
planning/live-negotiation/sections/section-05-context-assembler-update.md
planning/live-negotiation/sections/section-06-ipc-handlers-and-preload.md
planning/live-negotiation/sections/section-07-negotiation-coaching-card-ui.md
planning/live-negotiation/sections/section-08-natively-interface-integration.md
```

## Key ERRATA to note

1. **Fix 1 — No double LLM call (Section 04, critical):** Do NOT return `JSON.stringify(coachingResponse)` as `contextBlock` in `processQuestion()`. This would feed the coaching data into a second LLM call and destroy it. Instead, return it via the `liveNegotiationResponse` field on `PromptAssemblyResult` (added in Section 01/05), and short-circuit in `LLMHelper.streamChat()` and `chatWithGemini()` with `yield JSON.stringify({ __negotiationCoaching: data }); return;` before any LLM call is made.

2. **Fix 2 — Pass tracker instance, not state struct (Sections 03 and 04):** `generateLiveCoachingResponse()` in `LiveNegotiationAdvisor` must receive the `NegotiationConversationTracker` class **instance** as its first argument — not the plain `NegotiationState` object returned by `tracker.getState()`. The original plan had a broken `${state_xml_here}` placeholder; the correct implementation calls `tracker.getStateXML()` directly inside the template literal, which requires the instance.

3. **Fix 8 — NegotiationPhase type in UI component (Section 07):** Do NOT attempt to `import { NegotiationPhase } from '../types/negotiation'` or any similar path in `NegotiationCoachingCard.tsx`. That path does not exist in the renderer. Define the `NegotiationPhase` string union type inline at the top of the component file. The message type in `NativelyInterface.tsx` should store `phase` as `string`, and cast with `phase as any` when passing to the card prop.
