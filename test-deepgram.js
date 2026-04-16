/**
 * Deepgram API key + WebSocket connection tester.
 * Usage: DEEPGRAM_KEY=<your_key> node test-deepgram.js
 */
const https = require('https');
const WebSocket = require('ws');

const API_KEY = process.env.DEEPGRAM_KEY;
if (!API_KEY) {
  console.error('Usage: DEEPGRAM_KEY=<your_key> node test-deepgram.js');
  process.exit(1);
}

console.log(`Key length: ${API_KEY.length}, prefix: ${API_KEY.substring(0, 8)}...`);

// Step 1: Test REST API (validates key)
function testRestKey() {
  return new Promise((resolve) => {
    const req = https.get('https://api.deepgram.com/v1/projects', {
      headers: { Authorization: `Token ${API_KEY}` }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`\n[REST /v1/projects] Status: ${res.statusCode}`);
        if (res.statusCode === 200) {
          console.log('  ✓ API key is valid');
        } else {
          console.log(`  ✗ Response: ${data.substring(0, 200)}`);
        }
        resolve(res.statusCode);
      });
    });
    req.on('error', (e) => { console.error('[REST] Error:', e.message); resolve(0); });
  });
}

// Step 2: Test WebSocket with a specific model
function testWS(model) {
  return new Promise((resolve) => {
    const url = `wss://api.deepgram.com/v1/listen?model=${model}&encoding=linear16&sample_rate=16000&channels=1&language=en`;
    console.log(`\n[WS ${model}] Connecting to: ${url}`);
    const ws = new WebSocket(url, { headers: { Authorization: `Token ${API_KEY}` } });

    const timeout = setTimeout(() => {
      console.log(`[WS ${model}]  ✓ Connected (no 400)`);
      ws.close();
      resolve(true);
    }, 3000);

    ws.on('open', () => {
      clearTimeout(timeout);
      console.log(`[WS ${model}]  ✓ Connected successfully`);
      ws.close();
      resolve(true);
    });
    ws.on('error', (err) => {
      clearTimeout(timeout);
      console.log(`[WS ${model}]  ✗ Error: ${err.message}`);
      resolve(false);
    });
    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      if (code !== 1000 && code !== 1005) {
        console.log(`[WS ${model}]  Closed: code=${code} reason=${reason.toString()}`);
      }
    });
  });
}

// Step 3: Test with exact app URL parameters
function testWSExact(label, url) {
  return new Promise((resolve) => {
    console.log(`\n[WS ${label}] Connecting to: ${url}`);
    const ws = new WebSocket(url, { headers: { Authorization: `Token ${API_KEY}` } });

    const timeout = setTimeout(() => {
      console.log(`[WS ${label}]  ✓ Connected (no 400)`);
      ws.close();
      resolve(true);
    }, 3000);

    ws.on('open', () => {
      clearTimeout(timeout);
      console.log(`[WS ${label}]  ✓ Connected successfully`);
      ws.close();
      resolve(true);
    });
    ws.on('error', (err) => {
      clearTimeout(timeout);
      console.log(`[WS ${label}]  ✗ Error: ${err.message}`);
      resolve(false);
    });
    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      if (code !== 1000 && code !== 1005) {
        console.log(`[WS ${label}]  Closed: code=${code} reason=${reason.toString()}`);
      }
    });
  });
}

// Step 4: Test exact app URL and send real silent PCM audio
function testWSWithAudio(label, url) {
  return new Promise((resolve) => {
    console.log(`\n[WS ${label}] Connecting to: ${url}`);
    const ws = new WebSocket(url, { headers: { Authorization: `Token ${API_KEY}` } });
    let audioInterval = null;
    let connected = false;

    // 960 samples of silence at 16-bit PCM = 1920 bytes
    const silentChunk = Buffer.alloc(1920, 0);

    const timeout = setTimeout(() => {
      if (connected) console.log(`[WS ${label}]  ✓ Stayed connected for 5s with audio`);
      else console.log(`[WS ${label}]  ✗ Never connected`);
      clearInterval(audioInterval);
      ws.close();
      resolve(connected);
    }, 5000);

    ws.on('open', () => {
      connected = true;
      console.log(`[WS ${label}]  ✓ Connected, sending silent audio...`);
      // Send ~20ms audio chunks at 48kHz (960 samples × 2 bytes)
      audioInterval = setInterval(() => {
        if (ws.readyState === ws.OPEN) ws.send(silentChunk);
      }, 20);
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'Results' && msg.channel?.alternatives?.[0]?.transcript) {
          console.log(`[WS ${label}]  Transcript: "${msg.channel.alternatives[0].transcript}"`);
        }
      } catch {}
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      clearInterval(audioInterval);
      console.log(`[WS ${label}]  ✗ Error: ${err.message}`);
      resolve(false);
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      clearInterval(audioInterval);
      if (connected) console.log(`[WS ${label}]  Closed after connecting: code=${code} reason=${reason.toString()}`);
      else console.log(`[WS ${label}]  Closed before open: code=${code}`);
      resolve(connected && code === 1000);
    });
  });
}

// Test two concurrent connections (mirrors how the app uses Deepgram)
function testTwoConcurrent(url) {
  console.log(`\n[CONCURRENT] Testing 2 simultaneous connections...`);
  return Promise.all([
    testWSWithAudio('conn-1', url),
    testWSWithAudio('conn-2', url),
  ]);
}

async function main() {
  const restStatus = await testRestKey();
  if (restStatus !== 200) {
    console.log('\nKey appears invalid — stopping here.');
    return;
  }

  const base = 'wss://api.deepgram.com/v1/listen?encoding=linear16&channels=1&language=en&smart_format=true&interim_results=true';

  console.log('\n--- nova-2 @ 16kHz ---');
  await testWSWithAudio('nova-2 16kHz', `${base}&model=nova-2&sample_rate=16000`);

  console.log('\n--- nova-3 @ 16kHz ---');
  await testWSWithAudio('nova-3 16kHz', `${base}&model=nova-3&sample_rate=16000`);

  console.log('\n--- nova-2 @ 48kHz ---');
  await testWSWithAudio('nova-2 48kHz', `${base}&model=nova-2&sample_rate=48000`);

  console.log('\n--- nova-3 @ 48kHz ---');
  await testWSWithAudio('nova-3 48kHz', `${base}&model=nova-3&sample_rate=48000`);
}

main();
