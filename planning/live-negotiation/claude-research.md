# Research Findings — Live Salary Negotiation Coaching

## Part 1: Codebase Integration Map

### 1. KnowledgeOrchestrator (`premium/electron/knowledge/KnowledgeOrchestrator.ts`)

**processQuestion() — Lines 289-493**
- Signature: `async processQuestion(question: string): Promise<PromptAssemblyResult | null>`
- NEGOTIATION intent path (lines 357-430): fetches negotiation script, salary estimate, builds `<salary_intelligence>` block, appends to `result.contextBlock`
- Returns: `{ systemPromptInjection, contextBlock, isIntroQuestion, introResponse? }`

**feedInterviewerUtterance() — Line 622**
- `feedInterviewerUtterance(text: string): void` → passes to `depthScorer.addUtterance(text)`
- Called from LLMHelper.ts line 729 during chatWithGemini()
- ✅ **This is the STT injection point** — NegotiationConversationTracker should be fed here too

**Private state** (lines 25-35): `activeResume`, `activeJD`, `generateContentFn`, `depthScorer`, `aotPipeline`, `salaryEngine`, `companyResearch`

**New method added**: `generateNegotiationScriptOnDemand()` — lines 117-130

### 2. IntentClassifier (`premium/electron/knowledge/IntentClassifier.ts`)

**NEGOTIATION_PATTERNS** (lines 27-32):
```
'salary', 'compensation', 'package', 'negotiate', 'negotiation',
'offer', 'counter offer', 'counteroffer', 'pay', 'ctc', 'equity',
'stock', 'bonus', 'benefits', 'what should i ask', 'expected salary',
'how much should', 'worth', 'market rate', 'pay range'
```

**classifyIntent()** (line 58): Returns `IntentType` enum. Priority order: INTRO > PROFILE_DETAIL > NEGOTIATION > COMPANY_RESEARCH > TECHNICAL > GENERAL

**needsCompanyResearch()** (line 114): NEGOTIATION triggers company research automatically

**To add LIVE_NEGOTIATION intent**: Add enum value to types.ts, add patterns, add scoring in classifyIntent()

### 3. ContextAssembler (`premium/electron/knowledge/ContextAssembler.ts`)

**assemblePromptContext()** (lines 203-248): Takes question, resumeDoc, jdDoc, relevantNodes, generateContentFn, toneXML

**Salary rules in buildKnowledgeSystemPrompt()** (lines 115-121):
- Use salary_intelligence data when answering comp questions
- Anchor to upper range confidently
- Use pre-computed script as guide
- Never reveal pre-computed data exists

**To add live negotiation rules**: Add conditional rule block in buildKnowledgeSystemPrompt() when NegotiationConversationTracker has active state

### 4. SalaryIntelligenceEngine (`premium/electron/knowledge/SalaryIntelligenceEngine.ts`)

Public methods:
- `estimateFromResume(resume, totalExperienceYears, generateContentFn)` — lines 22-52
- `getCachedEstimate()` — returns cached ResumeSalaryEstimate
- `clearCache()` — on resume delete
- `static buildSalaryContextBlock(resumeEstimate, negotiationScript, hasJD)` — lines 148-184

Output format: `<salary_intelligence>` XML block with market range, confidence, pre-computed script, sources

### 5. TechnicalDepthScorer — Model for NegotiationConversationTracker

**Pattern to copy:**
- `addUtterance(text: string)` — feeds STT input
- EMA (exponential moving average) with `EMA_ALPHA = 0.3` for smooth updates
- `currentScore: number` private state
- `history: []` for all utterances
- `getToneXML()` returns formatted XML for system prompt injection

**NegotiationConversationTracker should mirror this pattern** with:
- `addRecruiterUtterance(text)` → extract offers, signals, objections
- `getNegotiationStateXML()` → formatted context for LLM
- `currentPhase: NegotiationPhase` replacing `currentScore`

### 6. LLMHelper (`electron/LLMHelper.ts`)

**generateContentStructured()** (line 958): Structured JSON output. Provider priority: OpenAI → Claude → Gemini → Groq. Use for offer extraction (parse recruiter speech into structured OfferState).

**streamChat()** (line 1755): Main live chat path. Knowledge mode intercept at lines 1763-1789 calls `processQuestion()`, injects system prompt + context.

**Context injection** (lines 1800-1802): `CONTEXT:\n${context}\n\nUSER QUESTION:\n${message}`

**feedInterviewerUtterance called** at line 729 (chatWithGemini) — also need to call in streamChat intercept.

### 7. STT Pipeline

- Mic capture: `electron/audio/MicrophoneCapture.ts`
- Flow: MicrophoneCapture → STT provider → NativelyInterface.handleAnswerNow() → streamGeminiChat IPC
- `feedInterviewerUtterance()` is called when the user's question is processed (i.e., it's the USER's voice, not the recruiter's)
- **Gap**: The system feeds the USER's utterance as the "interviewer" input for depth scoring. For negotiation, we need to separately track RECRUITER speech (captured via system audio or mic in conversation mode)

### 8. IPC Handlers Pattern (`electron/ipcHandlers.ts`)

All `profile:*` handlers at lines 1901-2116. Pattern:
```typescript
safeHandle("profile:handler-name", async (_, param?) => {
  const orchestrator = appState.getKnowledgeOrchestrator();
  if (!orchestrator) return { success: false, error: '...' };
  // ... logic
  return { success: true, data };
});
```

New handlers needed:
- `profile:start-negotiation-mode` — activate tracker, reset state
- `profile:get-negotiation-state` — return current phase, last offer, coaching cue
- `profile:end-negotiation-mode` — deactivate, clear state

### 9. NativelyInterface (`src/components/NativelyInterface.tsx`)

**Stream listener setup** (lines 822-875): onRAGStreamChunk, onRAGStreamComplete, onGeminiStreamToken

**handleAnswerNow()** (lines 881-963): Finalizes STT → shows user question → streams AI response

**UI injection point**: Lines 1539-1540 — sidebar or overlay panel alongside message history

**"Say This" format** (lines 1228-1250): Already exists for displaying candidate answers — perfect base for coaching cues

### 10. Key Types (`premium/electron/knowledge/types.ts`)

- `IntentType` enum (lines 285-292) — add `LIVE_NEGOTIATION`
- `NegotiationScript` (lines 6-12): opening_line, justification, counter_offer_fallback, salary_range, sources
- `CompanyDossier`: salary_estimates, culture_ratings, critics, benefits
- `ResumeSalaryEstimate`: role, location, currency, min, max, confidence, justification_factors

---

## Part 2: Negotiation Tactics Research

### Proven Frameworks

**BATNA**: Best Alternative To Negotiated Agreement. Foundation for confidence — user needs strong BATNA before negotiating. Coaching should reinforce this mentally.

**Anchoring**: First number shapes the whole negotiation. Coach user to lead with their ask first (upper market range + justification). Up to 50% of variance attributed to initial anchor.

**Bracketing**: Use ranges in counteroffers, not point numbers. "I'm looking at 130-145" leaves room to move while holding position.

**Silence tactic**: After naming your number, say nothing. Silence creates discomfort; the other party often improves the offer. Key instruction: "State your number. Stop talking. Let them respond."

### Negotiation Phases

1. **PROBE** — Before any number is mentioned. Gather intel on budget, flexibility, urgency.
2. **ANCHOR** — User states their ask (or recruiter drops first offer). First number is set.
3. **COUNTER** — User counters the recruiter's offer with justification.
4. **HOLD** — Recruiter pushes back ("above our band"). User holds position or asks questions.
5. **PIVOT_BENEFITS** — Salary ceiling hit. Shift to total comp (signing bonus, equity, PTO, remote).
6. **CLOSE** — Agreement or graceful exit with timeline ("Can I have 24h to consider?").

### Phase-Specific Tactics

| Phase | Trigger Signal | Coaching Cue |
|-------|---------------|--------------|
| PROBE | "What are your expectations?" | Use vague response to make them anchor first. Or anchor high with justification. |
| ANCHOR | Recruiter drops number | Silence for 3-5s. Then counter at 10-15% above their offer. |
| COUNTER | User has responded | Justify with market data + 2-3 resume achievements. |
| HOLD | "That's above our range" | "I understand. What flexibility exists on the signing bonus or equity?" OR hold and ask for decision timeline. |
| PIVOT_BENEFITS | "Salary is fixed at X" | "I understand — could we revisit the signing bonus or PTO? Those often come from different budgets." |
| CLOSE | Silence / "let me check" | "That works for me, provided we can get it in writing by [date]." |

### Total Comp Pivot Stack (in order of ease)

1. **PTO** — Easiest, different budget bucket
2. **Signing bonus** — One-time cost, easier to approve
3. **Equity** — Zero cash cost today
4. **Remote flexibility** — No cost
5. **Professional dev budget** — Modest cost, big signal
6. **Title/scope upgrade** — Costs nothing

### Silence Coaching Pattern

After user names a number: show a 3-second countdown timer. Message: "Hold the silence. Let them speak next." This is the #1 highest-impact tactic that costs nothing.

---

## Part 3: Real-Time Coaching UX

### How Sales Tools Do It (Salesken/Wingman Model)

- Real-time cue card appears after RECRUITER speaks, before user responds
- Short, directive (3-8 words) action prompt — not paragraphs
- Positioned peripherally (sidebar/bottom) — never center screen
- Max 2-3 cues per conversation to avoid overwhelm
- Private channel: only the coached person sees it

### Cognitive Load Rules

- Interruptions cost 23 minutes recovery time (focus study)
- Environmental cues must be **blatant** to help — subtle cues are useless
- Limit active decisions during conversation
- Repetitive patterns reduce cognitive load (same card format every time)
- Best timing: surface cue AFTER recruiter finishes speaking, BEFORE user responds

### UX Design Principles for NegotiationHUD

1. **Never interrupt** — only show when there's a natural pause
2. **One cue at a time** — the single most important thing to say/do right now
3. **Directive, not advisory** — "Say: [exact phrase]" not "Consider mentioning..."
4. **Phase badge** — shows where in the negotiation they are (ANCHOR / COUNTER / HOLD)
5. **Numbers always visible** — current offer, user's target, market range — persistent display
6. **Copy button** — one tap to copy the recommended response
7. **Minimizable** — user can collapse HUD when they don't need it

---

## Part 4: Offer Extraction from Speech

### Hybrid Extraction Strategy

1. **Regex first pass** — match salary patterns: `(\d{2,3})[k]?`, `\$[\d,]+`, `between \d+ and \d+`
2. **NER classification** — distinguish salary from other numbers (years, headcount, etc.)
3. **LLM for ambiguous speech** — "around 95", "competitive", "upper end of the band"

### Structural Patterns to Extract

```
Direct:     "base is 110"               → { type: 'base', value: 110000, unit: 'USD' }
Range:      "between 100 and 120"       → { type: 'range', min: 100000, max: 120000 }
Hedged:     "could probably do 95"      → { type: 'offer', value: 95000, negotiable: true }
Multi-comp: "110 base plus 20% bonus"   → { base: 110000, bonus_pct: 20 }
Ceiling:    "budget tops out at 150"    → { type: 'ceiling', value: 150000 }
Vague:      "competitive comp"          → { type: 'vague', flag: 'needs_clarification' }
```

### Signal Detection Patterns

| Signal Type | Verbal Cues | Action |
|-------------|-------------|--------|
| Acceptance | "That works", "I can approve", "Let me send that" | Prompt: "Ask for it in writing" |
| Rejection | "That won't work", "Not possible", hard no | Trigger PIVOT_BENEFITS phase |
| Pushback | "That's above our band", "We need to check" | HOLD tactic: silence or benefits pivot |
| Uncertainty | "Hmm", "Let me think", "Interesting..." | Signal: they're close — hold position |
| Vague offer | "Competitive", "Above market" | Prompt: "Ask for the specific number" |

### Offer Tracker Concept

Display running list of all numbers mentioned:
```
15:32  Offer #1  $95,000   (recruiter said: "our budget is around 95")
15:34  Counter   $130,000  (you said)
15:36  Revised   $105,000  (recruiter: "best I can do is 105")
15:38  Counter   $120,000  (you said: "I can meet at 120")
```
Visual trajectory arrows (↑↓) show momentum. Candidate sees the arc.
