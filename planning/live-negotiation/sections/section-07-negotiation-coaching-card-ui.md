# Section 07 — NegotiationCoachingCard UI Component

**File created:** `src/components/NegotiationCoachingCard.tsx`

**Depends on:** Section 01 (Types — but `NegotiationPhase` is defined inline per Fix 8)

---

## Overview

A visually distinct inline chat card that renders when a `LiveCoachingResponse` is detected in the stream. It shows the negotiation phase badge, their offer vs. your target, a tactical note, the exact script the user should speak, a copy button, and an optional 5-second silence timer.

The component is self-contained: it imports no types from the electron/main process codebase (Fix 8). The `NegotiationPhase` type is defined inline at the top of this file.

---

## ERRATA Notes Applicable to This Section

- **Fix 8:** Do NOT `import { NegotiationPhase } from '../types/negotiation'` — that path does not exist. Define the type inline.
- **Fix 11:** Do NOT call `onSilenceTimerEnd` from inside the `setSilenceSeconds` setState updater. Use a separate `setTimeout` with a ref guard.

---

## Full Implementation

```typescript
import React, { useState, useEffect } from 'react';
import { Copy, Check, TrendingUp, Clock } from 'lucide-react';

// Fix 8: Define inline — do NOT import from a non-existent path
type NegotiationPhase =
  | 'INACTIVE'
  | 'PROBE'
  | 'ANCHOR'
  | 'COUNTER'
  | 'HOLD'
  | 'PIVOT_BENEFITS'
  | 'CLOSE';

interface Props {
  tacticalNote: string;
  exactScript: string;
  showSilenceTimer: boolean;
  phase: NegotiationPhase;
  theirOffer: number | null;
  yourTarget: number | null;
  currency: string;
  onSilenceTimerEnd?: () => void;
}

const PHASE_COLORS: Record<string, string> = {
  PROBE:          'bg-gray-500/15 text-gray-400 border-gray-500/25',
  ANCHOR:         'bg-blue-500/15 text-blue-400 border-blue-500/25',
  COUNTER:        'bg-orange-500/15 text-orange-400 border-orange-500/25',
  HOLD:           'bg-yellow-500/15 text-yellow-400 border-yellow-500/25',
  PIVOT_BENEFITS: 'bg-purple-500/15 text-purple-400 border-purple-500/25',
  CLOSE:          'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
};

const PHASE_LABELS: Record<string, string> = {
  PROBE:          'Gathering Intel',
  ANCHOR:         'First Offer',
  COUNTER:        'Countering',
  HOLD:           'Holding Position',
  PIVOT_BENEFITS: 'Total Comp',
  CLOSE:          'Closing',
};

export const NegotiationCoachingCard: React.FC<Props> = ({
  tacticalNote,
  exactScript,
  showSilenceTimer,
  phase,
  theirOffer,
  yourTarget,
  currency,
  onSilenceTimerEnd,
}) => {
  const [copied, setCopied] = useState(false);
  const [silenceSeconds, setSilenceSeconds] = useState(5);

  // Copy handler
  const handleCopy = () => {
    navigator.clipboard?.writeText(exactScript);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Fix 11: Silence timer — onSilenceTimerEnd called via separate setTimeout,
  // NOT inside setState updater, to avoid calling it during a React render cycle.
  useEffect(() => {
    if (!showSilenceTimer) return;

    const timerEndedRef = { current: false };
    setSilenceSeconds(5);

    const interval = setInterval(() => {
      setSilenceSeconds(s => {
        if (s <= 1) {
          clearInterval(interval);
          return 0;
        }
        return s - 1;
      });
    }, 1000);

    // Call onSilenceTimerEnd via a separate timeout — NOT inside setState
    const endTimer = setTimeout(() => {
      if (!timerEndedRef.current) {
        timerEndedRef.current = true;
        onSilenceTimerEnd?.();
      }
    }, 5000);

    return () => {
      clearInterval(interval);
      clearTimeout(endTimer);
    };
  }, [showSilenceTimer]); // onSilenceTimerEnd intentionally omitted — use ref pattern

  const phaseColor = PHASE_COLORS[phase] || PHASE_COLORS.ANCHOR;
  const gap = theirOffer && yourTarget ? yourTarget - theirOffer : null;

  return (
    <div className="rounded-xl border border-orange-500/20 bg-orange-500/5 overflow-hidden my-2 text-sm">

      {/* Header row: phase badge + offer gap */}
      <div className="flex items-center justify-between px-3.5 pt-3 pb-2.5 border-b border-orange-500/10">
        <div className="flex items-center gap-2">
          <span
            className={`text-[9px] font-bold px-2 py-0.5 rounded-full border tracking-widest uppercase ${phaseColor}`}
          >
            {PHASE_LABELS[phase] || phase}
          </span>
          {gap !== null && gap > 0 && (
            <span className="text-[10px] text-text-tertiary flex items-center gap-1">
              <TrendingUp size={9} className="text-orange-400" />
              Gap: {currency} {(gap / 1000).toFixed(0)}k
            </span>
          )}
        </div>
        {theirOffer && yourTarget && (
          <div className="text-[10px] text-text-tertiary">
            <span className="text-red-400/80">
              {currency} {(theirOffer / 1000).toFixed(0)}k
            </span>
            <span className="mx-1.5 text-text-muted">→</span>
            <span className="text-emerald-400/80">
              {currency} {(yourTarget / 1000).toFixed(0)}k
            </span>
          </div>
        )}
      </div>

      {/* Silence timer (shown when user just named their number) */}
      {showSilenceTimer && silenceSeconds > 0 && (
        <div className="px-3.5 py-2.5 bg-yellow-500/5 border-b border-yellow-500/15 flex items-center gap-3">
          <Clock size={12} className="text-yellow-400 shrink-0" />
          <div className="flex-1">
            <div className="text-[10px] font-semibold text-yellow-400">
              Hold the silence. Let them speak first.
            </div>
            <div className="mt-1.5 h-1 rounded-full bg-yellow-500/15 overflow-hidden">
              <div
                className="h-full rounded-full bg-yellow-400/60 transition-all duration-1000"
                style={{ width: `${(silenceSeconds / 5) * 100}%` }}
              />
            </div>
          </div>
          <span className="text-[13px] font-bold text-yellow-400 tabular-nums">
            {silenceSeconds}
          </span>
        </div>
      )}

      {/* Tactical note */}
      <div className="px-3.5 py-2.5 border-b border-orange-500/10">
        <div className="text-[9px] font-bold uppercase tracking-widest text-text-tertiary mb-1.5">
          Tactical Note
        </div>
        <p className="text-[11px] text-text-secondary leading-relaxed">
          {tacticalNote}
        </p>
      </div>

      {/* Exact script + copy button */}
      <div className="px-3.5 py-2.5">
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-[9px] font-bold uppercase tracking-widest text-orange-400">
            Say This
          </div>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-[9px] font-medium text-text-tertiary hover:text-text-primary transition-colors px-2 py-0.5 rounded hover:bg-bg-input"
          >
            {copied
              ? <Check size={9} className="text-emerald-400" />
              : <Copy size={9} />
            }
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="text-[12px] text-text-primary leading-relaxed italic pl-2 border-l-2 border-orange-400/40">
          "{exactScript}"
        </p>
      </div>

    </div>
  );
};
```

---

## Component Anatomy

| Region | Content | Condition |
|--------|---------|-----------|
| Header left | Phase badge (colored pill) | Always |
| Header left | Gap display (`TrendingUp` icon + `Currency Xk`) | Only when `gap > 0` |
| Header right | `TheirOffer → YourTarget` in red/green | Only when both values present |
| Silence timer row | Yellow countdown bar + digit | `showSilenceTimer && silenceSeconds > 0` |
| Tactical note | 1-2 sentence coach commentary | Always |
| Say This | Italic quoted script + copy button | Always |

---

## Phase Color Reference

| Phase | Badge color |
|-------|------------|
| PROBE | Gray |
| ANCHOR | Blue |
| COUNTER | Orange |
| HOLD | Yellow |
| PIVOT_BENEFITS | Purple |
| CLOSE | Emerald |

---

## Silence Timer Behavior (Fix 11 Detail)

The timer uses two separate async mechanisms:

1. `setInterval` at 1-second cadence — updates the visible `silenceSeconds` counter and the progress bar width.
2. `setTimeout` at 5000ms — triggers `onSilenceTimerEnd` via a ref guard to prevent double-fire.

The `timerEndedRef` is a plain object `{ current: false }` created inside the `useEffect` closure (not a `React.useRef`) because it only needs to persist for the lifetime of that particular timer activation, not across renders.

`onSilenceTimerEnd` is intentionally omitted from the `useEffect` dependency array. If it were included, a parent re-render that creates a new function reference would restart the timer. The ref pattern ensures the latest callback is called without making it a dependency.

---

## Acceptance Criteria

- [ ] Card renders with phase badge using the correct color for each phase value
- [ ] Offer gap line (`TrendingUp` icon + `Gap: USD Xk`) appears only when `theirOffer` and `yourTarget` are both non-null and `yourTarget > theirOffer`
- [ ] Their offer and your target display in the header right (red → green) only when both values are present
- [ ] Copy button copies `exactScript` to clipboard and shows `Check` icon for 2 seconds, then reverts
- [ ] Silence timer section renders when `showSilenceTimer` is `true` and `silenceSeconds > 0`
- [ ] Progress bar drains from 100% to 0% over 5 seconds
- [ ] `onSilenceTimerEnd` is called once, approximately 5 seconds after mount with `showSilenceTimer: true`
- [ ] `onSilenceTimerEnd` is NOT called from inside a React setState updater (Fix 11 satisfied)
- [ ] `NegotiationPhase` is defined inline — no import from `../types/negotiation` or any non-existent path (Fix 8 satisfied)
- [ ] Component compiles with `tsc --noEmit` with zero errors
- [ ] Card is visually distinct from regular markdown chat messages (orange border/tint vs. default styling)
