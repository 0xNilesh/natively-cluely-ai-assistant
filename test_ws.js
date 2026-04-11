const WebSocket = require('ws');
const apiKey = "dummy";
const url = 'wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&channels=1';
const ws = new WebSocket(url, {
  headers: { Authorization: `Token ${apiKey}` },
});
ws.on('open', () => { console.log('open'); ws.close(); });
ws.on('error', (err) => { console.log('error', err.message); });
ws.on('close', (code, reason) => { console.log('close', code, reason.toString()); });
