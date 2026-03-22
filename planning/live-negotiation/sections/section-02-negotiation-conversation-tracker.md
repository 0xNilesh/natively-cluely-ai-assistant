# Section 02 — NegotiationConversationTracker

## Overview

**File to create:** `premium/electron/knowledge/NegotiationConversationTracker.ts`

**Depends on:** Section 01 (Types) — `NegotiationPhase`, `NegotiationState`, `OfferEvent`, `OfferState` must exist in `premium/electron/knowledge/types.ts`

**Blocks:** Section 03 (LiveNegotiationAdvisor), Section 04 (KnowledgeOrchestrator Integration)

**Purpose:** Stateful turn-by-turn tracker that processes recruiter and user utterances, extracts dollar amounts via regex, detects negotiation signals (offers, pushback, rejection, acceptance, benefits, vague offers), and maintains a phase state machine. Mirrors the TechnicalDepthScorer pattern — same instantiation point in the orchestrator, same injection pattern.

---

## Prerequisites: Types (from Section 01)

The following types must exist in `premium/electron/knowledge/types.ts` before implementing this section:

```typescript
export type NegotiationPhase =
  | 'INACTIVE'
  | 'PROBE'
  | 'ANCHOR'
  | 'COUNTER'
  | 'HOLD'
  | 'PIVOT_BENEFITS'
  | 'CLOSE';

export interface OfferEvent {
  speaker: 'recruiter' | 'user';
  amount: number;
  currency: string;
  offerType: 'base' | 'total' | 'range_min' | 'range_max' | 'ceiling' | 'unknown';
  raw: string;
  timestamp: number;
  isVague: boolean;
}

export interface OfferState {
  latestRecruiterAmount: number | null;
  latestRecruiterCurrency: string;
  trajectory: 'rising' | 'flat' | 'first';
  allEvents: OfferEvent[];
}

export interface NegotiationState {
  phase: NegotiationPhase;
  offers: OfferState;
  userTarget: number | null;
  pushbackCount: number;
  benefitsMentioned: string[];
  vagueOfferDetected: boolean;
  silenceTimerActive: boolean;
  lastRecruiterSignal: 'offer' | 'pushback' | 'rejection' | 'acceptance' | 'vague' | 'benefits' | null;
}
```

---

## Full Implementation

Create `premium/electron/knowledge/NegotiationConversationTracker.ts` with the following complete content:

```typescript
import { NegotiationPhase, NegotiationState, OfferEvent, OfferState } from './types';

// ── Signal pattern constants ──────────────────────────────────

/**
 * Regex patterns for extracting salary amounts from natural speech.
 * Order matters: more specific patterns first.
 *
 * Pattern breakdown:
 *   1. $95,000 or $95k or $ 95k
 *   2. 95k or 130k (bare number + k suffix, no dollar sign)
 *   3. "between 90k and 110k" — captures both bounds
 *   4. "130k base" / "95k salary" / "100k comp"
 *   5. "budget is 95k" / "budget tops at 95k" / "budget caps out at 95"
 *   6. "offer is 95k" / "offering 95k" / "offer you 95k"
 */
const SALARY_PATTERNS: RegExp[] = [
  /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d+)?)[k]?/gi,
  /(\d{2,3})[k]\b/gi,
  /between\s+(\d{2,3})[k]?\s+and\s+(\d{2,3})[k]?/gi,
  /(\d{2,3})[k]?\s+(?:base|salary|comp|compensation|package)/gi,
  /budget\s+(?:is|tops?|caps?)\s+(?:at|out\s+at)?\s+(\d{2,3})[k]?/gi,
  /(?:offer|offering|offer you)\s+(?:is|of)?\s+(\d{2,3})[k]?/gi,
];

/**
 * Phrases indicating the recruiter is pushing back on the candidate's ask.
 * These are normal negotiation tactics — NOT final rejections.
 */
const PUSHBACK_SIGNALS: string[] = [
  'above our', 'beyond our', 'out of range', "can't go higher",
  "can't go above", 'budget is fixed', 'budget tops', 'best we can do',
  'highest we can go', 'max is', 'ceiling is',
];

/**
 * Phrases indicating a hard rejection or non-negotiable position.
 * Triggers PIVOT_BENEFITS phase.
 */
const REJECTION_SIGNALS: string[] = [
  'not possible', "won't work", 'decline', 'no flexibility',
  'take it or leave', 'final offer', 'non-negotiable',
];

/**
 * Phrases indicating the recruiter is moving toward agreement.
 * Triggers CLOSE phase.
 */
const ACCEPTANCE_SIGNALS: string[] = [
  "that works", "i'll get that approved", "let me send that",
  "we can do that", "let me confirm", "i can approve",
];

/**
 * Benefits and perks the recruiter may mention as alternatives to base salary.
 * Each matched signal is stored in benefitsMentioned for advisor context.
 */
const BENEFITS_SIGNALS: string[] = [
  'signing bonus', 'sign-on', 'equity', 'stock', 'rsu', 'options',
  'pto', 'vacation days', 'remote', 'work from home', 'wfh',
  'flexible', 'professional development', 'learning budget',
];

/**
 * Vague compensation language — recruiter acknowledges comp without naming a number.
 * Sets vagueOfferDetected = true so the advisor can prompt the candidate to get specifics.
 */
const VAGUE_SIGNALS: string[] = [
  'competitive', 'above market', 'market rate', 'industry standard',
  'in line with', 'within range', 'fair compensation',
];

/**
 * Context words required in the USER's utterance before the silence timer activates.
 * Guards against triggering the silence timer on incidental numbers (e.g., "I have 3 years of experience").
 * The user must be explicitly stating a salary ask.
 *
 * ERRATA Fix 4: addUserUtterance silence timer gating.
 */
const SALARY_CONTEXT_WORDS: string[] = [
  'targeting', 'asking', 'looking for', 'expect', 'want', 'need', 'require', 'range',
];

// ── Helper: normalize number to annual salary ─────────────────

/**
 * Normalizes a raw matched string to an annual salary integer.
 * Strips dollar signs, commas, and whitespace.
 * Numbers below 1000 are treated as thousands (e.g., "95" → 95000, "130" → 130000).
 */
function normalizeAmount(raw: string): number {
  const clean = raw.replace(/[$,\s]/g, '');
  const num = parseFloat(clean);
  return num < 1000 ? num * 1000 : num;
}

// ── Main class ────────────────────────────────────────────────

export class NegotiationConversationTracker {
  private state: NegotiationState;

  constructor() {
    this.state = this.initialState();
  }

  private initialState(): NegotiationState {
    return {
      phase: 'INACTIVE',
      offers: {
        latestRecruiterAmount: null,
        latestRecruiterCurrency: 'USD',
        trajectory: 'first',
        allEvents: [],
      },
      userTarget: null,
      pushbackCount: 0,
      benefitsMentioned: [],
      vagueOfferDetected: false,
      silenceTimerActive: false,
      lastRecruiterSignal: null,
    };
  }

  // ── Public API ────────────────────────────────────────────────

  /**
   * Feed a recruiter (system audio STT) utterance into the tracker.
   *
   * Processing order (ERRATA Fix 9):
   *   1. INACTIVE → PROBE transition fires FIRST, before any signal extraction.
   *      This ensures the tracker is active before other phase transitions run.
   *   2. Extract salary amounts — may trigger ANCHOR or COUNTER phase.
   *   3. Detect pushback / rejection / acceptance / benefits / vague signals.
   *
   * @param text - Raw recruiter utterance from system audio STT
   */
  addRecruiterUtterance(text: string): void {
    const lower = text.toLowerCase();

    // ERRATA Fix 9: INACTIVE → PROBE is the FIRST operation.
    // Any recruiter speech activates the tracker, even without a number.
    if (this.state.phase === 'INACTIVE') {
      this.state.phase = 'PROBE';
    }

    // Extract salary amounts from recruiter speech
    const amounts = this.extractAmounts(text);
    for (const amount of amounts) {
      const event: OfferEvent = {
        speaker: 'recruiter',
        amount,
        currency: 'USD',
        offerType: 'base',
        raw: text,
        timestamp: Date.now(),
        isVague: false,
      };
      this.state.offers.allEvents.push(event);

      // Update trajectory
      const prev = this.state.offers.latestRecruiterAmount;
      this.state.offers.latestRecruiterAmount = amount;
      this.state.offers.trajectory = prev === null ? 'first' : amount > prev ? 'rising' : 'flat';

      // ERRATA Fix 5: pass 'new_offer' trigger so HOLD/PIVOT_BENEFITS can re-anchor to COUNTER
      this.transitionPhase('ANCHOR', 'new_offer');
    }

    // Signal detection — runs after amount extraction
    if (PUSHBACK_SIGNALS.some(s => lower.includes(s))) {
      this.state.pushbackCount++;
      this.state.lastRecruiterSignal = 'pushback';
      this.transitionPhase('HOLD');
      if (this.state.pushbackCount >= 2) {
        this.transitionPhase('PIVOT_BENEFITS');
      }
    } else if (REJECTION_SIGNALS.some(s => lower.includes(s))) {
      this.state.lastRecruiterSignal = 'rejection';
      this.transitionPhase('PIVOT_BENEFITS');
    } else if (ACCEPTANCE_SIGNALS.some(s => lower.includes(s))) {
      this.state.lastRecruiterSignal = 'acceptance';
      this.transitionPhase('CLOSE');
    } else if (amounts.length > 0) {
      this.state.lastRecruiterSignal = 'offer';
    }

    // Benefits detection — each unique signal stored
    for (const signal of BENEFITS_SIGNALS) {
      if (lower.includes(signal) && !this.state.benefitsMentioned.includes(signal)) {
        this.state.benefitsMentioned.push(signal);
        this.state.lastRecruiterSignal = 'benefits';
      }
    }

    // Vague offer detection — only when no specific number was stated
    if (VAGUE_SIGNALS.some(s => lower.includes(s)) && amounts.length === 0) {
      this.state.vagueOfferDetected = true;
      this.state.lastRecruiterSignal = 'vague';
    }
  }

  /**
   * Feed a user (microphone STT) utterance into the tracker.
   *
   * ERRATA Fix 4: Silence timer gating — the silence timer only activates when:
   *   1. The tracker is already active (isActive() === true) — guards against
   *      triggering before any negotiation has started.
   *   2. The user's utterance contains a salary amount.
   *   3. The utterance contains at least one salary context word (targeting, asking,
   *      looking for, expect, want, need, require, range) — prevents incidental
   *      numbers like "I have 5 years of experience" from triggering the timer.
   *
   * @param text - Raw user utterance from microphone STT
   */
  addUserUtterance(text: string): void {
    const lower = text.toLowerCase();
    const amounts = this.extractAmounts(text);

    if (amounts.length > 0) {
      // ERRATA Fix 4: require isActive() AND salary context words
      const hasSalaryContext = SALARY_CONTEXT_WORDS.some(w => lower.includes(w));

      if (this.isActive() && hasSalaryContext) {
        this.state.silenceTimerActive = true;

        // First number the user states becomes their target
        if (this.state.userTarget === null) {
          this.state.userTarget = amounts[0];
        }

        const event: OfferEvent = {
          speaker: 'user',
          amount: amounts[0],
          currency: 'USD',
          offerType: 'base',
          raw: text,
          timestamp: Date.now(),
          isVague: false,
        };
        this.state.offers.allEvents.push(event);

        // User countering after an anchor moves to COUNTER phase
        if (this.state.phase === 'ANCHOR') {
          this.transitionPhase('COUNTER');
        }
      }
    } else {
      // User spoke without stating a salary number — silence timer is no longer relevant
      this.state.silenceTimerActive = false;
    }
  }

  /**
   * Manually clear the silence timer (e.g., after the recruiter speaks again).
   */
  clearSilenceTimer(): void {
    this.state.silenceTimerActive = false;
  }

  /**
   * Returns a deep copy of the current negotiation state.
   *
   * ERRATA Fix 6: Deep copy — prevents external mutation of nested objects
   * (offers.allEvents array and benefitsMentioned array).
   */
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

  /**
   * Returns true once any negotiation signal has been received.
   * Used by KnowledgeOrchestrator to decide whether to activate the live coaching path.
   */
  isActive(): boolean {
    return this.state.phase !== 'INACTIVE';
  }

  /**
   * Resets the tracker to initial state.
   * Called when the user uploads a new JD or explicitly resets the session.
   */
  reset(): void {
    this.state = this.initialState();
  }

  /**
   * Seeds the user's salary target from the pre-computed negotiation script.
   * Called during KnowledgeOrchestrator.refreshCache() when the script is loaded.
   * Important: must be called before the first recruiter utterance so the advisor
   * has target context even before the user speaks.
   *
   * @param amount - Normalized annual amount (e.g., 130000)
   */
  setUserTarget(amount: number): void {
    this.state.userTarget = amount;
  }

  /**
   * Returns an XML-formatted string of the current negotiation state for LLM injection.
   * Called by LiveNegotiationAdvisor to build the prompt context block.
   *
   * Format is XML so the LLM can parse it reliably and so it is visually distinct
   * from the surrounding natural language in the prompt.
   */
  getStateXML(): string {
    const s = this.state;
    const offerHistory = s.offers.allEvents
      .map(e =>
        `  - ${e.speaker === 'recruiter' ? 'Recruiter' : 'You'}: ${e.currency} ${(e.amount / 1000).toFixed(0)}k (${e.raw.substring(0, 60)})`
      )
      .join('\n');

    return `<live_negotiation_state>
Phase: ${s.phase}
Their latest offer: ${s.offers.latestRecruiterAmount
      ? `${s.offers.latestRecruiterCurrency} ${s.offers.latestRecruiterAmount.toLocaleString()}`
      : 'Not stated yet'}
Your target: ${s.userTarget
      ? `${s.offers.latestRecruiterCurrency} ${s.userTarget.toLocaleString()}`
      : 'Not stated yet'}
Pushback count: ${s.pushbackCount}
Benefits mentioned by recruiter: ${s.benefitsMentioned.length > 0 ? s.benefitsMentioned.join(', ') : 'None'}
Vague offer detected: ${s.vagueOfferDetected}
Last recruiter signal: ${s.lastRecruiterSignal || 'none'}
Offer history:
${offerHistory || '  (no offers yet)'}
</live_negotiation_state>`;
  }

  // ── Private methods ───────────────────────────────────────────

  /**
   * Extracts and normalizes all salary amounts from a text string.
   * Applies all SALARY_PATTERNS, deduplicates by amount value, and filters
   * out implausible salaries (below $20k or above $5M).
   *
   * For range patterns (e.g., "between 90k and 110k"), both bounds are extracted.
   *
   * @param text - Raw utterance (any speaker)
   * @returns Array of unique, plausible annual salary amounts
   */
  private extractAmounts(text: string): number[] {
    const amounts: number[] = [];
    const seen = new Set<number>();

    for (const pattern of SALARY_PATTERNS) {
      // Clone the regex to reset lastIndex on each call (avoids stateful regex bugs)
      const regex = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;

      while ((match = regex.exec(text)) !== null) {
        // match[1] is the first capture group; match[0] is the full match
        const raw = match[1] || match[0];
        const amount = normalizeAmount(raw);

        // Filter implausible salaries
        if (amount >= 20000 && amount <= 5000000 && !seen.has(amount)) {
          seen.add(amount);
          amounts.push(amount);
        }

        // For range patterns, also extract the second bound (match[2])
        if (match[2]) {
          const amount2 = normalizeAmount(match[2]);
          if (amount2 >= 20000 && amount2 <= 5000000 && !seen.has(amount2)) {
            seen.add(amount2);
            amounts.push(amount2);
          }
        }
      }
    }

    return amounts;
  }

  /**
   * Transitions the phase state machine to a new phase.
   *
   * ERRATA Fix 5: The state machine supports two modes:
   *
   * 1. Normal forward-only progression (default):
   *    INACTIVE → PROBE → ANCHOR → COUNTER → HOLD → PIVOT_BENEFITS → CLOSE
   *    A phase can only advance; it cannot move backward.
   *    CLOSE is always terminal — nothing can overwrite it.
   *
   * 2. Re-anchoring on new recruiter offer (trigger === 'new_offer'):
   *    If the recruiter makes a NEW offer while the phase is HOLD or PIVOT_BENEFITS,
   *    the phase resets to COUNTER. This models the real-world scenario where the
   *    recruiter comes back with an improved offer after pushback — the negotiation
   *    is alive again, and the candidate should counter rather than pivot to benefits.
   *
   * @param to      - Target phase
   * @param trigger - 'new_offer' enables re-anchoring from HOLD/PIVOT_BENEFITS;
   *                  'signal' (default) uses forward-only rules
   */
  private transitionPhase(to: NegotiationPhase, trigger?: 'new_offer' | 'signal'): void {
    // CLOSE is always terminal — nothing overwrites it
    if (this.state.phase === 'CLOSE') return;

    // ERRATA Fix 5: New offer from recruiter re-activates COUNTER from HOLD or PIVOT_BENEFITS
    if (
      trigger === 'new_offer' &&
      (this.state.phase === 'HOLD' || this.state.phase === 'PIVOT_BENEFITS')
    ) {
      this.state.phase = 'COUNTER';
      return;
    }

    // Normal forward-only progression
    const order: NegotiationPhase[] = [
      'INACTIVE', 'PROBE', 'ANCHOR', 'COUNTER', 'HOLD', 'PIVOT_BENEFITS', 'CLOSE',
    ];
    const currentIdx = order.indexOf(this.state.phase);
    const targetIdx = order.indexOf(to);

    if (targetIdx > currentIdx) {
      this.state.phase = to;
    }
  }
}
```

---

## Phase State Machine — Reference

```
INACTIVE ──(any recruiter speech)──────────────────────────► PROBE
   │
   │ Note: INACTIVE → PROBE fires at the TOP of addRecruiterUtterance,
   │ before any signal extraction. (ERRATA Fix 9)

PROBE ──(recruiter states number)──────────────────────────► ANCHOR
                                                               │
ANCHOR ──(user counters with number)───────────────────────► COUNTER
                                                               │
COUNTER ──(recruiter pushback × 1)─────────────────────────► HOLD
                                                               │
HOLD ──(recruiter pushback × 2 total)──────────────────────► PIVOT_BENEFITS
    │                                                          │
    └──(recruiter new offer, trigger='new_offer')──────────► COUNTER  ← re-anchor (Fix 5)

PIVOT_BENEFITS ──(recruiter new offer, trigger='new_offer')► COUNTER  ← re-anchor (Fix 5)
              │
              └──(any acceptance signal)───────────────────► CLOSE

CLOSE (terminal — nothing overwrites)
```

**Key rule:** `CLOSE` is terminal. Once reached, `transitionPhase()` returns immediately regardless of trigger.

**Key rule:** The `new_offer` trigger is the ONLY way to move a phase backward (HOLD/PIVOT → COUNTER). All other transitions are strictly forward.

---

## Silence Timer Gating Logic — Reference (ERRATA Fix 4)

The silence timer (`silenceTimerActive = true`) activates **only when all three conditions are met** inside `addUserUtterance()`:

| Condition | Rationale |
|-----------|-----------|
| `this.isActive()` is true | Prevents timer from firing before any negotiation has been detected |
| `amounts.length > 0` | A specific salary number must be present |
| `hasSalaryContext` is true | At least one of: "targeting", "asking", "looking for", "expect", "want", "need", "require", "range" must appear in the utterance |

**Example — timer fires:**
- "I'm targeting $130,000" → isActive=true, amount=130000, hasSalaryContext=true ("targeting") → timer fires

**Example — timer does NOT fire:**
- "I have 5 years of experience" → amount extracted (5? — below 20k threshold, filtered) → no fire
- "I have 130 clients" → isActive=true, amount=130000 extracted BUT hasSalaryContext=false → no fire
- "I'm targeting $130k" before any recruiter speech → isActive=false → no fire

---

## Acceptance Criteria

### Core Functionality (from Section 2 original plan)

- [ ] `addRecruiterUtterance("our budget is around 95k")` → `phase === 'ANCHOR'`, `offers.latestRecruiterAmount === 95000`
- [ ] `addRecruiterUtterance("that's above our range")` → `pushbackCount === 1`, `phase === 'HOLD'`
- [ ] `addRecruiterUtterance("that's above our range")` called twice total → `pushbackCount === 2`, `phase === 'PIVOT_BENEFITS'`
- [ ] `addRecruiterUtterance("we can do equity and signing bonus")` → `benefitsMentioned` contains both `'equity'` and `'signing bonus'`
- [ ] `addUserUtterance("I'm targeting 130,000")` after recruiter has spoken → `silenceTimerActive === true`, `userTarget === 130000`
- [ ] Phase never moves backward via normal transitions (COUNTER → ANCHOR is blocked)
- [ ] `isActive()` returns `false` until first recruiter utterance is processed
- [ ] `reset()` restores all initial state (phase=INACTIVE, all arrays empty, all counts zero)
- [ ] `getStateXML()` produces valid XML containing all fields

### ERRATA Fix 4: Silence Timer Gating

- [ ] `addUserUtterance("I have 130 clients")` → `silenceTimerActive` remains `false` (no salary context word)
- [ ] `addUserUtterance("I'm targeting $130k")` before any recruiter speech → `silenceTimerActive` remains `false` (tracker not active)
- [ ] `addUserUtterance("I'm targeting $130k")` after recruiter has spoken → `silenceTimerActive === true`
- [ ] `addUserUtterance("I'm asking for $130k")` → `silenceTimerActive === true` (via "asking" context word)

### ERRATA Fix 5: Re-anchoring on New Offer

- [ ] After `phase === 'HOLD'`, calling `addRecruiterUtterance("we can do 100k")` → `phase === 'COUNTER'`
- [ ] After `phase === 'PIVOT_BENEFITS'`, calling `addRecruiterUtterance("let me offer 105k")` → `phase === 'COUNTER'`
- [ ] After `phase === 'CLOSE'`, calling `addRecruiterUtterance("actually we can do 110k")` → `phase` remains `'CLOSE'`

### ERRATA Fix 6: Deep Copy in getState()

- [ ] Mutating the array returned by `getState().offers.allEvents` does not affect internal tracker state
- [ ] Mutating the array returned by `getState().benefitsMentioned` does not affect internal tracker state

### ERRATA Fix 9: PROBE Transition Ordering

- [ ] `addRecruiterUtterance("can we schedule the final interview?")` (no salary content) → `phase === 'PROBE'` (not `'INACTIVE'`)
- [ ] After `addRecruiterUtterance("our budget is 95k")`, `phase === 'ANCHOR'` (PROBE → ANCHOR in same call)

### Additional Edge Cases

- [ ] `extractAmounts("between 90k and 110k")` returns both `90000` and `110000`
- [ ] `extractAmounts("I have 3 years of experience")` returns `[]` (3 < 20000 threshold)
- [ ] `extractAmounts("$2,500,000 signing bonus")` returns `[2500000]` (within range)
- [ ] `extractAmounts("$6,000,000 lottery winner")` returns `[]` (above $5M threshold)
- [ ] Calling `addRecruiterUtterance()` multiple times with the same signal does not duplicate `benefitsMentioned` entries
- [ ] `getStateXML()` includes offer history lines for both recruiter and user events
- [ ] `setUserTarget(130000)` before any recruiter speech seeds `userTarget` without changing `phase`

---

## Integration Notes for Section 04 (KnowledgeOrchestrator)

When Section 04 implements the orchestrator integration, the following call patterns apply:

**Seeding the target on script load:**
```typescript
const script = this.getNegotiationScript();
if (script?.salary_range?.max) {
  this.negotiationTracker.setUserTarget(script.salary_range.max);
}
```

**Feeding recruiter speech (system audio STT):**
```typescript
feedInterviewerUtterance(text: string): void {
  this.depthScorer.addUtterance(text);
  this.negotiationTracker.addRecruiterUtterance(text);  // NEW
}
```

**Feeding user speech (microphone STT):**
```typescript
// In processQuestion(), before intent detection:
this.negotiationTracker.addUserUtterance(question);
```

**Passing the tracker to the advisor (ERRATA Fix 2 — pass the instance, not getState()):**
```typescript
const coachingResponse = await generateLiveCoachingResponse(
  this.negotiationTracker,   // ← tracker instance, NOT this.negotiationTracker.getState()
  question,
  this.activeResume!,
  this.activeJD,
  dossier,
  script,
  this.generateContentFn
);
```

**Resetting on JD change:**
```typescript
this.negotiationTracker.reset();
```
