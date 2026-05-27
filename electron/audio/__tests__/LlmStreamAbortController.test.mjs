// Regression test for: LLM chat-stream AbortController plumbing.
//
// Bug: When stream A was superseded by stream B, the IPC handler's for-await
// loop bailed out via the `_chatStreamId !== myStreamId` check — but
// LLMHelper.streamChat's generator kept yielding tokens that were silently
// discarded. The producer (provider HTTP call) kept running until its own
// per-call timeout (~60s for Gemini Pro), wasting quota and delaying the
// first token of the superseding question.
//
// Fix:
//   1. LLMHelper.streamChat extracts the trailing arg as an AbortSignal and
//      gates each yield with `if (abortSignal?.aborted) return;` BEFORE
//      yielding the post-processed chunk.
//   2. ipcHandlers' gemini-chat-stream creates a fresh AbortController per
//      invocation, aborts the prior one on supersession, and passes the new
//      signal to llmHelper.streamChat as the trailing variadic arg.
//   3. A new `ipcMain.on('gemini-chat-stream-stop', ...)` handler aborts the
//      active controller so the renderer can cancel explicitly.
//   4. preload.ts exposes `cancelChatStream` mapped to
//      `ipcRenderer.send('gemini-chat-stream-stop')`; the binding is typed
//      in src/types/electron.d.ts.
//
// Strategy: source-level static assertions. Driving the real streamChat
// generator would pull in the entire LLMHelper module (Gemini SDK, Groq,
// OpenAI, Claude, Natively, RAG, knowledge orchestrator, mode loader,
// post-processor, …) which is impractical for a fast unit test. The static
// checks below catch any regression where the abort-gate, controller
// supersession, stop handler, or preload binding is removed or weakened —
// which is exactly the failure mode this fix prevents.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const llmHelperPath = path.join(repoRoot, 'electron/LLMHelper.ts');
const ipcHandlersPath = path.join(repoRoot, 'electron/ipcHandlers.ts');
const preloadPath = path.join(repoRoot, 'electron/preload.ts');
const electronDtsPath = path.join(repoRoot, 'src/types/electron.d.ts');

const llmHelperSrc = readFileSync(llmHelperPath, 'utf8');
const ipcHandlersSrc = readFileSync(ipcHandlersPath, 'utf8');
const preloadSrc = readFileSync(preloadPath, 'utf8');
const electronDtsSrc = readFileSync(electronDtsPath, 'utf8');

// Brace-balancing body extractor (mirrors the helper in
// MicRecoveryUsesCanonicalWiring.test.mjs). Extracts the body of the first
// method matching `signatureRe` so assertions only apply to that scope and
// don't get false-positive matches from unrelated callsites elsewhere in
// the (47k-line) file.
function extractBalancedBody(src, signatureRe, label) {
    const m = signatureRe.exec(src);
    assert.ok(m, `could not locate ${label} signature`);
    // Find the first '{' at or after the match end (handles multi-line sigs).
    let i = src.indexOf('{', m.index + m[0].length);
    assert.ok(i >= 0, `could not find opening brace for ${label}`);
    i++;
    const start = i;
    let depth = 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    assert.equal(depth, 0, `unbalanced braces while extracting ${label}`);
    return src.slice(start, i - 1);
}

// ---------------------------------------------------------------------------
// LLMHelper.streamChat — the public generator that gates yields on abort.
// ---------------------------------------------------------------------------

const streamChatBody = extractBalancedBody(
    llmHelperSrc,
    /public\s+async\s*\*\s*streamChat\s*\(/,
    'LLMHelper.streamChat',
);

test('streamChat extracts trailing arg as AbortSignal via args[args.length - 1] and instanceof check', () => {
    // The exact extraction pattern: pull the last positional arg, narrow with
    // `instanceof AbortSignal`. Duck-typing on `.aborted` was the first
    // implementation; we tightened to `instanceof` because future params
    // (extraDataScopes, options objects) could accidentally have an `aborted`
    // shape and either crash on access or be misclassified as a never-aborted
    // signal.
    const hasLastArgLookup = /args\s*\[\s*args\.length\s*-\s*1\s*\]/.test(streamChatBody);
    const hasInstanceOfCheck = /instanceof\s+AbortSignal/.test(streamChatBody);
    assert.ok(
        hasLastArgLookup,
        'BUG: streamChat must extract the trailing positional arg via args[args.length - 1]. ' +
        'Without this, callers that pass an AbortSignal as the variadic trailing arg cannot ' +
        'cancel the generator, and supersession-discarded tokens keep streaming from the provider.',
    );
    assert.ok(
        hasInstanceOfCheck,
        'BUG: streamChat must narrow the trailing arg with `instanceof AbortSignal`. ' +
        'Without the instanceof check, a non-signal trailing arg (boolean / scope array / ' +
        'undefined) could either crash on .aborted access or be treated as a never-aborted signal.',
    );
});

test('streamChat declares an abortSignal local typed as AbortSignal', () => {
    // Sanity check: the extracted value must be bound to a local that the
    // for-await loop can reference.
    assert.ok(
        /const\s+abortSignal\s*=/.test(streamChatBody),
        'streamChat must bind the extracted signal to a const named abortSignal so the for-await loop can gate on it',
    );
    // The implementation either casts via `as AbortSignal` (duck-type variant)
    // or narrows via `instanceof AbortSignal` ternary (current implementation).
    // Either is acceptable for type safety — both pin the local to AbortSignal.
    const hasInstanceOf = /instanceof\s+AbortSignal/.test(streamChatBody);
    const hasAsCast = /as\s+AbortSignal/.test(streamChatBody);
    assert.ok(
        hasInstanceOf || hasAsCast,
        'streamChat must narrow the trailing arg as AbortSignal (instanceof or as-cast) for type safety',
    );
});

test('streamChat gates each yield with `if (abortSignal?.aborted) return;` BEFORE yielding', () => {
    // The fix's load-bearing line. The check MUST come before the yield;
    // gating *after* the yield would let one already-discarded token escape
    // each cancellation, which is exactly the silent-discard regression.
    const gatePattern = /if\s*\(\s*abortSignal\s*\?\.\s*aborted\s*\)\s*return\s*;?/;
    assert.ok(
        gatePattern.test(streamChatBody),
        'BUG: streamChat must contain `if (abortSignal?.aborted) return;` inside the for-await ' +
        'loop. Without this gate the generator keeps yielding tokens after cancellation, which ' +
        'is the exact silent-discard bug this fix addresses.',
    );

    // Enforce ordering: the abort check must appear before the `yield`
    // statement inside the loop body. Match the actual yield statement
    // (yield followed by an identifier/call expression) rather than the
    // substring "yield " which also appears in comments above the loop.
    const gateIdx = streamChatBody.search(gatePattern);
    const yieldStmtRe = /(^|\n)\s*yield\s+\w/;
    const yieldMatch = yieldStmtRe.exec(streamChatBody);
    assert.ok(gateIdx >= 0, 'abort gate not found');
    assert.ok(yieldMatch, 'yield statement not found in streamChat body');
    assert.ok(
        gateIdx < yieldMatch.index,
        'BUG: abort gate must come BEFORE the yield. Gating after the yield lets one token ' +
        'leak through per cancellation — the exact silent-discard regression we are guarding against.',
    );

    // And both must live inside a for-await loop over _streamChatInner.
    assert.ok(
        /for\s+await\s*\(\s*const\s+\w+\s+of\s+this\._streamChatInner\s*\(/.test(streamChatBody),
        'streamChat must iterate _streamChatInner via for-await; otherwise the abort gate has nothing to gate',
    );
});

// ---------------------------------------------------------------------------
// ipcHandlers — gemini-chat-stream creates a per-stream AbortController,
// aborts the prior one on supersession, and passes the signal to streamChat.
// Also: a new gemini-chat-stream-stop handler exists.
// ---------------------------------------------------------------------------

test('ipcHandlers declares a module-scoped _chatStreamController: AbortController | null', () => {
    // The supersession-abort + renderer-cancel paths both reach for this
    // shared handle. If it goes away (or is re-scoped per-call), supersession
    // can't abort the prior stream and the renderer's cancelChatStream is a
    // no-op.
    assert.ok(
        /let\s+_chatStreamController\s*:\s*AbortController\s*\|\s*null\s*=\s*null/.test(ipcHandlersSrc),
        'BUG: ipcHandlers must declare `let _chatStreamController: AbortController | null = null` at module scope. ' +
        'Both the supersession-abort path and the gemini-chat-stream-stop handler reach for this shared handle.',
    );
});

test('gemini-chat-stream handler aborts prior controller, creates a fresh one, and passes signal to streamChat', () => {
    // Find the safeHandle('gemini-chat-stream', ...) block and balance-extract
    // its async callback body. This is brittle to handler refactors but keeps
    // the assertions scoped — false positives from unrelated AbortController
    // usage in the same file (RAG queries, etc.) are otherwise impossible to
    // filter out.
    const handlerStart = ipcHandlersSrc.indexOf("'gemini-chat-stream'");
    assert.ok(handlerStart >= 0, "could not locate 'gemini-chat-stream' safeHandle registration");

    // Extract a generous window after the handler registration — enough to
    // cover the handler callback through its closing brace + the subsequent
    // gemini-chat-stream-stop registration.
    const handlerRegion = ipcHandlersSrc.slice(handlerStart, handlerStart + 12_000);

    // 1. Prior controller is aborted on supersession.
    assert.ok(
        /if\s*\(\s*_chatStreamController\s*\)\s*\{[^}]*_chatStreamController\.abort\s*\(\s*\)/.test(handlerRegion),
        'BUG: gemini-chat-stream handler must abort the prior _chatStreamController on entry. ' +
        'Without this, supersession only flips the stream-ID counter — the prior provider call ' +
        'keeps running and its tokens are silently discarded at the for-await guard.',
    );

    // 2. A fresh AbortController is constructed per invocation.
    assert.ok(
        /new\s+AbortController\s*\(\s*\)/.test(handlerRegion),
        'BUG: gemini-chat-stream handler must construct a fresh AbortController per invocation',
    );

    // 3. The fresh controller is assigned to the module-scoped handle so the
    //    stop handler (and the next supersession) can find it.
    assert.ok(
        /_chatStreamController\s*=\s*\w+/.test(handlerRegion),
        'BUG: gemini-chat-stream handler must assign the fresh controller to _chatStreamController ' +
        'so cancelChatStream / next-supersession can abort it',
    );

    // 4. The controller's signal is passed to llmHelper.streamChat. The
    //    streamChat wrapper expects it as the trailing variadic arg.
    assert.ok(
        /llmHelper\.streamChat\s*\([\s\S]*?\.signal\s*,?\s*\)/.test(handlerRegion),
        'BUG: gemini-chat-stream handler must pass the AbortController.signal to llmHelper.streamChat. ' +
        'Without this, streamChat has no signal to gate yields on and the producer keeps running.',
    );
});

test('gemini-chat-stream-stop handler is registered and aborts the active controller', () => {
    // ipcMain.on registration (renderer .send → main .on, not invoke/handle).
    const stopRegPattern = /ipcMain\.on\s*\(\s*['"]gemini-chat-stream-stop['"]\s*,/;
    assert.ok(
        stopRegPattern.test(ipcHandlersSrc),
        "BUG: ipcMain.on('gemini-chat-stream-stop', ...) must be registered so the renderer's " +
        'cancelChatStream can reach the main process. Without it, cancelChatStream is a silent no-op.',
    );

    // The handler body must abort the controller. Extract just the stop
    // handler body to scope the assertion.
    const stopHandlerBody = extractBalancedBody(
        ipcHandlersSrc,
        stopRegPattern,
        "gemini-chat-stream-stop handler",
    );
    assert.ok(
        /_chatStreamController\.abort\s*\(\s*\)/.test(stopHandlerBody),
        'BUG: gemini-chat-stream-stop handler must call _chatStreamController.abort(). ' +
        'Otherwise the renderer-initiated cancel does not actually stop the producer.',
    );
});

// ---------------------------------------------------------------------------
// preload.ts — cancelChatStream binding.
// ---------------------------------------------------------------------------

test('preload exposes cancelChatStream mapped to ipcRenderer.send("gemini-chat-stream-stop")', () => {
    // The binding must use .send (not .invoke) because the main-side handler
    // is registered with ipcMain.on, not ipcMain.handle / safeHandle.
    const cancelBindingPattern =
        /cancelChatStream\s*:\s*\(\s*\)\s*=>\s*\{[\s\S]*?ipcRenderer\.send\s*\(\s*['"]gemini-chat-stream-stop['"]\s*\)/;
    assert.ok(
        cancelBindingPattern.test(preloadSrc),
        "BUG: preload.ts must expose cancelChatStream as () => ipcRenderer.send('gemini-chat-stream-stop'). " +
        'Using ipcRenderer.invoke would deadlock the renderer (no main-side handle), and any other ' +
        'channel name would silently miss the gemini-chat-stream-stop handler.',
    );
});

test('preload ElectronAPI interface and src/types/electron.d.ts both type cancelChatStream', () => {
    // Type-level binding in the preload module's interface.
    assert.ok(
        /cancelChatStream\s*:\s*\(\s*\)\s*=>\s*void/.test(preloadSrc),
        'preload.ts ElectronAPI interface must declare `cancelChatStream: () => void`',
    );
    // And the renderer-facing type declaration. Without this, renderer
    // callers (e.g., chat-overlay unmount) get a type error and the
    // cancellation path is removed by the build, regressing the bug.
    assert.ok(
        /cancelChatStream\s*:\s*\(\s*\)\s*=>\s*void/.test(electronDtsSrc),
        'src/types/electron.d.ts must declare `cancelChatStream: () => void` so renderer code can call it type-safely',
    );
});
