/**
 * test-deepgram-v3.js
 *
 * Mimics DeepgramStreamingSTT.ts class behaviour EXACTLY:
 *   - buffer chunks during handshake (~500ms)
 *   - flush entire buffer on 'open'
 *   - keep sending at 48kHz rate after open
 *   - send KeepAlive JSON every 1000ms
 *   - generation counter logic
 *   - reconnect on 1006
 *
 * Also tests whether ws.send() errors are silent.
 */
const WebSocket = require('ws');

const API_KEY = process.env.DEEPGRAM_KEY || 'e441b7391d536fad12ef91e4c6c93735111a665b';
const SAMPLE_RATE = 48000;
const CHUNK_BYTES = 1920; // 48kHz × 16-bit × 1ch × 20ms
const CHUNK_INTERVAL_MS = 20;
const KEEPALIVE_INTERVAL_MS = 1000;

function makeUrl() {
  return (
    `wss://api.deepgram.com/v1/listen` +
    `?model=nova-3` +
    `&encoding=linear16` +
    `&sample_rate=${SAMPLE_RATE}` +
    `&channels=1` +
    `&language=en` +
    `&smart_format=true` +
    `&interim_results=true` +
    `&keepalive=true`
  );
}

class DeepgramLikeTester {
  constructor(label) {
    this.label = label;
    this.ws = null;
    this.isActive = false;
    this.shouldReconnect = false;
    this.isConnecting = false;
    this.connectionGen = 0;
    this.buffer = [];
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.keepAliveTimer = null;
    this.audioTimer = null;
    this.chunksSent = 0;
    this.sendErrors = 0;
    this.closeCodes = [];
    this.startTime = Date.now();
  }

  log(msg) {
    const ms = Date.now() - this.startTime;
    console.log(`[${this.label}][+${ms}ms] ${msg}`);
  }

  start() {
    if (this.isActive) return;
    this.isActive = true;
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    this.connect();
  }

  stop() {
    this.shouldReconnect = false;
    this.clearTimers();
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'CloseStream' }));
        }
      } catch {}
      this.ws.close();
      this.ws = null;
    }
    this.isActive = false;
    this.isConnecting = false;
    this.buffer = [];
    this.log('Stopped');
  }

  write(chunk) {
    if (!this.isActive) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.buffer.push(chunk);
      if (this.buffer.length > 500) this.buffer.shift();
      const alreadyConnecting = this.isConnecting ||
        (this.ws !== null && this.ws.readyState === WebSocket.CONNECTING);
      if (!alreadyConnecting && this.shouldReconnect && !this.reconnectTimer) {
        this.connect();
      }
      return;
    }
    this.ws.send(chunk, { binary: true }, (err) => {
      if (err) {
        this.sendErrors++;
        this.log(`SEND ERROR #${this.sendErrors}: ${err.message}`);
      }
    });
    this.chunksSent++;
  }

  connect() {
    if (this.isConnecting) return;
    this.isConnecting = true;
    const gen = ++this.connectionGen;
    const url = makeUrl();
    this.log(`Connecting gen=${gen}...`);

    const ws = new WebSocket(url, {
      headers: { Authorization: `Token ${API_KEY}` },
    });
    this.ws = ws;

    ws.on('open', () => {
      if (gen !== this.connectionGen) { this.log(`stale open gen=${gen}`); ws.close(); return; }
      this.isActive = true;
      this.isConnecting = false;
      this.reconnectAttempts = 0;
      this.log(`Connected gen=${gen}, buffered=${this.buffer.length} chunks`);

      // Flush buffer
      let flushed = 0;
      while (this.buffer.length > 0) {
        const chunk = this.buffer.shift();
        if (chunk && ws.readyState === WebSocket.OPEN) {
          ws.send(chunk, { binary: true }, (err) => {
            if (err) { this.sendErrors++; this.log(`FLUSH SEND ERROR: ${err.message}`); }
          });
          flushed++;
        }
      }
      if (flushed > 0) this.log(`Flushed ${flushed} buffered chunks`);

      // Start keepalive
      this.clearKeepAlive();
      this.keepAliveTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'KeepAlive' }));
        }
      }, KEEPALIVE_INTERVAL_MS);
    });

    ws.on('message', (data) => {
      if (gen !== this.connectionGen) return;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'Results') {
          const t = msg.channel?.alternatives?.[0]?.transcript;
          if (t) this.log(`transcript: "${t}"`);
        } else if (msg.type !== 'Metadata' && msg.type !== 'SpeechStarted' && msg.type !== 'UtteranceEnd') {
          this.log(`NON-RESULTS msg type=${msg.type}: ${JSON.stringify(msg).substring(0, 200)}`);
        }
      } catch {}
    });

    ws.on('error', (err) => {
      if (gen !== this.connectionGen) return;
      if (err.message === 'WebSocket was closed before the connection was established') return;
      this.log(`WS ERROR: ${err.message}`);
    });

    ws.on('close', (code, reason) => {
      if (gen !== this.connectionGen) { this.log(`stale close gen=${gen} code=${code}`); return; }
      this.isConnecting = false;
      this.clearKeepAlive();
      const reasonStr = reason?.length > 0 ? reason.toString() : '(empty)';
      this.closeCodes.push(code);
      this.log(`CLOSED gen=${gen} code=${code} reason="${reasonStr}" sendErrors=${this.sendErrors}`);
      if (this.shouldReconnect && code !== 1000) {
        this.scheduleReconnect();
      }
    });
  }

  scheduleReconnect() {
    if (!this.shouldReconnect) return;
    if (this.reconnectAttempts >= 3) {
      this.log('Max reconnect attempts reached, giving up');
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 8000);
    this.reconnectAttempts++;
    this.log(`Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts}/3)`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) this.connect();
    }, delay);
  }

  clearKeepAlive() {
    if (this.keepAliveTimer) { clearInterval(this.keepAliveTimer); this.keepAliveTimer = null; }
  }

  clearTimers() {
    this.clearKeepAlive();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  startAudio(sparseMode = false) {
    const chunk = Buffer.alloc(CHUNK_BYTES, 0);
    let tick = 0;
    this.audioTimer = setInterval(() => {
      tick++;
      if (!sparseMode || tick % 10 === 0) {
        this.write(chunk);
      }
    }, CHUNK_INTERVAL_MS);
  }

  stopAudio() {
    if (this.audioTimer) { clearInterval(this.audioTimer); this.audioTimer = null; }
  }

  report() {
    this.log(`REPORT: chunks=${this.chunksSent} sendErrors=${this.sendErrors} closeCodes=[${this.closeCodes.join(',')}]`);
  }
}

async function runTest(label, sparseMode, durationMs) {
  return new Promise((resolve) => {
    const t = new DeepgramLikeTester(label);
    t.start();
    t.startAudio(sparseMode);
    setTimeout(() => {
      t.stopAudio();
      t.stop();
      t.report();
      setTimeout(resolve, 500); // brief pause between tests
    }, durationMs);
  });
}

async function main() {
  console.log(`\nAPI key prefix: ${API_KEY.substring(0, 8)}...\n`);

  // Test 1: Single instance, continuous 48kHz
  console.log('\n══ TEST 1: Single instance, continuous 48kHz (10s) ══');
  await runTest('single-continuous', false, 10000);

  // Test 2: Single instance, sparse 48kHz (SilenceSuppressor sim)
  console.log('\n══ TEST 2: Single instance, SPARSE 48kHz (10s) ══');
  await runTest('single-sparse', true, 10000);

  // Test 3: TWO instances simultaneously (exact app scenario)
  console.log('\n══ TEST 3: TWO INSTANCES simultaneously (10s) ══');
  const t3a = new DeepgramLikeTester('dual-A');
  const t3b = new DeepgramLikeTester('dual-B');
  t3a.start(); t3a.startAudio(true);
  t3b.start(); t3b.startAudio(false);
  await new Promise(r => setTimeout(r, 10000));
  t3a.stopAudio(); t3b.stopAudio();
  t3a.stop(); t3b.stop();
  t3a.report(); t3b.report();
  await new Promise(r => setTimeout(r, 500));

  // Test 4: Simulate the exact startup sequence:
  //   setSampleRate(48000) called before start()
  //   then audio starts flowing immediately
  console.log('\n══ TEST 4: setSampleRate-before-start sequence (10s) ══');
  {
    const t = new DeepgramLikeTester('startup-seq');
    // Simulate: setSampleRate is called, then start, then audio immediately
    // In the real app, audio starts flowing BEFORE the WS is open
    // so chunks go into the buffer
    const chunk = Buffer.alloc(CHUNK_BYTES, 0);
    // Simulate pre-start audio (should be dropped since !isActive)
    for (let i = 0; i < 5; i++) t.write(chunk);
    t.start();
    // Immediately start sending audio (goes to buffer during handshake)
    t.startAudio(false);
    await new Promise(r => setTimeout(r, 10000));
    t.stopAudio(); t.stop(); t.report();
  }

  console.log('\n══ All tests complete ══');
}

main().catch(console.error);
