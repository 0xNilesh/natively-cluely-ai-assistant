# Section 08 — NativelyInterface Integration

**File modified:** `src/components/NativelyInterface.tsx`

**Depends on:** Section 04 (stream token format), Section 06 (IPC types), Section 07 (NegotiationCoachingCard)

---

## Overview

`NativelyInterface.tsx` receives streamed tokens from the LLM layer. When the live negotiation path fires, `LLMHelper` emits exactly one token: a JSON string with the shape `{ __negotiationCoaching: LiveCoachingResponse }`. This section makes the interface:

1. Import and render `NegotiationCoachingCard`
2. Extend the message type to carry coaching data
3. Detect the `__negotiationCoaching` token in the stream handler
4. Render `NegotiationCoachingCard` instead of markdown for coaching messages
5. Clear the silence timer via `onSilenceTimerEnd`

---

## 8a. Import NegotiationCoachingCard

Add the import near the top of `NativelyInterface.tsx` alongside other component imports:

```typescript
import { NegotiationCoachingCard } from './NegotiationCoachingCard';
```

---

## 8b. Extend the Message Type

Find the local message type definition (it will be a `type` or `interface` used by the `messages` state array). Add the two optional fields:

```typescript
isNegotiationCoaching?: boolean;
negotiationCoachingData?: {
  tacticalNote: string;
  exactScript: string;
  showSilenceTimer: boolean;
  phase: string;
  theirOffer: number | null;
  yourTarget: number | null;
  currency: string;
};
```

Use `phase: string` (not the `NegotiationPhase` union) to avoid importing from a cross-boundary path. The `NegotiationCoachingCard` component accepts `phase` as its inline-defined type, and a `string` value satisfies the prop since the actual values will always be valid phase names.

---

## 8c. Detect `__negotiationCoaching` in the Stream Token Handler

The stream token handler is the function called on each streamed chunk (the `onGeminiStreamToken` handler or equivalent). Find the handler where individual stream tokens are appended to the current message's `text` field.

Add a check at the point where a token arrives: before appending it as text, test whether it is a negotiation coaching payload. If so, handle it as a special message type rather than appending raw JSON.

```typescript
// Inside the stream token handler (e.g., onGeminiStreamToken):
const handleStreamToken = (token: string) => {
  // Check for negotiation coaching short-circuit token
  try {
    const parsed = JSON.parse(token);
    if (parsed?.__negotiationCoaching) {
      const data = parsed.__negotiationCoaching;
      setMessages(prev => {
        const lastMsg = prev[prev.length - 1];
        if (!lastMsg || lastMsg.role !== 'system') return prev;
        return [
          ...prev.slice(0, -1),
          {
            ...lastMsg,
            isStreaming: false,
            isNegotiationCoaching: true,
            negotiationCoachingData: {
              tacticalNote: data.tacticalNote,
              exactScript: data.exactScript,
              showSilenceTimer: data.showSilenceTimer,
              phase: data.phase,
              theirOffer: data.theirOffer,
              yourTarget: data.yourTarget,
              currency: data.currency,
            },
            text: '', // Clear raw text so no JSON leaks into markdown render
          },
        ];
      });
      return; // Do NOT append to text
    }
  } catch {
    // Not JSON — fall through to normal text append
  }

  // Normal token: append to current streaming message
  setMessages(prev => {
    const lastMsg = prev[prev.length - 1];
    if (!lastMsg || lastMsg.role !== 'system') return prev;
    return [
      ...prev.slice(0, -1),
      { ...lastMsg, text: lastMsg.text + token },
    ];
  });
};
```

**Important:** The `try/catch` around `JSON.parse` is required. Normal LLM stream tokens are plain text and will throw on `JSON.parse`. Only the negotiation coaching short-circuit token is valid JSON.

---

## 8d. Render NegotiationCoachingCard in the Message List

Find the message rendering loop (map over `messages`). Before the existing text/markdown render path, add a conditional branch for coaching messages:

```typescript
{messages.map((msg, index) => (
  <div key={index} /* ... existing classes ... */>
    {msg.isNegotiationCoaching && msg.negotiationCoachingData ? (
      <NegotiationCoachingCard
        tacticalNote={msg.negotiationCoachingData.tacticalNote}
        exactScript={msg.negotiationCoachingData.exactScript}
        showSilenceTimer={msg.negotiationCoachingData.showSilenceTimer}
        phase={msg.negotiationCoachingData.phase as any}
        theirOffer={msg.negotiationCoachingData.theirOffer}
        yourTarget={msg.negotiationCoachingData.yourTarget}
        currency={msg.negotiationCoachingData.currency}
        onSilenceTimerEnd={() => {
          setMessages(prev =>
            prev.map(m =>
              m === msg
                ? {
                    ...m,
                    negotiationCoachingData: {
                      ...m.negotiationCoachingData!,
                      showSilenceTimer: false,
                    },
                  }
                : m
            )
          );
        }}
      />
    ) : (
      // ... existing markdown/text render for this message ...
    )}
  </div>
))}
```

**Notes:**
- `phase={msg.negotiationCoachingData.phase as any}` is needed because `NegotiationCoachingCard` expects the inline `NegotiationPhase` union type, but the message stores it as `string`. The values will always be valid phase strings.
- `onSilenceTimerEnd` uses `setMessages` to update the specific message's `showSilenceTimer` to `false` after the 5-second countdown. This stops the timer UI from persisting after it completes.
- The `m === msg` identity check is safe here because the message object reference is stable within the same render (we are not recreating messages from scratch on each render).

---

## 8e. `onSilenceTimerEnd` Behavior

When the silence timer completes:
1. `NegotiationCoachingCard` calls `onSilenceTimerEnd` via its `setTimeout` ref pattern (Fix 11).
2. `NativelyInterface` sets `showSilenceTimer: false` on that message.
3. On the next render, `NegotiationCoachingCard` receives `showSilenceTimer={false}`, so the timer row is hidden.
4. The rest of the card (tactical note, exact script, copy button) remains visible.

---

## What Not to Change

- The existing message streaming logic for non-negotiation messages is untouched.
- The markdown render path for assistant messages is untouched.
- No new IPC calls are made from this component for the coaching card feature (the card is entirely driven by the stream token).

---

## Acceptance Criteria

- [ ] When a `{ __negotiationCoaching: ... }` token arrives in the stream, a `NegotiationCoachingCard` renders in place of the raw JSON
- [ ] The `NegotiationCoachingCard` shows the correct phase badge, their offer, your target, tactical note, and exact script
- [ ] Regular streamed messages (non-negotiation) continue to render as markdown — no regression
- [ ] The silence timer shows when `showSilenceTimer: true` in the coaching data
- [ ] After 5 seconds, `onSilenceTimerEnd` fires, `showSilenceTimer` is set to `false` on the message, and the timer row disappears
- [ ] The copy button on the card copies `exactScript` to the clipboard
- [ ] No TypeScript errors on the extended message type or the `NegotiationCoachingCard` prop spread
- [ ] `phase as any` cast is the only type cast added — no broader type suppressions
- [ ] The raw JSON token text does not appear in the chat as a regular message
