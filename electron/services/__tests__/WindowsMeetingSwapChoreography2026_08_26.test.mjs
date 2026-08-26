import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(__dirname, '../../..', rel), 'utf8');

// Regression pins for the Windows launcher <-> meeting-overlay swap feeling
// like two windows blinking rather than one continuous motion.
//
// The structural defect was a HOLE, not a curve problem. switchToOverlay used
// to run `launcherWindow.hide()` synchronously at the end of the function
// while the overlay sat at setOpacity(0) behind its content-protection shield
// for another 60ms — roughly four frames with NEITHER surface painted. The fix
// is a handoff: the launcher's renderer recedes, its window stays alive
// underneath the always-on-top overlay, and it is only hidden once that recede
// has run out.
//
// Three contracts hold the result together, and all three are cheap to break
// by accident:
//
//   1. The launcher hide must stay DEFERRED behind the shield on win32.
//   2. LAUNCHER_RECEDE_MS must stay strictly greater than
//      LAUNCHER_RECEDE_LEAD_MS + OVERLAY_SHIELD_MS, or the launcher finishes
//      fading before the overlay has painted anything and the swap is
//      sequential again — the blank gap in a new costume.
//   3. The overlay shell, pill and toggle must stay on ONE timeline.
//
// Plus the cross-file duration mirrors: the timings live in three places
// (WindowHelper.ts owns them, src/index.css animates them, and
// src/lib/windowTransitions.ts schedules cleanup off them) and silently drift.
//
// main.ts / WindowHelper.ts import electron at module scope and cannot load
// under `node --test`; these assert the contracts in source, matching the
// MeetingOverlayStaleFrame / StealthShortcutGuard approach.

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const helperSource = () => stripComments(read('electron/WindowHelper.ts'));

const sliceSwitchToOverlay = (helper) => {
  const start = helper.indexOf('public switchToOverlay(');
  assert.ok(start > -1, 'switchToOverlay() not found in electron/WindowHelper.ts');
  const end = helper.indexOf('public switchToLauncher(', start);
  assert.ok(end > start, 'end of switchToOverlay() not found');
  return helper.slice(start, end);
};

const numericConstant = (helper, name) => {
  const m = new RegExp(`static readonly ${name}\\s*=\\s*(\\d+)`).exec(helper);
  assert.ok(m, `WindowHelper.${name} not found — the swap choreography depends on it.`);
  return Number(m[1]);
};

// ─── #1: the launcher hide is deferred behind the shield on Windows ──────────
test('switchToOverlay does not hide the launcher synchronously on Windows', () => {
  const body = sliceSwitchToOverlay(helperSource());

  // The trailing "Hide Launcher SECOND" block runs BEFORE the shield's 60ms
  // timer fires, so reaching it on the normal win32 path IS the blank gap.
  const tailAt = body.lastIndexOf('this.launcherWindow.hide()');
  assert.ok(tailAt > -1, 'switchToOverlay must still hide the launcher on the paths that do not defer.');
  const guardWindow = body.slice(Math.max(0, tailAt - 400), tailAt);
  assert.match(
    guardWindow,
    /!launcherHideDeferred/,
    "the synchronous launcher hide must yield to the deferred one — on win32 it runs ~60ms before the overlay is un-shielded, leaving neither window painted.",
  );

  // ...and the flag has to be a real handoff, not a platform check in
  // disguise: with no overlay window there is no shield timer to hand off to,
  // and the launcher must still be hidden by the fallback above.
  const armAt = body.indexOf('launcherHideDeferred = true');
  const timerAt = body.indexOf('this.opacityTimeout = setTimeout(');
  assert.ok(
    armAt > -1 && timerAt > -1 && armAt < timerAt,
    'launcherHideDeferred must be set exactly where the shield timer is armed, so any path that arms no timer still falls through to the synchronous hide.',
  );
});

test('the Windows launcher hide runs from inside the shield callback, after the un-shield', () => {
  const body = sliceSwitchToOverlay(helperSource());
  const timerAt = body.indexOf('this.opacityTimeout = setTimeout(');
  assert.ok(timerAt > -1, 'the deferred un-shield timer must still exist.');
  const callback = body.slice(timerAt, body.indexOf('}, 60);', timerAt));

  const restoreAt = callback.indexOf('setOpacity(1)');
  const handoffAt = callback.indexOf('this.hideLauncherAfterOverlayHandoff()');
  assert.ok(
    handoffAt > -1,
    'the shield callback must hand the screen off to the overlay before the launcher goes away.',
  );
  assert.ok(
    restoreAt > -1 && restoreAt < handoffAt,
    'the overlay must be made opaque BEFORE the launcher is released — that ordering is the entire fix.',
  );

  const guardAt = callback.indexOf("this.currentWindowMode !== 'overlay'");
  assert.ok(
    guardAt > -1 && guardAt < handoffAt,
    'the mode guard must run before the handoff — once switchToLauncher owns the launcher, hiding it here fights it.',
  );
});

test('every route that takes ownership of the launcher cancels the deferred hide', () => {
  const helper = helperSource();

  for (const fn of ['public switchToLauncher(', 'public hideMainWindow(']) {
    const start = helper.indexOf(fn);
    assert.ok(start > -1, `${fn} not found.`);
    const body = helper.slice(start, start + 4000);
    assert.match(
      body,
      /this\.clearLauncherHideTimeout\(\)/,
      `${fn} must cancel the deferred launcher hide. Deferring it is only safe because the two functions that take over the launcher — one shows it, one hides it — both clear the timer; drop either and a queued hide fires on a launcher the user is looking at.`,
    );
  }
});

// ─── #2: the overlap invariant ───────────────────────────────────────────────
test('the launcher recede outlasts the lead plus the shield', () => {
  const helper = helperSource();
  const recede = numericConstant(helper, 'LAUNCHER_RECEDE_MS');
  const lead = numericConstant(helper, 'LAUNCHER_RECEDE_LEAD_MS');
  const shield = numericConstant(helper, 'OVERLAY_SHIELD_MS');

  assert.ok(
    recede > lead + shield,
    `LAUNCHER_RECEDE_MS (${recede}) must be strictly greater than LAUNCHER_RECEDE_LEAD_MS + OVERLAY_SHIELD_MS (${lead} + ${shield} = ${lead + shield}). At or below it, the launcher is fully faded before the overlay's first opaque frame and the swap is two sequential animations again — the blank gap with easing painted over it. The margin is the overlap that makes the two windows read as one motion.`,
  );
});

test('OVERLAY_SHIELD_MS still describes the real shield timer', () => {
  const body = sliceSwitchToOverlay(helperSource());
  const shield = numericConstant(helperSource(), 'OVERLAY_SHIELD_MS');
  assert.ok(
    body.includes(`}, ${shield});`),
    `OVERLAY_SHIELD_MS (${shield}) must match the literal delay on switchToOverlay's un-shield timer — it is only a mirror, and the overlap invariant above is computed from it.`,
  );
});

// ─── #3: the overlay group is one object ─────────────────────────────────────
test('shell, pill and toggle share one entrance timeline', () => {
  const helper = helperSource();
  const start = helper.indexOf('private sendOverlayTransition(');
  assert.ok(start > -1, 'sendOverlayTransition() not found.');
  const body = helper.slice(start, helper.indexOf('public beginLauncherRecede(', start));

  assert.match(
    body,
    /this\.overlayWindow,\s*this\.pillWindow,\s*this\.toggleWindow/,
    'all three overlay windows must receive the same cue — they are separate HWNDs but one object on screen.',
  );

  const css = read('src/index.css');
  const enterBlock = css.slice(css.indexOf('[data-overlay-enter="entering"]'));
  const declarations = enterBlock.slice(0, enterBlock.indexOf('}'));
  assert.doesNotMatch(
    declarations,
    /transition-delay|animation-delay/,
    'no stagger on the overlay entrance. The pill is welded chrome, not a discrete control, and applyOverlayAuxVisibility/switchToOverlay deliberately land it on the same compositor commit as the shell; a delay here undoes that.',
  );
});

test('the pill scales from the seam it shares with the shell, not its own top', () => {
  const css = read('src/index.css');
  const pillAt = css.indexOf('[data-window="overlay-pill"][data-overlay-enter] body');
  assert.ok(pillAt > -1, 'the pill window needs its own transform-origin for the swap entrance.');
  const rule = css.slice(pillAt, css.indexOf('}', pillAt));
  assert.match(
    rule,
    /transform-origin:\s*bottom center/,
    'the pill sits directly above the shell, so it must grow from its BOTTOM edge while the shell grows from its top — otherwise a gap opens between them at scale 0.96 and the group stops reading as one rigid object.',
  );
});

// ─── #4: cross-file duration mirrors ─────────────────────────────────────────
test('the recede duration is identical in WindowHelper, the CSS and the renderer module', () => {
  const recede = numericConstant(helperSource(), 'LAUNCHER_RECEDE_MS');

  const css = read('src/index.css');
  const recedeAt = css.indexOf('[data-launcher-transition="receding"] body');
  assert.ok(recedeAt > -1, 'the launcher recede rule is missing from src/index.css.');
  const rule = css.slice(recedeAt, css.indexOf('}', recedeAt));
  assert.ok(
    rule.includes(`opacity ${recede}ms`) && rule.includes(`transform ${recede}ms`),
    `src/index.css must animate the recede over exactly LAUNCHER_RECEDE_MS (${recede}ms). WindowHelper arms the deferred launcher hide off this number; if the CSS is slower the window vanishes mid-fade.`,
  );

  const mod = read('src/lib/windowTransitions.ts');
  assert.ok(
    new RegExp(`LAUNCHER_RECEDE_MS = ${recede}\\b`).test(mod),
    `src/lib/windowTransitions.ts mirrors LAUNCHER_RECEDE_MS (${recede}) for its self-heal timer.`,
  );
});

test('the overlay entrance duration matches the renderer cleanup timer', () => {
  const css = read('src/index.css');
  const enterAt = css.indexOf('[data-overlay-enter="entering"] body');
  assert.ok(enterAt > -1, 'the overlay entrance rule is missing from src/index.css.');
  const rule = css.slice(enterAt, css.indexOf('}', enterAt));
  const m = /transform (\d+)ms/.exec(rule);
  assert.ok(m, 'the overlay entrance must animate transform for a known duration.');

  const mod = read('src/lib/windowTransitions.ts');
  assert.ok(
    new RegExp(`OVERLAY_ENTER_MS = ${m[1]}\\b`).test(mod),
    `src/lib/windowTransitions.ts must mirror the CSS entrance duration (${m[1]}ms) — it tears the attribute down on that timer, and tearing it down early snaps a half-finished entrance to rest.`,
  );

  const opacity = /opacity (\d+)ms/.exec(rule);
  assert.ok(opacity, 'the overlay entrance must animate opacity for a known duration.');
  assert.ok(
    Number(opacity[1]) < Number(m[1]),
    'opacity must finish before the transform. The surface being fully present while its shape is still settling is what makes the entrance read as an object arriving rather than a layer fading up.',
  );
});

// ─── #5: macOS is deliberately untouched ─────────────────────────────────────
test('the swap choreography never fires off Windows', () => {
  const helper = helperSource();

  for (const fn of ['private sendOverlayTransition(', 'public beginLauncherRecede(', 'private restoreLauncherFromRecede(']) {
    const start = helper.indexOf(fn);
    assert.ok(start > -1, `${fn} not found.`);
    const body = helper.slice(start, start + 900);
    assert.match(
      body,
      /process\.platform !== 'win32'/,
      `${fn} must return early off win32. macOS has no opacity shield to arm an invisible pre-entrance state behind, and it re-presents a hidden window's last composited frame on show() — so an entrance there risks a rest-frame flash nobody can verify from Windows. Its path stays byte-identical to before this change.`,
    );
  }

  const css = read('src/index.css');
  for (const attr of ['[data-overlay-enter="armed"]', '[data-launcher-transition="receding"]']) {
    const at = css.indexOf(attr);
    assert.ok(at > -1, `${attr} rule missing from src/index.css.`);
    const selectorStart = css.lastIndexOf('\n', css.lastIndexOf('html', at)) + 1;
    assert.match(
      css.slice(selectorStart, at + attr.length),
      /html\[data-platform="win32"\]/,
      `${attr} must stay gated on html[data-platform="win32"] — the CSS gate and the main-process gate have to agree, or macOS gets a half-installed animation.`,
    );
  }
});

test('startMeetingTransition waits for the recede before swapping, and only after the permission probes', () => {
  const main = stripComments(read('electron/main.ts'));
  const start = main.indexOf('private async startMeetingTransition(');
  assert.ok(start > -1, 'startMeetingTransition() not found.');
  const body = main.slice(start, main.indexOf('public endMeeting(', start));

  const recedeAt = body.indexOf('beginLauncherRecede()');
  const swapAt = body.indexOf("setWindowMode('overlay')");
  const micAt = body.indexOf('ensureMacMicrophoneAccess');

  assert.ok(recedeAt > -1, 'meeting start must ask the launcher to recede — without it the launcher is cut at full opacity.');
  assert.ok(
    body.slice(0, swapAt).includes('await this.windowHelper.beginLauncherRecede()'),
    'the recede must be AWAITED before the swap, or the overlay lands on a launcher that has not started moving.',
  );
  assert.ok(
    micAt > -1 && micAt < recedeAt,
    'the recede must come AFTER the permission probes. Those can throw and abort the start, and a launcher that had already receded would be left faded out on the screen the user is stuck on.',
  );
});
