/**
 * test-deepgram-v4.js
 *
 * Tests the EXACT failure scenario:
 *   - Zero audio after connect (SilenceSuppressor fully suppressing)
 *   - Empty buffer at connect time
 *   - Measures how quickly Deepgram drops connection without audio
 *   - Tests whether keepalive=true URL param and KeepAlive JSON prevent this
 */
const WebSocket = require('ws');
const API_KEY = process.env.DEEPGRAM_KEY || 'e441b7391d536fad12ef91e4c6c93735111a665b';

function conn(label, url, opts = {}) {
  const { sendKeepaliveJson = false, keepaliveMs = 1000, sendNoAudio = true, firstAudioDelayMs = 0 } = opts;
  return new Promise((resolve) => {
    const t0 = Date.now();
    const ws = new WebSocket(url, { headers: { Authorization: `Token ${API_KEY}` } });
    let timer = null;
    let openedAt = null;
    let closedAt = null;

    ws.on('open', () => {
      openedAt = Date.now() - t0;
      console.log(`[${label}] open at +${openedAt}ms`);

      if (sendKeepaliveJson) {
        timer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'KeepAlive' }));
            console.log(`[${label}] KeepAlive sent at +${Date.now()-t0}ms`);
          }
        }, keepaliveMs);
      }

      if (!sendNoAudio && firstAudioDelayMs > 0) {
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            const chunk = Buffer.alloc(1920, 0);
            ws.send(chunk, { binary: true });
            console.log(`[${label}] first audio sent at +${Date.now()-t0}ms`);
          }
        }, firstAudioDelayMs);
      }
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type !== 'Results' && msg.type !== 'Metadata') {
          console.log(`[${label}] msg type=${msg.type}: ${JSON.stringify(msg).substring(0,150)}`);
        }
      } catch {}
    });

    ws.on('error', (e) => console.log(`[${label}] error: ${e.message}`));

    ws.on('close', (code, reason) => {
      clearInterval(timer);
      closedAt = Date.now() - t0;
      const openDur = openedAt !== null ? closedAt - openedAt : 'never opened';
      console.log(`[${label}] CLOSED code=${code} reason="${reason?.length ? reason.toString() : '(empty)'}" total=+${closedAt}ms openDur=${openDur}ms`);
      resolve({ label, code, openedAt, closedAt, openDuration: closedAt - (openedAt || closedAt) });
    });

    // Force close after 12 seconds if still open
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        console.log(`[${label}] still alive after 12s — closing`);
        ws.close();
      }
    }, 12000);
  });
}

const BASE = (ka) => `wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=48000&channels=1&language=en&smart_format=true&interim_results=true${ka ? '&keepalive=true' : ''}`;

async function main() {
  // Test A: No audio at all, no keepalive JSON, no keepalive URL param
  // → how long before Deepgram drops?
  console.log('\n── A: No audio, no keepalive URL, no KeepAlive JSON ──');
  await conn('A-nothing', BASE(false), { sendNoAudio: true, sendKeepaliveJson: false });

  // Test B: No audio, with keepalive=true URL param, no JSON
  console.log('\n── B: No audio, keepalive=true URL, no KeepAlive JSON ──');
  await conn('B-urlparam', BASE(true), { sendNoAudio: true, sendKeepaliveJson: false });

  // Test C: No audio, no keepalive URL, with KeepAlive JSON every 1s
  console.log('\n── C: No audio, no keepalive URL, KeepAlive JSON every 1s ──');
  await conn('C-json1s', BASE(false), { sendNoAudio: true, sendKeepaliveJson: true, keepaliveMs: 1000 });

  // Test D: No audio, keepalive=true URL, KeepAlive JSON every 1s (CURRENT CONFIG)
  console.log('\n── D: No audio, keepalive=true URL + KeepAlive JSON every 1s (current config) ──');
  await conn('D-both', BASE(true), { sendNoAudio: true, sendKeepaliveJson: true, keepaliveMs: 1000 });

  // Test E: No audio, keepalive=true URL, KeepAlive JSON every 500ms
  console.log('\n── E: No audio, keepalive=true URL + KeepAlive JSON every 500ms ──');
  await conn('E-fast', BASE(true), { sendNoAudio: true, sendKeepaliveJson: true, keepaliveMs: 500 });

  // Test F: 500ms delay before first audio (simulates SilenceSuppressor startup)
  console.log('\n── F: keepalive=true URL, first audio at 500ms ──');
  await conn('F-delay500', BASE(true), { sendNoAudio: false, firstAudioDelayMs: 500, sendKeepaliveJson: true, keepaliveMs: 1000 });

  console.log('\n══ Done ══');
}

main().catch(console.error);
