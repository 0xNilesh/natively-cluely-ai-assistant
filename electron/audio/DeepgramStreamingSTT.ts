/**
 * DeepgramStreamingSTT - WebSocket-based streaming Speech-to-Text using Deepgram Nova-3
 *
 * Implements the same EventEmitter interface as GoogleSTT:
 *   Events: 'transcript' ({ text, isFinal, confidence }), 'error' (Error)
 *   Methods: start(), stop(), write(chunk), setSampleRate(), setAudioChannelCount()
 *
 * Sends raw PCM (linear16, 16-bit LE) over WebSocket — NO WAV header.
 * Receives interim and final transcription results in real time.
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { RECOGNITION_LANGUAGES } from '../config/languages';

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const RECONNECT_MAX_ATTEMPTS = 10;
const KEEPALIVE_INTERVAL_MS = 1000;

export class DeepgramStreamingSTT extends EventEmitter {
    private apiKey: string;
    private ws: WebSocket | null = null;
    private isActive = false;
    private shouldReconnect = false;

    private sampleRate = 16000;
    private numChannels = 1;
    private languageCode: string | null = 'en'; // null = multilingual streaming via language=multi

    private reconnectAttempts = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private keepAliveTimer: NodeJS.Timeout | null = null;
    private buffer: Buffer[] = [];
    private isConnecting = false;
    private connectionGen = 0; // incremented each connect(); handlers ignore stale gens

    constructor(apiKey: string) {
        super();
        this.apiKey = apiKey;
    }

    // =========================================================================
    // Configuration (match GoogleSTT / RestSTT interface)
    // =========================================================================

    public setSampleRate(rate: number): void {
        if (this.sampleRate === rate) return;
        this.sampleRate = rate;
        console.log(`[DeepgramStreaming] Sample rate set to ${rate}`);

        if (this.isActive) {
            console.log('[DeepgramStreaming] Sample rate changed while active. Restarting...');
            const savedBuffer = [...this.buffer];
            this.stop();
            this.start();
            if (savedBuffer.length > 0) {
                this.buffer = [...savedBuffer, ...this.buffer];
            }
        }
    }

    public setAudioChannelCount(count: number): void {
        this.numChannels = count;
        console.log(`[DeepgramStreaming] Channel count set to ${count}`);
    }

    /** Set recognition language using ISO-639-1 code, or 'auto' for detect_language mode */
    public setRecognitionLanguage(key: string): void {
        const restartIfActive = () => {
            if (this.isActive) {
                console.log('[DeepgramStreaming] Language changed while active. Restarting...');
                const savedBuffer = [...this.buffer];
                this.stop();
                this.start();
                if (savedBuffer.length > 0) {
                    this.buffer = [...savedBuffer, ...this.buffer];
                }
            }
        };

        if (key === 'auto') {
            this.languageCode = null;
            console.log('[DeepgramStreaming] Language set to multilingual streaming (language=multi)');
            restartIfActive();
            return;
        }

        const config = RECOGNITION_LANGUAGES[key];
        if (config) {
            this.languageCode = config.iso639;
            console.log(`[DeepgramStreaming] Language set to ${this.languageCode}`);
            restartIfActive();
        }
    }

    /** No-op — no Google credentials needed */
    public setCredentials(_path: string): void { }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    public start(): void {
        if (this.isActive) return;
        // Mark active immediately so write() buffers chunks
        // instead of dropping them during WebSocket handshake (~500ms).
        this.isActive = true;
        this.shouldReconnect = true;
        this.reconnectAttempts = 0;
        this.connect();
    }

    public stop(): void {
        this.shouldReconnect = false;
        this.clearTimers();

        if (this.ws) {
            try {
                // Send Deepgram's graceful close message
                if (this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({ type: 'CloseStream' }));
                }
            } catch {
                // Ignore send errors during shutdown
            }
            this.ws.close();
            this.ws = null;
        }

        this.isActive = false;
        this.isConnecting = false;
        this.buffer = [];
        console.log('[DeepgramStreaming] Stopped');
    }

    // =========================================================================
    // Audio Data
    // =========================================================================

    public write(chunk: Buffer): void {
        if (!this.isActive) return;

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.buffer.push(chunk);
            if (this.buffer.length > 500) this.buffer.shift(); // Cap buffer size

            // Don't spawn a new connection if one is already in-flight (CONNECTING or isConnecting flag).
            const alreadyConnecting = this.isConnecting ||
                (this.ws !== null && this.ws.readyState === WebSocket.CONNECTING);
            if (!alreadyConnecting && this.shouldReconnect && !this.reconnectTimer) {
                console.log('[DeepgramStreaming] WS not ready. Lazy connecting on new audio...');
                this.connect();
            }
            return;
        }

        this.ws.send(chunk);
    }

    // =========================================================================
    // WebSocket Connection
    // =========================================================================

    private connect(): void {
        if (this.isConnecting) return;
        this.isConnecting = true;
        const gen = ++this.connectionGen;

        // detect_language=true is not supported for streaming (pre-recorded only).
        // For multilingual streaming, use language=multi (Nova-3 multilingual codeswitching).
        const langParam = this.languageCode === null
            ? '&language=multi'
            : `&language=${this.languageCode}`;

        const url =
            `wss://api.deepgram.com/v1/listen` +
            `?model=nova-3` +
            `&encoding=linear16` +
            `&sample_rate=${this.sampleRate}` +
            `&channels=${this.numChannels}` +
            langParam +
            `&smart_format=true` +
            `&interim_results=true` +
            `&keepalive=true`;

        console.log(`[DeepgramStreaming] Connecting (rate=${this.sampleRate}, ch=${this.numChannels})...`);

        const ws = new WebSocket(url, {
            headers: { Authorization: `Token ${this.apiKey}` },
        });
        this.ws = ws;

        ws.on('open', () => {
            if (gen !== this.connectionGen) { ws.close(); return; } // stale connection
            this.isActive = true;
            this.isConnecting = false;
            this.reconnectAttempts = 0;
            console.log('[DeepgramStreaming] Connected');

            // Flush any audio buffered during the WebSocket handshake (~500ms)
            while (this.buffer.length > 0) {
                const chunk = this.buffer.shift();
                if (chunk && ws.readyState === WebSocket.OPEN) {
                    ws.send(chunk);
                }
            }

            this.startKeepAlive();
        });

        ws.on('message', (data: WebSocket.Data) => {
            if (gen !== this.connectionGen) return; // stale
            try {
                const msg = JSON.parse(data.toString());

                // Deepgram response structure:
                // { type: "Results", channel: { alternatives: [{ transcript, confidence }] }, is_final }
                if (msg.type !== 'Results') {
                    // Log non-Results messages (errors, metadata, etc.) to aid debugging
                    if (msg.type !== 'Metadata' && msg.type !== 'SpeechStarted' && msg.type !== 'UtteranceEnd') {
                        console.log(`[DeepgramStreaming] Non-results message (type=${msg.type}):`, JSON.stringify(msg).substring(0, 200));
                    }
                    return;
                }

                const transcript = msg.channel?.alternatives?.[0]?.transcript;
                if (!transcript) return;

                this.emit('transcript', {
                    text: transcript,
                    isFinal: msg.is_final ?? false,
                    confidence: msg.channel?.alternatives?.[0]?.confidence ?? 1.0,
                });
            } catch (err) {
                console.error('[DeepgramStreaming] Parse error:', err);
            }
        });

        ws.on('error', (err: Error) => {
            if (gen !== this.connectionGen) return; // stale
            if (err.message === 'WebSocket was closed before the connection was established') return;
            console.error('[DeepgramStreaming] WebSocket error:', err.message);
            this.emit('error', err);
        });

        ws.on('close', (code: number, reason: Buffer) => {
            if (gen !== this.connectionGen) return; // stale — don't touch shared state
            this.isConnecting = false;
            this.clearKeepAlive();
            const reasonStr = reason?.length > 0 ? reason.toString() : '(empty)';
            console.log(`[DeepgramStreaming] Closed (code=${code}, reason=${reasonStr}, rate=${this.sampleRate}, lang=${this.languageCode})`);

            if (this.shouldReconnect && code !== 1000) {
                this.scheduleReconnect();
            }
        });
    }

    // =========================================================================
    // Reconnection
    // =========================================================================

    private scheduleReconnect(): void {
        if (!this.shouldReconnect) return;

        if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
            console.error(`[DeepgramStreaming] Max reconnect attempts (${RECONNECT_MAX_ATTEMPTS}) reached — giving up`);
            this.emit('error', new Error('DeepgramStreamingSTT: max reconnect attempts exceeded'));
            return;
        }

        const delay = Math.min(
            RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
            RECONNECT_MAX_DELAY_MS
        );
        this.reconnectAttempts++;

        console.log(`[DeepgramStreaming] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS})...`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.shouldReconnect) {
                this.connect();
            }
        }, delay);
    }

    // =========================================================================
    // Keep-alive
    // =========================================================================

    private startKeepAlive(): void {
        this.clearKeepAlive();
        this.keepAliveTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                try {
                    // Send KeepAlive JSON instead of raw ping frame for Deepgram API idle prevention
                    this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
                } catch {
                    // Ignore errors
                }
            }
        }, KEEPALIVE_INTERVAL_MS);
    }

    private clearKeepAlive(): void {
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
    }

    private clearTimers(): void {
        this.clearKeepAlive();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
}
