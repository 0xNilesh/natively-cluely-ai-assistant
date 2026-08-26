// Regression check: the frameless launcher's rounded window corners.
//
// Background: on Windows/Linux the launcher BrowserWindow is `frame: false`,
// so the OS draws no chrome and there is nothing to round. The curve comes
// entirely from the `html[data-platform="win32"] body` radius in src/index.css,
// clipped by that rule's `overflow: hidden`, and it only reads as a *window*
// corner because the BrowserWindow's native backgroundColor is fully
// transparent on those platforms (LAUNCHER_TRANSPARENT_BG in
// electron/WindowHelper.ts) so the desktop shows through outside the radius.
// macOS needs none of it: its launcher is a native `titleBarStyle:
// 'hiddenInset'` window and the OS rounds and masks the rect itself.
//
// Three branches have to hold at once, and two of them are invisible on any
// single machine, so they are asserted here rather than left to a screenshot:
//
//   1. win32, restored  → 16px   (a plain circular arc; `corner-shape: squircle`
//                                 was tried and rejected — see index.css for the
//                                 per-scanline step measurements)
//   2. win32, maximized → 0px    (flush with the work area on all four sides;
//                                 a radius there cuts transparent notches
//                                 through to the desktop at the screen corners)
//   3. darwin           → 0px    (selector must never match darwin — the DOM
//                                 there is square and the OS supplies the curve)
//
// It also pins two things a computed-style check alone would miss:
//
//   · CLIPPING — it samples the real corner pixel. #surface paints its own
//     square opaque background, so the corner only comes back as the page
//     background if body genuinely clips it. (Asserting `overflow: hidden` in
//     computed style would be vacuous: the global `html, body, #root` rule
//     supplies it regardless, so that assertion passes with this rule's copy
//     deleted — verified by mutation.)
//
//   · ANTIALIASING — the user-visible complaint that started this was a corner
//     that read as a "dirty crop". Every scanline crossing the arc must contain
//     at least one partial-coverage pixel; a hard stair-step has none. This is
//     the assertion that would catch a future change (a mask, a promoted layer,
//     a clip-path on a composited subtree) quietly turning the curve jaggy.
//
// SHAPE is asserted too: macOS window corners are continuous (superellipse),
// not circular arcs, and `corner-shape: squircle` is what matches them. The
// property shipped in Chrome 139; on an older engine it is ignored and the
// corner degrades to a circular arc of the same radius, so this is asserted
// only when the engine reports support.
//
// Why Electron rather than a string match on the CSS: the maximized rule wins
// by specificity, not source order, and the darwin case depends on selector
// matching. Both are cascade behavior, which only a real engine settles.
//
// Run: npm run test:css:launcher-corners
import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const INDEX_CSS = resolve(process.cwd(), 'src/index.css');
const INDEX_HTML = resolve(process.cwd(), 'index.html');

// index.html carries an EARLY-PAINT MIRROR of the launcher's rounded window,
// because src/index.css only arrives with the module bundle and until then the
// window would paint as a hard black rectangle and then pop round. The two
// radii must not drift.
function inlineMirror() {
  if (!existsSync(INDEX_HTML)) return null;
  const html = readFileSync(INDEX_HTML, 'utf8');
  const start = html.indexOf('EARLY-PAINT MIRROR');
  if (start === -1) return null;
  const block = html.slice(start, html.indexOf('</style>', start));
  const m = /border-radius:\s*([0-9]+px)/.exec(block);
  // Every #root selector in the mirror, so a half-guarded pair (win32 fixed,
  // linux forgotten) fails rather than passing on the first match.
  const rootSelectors = block.split('\n').filter((l) => /#root\s*[,{]/.test(l));
  return { radius: m ? m[1] : null, rootSelectors };
}

// Both markers must be present. If either rule is renamed or deleted this
// check must be updated deliberately, not silently pass on an empty slice.
const MARKERS = {
  start: 'html[data-platform="win32"] body,',
  maximized: 'html[data-platform="win32"][data-window-maximized="true"] body,',
  end: '/* ───────────────────────────────────────────────────────────────────────\n   Natively API',
};

function sliceCss() {
  if (!existsSync(INDEX_CSS)) {
    throw new Error(
      `stylesheet not found at ${INDEX_CSS} — run this from the repo root ` +
      `(npm run test:css:launcher-corners), not from a subdirectory. This is a ` +
      `harness problem, not a CSS regression.`,
    );
  }
  const css = readFileSync(INDEX_CSS, 'utf8');
  for (const [name, marker] of Object.entries(MARKERS)) {
    if (css.indexOf(marker) === -1) {
      throw new Error(
        `index.css marker "${name}" not found (${JSON.stringify(marker)}). The ` +
        `launcher corner rules were renamed or removed — update this check ` +
        `rather than deleting it.`,
      );
    }
  }
  const start = css.indexOf(MARKERS.start);
  const end = css.indexOf(MARKERS.end, start);
  return css.slice(start, end);
}

// The html/body baseline from index.css:2069-2072 is reproduced so the fixture
// matches the real cascade context. `#surface` stands in for the launcher's
// opaque root div: it has its own square background, so the ONLY thing that can
// keep it out of the window's corner is body's radius + clipping. The page
// background is white so a clipped corner and an unclipped one are different
// colors under capturePage().
const WHITE = 'rgb(255, 255, 255)';
const SURFACE = '#101010';
const page = (rules, platform, maximized, theme, isLauncher = true, splash = false, emptyRoot = false, preview = false) => `<!doctype html>
<html data-platform="${platform}"${isLauncher ? ' data-window="launcher"' : ''}${maximized ? ' data-window-maximized="true"' : ''}${theme ? ` data-theme="${theme}"` : ''}${preview ? ' data-opacity-preview="active"' : ''}>
<meta charset="utf-8"><style>
  html { background: #ffffff; }
  html, body, #root { height: 100%; width: 100%; overflow: hidden; background: transparent !important; margin: 0; }
  ${rules}
</style>
<body><div id="root">${emptyRoot ? '' : `<div id="surface" style="height:100%;background:${SURFACE}"></div>`}
${splash ? `<div id="splash" style="position:fixed;inset:0;z-index:100;background:${SURFACE}"></div>` : ''}</div></body>
</html>`;

async function measure() {
  const win = new BrowserWindow({ width: 420, height: 320, show: false });
  const written = [];
  const load = async (tag, platform, maximized, theme, isLauncher = true, splash = false, emptyRoot = false, preview = false) => {
    const fixture = join(tmpdir(), `natively-launcher-corners-${tag}.html`);
    writeFileSync(fixture, page(sliceCss(), platform, maximized, theme, isLauncher, splash, emptyRoot, preview));
    written.push(fixture);
    await win.loadFile(fixture);
    const style = await win.webContents.executeJavaScript(`
      new Promise(r => requestAnimationFrame(() => {
        const cs = getComputedStyle(document.body);
        r({
          radius: cs.borderTopLeftRadius,
          allCorners: [
            cs.borderTopLeftRadius, cs.borderTopRightRadius,
            cs.borderBottomRightRadius, cs.borderBottomLeftRadius,
          ],
          cornerShape: cs.cornerShape ?? '(unsupported)',
          engineSupportsCornerShape: CSS.supports('corner-shape', 'squircle'),
          ringShadow: getComputedStyle(document.body, '::after').boxShadow,
        });
      }));
    `);
    // Sample the actual top-left corner pixel. This is what proves the radius
    // is load-bearing rather than decorative: #surface paints its own square
    // background, so the corner only comes back white if body genuinely CLIPS
    // it. A computed-style assertion on `overflow` could not show this — the
    // global html/body rule sets `overflow: hidden` anyway, so it would pass
    // with this rule's copy deleted.
    const shot = await win.capturePage({ x: 0, y: 0, width: 32, height: 32 });
    const data = shot.toBitmap();          // BGRA
    const { width: sw, height: sh } = shot.getSize();
    const px = (x, y) => {
      const i = (y * sw + x) * 4;
      return { r: data[i + 2], g: data[i + 1], b: data[i] };
    };
    const cornerPixel = (() => { const p = px(0, 0); return `rgb(${p.r}, ${p.g}, ${p.b})`; })();
    const centrePixel = (() => { const p = px(sw - 1, sh - 1); return `rgb(${p.r}, ${p.g}, ${p.b})`; })();

    // Per-scanline antialiasing profile of the SILHOUETTE — the boundary
    // between the page background and the window surface along the top-left
    // arc. Measuring the silhouette rather than counting "blend" pixels keeps
    // this independent of whatever is painted just inside the edge (the
    // hairline ring, a header with its own background), which would otherwise
    // change the pixel makeup and make the assertion mean something different.
    //
    // For each row: find the first pixel that is not pure page background.
    // On a correctly antialiased curve that pixel is a PARTIAL blend, so its
    // luminance sits strictly between the background and the solid interior a
    // few px further in. On a hard clip it jumps straight to the interior
    // value with no intermediate step.
    const lum = ({ r, g, b }) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const isBg = ({ r, g, b }) => r === 0xff && g === 0xff && b === 0xff;
    let rowsCrossingArc = 0;
    let rowsWithBlend = 0;
    let worstRow = null;
    for (let y = 0; y < sh; y++) {
      let firstX = -1;
      for (let x = 0; x < sw; x++) {
        if (!isBg(px(x, y))) { firstX = x; break; }
      }
      // firstX <= 0 → the row is at or past the tangent point (edge is flush
      // with x=0), so it is not part of the arc. -1 → fully background.
      if (firstX <= 0 || firstX + 3 >= sw) continue;
      rowsCrossingArc++;
      const edge = lum(px(firstX, y));
      const inside = lum(px(firstX + 3, y));
      // Strictly intermediate: darker than the background, lighter than the
      // solid interior. Equality at either end means no partial coverage.
      if (edge < 255 && edge > inside) rowsWithBlend++;
      else if (worstRow === null) worstRow = y;
    }
    // Per-row horizontal inset profile down the arc, and the largest jump
    // between consecutive rows. Antialiasing cannot rescue a big step.
    const insets = [];
    for (let y = 0; y < sh; y++) {
      let firstX = -1;
      for (let x = 0; x < sw; x++) { if (!isBg(px(x, y))) { firstX = x; break; } }
      if (firstX > 0) insets.push(firstX);
    }
    let maxStep = 0;
    for (let i = 1; i < insets.length; i++) maxStep = Math.max(maxStep, Math.abs(insets[i - 1] - insets[i]));
    return { ...style, cornerPixel, centrePixel, rowsCrossingArc, rowsWithBlend, worstRow, insets, maxStep };
  };
  try {
    return {
      win32: await load('win32', 'win32', false, 'dark'),
      win32Max: await load('win32-max', 'win32', true, 'dark'),
      win32Light: await load('win32-light', 'win32', false, 'light'),
      win32LightMax: await load('win32-light-max', 'win32', true, 'light'),
      darwin: await load('darwin', 'darwin', false, 'dark'),
      linux: await load('linux', 'linux', false, 'dark'),
      win32OtherWindow: await load('win32-other', 'win32', false, 'dark', false),
      win32Splash: await load('win32-splash', 'win32', false, 'dark', true, true),
      win32Gap: await load('win32-gap', 'win32', false, 'dark', true, false, true),
      // Settings > Interface Opacity, slider held. emptyRoot is REQUIRED, not
      // incidental: the real preview hides #launcher-container, so leaving
      // #surface in would let the transparency assertion pass on a window that
      // is only see-through because the fixture happens to paint nothing there.
      win32Preview: await load('win32-preview', 'win32', false, 'dark', true, false, true, true),
      win32PreviewLight: await load('win32-preview-light', 'win32', false, 'light', true, false, true, true),
      linuxPreview: await load('linux-preview', 'linux', false, 'dark', true, false, true, true),
    };
  } finally {
    win.destroy();
    for (const f of written) rmSync(f, { force: true });
  }
}

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    const m = await measure();

    const inline = inlineMirror();
    check(
      inline?.radius === m.win32.radius,
      `index.html's early-paint mirror uses border-radius ${inline?.radius} but ` +
      `src/index.css uses ${m.win32.radius} — they must match, or the launcher ` +
      `visibly changes shape the moment the stylesheet loads`,
    );
    // The mirror's opaque #root backing needs the SAME opacity-preview guard as
    // the stylesheet's, and this is not belt-and-braces: the mirror's copy is
    // not `!important`, so it is precisely what wins once the stylesheet's
    // `!important` copy stops matching. Guard one and not the other and the
    // preview still paints black — the Electron assertions further down cannot
    // see this, because they only ever load src/index.css.
    check(
      (inline?.rootSelectors.length ?? 0) >= 2,
      `index.html's early-paint mirror has ${inline?.rootSelectors.length ?? 0} ` +
      `#root selector line(s); expected at least 2 (win32 + linux). The mirror ` +
      `was restructured — update this check rather than dropping it.`,
    );
    for (const sel of inline?.rootSelectors ?? []) {
      check(
        sel.includes(':not([data-opacity-preview="active"])'),
        `index.html's early-paint mirror paints #root unguarded ` +
        `(${sel.trim()}) — it is not !important, so it takes over the instant ` +
        `src/index.css's guarded copy stops matching, and the Interface Opacity ` +
        `preview shows black instead of the desktop`,
      );
    }
    check(
      m.win32.radius === '16px',
      `win32 restored body radius was ${m.win32.radius}, expected 16px`,
    );
    check(
      new Set(m.win32.allCorners).size === 1,
      `win32 restored corners were uneven: ${m.win32.allCorners.join(' / ')} ` +
      `(top-left / top-right / bottom-right / bottom-left) — all four must match`,
    );
    check(
      m.win32.cornerPixel === WHITE,
      `win32 restored top-left corner pixel was ${m.win32.cornerPixel}, expected ${WHITE} — ` +
      `the opaque surface is NOT being clipped to the radius, so the rounded ` +
      `corner is decorative and the window still reads as square`,
    );
    check(
      m.win32Max.cornerPixel !== WHITE,
      `win32 maximized top-left corner pixel was ${m.win32Max.cornerPixel} (page background) — ` +
      `a maximized window must paint its surface right into the corner, not clip it away`,
    );
    check(
      m.linux.radius === '16px',
      `linux restored body radius was ${m.linux.radius}, expected 16px (same branch as win32)`,
    );

    // The "dirty crop" guard. A hard stair-step has rowsWithBlend === 0.
    // Sanity floor so the assertion below can't pass vacuously on a corner too
    // small to measure. 5 is calibrated for the squircle: its curve approaches
    // the straight edges much flatter than a circular arc, so far fewer rows
    // have a measurable horizontal inset (7 here at 16px / dpr 1.25, versus
    // ~11 for the equivalent circular arc). Raising this without re-measuring
    // will fail on the shape it is meant to protect.
    check(
      m.win32.rowsCrossingArc >= 5,
      `only ${m.win32.rowsCrossingArc} scanlines crossed the arc — the corner is ` +
      `too small to measure, so the antialiasing assertion below proves nothing`,
    );
    check(
      m.win32.rowsWithBlend === m.win32.rowsCrossingArc,
      `${m.win32.rowsCrossingArc - m.win32.rowsWithBlend} of ${m.win32.rowsCrossingArc} ` +
      `scanlines across the corner arc have NO partial-coverage pixels (first at ` +
      `y=${m.win32.worstRow}) — the curve is being hard-clipped and will read as a ` +
      `jagged crop rather than a smooth corner`,
    );

    // A `position: fixed` full-screen overlay must be clipped to the curve too.
    // Its containing block is the viewport, not body, so `overflow: hidden`
    // alone does NOT clip it — the startup splash (StartupSequence.tsx, `fixed
    // inset-0` opaque) painted straight over the corners and squared the window
    // for the whole boot animation. `contain: paint` on body is what makes body
    // a containing block for fixed descendants and clips them to the radius.
    check(
      m.win32Splash.cornerPixel === WHITE,
      `with a fixed-position full-screen overlay mounted, the corner pixel was ` +
      `${m.win32Splash.cornerPixel} instead of ${WHITE} — the overlay is escaping ` +
      `the window clip and squaring off the corners (this is what happens to the ` +
      `startup splash without \`contain: paint\` on body)`,
    );
    check(
      m.win32Splash.rowsWithBlend === m.win32Splash.rowsCrossingArc &&
        m.win32Splash.rowsCrossingArc >= 5,
      `fixed-overlay corner AA was ${m.win32Splash.rowsWithBlend}/` +
      `${m.win32Splash.rowsCrossingArc} scanlines — the overlay must be clipped ` +
      `with the same antialiased curve as the base surface, not a hard edge`,
    );

    // THE GAP between the startup splash unmounting and the launcher mounting.
    // #root is empty here, so nothing in the app is painting. That instant used
    // to be filled by the BrowserWindow's opaque black native background; once
    // that had to go transparent for the corners, the gap became a see-through
    // hole onto the desktop (reported as "startup sequence -> transparent
    // screen -> launcher" instead of "-> black screen ->"). The opaque #root
    // backing restores it, and must do so WITHOUT refilling the corners.
    check(
      m.win32Gap.centrePixel === 'rgb(0, 0, 0)',
      `with #root empty (the splash-to-launcher gap) the window interior was ` +
      `${m.win32Gap.centrePixel}, expected opaque black — the window is ` +
      `see-through during that beat and the desktop shows through`,
    );
    check(
      m.win32Gap.cornerPixel === WHITE,
      `the opaque #root backing leaked into the corner (${m.win32Gap.cornerPixel} ` +
      `instead of ${WHITE}) — it must be clipped by the radius, not painted over ` +
      `it. The classic cause is putting this background on BODY: a body background ` +
      `propagates to the canvas and ignores border-radius (paint containment ` +
      `currently suppresses that, which is why #root is used instead of relying on it).`,
    );

    // THE INTERFACE-OPACITY PREVIEW — the one moment the launcher window is
    // SUPPOSED to be see-through. Holding the Settings > Interface Opacity
    // slider hides every DOM layer and strips the native backgroundColor
    // (WindowHelper.setLauncherOpacityPreview) so the desktop shows behind the
    // mockup. The opaque #root backing asserted just above sits between those
    // two and is reached by neither, so it has to be switched off by selector —
    // and this is the assertion that catches it coming back. It regressed
    // exactly once already, when the backing was introduced for the corners.
    for (const [name, m2] of [
      ['win32 dark', m.win32Preview],
      ['win32 light', m.win32PreviewLight],
      ['linux dark', m.linuxPreview],
    ]) {
      check(
        m2.centrePixel === WHITE,
        `${name}: with data-opacity-preview="active" the window interior was ` +
        `${m2.centrePixel}, expected ${WHITE} (see-through) — the opaque #root ` +
        `backing is surviving the Interface Opacity preview, so holding the ` +
        `slider shows a black rectangle instead of the desktop behind the mockup`,
      );
      // The ring paints whether or not anything is behind it, so during a
      // see-through preview it hangs a 1px rounded rectangle in mid-air.
      check(
        m2.ringShadow === 'none',
        `${name}: the hairline ring was "${m2.ringShadow}" during the opacity ` +
        `preview — it frames the launcher's opaque surface, and with that ` +
        `surface suppressed it outlines nothing but the desktop`,
      );
    }

    // Hairline ring on body::after. At 16px the arc is wide enough that a bare
    // opaque fill reads soft against a busy desktop, so the ring is part of
    // making the radius work — but it is theme-dependent and its rules share
    // specificity with the maximized override, so which one wins is decided by
    // the cascade. That is exactly the kind of thing to pin in an engine.
    check(
      /rgba?\(/.test(m.win32.ringShadow) && m.win32.ringShadow !== 'none',
      `dark theme ring was "${m.win32.ringShadow}" — expected an inset hairline`,
    );
    check(
      m.win32Light.ringShadow !== 'none' && m.win32Light.ringShadow !== m.win32.ringShadow,
      `light theme ring was "${m.win32Light.ringShadow}", same as dark — the ` +
      `light override is not winning the cascade, so light gets the dark-theme ` +
      `pair and the edge reads as a grimy outline on a pale surface`,
    );
    check(
      m.win32Max.ringShadow === 'none',
      `maximized ring was "${m.win32Max.ringShadow}", expected none — a 1px ` +
      `outline around the whole display is framing nothing`,
    );
    check(
      m.win32LightMax.ringShadow === 'none',
      `light + maximized ring was "${m.win32LightMax.ringShadow}", expected none — ` +
      `the maximized override and the light override have equal specificity, so ` +
      `this only holds while the maximized rule stays last in source order`,
    );
    check(
      m.darwin.ringShadow === 'none',
      `darwin picked up a ring ("${m.darwin.ringShadow}") — macOS draws its own ` +
      `native window edge and must not get the DOM hairline`,
    );
    // The ring must be LAUNCHER-scoped, not merely platform-scoped. Every other
    // win32 renderer (settings, model selector, cropper, overlay, aux panels)
    // is a transparent window painting its own rounded panel inside a
    // see-through body. A radius there is inert — but a box-shadow paints
    // regardless, so an unscoped ring outlines those windows' full rects as a
    // ghost rectangle on the desktop.
    check(
      m.win32OtherWindow.ringShadow === 'none',
      `a non-launcher win32 window picked up the ring ("${m.win32OtherWindow.ringShadow}") — ` +
      `it would paint a 1px rounded outline around the whole window rect of the ` +
      `settings/overlay/cropper windows, which are transparent and have no such edge`,
    );

    // NOTE: `corner-shape: squircle` is deliberately NOT used here. It was
    // measured to concentrate curvature and step up to 4px per scanline near
    // the tangents, which reads as a jagged corner beside perfectly crisp
    // straight edges. The per-row step assertion below is what guards that.
    check(
      m.win32.maxStep <= 3,
      `the corner advances up to ${m.win32.maxStep}px in a single scanline ` +
      `(profile: ${m.win32.insets.join(' ')}) — steps that large read as a ` +
      `jagged corner no matter how well antialiased each pixel is`,
    );

    if (failures.length) {
      console.error('✗ launcher-corner-radius check FAILED');
      for (const f of failures) console.error('  · ' + f);
      app.exit(1);
      return;
    }
    console.log(
      `✓ launcher-corner-radius check passed (win32=${m.win32.radius} ${m.win32.cornerShape}, ` +
      `win32-maximized=${m.win32Max.radius}, linux=${m.linux.radius}, darwin=${m.darwin.radius}, ` +
      `AA=${m.win32.rowsWithBlend}/${m.win32.rowsCrossingArc} arc scanlines antialiased, max step=${m.win32.maxStep}px, ` +
      `Electron ${process.versions.electron} / Chrome ${process.versions.chrome})`,
    );
    app.exit(0);
  } catch (err) {
    console.error('✗ launcher-corner-radius check ERRORED:', err.message);
    app.exit(1);
  }
});
