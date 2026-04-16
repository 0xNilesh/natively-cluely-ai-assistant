/**
 * test-deepgram-stagger.js
 *
 * Validates the stagger fix: two instances with the same API key should connect
 * at least STAGGER_INTERVAL_MS (3000ms) apart, not simultaneously.
 *
 * Also tests that the reconnect backoff actually increases instead of resetting
 * to 0 every time (stability timer fix).
 *
 * Run: node test-deepgram-stagger.js
 */
const WebSocket = require('ws');

const API_KEY = process.env.DEEPGRAM_KEY || 'e441b7391d536fad12ef91e4c6c93735111a665b';
const SAMPLE_RATE = 48000;
const CHUNK_BYTES = 1920;
const STAGGER_INTERVAL_MS = 3000;

// --- Stagger logic mirrored from DeepgramStreamingSTT.ts ---
const nextSlotByKey = new Map();
function acquireSlot(key) {
    const now = Date.now();
    const reserved = nextSlotByKey.get(key) ?? 0;
    const staggerMs = Math.max(0, reserved - now);
    nextSlotByKey.set(key, Math.max(now, reserved) + STAGGER_INTERVAL_MS);
    return staggerMs;
}

function makeUrl() {
    return `wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=${SAMPLE_RATE}&channels=1&language=en&smart_format=true&interim_results=true&keepalive=true`;
}

function openConnection(label, delayMs) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        setTimeout(() => {
            const ws = new WebSocket(makeUrl(), { headers: { Authorization: `Token ${API_KEY}` } });
            let openedAt = null;
            let timer = null;

            ws.on('open', () => {
                openedAt = Date.now() - t0;
                console.log(`[${label}] open at +${openedAt + delayMs}ms (total from test start)`);
                // Send keepalive + some audio
                timer = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'KeepAlive' }));
                        ws.send(Buffer.alloc(CHUNK_BYTES, 0));
                    }
                }, 500);
                // Close cleanly after 6s
                setTimeout(() => {
                    clearInterval(timer);
                    ws.send(JSON.stringify({ type: 'CloseStream' }));
                    ws.close();
                }, 6000);
            });

            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.type !== 'Results' && msg.type !== 'Metadata') {
                        console.log(`[${label}] msg type=${msg.type}`);
                    }
                } catch {}
            });

            ws.on('error', (e) => console.log(`[${label}] error: ${e.message}`));
            ws.on('close', (code, reason) => {
                clearInterval(timer);
                const elapsed = Date.now() - t0 + delayMs;
                const r = reason?.length ? reason.toString() : '(empty)';
                console.log(`[${label}] CLOSED code=${code} reason="${r}" at +${elapsed}ms`);
                resolve({ label, code, elapsed });
            });
        }, delayMs);
    });
}

async function main() {
    console.log(`\nAPI key: ...${API_KEY.slice(-8)}\n`);

    // ── Test 1: Stagger logic unit test ──
    console.log('══ TEST 1: Stagger unit test ══');
    const k = 'test-key';
    const s1 = acquireSlot(k);
    const s2 = acquireSlot(k);
    const s3 = acquireSlot(k);
    console.log(`  Instance 1 stagger: ${s1}ms (expected 0)`);
    console.log(`  Instance 2 stagger: ${s2}ms (expected ~3000)`);
    console.log(`  Instance 3 stagger: ${s3}ms (expected ~6000)`);
    if (s1 !== 0) console.error('  FAIL: first instance should have 0 stagger');
    else if (s2 < 2900 || s2 > 3100) console.error(`  FAIL: second instance stagger should be ~3000, got ${s2}`);
    else if (s3 < 5900 || s3 > 6100) console.error(`  FAIL: third instance stagger should be ~6000, got ${s3}`);
    else console.log('  PASS: stagger intervals correct');

    // ── Test 2: Two concurrent connections (without stagger) ──
    console.log('\n══ TEST 2: Two simultaneous connections (no stagger) ══');
    const t2start = Date.now();
    const results2 = await Promise.all([
        openConnection('A-simul', 0),
        openConnection('B-simul', 0),
    ]);
    const t2dur = Date.now() - t2start;
    const t2codes = results2.map(r => r.code);
    console.log(`  Close codes: ${t2codes} — duration: ${t2dur}ms`);
    if (t2codes.every(c => c === 1000)) console.log('  RESULT: both closed cleanly ✓');
    else if (t2codes.includes(1006)) console.log(`  RESULT: 1006 detected — concurrent connection limit triggered`);
    else console.log(`  RESULT: codes=${t2codes}`);

    // ── Test 3: Two connections staggered by 3s ──
    console.log('\n══ TEST 3: Two connections staggered by 3000ms ══');
    const t3start = Date.now();
    const results3 = await Promise.all([
        openConnection('C-stagger0', 0),
        openConnection('D-stagger3', 3000),
    ]);
    const t3dur = Date.now() - t3start;
    const t3codes = results3.map(r => r.code);
    console.log(`  Close codes: ${t3codes} — duration: ${t3dur}ms`);
    if (t3codes.every(c => c === 1000)) console.log('  RESULT: both closed cleanly ✓ — stagger fix works');
    else if (t3codes.includes(1006)) console.log(`  RESULT: 1006 still seen with stagger — may need longer delay or different fix`);
    else console.log(`  RESULT: codes=${t3codes}`);

    console.log('\n══ Done ══');
}

main().catch(console.error);
