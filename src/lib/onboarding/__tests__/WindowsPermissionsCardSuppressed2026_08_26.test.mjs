// src/lib/onboarding/__tests__/WindowsPermissionsCardSuppressed2026_08_26.test.mjs
//
// Regression: the onboarding permissions card was raised on EVERY platform's
// first launch, and its content is a macOS TCC walkthrough — a consent dialog
// reading "Natively wants to record the screen" and a System Settings → Privacy
// & Security breadcrumb. Windows has no such grant to make: `permissions:check`
// returns a constant screen: 'granted' there (there is no screen-capture gate)
// and the mic is granted by default, so a Windows user was shown a macOS
// walkthrough for permissions that did not need granting.
//
// The stage now shows only when EITHER something actionable is genuinely
// blocked (`macTCCBlocked` on darwin, `permissionsNeedAttention` anywhere) OR
// the platform's permission model warrants a first-launch walkthrough
// (`permissionsFirstRunEligible`, true only on darwin).
//
// Both platform branches are exercised here — the predicate is pure and takes
// user-state, so neither needs process.platform mutated (CLAUDE.md).

import test from 'node:test';
import assert from 'node:assert/strict';

import { STAGES } from '../stageCatalog.mjs';
import { shouldShowToaster, DEFAULT_USER_STATE } from '../orchestrator.mjs';
// The SHIPPED derivation App.tsx uses — imported, not restated. A hand-copied
// twin here would keep passing forever after the real one drifts.
import { permissionsNeedAttention as needsAttention } from '../../micPermissionPolicy.mjs';

const permissions = STAGES.find((s) => s.id === 'permissions');

function ctx(userState = {}) {
  return {
    startupCount: 0,
    totalUsageMs: 0,
    turnCount: 0,
    homepageMountedFor: 3_000,
    appInForeground: true,
    homepageCurrentlyMounted: true,
    meetingActive: false,
    userState: { ...DEFAULT_USER_STATE, ...userState },
    completed: {},
    skipped: new Set(),
    lastShownTimes: {},
    now: Date.now(),
  };
}

// The two states App.tsx derives from permissions:check, per platform.
const WIN32_HEALTHY = { permissionsFirstRunEligible: false, permissionsNeedAttention: false };
const WIN32_MIC_BLOCKED = { permissionsFirstRunEligible: false, permissionsNeedAttention: true };
const DARWIN_FIRST_RUN = { permissionsFirstRunEligible: true, permissionsNeedAttention: false };

// ─── Windows branch ───────────────────────────────────────────────

test('win32 + nothing blocked: the card never appears on first launch', () => {
  assert.equal(shouldShowToaster(permissions, ctx(WIN32_HEALTHY)), false);
});

test('win32 + nothing blocked: still suppressed on later launches', () => {
  assert.equal(
    shouldShowToaster(permissions, ctx({ ...WIN32_HEALTHY, permsShown: true })),
    false,
  );
});

test('win32 + mic blocked by the privacy toggle: the card DOES appear', () => {
  assert.equal(shouldShowToaster(permissions, ctx(WIN32_MIC_BLOCKED)), true);
});

test('win32 + mic blocked re-raises even after the card was dismissed once', () => {
  // reEligibility must cover the platform-neutral flag too, or a Windows user
  // who dismissed the card once could never be told about a later mic block.
  assert.equal(
    shouldShowToaster(permissions, ctx({ ...WIN32_MIC_BLOCKED, permsShown: true })),
    true,
  );
});

test("win32 + mic 'not-determined' (unresolved query) does NOT raise the card", () => {
  // getMediaAccessStatus leaves 'not-determined' when get_CurrentStatus fails;
  // that is an unknown, not a denial, and must never trigger the modal.
  const need = needsAttention('win32', 'not-determined', 'granted');
  assert.equal(need, false);
  assert.equal(
    shouldShowToaster(
      permissions,
      ctx({ permissionsFirstRunEligible: false, permissionsNeedAttention: need }),
    ),
    false,
  );
});

test("win32 + mic 'restricted' (device-level switch off) DOES raise the card", () => {
  assert.equal(needsAttention('win32', 'restricted', 'granted'), true);
});

test("win32 + mic 'granted' derives no attention", () => {
  assert.equal(needsAttention('win32', 'granted', 'granted'), false);
});

test("darwin + screen 'denied' derives attention even with the mic granted", () => {
  assert.equal(needsAttention('darwin', 'granted', 'denied'), true);
});

// ─── macOS branch (unchanged) ─────────────────────────────────────

test('darwin first launch: the card still appears', () => {
  assert.equal(shouldShowToaster(permissions, ctx(DARWIN_FIRST_RUN)), true);
});

test('darwin after dismissal with TCC intact: suppressed', () => {
  assert.equal(
    shouldShowToaster(permissions, ctx({ ...DARWIN_FIRST_RUN, permsShown: true })),
    false,
  );
});

test('darwin with revoked TCC: re-raised', () => {
  assert.equal(
    shouldShowToaster(
      permissions,
      ctx({ ...DARWIN_FIRST_RUN, permsShown: true, macTCCBlocked: true }),
    ),
    true,
  );
});

// ─── Downstream stages must not be stranded ───────────────────────

test('shouldShowToaster accepts a SKIPPED dependency, not only a completed one', () => {
  // browser_extension requires the permissions stage, and every later stage
  // chains off it. This pins the CONSUMER half of the contract: a stage in
  // `skipped` satisfies requiresStages. The PRODUCER half — that the class
  // actually puts a skipWhen-suppressed stage into `skipped` — cannot be seen
  // from this pure predicate and is pinned in orchestratorClass.test.mjs
  // ('win32 healthy: the suppressed permissions stage is auto-skipped …').
  const browserExt = STAGES.find((s) => s.id === 'browser_extension');
  const c = ctx({ ...WIN32_HEALTHY, extensionConnected: false });
  c.homepageMountedFor = 6_000;
  c.skipped = new Set(['permissions']);
  assert.equal(shouldShowToaster(browserExt, c), true);
});

// ─── Windows nag cooldown ─────────────────────────────────────────
//
// permissionsNeedAttention stays true for as long as the mic is denied, so
// skipWhen can never go true and an explicit dismiss only survives the session.
// Without a cooldown that means a full-viewport modal at EVERY startup, with no
// permanent opt-out, for a Windows user who deliberately runs mic-off. macOS is
// exempt on purpose: a revoked TCC grant kills capture outright and re-prompting
// every launch is that platform's designed behaviour.

const WEEK = 7 * 24 * 60 * 60 * 1000;

test('win32 mic blocked: raised the first time, never having been shown', () => {
  assert.equal(shouldShowToaster(permissions, ctx(WIN32_MIC_BLOCKED)), true);
});

test('win32 mic blocked: suppressed on a relaunch one day later', () => {
  const c = ctx(WIN32_MIC_BLOCKED);
  c.lastShownTimes = { permissions: c.now - 24 * 60 * 60 * 1000 };
  assert.equal(shouldShowToaster(permissions, c), false, 'must not nag every launch');
});

test('win32 mic blocked: resurfaces once the week has elapsed', () => {
  const c = ctx(WIN32_MIC_BLOCKED);
  c.lastShownTimes = { permissions: c.now - (WEEK + 60_000) };
  assert.equal(shouldShowToaster(permissions, c), true, 'a real misconfiguration still comes back');
});

test('darwin revoked TCC is EXEMPT — it still re-prompts on the very next launch', () => {
  const c = ctx({ ...DARWIN_FIRST_RUN, permsShown: true, macTCCBlocked: true });
  c.lastShownTimes = { permissions: c.now - 60_000 }; // a minute ago
  assert.equal(
    shouldShowToaster(permissions, c),
    true,
    'the Windows cooldown must not weaken the macOS TCC prompt',
  );
});
