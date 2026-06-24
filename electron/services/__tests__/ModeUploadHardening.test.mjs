// electron/services/__tests__/ModeUploadHardening.test.mjs
//
// Regression for FIX-009: modes:upload-reference-file used to fall through
// to fs.readFileSync(utf8) for any non-PDF/DOCX file, regardless of
// extension. Renamed binaries (e.g. secret.zip → secret.txt) were stored as
// mojibake-laden text and polluted every subsequent retrieval. Size and
// empty-result handling were also absent.
//
// We test the handler at the source level — same pattern as
// ModeBleeding.test.mjs and ProfileIntelligenceGate.test.mjs — because the
// safeHandle wrapper requires an Electron runtime to invoke directly.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { findSafeHandle, sliceSafeHandleBlock } from './ipcTestUtils.mjs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.resolve(__dirname, '../../ipcHandlers.ts'), 'utf8');
const BUILD_SCRIPT = fs.readFileSync(path.resolve(__dirname, '../../../scripts/build-electron.js'), 'utf8');

function handlerBody() {
  const start = findSafeHandle(SOURCE, 'modes:upload-reference-file');
  assert.ok(start >= 0, 'Upload handler must exist');
  return sliceSafeHandleBlock(SOURCE, 'modes:upload-reference-file');
}

describe('FIX-009: modes:upload-reference-file hardening', () => {
  const body = handlerBody();

  test('declares an explicit server-side ALLOWED_EXTENSIONS allow-list', () => {
    assert.ok(body.includes('ALLOWED_EXTENSIONS'), 'Allow-list must be declared');
    // Must include every supported format. Plain-text family (txt md markdown
    // json csv tsv xml html htm log) plus the parser-backed binary formats
    // (pdf docx). Note: legacy .doc is intentionally EXCLUDED — see the
    // dedicated "removes legacy .doc" test below.
    for (const ext of [
      '.txt',
      '.md',
      '.markdown',
      '.json',
      '.csv',
      '.tsv',
      '.xml',
      '.html',
      '.htm',
      '.log',
      '.pdf',
      '.docx',
    ]) {
      assert.ok(body.includes(`'${ext}'`), `Allow-list must contain ${ext}`);
    }
  });

  // Regression: legacy Word .doc (binary CFB format) used to be in the
  // allow-list. mammoth@1.x is a .docx-only parser and would throw `unzip`
  // errors on real .doc files, surfacing the misleading "PDF may be corrupt"
  // message. The handler now removes .doc from the allow-list entirely and
  // emits a dedicated "convert to .docx" error so users know the exact fix.
  test('removes legacy .doc from allow-list — mammoth cannot read CFB', () => {
    // The literal "'.doc'" entry must NOT appear in the ALLOWED_EXTENSIONS
    // Set. The .docx literal ('.docx') is fine — it's a different prefix.
    // We anchor on the comma-newline-whitespace pattern Set entries use.
    assert.ok(
      !/,\s*'\.doc'\s*,/.test(body) && !/'\.doc'\s*\]/.test(body) && !/'\.doc',/.test(body),
      "Legacy .doc must not appear in the ALLOWED_EXTENSIONS Set (mammoth only handles .docx)",
    );
    // The handler must still special-case .doc with a friendly error so
    // users who pick a .doc file via the "All Files" filter get an
    // actionable message instead of "unsupported file type".
    assert.ok(
      /Save As \.docx/.test(body) || /Save as \.docx/.test(body) || /convert.*\.docx/i.test(body),
      '.doc special-case error must instruct users to convert to .docx',
    );
    // The mammoth branch must only match .docx, not .doc — a guard
    // against future regressions that re-add .doc to the parser dispatch.
    assert.ok(
      /else if \(ext === '\.docx'\)/.test(body),
      'mammoth branch must match .docx only (not .doc)',
    );
    assert.ok(
      !/ext === '\.docx' \|\| ext === '\.doc'/.test(body),
      'mammoth branch must NOT also match .doc',
    );
  });

  // Regression: the dialog filter MUST stay in sync with the allow-list, or
  // users have to switch to "All Files" to pick any extension that's in the
  // allow-list but missing from the filter. Previously the filter listed 9
  // of the 12 allow-list entries — missing .markdown, .tsv, .log, .htm.
  test('dialog filter lists every allow-list extension', () => {
    // Find the showOpenDialog call and assert the filter covers all 12
    // extensions. Match the entire filter `extensions: [ ... ]` array.
    const filterMatch = body.match(/filters:\s*\[\s*\{[\s\S]*?extensions:\s*\[([\s\S]*?)\]/);
    assert.ok(filterMatch, 'showOpenDialog must declare a filter with an extensions array');
    const filterList = filterMatch[1];
    const required = [
      'txt',
      'md',
      'markdown',
      'json',
      'csv',
      'tsv',
      'xml',
      'html',
      'htm',
      'log',
      'pdf',
      'docx',
    ];
    for (const ext of required) {
      // Filter entries are bare strings (no leading dot), single-quoted.
      assert.ok(
        filterList.includes(`'${ext}'`),
        `Dialog filter must include '${ext}' (otherwise users have to switch to "All Files")`,
      );
    }
    // And the filter must NOT include 'doc' (legacy, removed).
    assert.ok(
      !/['"]doc['"]/.test(filterList),
      "Dialog filter must NOT include 'doc' (legacy, removed from allow-list)",
    );
  });

  test('declares a size cap (MAX_FILE_BYTES) and pre-flight checks lstat size + isFile', () => {
    assert.ok(body.includes('MAX_FILE_BYTES'), 'Size constant must be declared');
    // lstatSync (not statSync) — must NOT follow symlinks, otherwise a
    // symlink to /dev/zero hangs the renderer-IPC reply forever.
    assert.ok(body.includes('fs.lstatSync(filePath)'), 'Handler must lstat the file pre-parse (not statSync)');
    assert.ok(/stats\.isFile\(\)/.test(body), 'Handler must reject non-regular-files (symlinks, devices, fifos, directories)');
    assert.ok(/stats\.size\s*>\s*MAX_FILE_BYTES/.test(body), 'Handler must reject when stats.size exceeds the cap');
  });

  test('wraps PDF and DOCX parsers in a timeout to guard against malformed input / zip bombs', () => {
    assert.ok(body.includes('PARSE_TIMEOUT_MS'), 'Parse-timeout constant must be declared');
    assert.ok(body.includes('withTimeout'), 'Handler must define a withTimeout helper');
    assert.ok(/withTimeout[\s\S]{0,80}parser\.getText\(\)/.test(body), 'PDF parse must be wrapped in withTimeout');
    assert.ok(/withTimeout[\s\S]{0,120}mammoth\.extractRawText/.test(body), 'DOCX parse must be wrapped in withTimeout');
  });

  test('BOM-aware decoding for UTF-16 / UTF-8-BOM text files (no false-positive binary rejection)', () => {
    // UTF-16 LE BOM: 0xFF 0xFE → decode with utf16le, do NOT treat embedded
    // null bytes as a renamed-binary signal.
    assert.ok(/0xff.+0xfe/i.test(body), 'Handler must detect UTF-16 LE BOM');
    assert.ok(/0xfe.+0xff/i.test(body), 'Handler must detect UTF-16 BE BOM');
    assert.ok(/0xef[\s\S]{0,40}0xbb[\s\S]{0,40}0xbf/i.test(body), 'Handler must detect UTF-8 BOM');
    assert.ok(/utf16le/.test(body), 'Handler must decode UTF-16 with the utf16le codec');
  });

  test('rejects extensions not in the allow-list with a friendly user-facing message', () => {
    assert.ok(/Unsupported file type/.test(body), 'Friendly error message must be present');
    assert.ok(/Profile Intelligence/.test(body), 'Error must route resume/JD users to Profile Intelligence');
  });

  test('sniffs the first bytes for null-byte to detect renamed binaries on plain-text path', () => {
    // The sniff must read raw bytes (encoding null) and look for a zero byte
    // before utf8-decoding the rest of the buffer.
    assert.ok(/encoding:\s*null/.test(body), 'Plain-text path must read raw bytes');
    assert.ok(/sniffWindow\.includes\(0\)/.test(body) || /includes\(0\)/.test(body),
      'Plain-text path must check for null byte');
  });

  test('rejects parses that yield empty content (image-only PDFs, password-protected, corrupt)', () => {
    assert.ok(/parsed to empty text/.test(body) || /empty/.test(body),
      'Handler must reject empty-parse results');
  });

  test('does not leak raw error.message to the renderer on unexpected failures', () => {
    // The catch block must NOT return `error: e.message`. It must return a
    // generic string; the detail goes only to the main-process console.
    assert.ok(
      !/return\s*\{\s*success:\s*false,\s*error:\s*e\.message\s*\}/.test(body),
      'Handler must NOT echo raw e.message back to the renderer'
    );
    assert.ok(
      /console\.error\(.+modes:upload-reference-file/.test(body),
      'Handler must log the raw error in main-process console'
    );
  });

  test('still gates on Pro/trial before doing any work', () => {
    const gateIdx = body.indexOf('isProOrTrialActive()');
    const showDialogIdx = body.indexOf('showOpenDialog');
    assert.ok(gateIdx >= 0 && showDialogIdx >= 0);
    assert.ok(gateIdx < showDialogIdx, 'Pro gate must run before opening the file dialog');
  });

  // Regression for "modes:upload-reference-file" PDF-parse "Setting up fake
  // worker failed" error AND for the secondary "DOMMatrix is not defined"
  // throw at pdfjs-dist module-init time. pdf-parse@2.x wraps
  // pdfjs-dist@5.4.296's legacy build, which:
  //   (a) defaults GlobalWorkerOptions.workerSrc to
  //       `new URL("./pdf.worker.mjs", import.meta.url)` — broken under
  //       esbuild because import.meta.url resolves to the bundle path
  //       dist-electron/electron/main.js, where the worker file does not
  //       exist. The fallback fake-worker import then fails and the user
  //       sees the misleading "PDF may be corrupt / password-protected"
  //       message.
  //   (b) runs a `if (isNodeJS) { ... }` polyfill block at module-init
  //       that calls `createRequire(import.meta.url)` to load
  //       `@napi-rs/canvas`. esbuild's CJS bundle sets `import_meta = {}`,
  //       so createRequire(undefined) throws, the canvas polyfill never
  //       runs, and `new DOMMatrix()` later throws
  //       "DOMMatrix is not a constructor".
  //
  // We assert against the full SOURCE (not the handler slice) because the
  // pin lives in a module-scope helper (`pinPdfjsWorkerSrcOnce`) defined
  // outside the handler block — sliceSafeHandleBlock intentionally excludes
  // top-level declarations.
  test('PDF branch pins pdfjs-dist workerSrc before constructing PDFParse', () => {
    // 1. The source MUST mention pdfjs-dist (the underlying engine).
    assert.ok(
      SOURCE.includes("pdfjs-dist"),
      'Source must reference pdfjs-dist to pin workerSrc before PDFParse construction',
    );
    // 2. The pin MUST resolve the real worker file inside node_modules
    //    (not rely on the broken `new URL("./pdf.worker.mjs", ...)` default).
    assert.ok(
      /require\.resolve\(\s*['"]pdfjs-dist[^'"]*pdf\.worker[^'"]*['"]\s*\)/.test(SOURCE),
      'Pin must require.resolve the pdfjs-dist worker file (not the ./pdf.worker.mjs default)',
    );
    // 3. The pin must convert to a file:// URL via pathToFileURL — required
    //    because the legacy build feeds workerSrc to `new URL(...)` and then
    //    `import(...)`, both of which need an absolute file:// scheme.
    assert.ok(
      /pathToFileURL\(/.test(SOURCE),
      'Pin must convert the resolved worker path to a file:// URL via pathToFileURL',
    );
    // 4. The pin must be written to GlobalWorkerOptions.workerSrc — that's
    //    the option pdfjs-dist's PDFWorker class reads at runtime.
    assert.ok(
      /GlobalWorkerOptions\.workerSrc\s*=/.test(SOURCE),
      'Pin must assign to pdfjsLib.GlobalWorkerOptions.workerSrc',
    );
    // 5. The pin MUST be invoked BEFORE `new PDFParse(...)` is called inside
    //    the handler — otherwise the broken default workerSrc is already
    //    cached inside the bundled PDFWorker class and the fix is a no-op.
    //    The invocation is `pinPdfjsWorkerSrcOnce();` which appears in the
    //    handler body (within `body`). Match `new PDFParse(` followed by an
    //    argument — not the bare comment `// new PDFParse(...)`.
    const handlerPinIdx = body.indexOf('pinPdfjsWorkerSrcOnce()');
    const parseIdx = body.search(/new PDFParse\(\s*\{/);
    assert.ok(handlerPinIdx >= 0, 'Handler must call pinPdfjsWorkerSrcOnce()');
    assert.ok(parseIdx >= 0, 'Handler must still construct PDFParse');
    assert.ok(handlerPinIdx < parseIdx, 'pinPdfjsWorkerSrcOnce() call must come BEFORE new PDFParse(...)');
  });

  // The pin helper is a no-op if pdfjs-dist is bundled into main.js, because
  // esbuild's CJS bundle sets `import_meta = {}` and the bundled
  // canvas/DOMMatrix polyfill chain throws before GlobalWorkerOptions is even
  // reachable. Keeping pdfjs-dist + pdf-parse + mammoth as esbuild externals
  // means they load from real node_modules at runtime, where Node's ESM
  // loader provides a real import.meta.url and @napi-rs/canvas polyfills the
  // missing browser globals.
  test('build:externalizes pdfjs-dist, pdf-parse, mammoth so the pin can run', () => {
    const externalMatch = BUILD_SCRIPT.match(/external:\s*\[([\s\S]*?)\]/);
    assert.ok(externalMatch, 'build-electron.js must declare an external list');
    const externalList = externalMatch[1];
    for (const pkg of ['pdfjs-dist', 'pdf-parse', 'mammoth']) {
      // Match either single- or double-quoted strings containing the
      // package name. Allow both exact and prefix matches (e.g. "pdf-parse"
      // is fine, "pdf-parse/something" would also pass — but we only need
      // to assert the bare module name is listed).
      const re = new RegExp(`['"]${pkg.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}['"]`);
      assert.ok(
        re.test(externalList),
        `build-electron.js externals must include '${pkg}' — otherwise the pdfjs-dist module-init polyfill chain throws "DOMMatrix is not defined" and the workerSrc pin is a no-op`,
      );
    }
  });
});
