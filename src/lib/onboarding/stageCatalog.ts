/**
 * Stage catalog — declarative configs for the 8 orchestrated onboarding stages
 * (10 entries incl. quiet_window).
 *
 * Order matters: stages are evaluated front-to-back by the orchestrator, and
 * the first eligible wins (single-slot invariant). The quiet_window is
 * inserted dynamically after trial_promo dismisses, so it is not in this
 * static catalog.
 */

import type { Ctx, StageConfig, ToasterId } from './orchestrator';

/**
 * Engagement policy for the review prompt, mirrored from the review ledger
 * (electron/services/ReviewPromptLogic.ts, and its backend twin in
 * natively-api/reviews.js). Restated here because this module is renderer-side
 * and cannot import from electron/ — the ReviewPromptLogic header already
 * documents that this trio must be kept in sync.
 *
 * WHY THIS IS A PREDICATE AND NOT `triggers`. The ledger's rule is
 * "N sessions OR M minutes" — either one qualifies. The orchestrator ANDs every
 * trigger it is given, so expressing this as requiresStartupCount +
 * requiresTotalUsageMs silently changed the policy to "N sessions AND M
 * minutes", a strictly harder gate. That is what shipped: the catalog demanded
 * 6 startups AND 45 minutes while the ledger asked for 3 OR 30, so the ledger's
 * thresholds were dead in production and tuning them moved nothing.
 */
export const REVIEW_PROMPT_MIN_SESSIONS = 3;
export const REVIEW_PROMPT_MIN_USAGE_MS = 30 * 60 * 1000;

/** True once the user is engaged enough to be asked — sessions OR usage. */
export function reviewEngagementMet(ctx: Ctx): boolean {
  return ctx.startupCount >= REVIEW_PROMPT_MIN_SESSIONS
    || ctx.totalUsageMs >= REVIEW_PROMPT_MIN_USAGE_MS;
}

export const STAGE_ORDER: ToasterId[] = [
  'permissions',
  'browser_extension',
  'profile_intelligence',
  'modes_manager',
  'trial_promo',
  'support',
  'ads',
  'review_prompt',
];

export const STAGES: StageConfig[] = [
  // ──────────────────────────────────────────────────────────────
  // 1. Permissions — first launch OR returning mac user with revoked TCC
  // ──────────────────────────────────────────────────────────────
  {
    id: 'permissions',
    order: 1,
    onceEver: false, // can re-fire if mac TCC is denied
    triggers: {
      requiresHomepageMounted: true,
      requiresHomepageDuration: 2_000,
      requiresForeground: true,
      requiresMeetingInactive: true,
    },
    // Show when EITHER (a) something actionable is genuinely blocked, or
    // (b) this is a first launch on a platform whose permission model needs an
    // up-front walkthrough. Windows satisfies neither in the normal case: it has
    // no screen-capture gate and grants the mic by default, so setting
    // permissionsFirstRunEligible=false there stops the card from appearing at
    // startup on a machine with nothing to fix. A Windows mic denial still
    // raises it, via permissionsNeedAttention.
    skipWhen: (s) =>
      !s.macTCCBlocked &&
      !s.permissionsNeedAttention &&
      (s.permsShown || s.permissionsFirstRunEligible === false),
    reEligibility: (s) => s.macTCCBlocked || s.permissionsNeedAttention,
    // macOS keeps its every-launch prompt for a revoked TCC grant: capture is
    // dead until the user re-grants, and that is the platform's designed
    // behaviour. Off darwin the card is raised by permissionsNeedAttention,
    // which stays true for as long as the mic is denied — so without a cooldown
    // a Windows user who deliberately runs mic-off (screen and text only) would
    // be met by a full-viewport modal at EVERY startup with no way to stop it.
    // A week is long enough to stop being a nag and short enough that a genuine
    // misconfiguration still resurfaces.
    cooldownMs: (s) =>
      s.macTCCBlocked ? 0
      : s.permissionsNeedAttention ? 7 * 24 * 60 * 60 * 1000
      : 0,
  },

  // ──────────────────────────────────────────────────────────────
  // 2. Browser extension — gates on permissions + next-launch semantics
  // ──────────────────────────────────────────────────────────────
  {
    id: 'browser_extension',
    order: 2,
    triggers: {
      requiresHomepageMounted: true,
      requiresHomepageDuration: 5_000,
      requiresForeground: true,
      requiresMeetingInactive: true,
    },
    requiresStages: ['permissions'],
    skipWhen: (s) =>
      !s.extensionSupported ||
      !s.isV2_8_OrNewer ||
      s.extensionConnected,
    cooldownMs: () => 7 * 24 * 60 * 60 * 1000, // 7 days
  },

  // ──────────────────────────────────────────────────────────────
  // 3. Profile intelligence — after browser ext seen/skipped
  // ──────────────────────────────────────────────────────────────
  {
    id: 'profile_intelligence',
    order: 3,
    onceEver: true,
    isGateOnly: true, // UI is the Launcher's header icon popover, not this stage
    triggers: {
      requiresHomepageMounted: true,
      requiresHomepageDuration: 4_000,
      requiresForeground: true,
      requiresMeetingInactive: true,
    },
    requiresStages: ['browser_extension'],
    skipWhen: (s) =>
      s.hasProfile ||
      s.isPremium ||
      s.seenProfileOnboarding,
  },

  // ──────────────────────────────────────────────────────────────
  // 4. Modes manager — after profile seen/skipped
  // ──────────────────────────────────────────────────────────────
  {
    id: 'modes_manager',
    order: 4,
    onceEver: true,
    isGateOnly: true, // UI is the Launcher's header icon popover, not this stage
    triggers: {
      requiresHomepageMounted: true,
      requiresHomepageDuration: 4_000,
      requiresForeground: true,
      requiresMeetingInactive: true,
    },
    requiresStages: ['profile_intelligence'],
    skipWhen: (s) =>
      s.seenModesOnboarding ||
      s.activeModeSet,
  },

  // ──────────────────────────────────────────────────────────────
  // 5. Trial promo — after modes seen/skipped
  // ──────────────────────────────────────────────────────────────
  {
    id: 'trial_promo',
    order: 5,
    triggers: {
      requiresHomepageMounted: true,
      requiresHomepageDuration: 6_000,
      requiresForeground: true,
      requiresMeetingInactive: true,
    },
    requiresStages: ['modes_manager'],
    skipWhen: (s) =>
      s.hasNativelyKey ||
      s.hasTrialToken ||
      s.isPremium,
    cooldownMs: () => 21 * 24 * 60 * 60 * 1000, // 21 days
    reEligibility: (s) => !s.hasNativelyKey && !s.hasTrialToken && !s.isPremium,
  },

  // ──────────────────────────────────────────────────────────────
  // 6. Support — after quiet_window resolves
  // ──────────────────────────────────────────────────────────────
  {
    id: 'support',
    order: 6,
    triggers: {
      requiresHomepageMounted: true,
      requiresHomepageDuration: 10_000,
      requiresForeground: true,
      requiresMeetingInactive: true,
    },
    requiresStages: ['quiet_window'],
    skipWhen: (s) => !s.donationShouldShow || s.isPremium,
    customPredicate: (ctx: Ctx) =>
      // Trigger after enough engagement: 10 turns OR 10 successful startups
      ctx.turnCount >= 10 || ctx.startupCount >= 10,
    cooldownMs: () => 14 * 24 * 60 * 60 * 1000, // 14 days
  },

  // ──────────────────────────────────────────────────────────────
  // 7. Ads — useAdCampaigns rotation. After support seen/skipped.
  // ──────────────────────────────────────────────────────────────
  {
    id: 'ads',
    order: 7,
    triggers: {
      requiresHomepageMounted: true,
      requiresHomepageDuration: 10_000,
      requiresForeground: true,
      requiresMeetingInactive: true,
      requiresStartupCount: 4,
    },
    requiresStages: ['support'],
    skipWhen: (s) => s.isPremium,
    cooldownMs: () => 14 * 24 * 60 * 60 * 1000, // 14 days
  },

  // ──────────────────────────────────────────────────────────────
  // 8. Review prompt — late-stage engagement gate
  // ──────────────────────────────────────────────────────────────
  {
    id: 'review_prompt',
    order: 8,
    triggers: {
      requiresHomepageMounted: true,
      requiresHomepageDuration: 10_000,
      requiresForeground: true,
      requiresMeetingInactive: true,
      // Engagement is NOT expressed here: `triggers` are ANDed, and the policy
      // is "sessions OR usage". See reviewEngagementMet above.
    },
    customPredicate: reviewEngagementMet,
    requiresStages: ['ads'],
    cooldownMs: () => 90 * 24 * 60 * 60 * 1000, // 90 days
  },
];

// ─── Quiet window stage ───────────────────────────────────────────
// Inserted dynamically after trial_promo dismisses. Resolves on 3 user turns
// via customPredicate. No React component — pure orchestrator gate.

export const QUIET_WINDOW_STAGE: StageConfig = {
  id: 'quiet_window',
  order: 99, // not used in static ordering
  isGateOnly: true, // No UI — auto-resolves once predicate is satisfied
  // MUST be onceEver like every other gate-only stage (profile_intelligence,
  // modes_manager). Without it, evaluateAndDispatch()'s auto-complete branch
  // re-completes this stage on EVERY pass of its `do { … } while (progressMade
  // && !activeToasterId)` drain loop: completeToaster() records completion, but
  // shouldShowToaster() only suppresses a completed stage when `onceEver` is set
  // (see orchestrator.ts step 2), so without it the stage stays eligible, keeps
  // setting progressMade=true, and the loop spins synchronously forever — each
  // pass calling persist()+notify(), churning unbounded native memory. That
  // pegged the launcher renderer's main thread and grew its RSS to ~9 GB before
  // an exitCode-5 OOM crash (2026-07-19). It resolves exactly once (3 user turns
  // after trial_promo), so once-ever is also the correct semantics.
  onceEver: true,
  triggers: {},
  customPredicate: (ctx: Ctx) => {
    const baseline = ctx.completed['_turnCountAtQuietStart'] ?? 0;
    return ctx.turnCount - baseline >= 3;
  },
};