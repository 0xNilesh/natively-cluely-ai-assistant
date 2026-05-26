import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Source for cheap protocol-string smoke checks (catches regressions before
// runtime — e.g. someone reintroduces 'OpenAI-Beta' or 'session.update').
const sourcePath = path.resolve(__dirname, '../../audio/OpenAIStreamingSTT.ts');
const source = fs.readFileSync(sourcePath, 'utf8');

// Compiled JS so behavioral tests exercise the same code path the app runs.
const compiledPath = path.resolve(__dirname, '../../../dist-electron/electron/audio/OpenAIStreamingSTT.js');
const { OpenAIStreamingSTT } = await import(pathToFileURL(compiledPath).href);

const WS_OPEN = 1; // ws.WebSocket.OPEN

function makeStubWs({ throwOnFirstSend = false, throwOnType = null } = {}) {
    const sent = [];
    let sendCallCount = 0;
    let listenerRemoveCalls = 0;
    let closeCalls = 0;
    return {
        readyState: WS_OPEN,
        sent,
        send(payload) {
            sendCallCount++;
            // throwOnType is type-match (preferred — robust to send-order refactors).
            // throwOnFirstSend is call-count fallback for legacy tests.
            let parsed = null;
            try { parsed = JSON.parse(payload); } catch { /* not JSON */ }
            if (throwOnType && parsed?.type === throwOnType) {
                throw new Error(`simulated ws.send failure on type=${throwOnType}`);
            }
            if (throwOnFirstSend && sendCallCount === 1) {
                throw new Error('simulated ws.send failure');
            }
            sent.push(parsed ?? { raw: payload });
        },
        on() {},
        removeAllListeners() { listenerRemoveCalls++; },
        close() { closeCalls++; this.readyState = 3; },
        get stats() { return { sendCallCount, listenerRemoveCalls, closeCalls }; },
    };
}

/** Construct an STT, force it into a “session ready / WS open” state for tests. */
function makeReadySTT({ stubWs, pcmSamples = 0 } = {}) {
    const stt = new OpenAIStreamingSTT('sk-test-key');
    stt.isActive = true;
    stt.shouldReconnect = false;
    stt.mode = 'ws';
    stt.isSessionReady = true;
    stt.ws = stubWs;
    if (pcmSamples > 0) {
        const chunk = new Int16Array(pcmSamples);
        for (let i = 0; i < pcmSamples; i++) chunk[i] = i % 1000;
        stt.pcmAccumulator = [chunk];
        stt.pcmAccumulatorLen = pcmSamples;
    } else {
        stt.pcmAccumulator = [];
        stt.pcmAccumulatorLen = 0;
    }
    return stt;
}

// ──────────────────────────────────────────────────────────────────────────
// Wire-format smoke checks (source-string assertions — fast, no runtime).
// ──────────────────────────────────────────────────────────────────────────

describe('wire format', () => {
    test('does not send OpenAI-Beta header (beta API removed)', () => {
        assert.doesNotMatch(source, /OpenAI-Beta/);
    });

    test('sends transcription_session.update not session.update', () => {
        assert.match(source, /type: 'transcription_session\.update'/);
        assert.doesNotMatch(source, /type: 'session\.update'/);
    });

    test('uses GA input_audio_format field not beta audio.input.format', () => {
        assert.match(source, /input_audio_format: 'pcm16'/);
        assert.doesNotMatch(source, /audio\.input\.format/);
    });

    test('handles GA transcript delta event name', () => {
        assert.match(source, /conversation\.item\.input_audio_transcription\.delta/);
        assert.doesNotMatch(source, /'transcript\.text\.delta'/);
    });

    test('handles GA transcript completed event name', () => {
        assert.match(source, /conversation\.item\.input_audio_transcription\.completed/);
        assert.doesNotMatch(source, /'transcript\.text\.done'/);
    });

    test('does not send beta session.close to server (transcription intent has no such client event)', () => {
        // The send() must never carry session.close. The string may still appear in
        // comments/log lines, so we only ban it inside JSON.stringify payloads.
        assert.doesNotMatch(
            source,
            /JSON\.stringify\(\s*\{\s*type:\s*'session\.close'\s*\}\s*\)/
        );
    });

    test('does not fall through session.created to transcription_session.created handler', () => {
        // The fallthrough has been replaced with a logged-and-ignored warning.
        // Require the case to exist (so a future rename/removal doesn't make
        // this assertion trivially pass) and require its body to NOT set
        // isSessionReady. Behavioral coverage of the same invariant lives in
        // the 'race / late-arrival safety' suite below.
        const block = source.match(
            /case 'session\.created':[\s\S]*?break;/
        );
        assert.ok(block, "expected case 'session.created': to still exist with a warning body");
        assert.doesNotMatch(block[0], /this\.isSessionReady\s*=\s*true/);
        assert.doesNotMatch(block[0], /_startKeepAlive|_flushRingBuffer/);
    });
});

// ──────────────────────────────────────────────────────────────────────────
// Behavioral tests (runtime — exercise compiled class with stub WebSocket).
// ──────────────────────────────────────────────────────────────────────────

describe('lifecycle — unconditional commit', () => {
    test('stop() commits even when pcmAccumulator is empty', () => {
        const ws = makeStubWs();
        const stt = makeReadySTT({ stubWs: ws, pcmSamples: 0 });
        stt.stop();
        const types = ws.sent.map(m => m.type);
        assert.ok(types.includes('input_audio_buffer.commit'),
            `expected commit in sent events, got ${JSON.stringify(types)}`);
        assert.ok(!types.includes('input_audio_buffer.append'),
            'should NOT append when accumulator empty');
    });

    test('finalize() commits even when pcmAccumulator is empty', () => {
        const ws = makeStubWs();
        const stt = makeReadySTT({ stubWs: ws, pcmSamples: 0 });
        stt.finalize();
        const types = ws.sent.map(m => m.type);
        assert.ok(types.includes('input_audio_buffer.commit'),
            `expected commit in sent events, got ${JSON.stringify(types)}`);
        assert.ok(!types.includes('input_audio_buffer.append'),
            'should NOT append when accumulator empty');
    });

    test('stop() appends THEN commits when pcmAccumulator has audio', () => {
        const ws = makeStubWs();
        const stt = makeReadySTT({ stubWs: ws, pcmSamples: 1200 });
        stt.stop();
        const types = ws.sent.map(m => m.type);
        const appendIdx = types.indexOf('input_audio_buffer.append');
        const commitIdx = types.indexOf('input_audio_buffer.commit');
        assert.notStrictEqual(appendIdx, -1, 'expected an append');
        assert.notStrictEqual(commitIdx, -1, 'expected a commit');
        assert.ok(appendIdx < commitIdx, 'append must precede commit');
    });

    test('finalize() appends THEN commits when pcmAccumulator has audio', () => {
        const ws = makeStubWs();
        const stt = makeReadySTT({ stubWs: ws, pcmSamples: 1200 });
        stt.finalize();
        const types = ws.sent.map(m => m.type);
        const appendIdx = types.indexOf('input_audio_buffer.append');
        const commitIdx = types.indexOf('input_audio_buffer.commit');
        assert.notStrictEqual(appendIdx, -1);
        assert.notStrictEqual(commitIdx, -1);
        assert.ok(appendIdx < commitIdx);
    });

    test('stop() commits even when append throws (data-loss prevention)', () => {
        // Throw on append by type, not call-count — robust to future send-order
        // refactors where the append is no longer the first send.
        const ws = makeStubWs({ throwOnType: 'input_audio_buffer.append' });
        const stt = makeReadySTT({ stubWs: ws, pcmSamples: 1200 });
        stt.stop();
        const types = ws.sent.map(m => m.type);
        assert.ok(types.includes('input_audio_buffer.commit'),
            'commit must fire even if append throws');
        assert.ok(!types.includes('input_audio_buffer.append'),
            'thrown append should not appear in sent log');
    });

    test('finalize() commits even when append throws', () => {
        const ws = makeStubWs({ throwOnType: 'input_audio_buffer.append' });
        const stt = makeReadySTT({ stubWs: ws, pcmSamples: 1200 });
        stt.finalize();
        const types = ws.sent.map(m => m.type);
        assert.ok(types.includes('input_audio_buffer.commit'),
            'commit must fire even if append throws');
        assert.ok(!types.includes('input_audio_buffer.append'));
    });
});

// ──────────────────────────────────────────────────────────────────────────
// Race / late-arrival safety (behavioral — closes test-engineer's HIGH 1
// and HIGH 3 ordering gaps).
// ──────────────────────────────────────────────────────────────────────────

describe('race / late-arrival safety', () => {
    test('inbound session.created (general-intent event) is inert on transcription session', () => {
        // HIGH 1 behavioral coverage: _handleWsMessage({type:'session.created'})
        // must NOT set isSessionReady, must NOT start a keep-alive, must NOT
        // flush the ring buffer. The session.created case body should be a
        // pure warn-and-ignore.
        const stt = new OpenAIStreamingSTT('sk-test-key');
        stt.isActive = true;
        stt.mode = 'ws';
        stt.isSessionReady = false;
        // Seed the ring buffer with a known marker so we can verify no flush.
        const marker = Buffer.alloc(1024);
        stt.ringBuffer = [marker];
        stt.ringBufferBytes = marker.length;

        stt._handleWsMessage({ type: 'session.created' });

        assert.strictEqual(stt.isSessionReady, false,
            'session.created on intent=transcription must not flip isSessionReady');
        assert.strictEqual(stt.keepAliveTimer, null,
            'session.created must not start keep-alive');
        assert.strictEqual(stt.ringBufferBytes, marker.length,
            'session.created must not flush the ring buffer');
        assert.strictEqual(stt.ringBuffer.length, 1);
    });

    test('inbound transcription_session.created DOES set isSessionReady (positive control)', () => {
        // Asymmetric pair: this proves the negative test above is meaningful.
        const stt = new OpenAIStreamingSTT('sk-test-key');
        stt.isActive = true;
        stt.mode = 'ws';
        stt.isSessionReady = false;

        stt._handleWsMessage({ type: 'transcription_session.created' });

        assert.strictEqual(stt.isSessionReady, true);
        assert.notStrictEqual(stt.keepAliveTimer, null,
            'transcription_session.created must start keep-alive');
        // Clean up the interval we just created so test process can exit.
        clearInterval(stt.keepAliveTimer);
        stt.keepAliveTimer = null;
    });

    test('late transcription_session.created arriving AFTER stop() is harmless', () => {
        // Production race: server is slow, stop() runs, then the 'created'
        // message lands. Currently it would still flip the flags — assert
        // explicitly so any future hardening can lock the behavior in.
        const ws = makeStubWs();
        const stt = makeReadySTT({ stubWs: ws, pcmSamples: 0 });
        // Simulate stop having torn down ws state.
        stt.stop();
        const sentCountAfterStop = ws.sent.length;

        // Now a late 'created' arrives. The handler will try to _flushRingBuffer
        // (which is empty — start state was reset) and _startKeepAlive (which
        // does start an interval; we'll clean it up). It must NOT throw and
        // must NOT push anything onto the (closed/null) ws.
        assert.doesNotThrow(() => {
            stt._handleWsMessage({ type: 'transcription_session.created' });
        });
        // The ws was nulled by stop() → _closeWs, so the late callback can't
        // have pushed anything new.
        assert.strictEqual(stt.ws, null,
            'ws must be null after stop()');
        assert.strictEqual(ws.sent.length, sentCountAfterStop,
            'no new sends to the prior socket after stop()');

        // Clean up the keep-alive interval the late handler created so the
        // test process can exit.
        if (stt.keepAliveTimer) clearInterval(stt.keepAliveTimer);
        stt.keepAliveTimer = null;
    });
});

describe('lifecycle — close behavior', () => {
    test('_closeWs() never sends session.close on the wire', () => {
        const ws = makeStubWs();
        const stt = makeReadySTT({ stubWs: ws, pcmSamples: 0 });
        // Both graceful (language change) and non-graceful (teardown) paths.
        stt._closeWs(true);
        const types = ws.sent.map(m => m.type);
        assert.ok(!types.includes('session.close'),
            'session.close is a beta/translation event, not GA transcription');
    });

    test('_closeWs(graceful=true) flushes pcm + commit before closing', () => {
        const ws = makeStubWs();
        const stt = makeReadySTT({ stubWs: ws, pcmSamples: 800 });
        stt._closeWs(true);
        const types = ws.sent.map(m => m.type);
        assert.ok(types.includes('input_audio_buffer.append'),
            'graceful close should flush pending pcm');
        assert.ok(types.includes('input_audio_buffer.commit'),
            'graceful close should commit before tearing down');
    });

    test('_closeWs() clears keepAliveTimer (no stale interval on reconnect)', () => {
        const ws = makeStubWs();
        const stt = makeReadySTT({ stubWs: ws, pcmSamples: 0 });
        // Simulate an active keep-alive timer left over from the prior session.
        stt.keepAliveTimer = setInterval(() => {}, 100_000);
        assert.notStrictEqual(stt.keepAliveTimer, null);
        stt._closeWs(false);
        assert.strictEqual(stt.keepAliveTimer, null,
            'keepAliveTimer must be cleared by _closeWs to prevent stale-socket sends after language change');
    });
});

describe('telemetry — ring buffer eviction', () => {
    test('emits warning event on first eviction; subsequent evictions stay silent', () => {
        const stt = new OpenAIStreamingSTT('sk-test-key');
        stt.isActive = true;
        stt.mode = 'ws';
        // No WS — write() will route to ring buffer.
        const warnings = [];
        stt.on('warning', (w) => warnings.push(w));

        // Cap is 5,760,000 bytes. Push more than that to force eviction.
        const big = Buffer.alloc(6_000_000);
        stt.write(big);
        // Second push of a big buffer should evict more — but only one warning total.
        const big2 = Buffer.alloc(1_000_000);
        stt.write(big2);

        assert.strictEqual(warnings.length, 1,
            'exactly one warning per session despite multiple evictions');
        assert.strictEqual(warnings[0].code, 'ring_buffer_eviction');
        assert.ok(warnings[0].droppedBytes > 0);
    });
});

describe('security — log scrubbing', () => {
    test('Bearer tokens in server error bodies are not propagated upstream', () => {
        const stt = new OpenAIStreamingSTT('sk-test-key');
        const errors = [];
        stt.on('error', (e) => errors.push(e));
        stt._handleWsMessage({
            type: 'error',
            error: { message: 'auth failed for Bearer sk-LIVE-ABCDEFG1234567890XYZ rejected' },
        });
        assert.strictEqual(errors.length, 1);
        assert.doesNotMatch(errors[0].message, /sk-LIVE-ABCDEFG/);
        assert.doesNotMatch(errors[0].message, /Bearer\s+sk-LIVE/);
        assert.match(errors[0].message, /REDACTED/);
    });
});
