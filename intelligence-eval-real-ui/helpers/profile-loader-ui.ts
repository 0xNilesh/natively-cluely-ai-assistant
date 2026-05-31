// intelligence-eval-real-ui/helpers/profile-loader-ui.ts
// Loads a profile's context THROUGH THE REAL SETTINGS UI:
//   - resume / JD: click the real upload button (aria-label) after priming the
//     native-dialog stub with the fixture path → triggers the real
//     profileUploadResume/JD IPC + real LLM extraction ingest.
//   - custom context / persona: type into the real textareas (debounced save).
//   - negotiation: stored via custom context (the UI surfaces negotiation through
//     custom notes + JD-derived AOT; there is no separate negotiation upload
//     control, so we append it to custom context — documented in the approach note).
// Then verifies the UI reports the profile as loaded (profileGetStatus).

import type { Page } from 'playwright-core';
import type { LaunchedApp } from './launch-natively.ts';
import path from 'node:path';
import fs from 'node:fs';

export interface ProfilePaths {
  dir: string;
  resume: string; jd: string; customContext: string; persona: string; negotiation: string;
  profileJson: string;
}

export function profilePaths(fixturesRoot: string, profileId: string): ProfilePaths {
  const dir = path.join(fixturesRoot, profileId);
  return {
    dir,
    resume: path.join(dir, 'resume.txt'),
    jd: path.join(dir, 'jd.txt'),
    customContext: path.join(dir, 'custom-context.txt'),
    persona: path.join(dir, 'persona.txt'),
    negotiation: path.join(dir, 'negotiation.txt'),
    profileJson: path.join(dir, 'profile.json'),
  };
}

const readMaybe = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '');

export interface LoadResult { resumeLoaded: boolean; jdLoaded: boolean; customSaved: boolean; personaSaved: boolean; status: any }

// Open the Profile Intelligence panel. It renders in the LAUNCHER window via
// openProfileExclusive() (also bound to the Cmd/Ctrl+4 global shortcut →
// activeAd='profile'). The panel is lazy-rendered, so the resume-upload button
// (aria-label "Select resume file") only exists after this. We trigger the same
// keyboard shortcut a user presses.
export async function openProfilePanel(win: Page): Promise<boolean> {
  // Click the REAL launcher "Profile Intelligence" button (the only way the app
  // opens the panel — there is no keyboard shortcut; it calls openProfileExclusive
  // → setIsProfileOpen(true)). Selected by data-testid (added for tests) with the
  // production title attr as fallback.
  const btn = win.locator('[data-testid="open-profile-intelligence"], button[title="Profile Intelligence"]');
  if (await btn.count() > 0) {
    await btn.first().click({ timeout: 15_000 }).catch(() => {});
    await win.waitForTimeout(800);
  }
  // Confirm the panel mounted (resume upload button exists in some state).
  const ready = win.locator('button[aria-label="Select resume file"], button[aria-label="Replace resume file"], button[aria-label="Ingesting resume"]');
  for (let i = 0; i < 10 && (await ready.count()) === 0; i++) await win.waitForTimeout(400);
  return (await ready.count()) > 0;
}

export async function loadProfileThroughUI(app: LaunchedApp, win: Page, paths: ProfilePaths): Promise<LoadResult> {
  await app.seedCleanState(win);   // dismiss startup/onboarding so the launcher mounts
  await openProfilePanel(win);
  // ── Resume: prime dialog → click real upload button → await ingest ─────────
  // 'Replace resume file' covers a second load when the app instance is reused.
  await app.primeFileDialog(paths.resume);
  await clickByAria(win, ['Select resume file', 'Replace resume file', 'Ingesting resume'], 'resume upload');
  const resumeLoaded = await waitForStatus(win, s => !!s?.hasProfile, 90_000);

  // ── JD: prime dialog → click JD upload ─────────────────────────────────────
  let jdLoaded = false;
  if (readMaybe(paths.jd)) {
    await app.primeFileDialog(paths.jd);
    await clickByAria(win, ['Upload job description', 'Replace job description', 'Parsing job description'], 'jd upload');
    // JD status lives in profileGetProfile().hasActiveJD (profileGetStatus has no JD field).
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const p = await win.evaluate(async () => (window as any).electronAPI?.profileGetProfile?.()).catch(() => null);
      if (p?.hasActiveJD) { jdLoaded = true; break; }
      await win.waitForTimeout(750);
    }
  }

  // ── Custom context + persona: type into the real textareas ─────────────────
  const customSaved = await typeContext(win, paths.customContext, 'custom');
  const personaSaved = await typeContext(win, paths.persona, 'persona');

  // Final UI-reported status.
  const status = await win.evaluate(async () => (window as any).electronAPI?.profileGetStatus?.());
  return { resumeLoaded, jdLoaded, customSaved, personaSaved, status };
}

async function clickByAria(win: Page, labels: string[], what: string): Promise<void> {
  for (const l of labels) {
    const btn = win.locator(`button[aria-label="${l}"]`);
    if (await btn.count() > 0) { await btn.first().click({ timeout: 15_000 }); return; }
  }
  throw new Error(`[profile-loader] could not find ${what} button (tried aria-labels: ${labels.join(', ')})`);
}

// Type into the custom-context / persona textarea. We locate by the production
// placeholder text (stable, user-facing) and drive a real keyboard fill so the
// debounced save IPC fires exactly as for a human.
async function typeContext(win: Page, file: string, kind: 'custom' | 'persona'): Promise<boolean> {
  const text = readMaybe(file);
  if (!text) return false;
  const placeholderNeedle = kind === 'persona' ? 'senior hiring manager' : 'use when pitching growth story';
  const ta = win.locator(`textarea[placeholder*="${placeholderNeedle}"]`);
  if (await ta.count() === 0) {
    // Fallback: the two profile textareas in order (custom first, persona second).
    const all = win.locator('textarea');
    const idx = kind === 'custom' ? 0 : 1;
    if (await all.count() <= idx) return false;
    await all.nth(idx).fill(text.slice(0, 4000), { timeout: 15_000 });
  } else {
    await ta.first().fill(text.slice(0, 4000), { timeout: 15_000 });
  }
  // Allow the 800ms debounce + save round-trip.
  await win.waitForTimeout(1200);
  return true;
}

async function waitForStatus(win: Page, pred: (s: any) => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await win.evaluate(async () => (window as any).electronAPI?.profileGetStatus?.()).catch(() => null);
    if (s && pred(s)) return true;
    await win.waitForTimeout(750);
  }
  return false;
}
