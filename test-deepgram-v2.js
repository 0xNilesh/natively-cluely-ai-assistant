/**
 * Deepgram diagnostic test v2
 * Tests the exact scenario the app uses:
 *   - 48kHz sample rate (native capture rate)
 *   - Two concurrent connections (mic + system audio)
 *   - Sparse audio (simulates SilenceSuppressor behavior)
 *   - keepalive=true URL param
 *   - KeepAlive JSON every 1s
 *
 * Usage: node test-deepgram-v2.js
 */
const WebSocket = require('ws');

const API_KEY = process.env.DEEPGRAM_KEY || 'e441b7391d536fad12ef91e4c6c93735111a665b';

function makeUrl(sampleRate, lang, keepaliveParam) {
  return (
    `wss://api.deepgram.com/v1/listen` +
    `?model=nova-3` +
    `&encoding=linear16` +
    `&sample_rate=${sampleRate}` +
    `&channels=1` +
    `&language=${lang}` +
    `&smart_format=true` +
    `&interim_results=true` +
    (keepaliveParam ? `&keepalive=true` : '')
  );
}

/**
 * Open a connection, optionally send sparse audio (simulate SilenceSuppressor),
 * stay open for `durationMs`, report what happened.
 */
function testConn(label, url, opts = {}) {
  const {
    durationMs = 8000,
    audioChunkBytes = 1920,          // 48kHz × 20ms × 2 bytes
    audioIntervalMs = 20,             // 20ms = real-time 48kHz
    sparseMode = false,               // if true, send audio only 10% of the time (simulate SilenceSuppressor)
    sendKeepaliveJson = true,
    keepaliveIntervalMs = 1000,
    bufferFlushChunks = 5,            // simulate buffer flushed on open
  } = opts;

  return new Promise((resolve) => {
    const t0 = Date.now();
    let audioTimer = null;
    let keepaliveTimer = null;
    let connected = false;
    let chunksSent = 0;
    let result = { label, connected: false, closeCode: null, closeReason: '', durationMs: 0, chunksSent: 0, transcripts: 0 };

    const chunk = Buffer.alloc(audioChunkBytes, 0);
    console.log(`\n[${label}] Connecting: ${url.replace(/key=[^&]+/, 'key=...')}`);

    const ws = new WebSocket(url, { headers: { Authorization: `Token ${API_KEY}` } });

    const done = (code, reason) => {
      clearInterval(audioTimer);
      clearInterval(keepaliveTimer);
      result.closeCode = code;
      result.closeReason = reason;
      result.durationMs = Date.now() - t0;
      result.chunksSent = chunksSent;
      console.log(`[${label}] CLOSED code=${code} reason="${reason}" after ${result.durationMs}ms, chunks=${chunksSent}`);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      console.log(`[${label}] Test duration reached — closing cleanly`);
      ws.send(JSON.stringify({ type: 'CloseStream' }));
      ws.close();
    }, durationMs);

    ws.on('open', () => {
      connected = true;
      result.connected = true;
      console.log(`[${label}] Connected at ${Date.now() - t0}ms`);

      // Simulate buffer flush (audio buffered during handshake ~500ms)
      for (let i = 0; i < bufferFlushChunks; i++) {
        ws.send(chunk);
        chunksSent++;
      }

      // Audio streaming
      let tick = 0;
      audioTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        tick++;
        // Sparse mode: send only ~10% of chunks (SilenceSuppressor suppresses silence)
        if (!sparseMode || (tick % 10 === 0)) {
          ws.send(chunk);
          chunksSent++;
        }
      }, audioIntervalMs);

      // KeepAlive JSON
      if (sendKeepaliveJson) {
        keepaliveTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'KeepAlive' }));
          }
        }, keepaliveIntervalMs);
      }
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'Results') {
          result.transcripts++;
          if (result.transcripts <= 2) {
            console.log(`[${label}] transcript="${msg.channel?.alternatives?.[0]?.transcript ?? ''}"`);
          }
        } else {
          // Show non-Results messages (errors, metadata)
          console.log(`[${label}] msg type=${msg.type}: ${JSON.stringify(msg).substring(0, 150)}`);
        }
      } catch {}
    });

    ws.on('error', (err) => {
      console.log(`[${label}] ERROR: ${err.message}`);
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      done(code, reason?.length ? reason.toString() : '(empty)');
    });
  });
}

async function main() {
  console.log(`API key prefix: ${API_KEY.substring(0, 8)}...\n`);

  const BASE_16K  = makeUrl(16000, 'en', false);
  const BASE_48K  = makeUrl(48000, 'en', false);
  const BASE_48K_KA = makeUrl(48000, 'en', true);

  // ── Test 1: Baseline 16kHz continuous (should work — this is what passes) ──
  console.log('\n══ TEST 1: 16kHz continuous (baseline) ══');
  await testConn('16k-continuous', BASE_16K, { durationMs: 6000, sparseMode: false });

  // ── Test 2: 48kHz continuous ──
  console.log('\n══ TEST 2: 48kHz continuous ══');
  await testConn('48k-continuous', BASE_48K, { durationMs: 6000, sparseMode: false });

  // ── Test 3: 48kHz sparse (SilenceSuppressor simulation) ──
  console.log('\n══ TEST 3: 48kHz SPARSE (SilenceSuppressor sim) ══');
  await testConn('48k-sparse', BASE_48K, { durationMs: 6000, sparseMode: true });

  // ── Test 4: 48kHz sparse + keepalive=true URL param ──
  console.log('\n══ TEST 4: 48kHz SPARSE + keepalive=true URL ══');
  await testConn('48k-sparse-ka', BASE_48K_KA, { durationMs: 6000, sparseMode: true });

  // ── Test 5: TWO concurrent connections at 48kHz (mimics the app exactly) ──
  console.log('\n══ TEST 5: TWO CONCURRENT 48kHz connections (exact app scenario) ══');
  await Promise.all([
    testConn('concurrent-A', BASE_48K_KA, { durationMs: 8000, sparseMode: true }),
    testConn('concurrent-B', BASE_48K_KA, { durationMs: 8000, sparseMode: true }),
  ]);

  // ── Test 6: Two concurrent with NO keepalive URL param (current state before fix) ──
  console.log('\n══ TEST 6: TWO CONCURRENT 48kHz, NO keepalive URL param ══');
  await Promise.all([
    testConn('concurrent-nokp-A', BASE_48K, { durationMs: 8000, sparseMode: true }),
    testConn('concurrent-nokp-B', BASE_48K, { durationMs: 8000, sparseMode: true }),
  ]);

  console.log('\n══ All tests done ══');
}

main().catch(console.error);
