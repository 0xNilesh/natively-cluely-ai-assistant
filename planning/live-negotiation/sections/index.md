<!-- SECTION_MANIFEST
section-00-stt-routing-verification
section-01-types
section-02-negotiation-conversation-tracker
section-03-live-negotiation-advisor
section-04-knowledge-orchestrator-integration
section-05-context-assembler-update
section-06-ipc-handlers-and-preload
section-07-negotiation-coaching-card-ui
section-08-natively-interface-integration
END_MANIFEST -->

# Section Index — Live Salary Negotiation Coaching

## Dependency Order (implement in this order)

```
00 (STT verification) ──→ 01 (Types)
                              ↓
                    02 (Tracker) ←── 01
                              ↓
                    03 (Advisor) ←── 01, 02
                              ↓
              04 (Orchestrator) ←── 01, 02, 03
                              ↓
         05 (ContextAssembler) ←── 04
                              ↓
              06 (IPC/Preload) ←── 04
                              ↓
                  07 (UI Card) ←── 01 (types inline)
                              ↓
           08 (NativelyInterface) ←── 04, 06, 07
```

## Sections

| # | Name | Files | Depends on | Blocks |
|---|------|-------|-----------|--------|
| 00 | STT Routing Verification | `electron/main.ts`, `electron/ipcHandlers.ts`, `electron/LLMHelper.ts` | none | 01-08 |
| 01 | Types | `premium/electron/knowledge/types.ts` | 00 | 02, 03, 04, 07 |
| 02 | NegotiationConversationTracker | `premium/electron/knowledge/NegotiationConversationTracker.ts` | 01 | 03, 04 |
| 03 | LiveNegotiationAdvisor | `premium/electron/knowledge/LiveNegotiationAdvisor.ts` | 01, 02 | 04 |
| 04 | KnowledgeOrchestrator Integration | `premium/electron/knowledge/KnowledgeOrchestrator.ts`, `electron/LLMHelper.ts` | 01, 02, 03 | 05, 06, 08 |
| 05 | ContextAssembler Update | `premium/electron/knowledge/ContextAssembler.ts` | 04 | 04 (update) |
| 06 | IPC Handlers & Preload | `electron/ipcHandlers.ts`, `electron/preload.ts`, `src/types/electron.d.ts` | 04 | 08 |
| 07 | NegotiationCoachingCard UI | `src/components/NegotiationCoachingCard.tsx` | 01 | 08 |
| 08 | NativelyInterface Integration | `src/components/NativelyInterface.tsx` | 04, 06, 07 | — |
