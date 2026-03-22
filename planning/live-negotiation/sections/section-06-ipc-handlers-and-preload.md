# Section 06 — IPC Handlers & Preload

**Files modified:**
- `electron/ipcHandlers.ts`
- `electron/preload.ts`
- `src/types/electron.d.ts`

**Depends on:** Section 04 (KnowledgeOrchestrator — `getNegotiationTracker()`, `resetNegotiationSession()`)

---

## Overview

Two new IPC handlers expose negotiation tracker state and reset capability to the renderer process. These are used for debugging, for the optional "Reset Negotiation" UI button, and for any renderer-side logic that needs to inspect tracker state without going through the chat stream.

Both handlers follow the existing `safeHandle` pattern used throughout `ipcHandlers.ts`.

---

## 6a. New Handlers in `electron/ipcHandlers.ts`

Find the block of `profile:*` handlers in `ipcHandlers.ts` and add the following two handlers:

```typescript
safeHandle("profile:get-negotiation-state", async () => {
  try {
    const orchestrator = appState.getKnowledgeOrchestrator();
    if (!orchestrator) return { success: false, error: 'Engine not ready' };
    const tracker = orchestrator.getNegotiationTracker();
    return {
      success: true,
      state: tracker.getState(),
      isActive: tracker.isActive(),
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

safeHandle("profile:reset-negotiation", async () => {
  try {
    const orchestrator = appState.getKnowledgeOrchestrator();
    if (!orchestrator) return { success: false, error: 'Engine not ready' };
    orchestrator.resetNegotiationSession();
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});
```

**Notes:**
- `appState.getKnowledgeOrchestrator()` is the same call pattern used by other profile handlers in this file.
- `getState()` returns a deep copy (per Fix 6 in the tracker) so the IPC-serialized snapshot is safe to use even if the tracker mutates concurrently.
- `resetNegotiationSession()` delegates to `tracker.reset()` inside the orchestrator.

---

## 6b. Preload Additions in `electron/preload.ts`

Find the `contextBridge.exposeInMainWorld` call and add the two new methods inside the exposed API object:

```typescript
profileGetNegotiationState: () =>
  ipcRenderer.invoke('profile:get-negotiation-state'),

profileResetNegotiation: () =>
  ipcRenderer.invoke('profile:reset-negotiation'),
```

These follow the exact same naming and pattern as existing `profile:*` preload entries (e.g., `profileGetResume`, `profileDeleteDocument`, etc.).

---

## 6c. TypeScript Types in `src/types/electron.d.ts`

Find the interface that declares the renderer-facing API (typically `interface ElectronAPI` or similar) and add:

```typescript
profileGetNegotiationState: () => Promise<{
  success: boolean;
  state?: {
    phase: string;
    offers: {
      latestRecruiterAmount: number | null;
      latestRecruiterCurrency: string;
      trajectory: 'rising' | 'flat' | 'first';
      allEvents: Array<{
        speaker: 'recruiter' | 'user';
        amount: number;
        currency: string;
        offerType: string;
        raw: string;
        timestamp: number;
        isVague: boolean;
      }>;
    };
    userTarget: number | null;
    pushbackCount: number;
    benefitsMentioned: string[];
    vagueOfferDetected: boolean;
    silenceTimerActive: boolean;
    lastRecruiterSignal: string | null;
  };
  isActive?: boolean;
  error?: string;
}>;

profileResetNegotiation: () => Promise<{
  success: boolean;
  error?: string;
}>;
```

**Typing strategy:** The `state` field uses an inline type that mirrors `NegotiationState` from `premium/electron/knowledge/types.ts`. Do not import from that path in `electron.d.ts` — it creates a cross-boundary import from main-process code into renderer types. Inline the shape instead.

---

## Acceptance Criteria

- [ ] `window.electronAPI.profileGetNegotiationState()` resolves in the renderer without TypeScript errors
- [ ] `window.electronAPI.profileResetNegotiation()` resolves in the renderer without TypeScript errors
- [ ] Calling `profileGetNegotiationState()` after recruiter utterances returns `isActive: true` and a `state` with the correct phase
- [ ] Calling `profileResetNegotiation()` resets the tracker: a subsequent `profileGetNegotiationState()` returns `isActive: false` and `state.phase === 'INACTIVE'`
- [ ] Both handlers return `{ success: false, error: 'Engine not ready' }` gracefully when the orchestrator is not yet initialized
- [ ] No existing profile handlers are modified
- [ ] TypeScript type declarations match the actual return values from the main-process handlers
