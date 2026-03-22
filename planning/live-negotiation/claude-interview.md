# Interview Transcript — Live Salary Negotiation Coaching

## Q1: Where does the recruiter's voice come from?
**Answer: System audio capture**

The app already captures system audio. Recruiter speech comes through the user's speakers and is captured alongside the user's mic. This means recruiter utterances flow through the same STT pipeline that already exists — they just need to be routed into NegotiationConversationTracker separately from user speech.

---

## Q2: When should the Negotiation HUD appear?
**Answer: Auto-detect from chat context**

System detects salary/negotiation keywords and automatically shows the HUD as an inline coaching card in the chat. No manual activation required. When the LLM detects negotiation intent (existing IntentClassifier.NEGOTIATION), the coaching card appears inline.

---

## Q3: Where should the Negotiation HUD live in the UI?
**Answer: Inline inside chat — a special coaching card**

Coaching appears as a special card in the message stream, rendered instead of (or above) the regular AI response. Visual design:
```
┌─ NEGOTIATION HUD ───────────┐
│ PHASE: COUNTER              │
│ Their offer: $95k           │
│ Your target: $130k          │
│ ──────────────────────────  │
│ Say: "I appreciate the..." │
│               [Copy]        │
└─────────────────────────────┘
```

---

## Q4: What should happen to negotiation state between sessions?
**Answer: Session-only — resets when overlay closes**

Negotiation state (current phase, tracked offers, conversation history) lives in memory only for the call duration. Clean slate each session. No DB persistence needed for the tracker state.

---

## Q5: What should the coaching response look like?
**Answer: Two sections — tactical note + exact script**

First section: short tactical explanation (why this move, what just happened)
Second section: exact words to say (copy button)

Example:
> **Tactical note:** They anchored 27% below your target. Standard low-ball opening. Don't panic — counter with justification.
>
> **Say this:** "I appreciate the offer. Based on market data for this role in [location] and my [X years + specific achievement], I'm targeting $130,000. Can we explore that range?"

---

## Q6: Should there be a silence timer?
**Answer: Yes — 5-second countdown**

After the user names their number, the HUD shows: "Hold the silence. Let them speak." with a 5-second countdown. This is the single highest-impact negotiation tactic — costs nothing, works every time. Should be triggered when the system detects the user has stated a specific salary number.

---

## Q7: How should recruiter statements be tracked?
**Answer: Auto-extract from system audio STT**

System audio is already captured. Pipe recruiter speech through the same STT and route it into NegotiationConversationTracker. Extract:
- Dollar amounts / ranges mentioned
- Acceptance/rejection/pushback signals
- Benefits/comp components mentioned
- Vague offers ("competitive") that need clarification

This enables fully automatic offer tracking without any user effort.
