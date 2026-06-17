import crypto from 'crypto';
import { app, BrowserWindow } from 'electron';
import http from 'http';
import os from 'os';
import QRCode from 'qrcode';
import { URL } from 'url';
import { WebSocket, WebSocketServer } from 'ws';
import { SettingsManager } from './SettingsManager';
import { CredentialsManager } from './CredentialsManager';
import { PHONE_MIRROR_HTML } from './phoneMirrorClient';
import { DOM_CONTEXT_MAX_CHARS } from '../config/constants';

export interface PhoneMirrorInfo {
  running: boolean;
  enabled: boolean;
  exposeOnLan: boolean;
  port: number;
  loopbackUrl: string | null;
  primaryUrl: string | null;
  lanUrls: string[];
  token: string | null;
  qrDataUrl: string | null;
  clients: number;
}

export type StreamEvent =
  | { type: 'history'; messages: PersistedMessage[] }
  | { type: 'user'; id: string; content: string; createdAt: string }
  | { type: 'token'; streamId: string; token: string }
  | { type: 'done'; streamId: string; content: string; createdAt: string }
  | { type: 'error'; streamId: string; message: string }
  | { type: 'assistant'; id: string; content: string; label: string; createdAt: string }
  | { type: 'ack'; action: string; message: string };

/** Command sent from the phone browser to the desktop. */
export type PhoneCommand =
  | { type: 'chat'; message: string }
  | { type: 'action'; action: string }
  | { type: 'screenshot' };

/**
 * Metadata the companion extension sends alongside a captured DOM (drives the
 * desktop "Page context" preview chip). All fields optional/best-effort.
 */
export interface DomCaptureMeta {
  title?: string;
  url?: string;
  source?: string;
  pageType?: string;
  firstLine?: string;
}

/** A single open tab reported by the extension for the multi-tab picker. */
export interface ExtensionTab {
  id: number;
  title: string;
  url: string;
}

interface PersistedMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  label?: string;
}

const DEFAULT_PORT = 4123;
const PORT_PROBE_RANGE = 12;
const HISTORY_LIMIT = 40;
const RATE_WINDOW_MS = 60_000;
const RATE_HTTP_LIMIT = 120;
const TOKEN_BYTES = 24;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const STATUS_LISTENERS_KEY = Symbol('phone-mirror-status-listeners');

// One-click /pair: how long the "Connect browser extension" button keeps the
// /pair endpoint open after the user clicks it. Single-use — burns on success.
const PAIR_ARM_WINDOW_MS = 60_000;
// Desktop → extension capture push default deadline. README: "short capture
// timeout + screenshot fallback" — if the extension doesn't ack `done` in time,
// the hotkey path falls back to a screenshot rather than silently no-op.
const CAPTURE_TIMEOUT_MS = 2_500;
const LIST_TABS_TIMEOUT_MS = 1_500;

// The companion extension's pinned ID (deterministic via the manifest `key`).
// The one-click /pair endpoint requires this EXACT origin (not the structural
// [a-p]{32} check used by /dom). Contributors loading an unpacked build with a
// different ID can override via NATIVELY_DOM_EXTENSION_ID. See natively-browser/README.md.
const PINNED_EXTENSION_ID =
  process.env.NATIVELY_DOM_EXTENSION_ID || 'macjecgdfliikhplbbdbpljomcigjnjg';
const PINNED_EXTENSION_ORIGIN = `chrome-extension://${PINNED_EXTENSION_ID}`;

type StatusListener = (info: PhoneMirrorInfo) => void;

export class PhoneMirrorService {
  private static _instance: PhoneMirrorService | null = null;

  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private port = 0;
  private token = '';
  private exposeOnLan = false;
  private history: PersistedMessage[] = [];
  // Single string instead of token array: O(1) append, O(1) replay (one WS frame).
  private livePartial: { streamId: string; content: string } | null = null;
  private rateBuckets = new Map<string, { count: number; resetAt: number }>();
  private statusListeners = new Set<StatusListener>();
  private phoneCommandListeners = new Set<(cmd: PhoneCommand) => void>();
  private cachedInfo: PhoneMirrorInfo | null = null;
  private cachedQrUrl: string | null = null;
  private cachedQrDataUrl: string | null = null;
  private starting: Promise<PhoneMirrorInfo> | null = null;
  // Debounce rapid connect/disconnect status events to avoid redundant QR re-renders.
  private statusDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // ----- companion browser extension (v2) state -----
  // Epoch (ms) until which the one-click /pair endpoint accepts a handshake.
  // Set by armExtensionPairing(); burned to 0 on the first successful /pair.
  private armedUntil = 0;
  // WebSocket clients that announced `{type:'hello', role:'extension'}`. Tracked
  // separately from phone clients so capture frames go only to the extension and
  // StreamEvents (phone chat) never reach it.
  private extClients = new Set<WebSocket>();
  // Timestamp of the extension socket per most-recent browser activity, so when
  // several browsers are paired the capture push targets the one in use.
  private extActiveAt = new WeakMap<WebSocket, number>();
  // In-flight desktop→extension requests keyed by reqId, resolved by the
  // matching `capture-ack`/`tabs` control frame (or a timeout).
  private pendingCaptures = new Map<string, { resolve: (r: { ok: boolean; reason?: string }) => void; timer: ReturnType<typeof setTimeout> }>();
  private pendingTabs = new Map<string, { resolve: (tabs: ExtensionTab[]) => void; timer: ReturnType<typeof setTimeout> }>();
  // Resolver for the window that should receive captured DOM (the overlay that
  // mounts NativelyInterface). When it yields no live window, /dom returns 409.
  private overlayResolver: (() => BrowserWindow | null) | null = null;

  static getInstance(): PhoneMirrorService {
    if (!PhoneMirrorService._instance) PhoneMirrorService._instance = new PhoneMirrorService();
    return PhoneMirrorService._instance;
  }

  // ----- public lifecycle -----

  isRunning(): boolean {
    return this.server !== null;
  }

  async start(opts?: { exposeOnLan?: boolean; persist?: boolean }): Promise<PhoneMirrorInfo> {
    if (this.starting) return this.starting;
    if (this.isRunning()) {
      if (typeof opts?.exposeOnLan === 'boolean' && opts.exposeOnLan !== this.exposeOnLan) {
        return this.restart({ exposeOnLan: opts.exposeOnLan, persist: opts.persist });
      }
      return this.snapshot();
    }

    const exposeOnLan =
      opts?.exposeOnLan ?? !!SettingsManager.getInstance().get('phoneMirrorExposeOnLan');
    this.starting = this._start(exposeOnLan, opts?.persist !== false);
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async stop(opts?: { persist?: boolean }): Promise<void> {
    if (opts?.persist !== false) {
      SettingsManager.getInstance().set('phoneMirrorEnabled', false);
    }
    await this._teardown();
    this.emitStatus();
  }

  async restart(opts: { exposeOnLan: boolean; persist?: boolean }): Promise<PhoneMirrorInfo> {
    await this._teardown();
    return this.start({ exposeOnLan: opts.exposeOnLan, persist: opts.persist });
  }

  async setExposeOnLan(value: boolean): Promise<PhoneMirrorInfo> {
    SettingsManager.getInstance().set('phoneMirrorExposeOnLan', value);
    if (!this.isRunning()) {
      this.exposeOnLan = value;
      return this.snapshot();
    }
    return this.restart({ exposeOnLan: value });
  }

  async rotateToken(): Promise<PhoneMirrorInfo> {
    this.token = generateToken();
    // Persist so the rotation survives a restart — this is the ONE deliberate
    // action that forces the extension/phone to re-pair.
    try {
      CredentialsManager.getInstance().setPhoneMirrorToken(this.token);
    } catch (_) {
      /* credentials not ready — token still rotates for this session */
    }
    this.invalidateQrCache();
    this.disconnectAllClients(4401, 'Token rotated');
    const info = await this.snapshot();
    this.emitStatus(info);
    return info;
  }

  async dispose(): Promise<void> {
    await this._teardown();
    this.statusListeners.clear();
    this.phoneCommandListeners.clear();
  }

  // ----- public publishing API (called from ipcHandlers) -----

  publishUserMessage(id: string, content: string): void {
    if (!this.isRunning() || !content?.trim()) return;
    const msg: PersistedMessage = {
      id: 'u:' + id,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    };
    this.recordHistory(msg);
    this.broadcast({ type: 'user', id: msg.id, content: msg.content, createdAt: msg.createdAt });
  }

  publishToken(streamId: string, token: string): void {
    if (!this.isRunning() || !token) return;
    if (!this.livePartial || this.livePartial.streamId !== streamId) {
      this.livePartial = { streamId, content: '' };
    }
    this.livePartial.content += token;
    this.broadcast({ type: 'token', streamId, token });
  }

  publishDone(streamId: string, fullContent: string): void {
    if (!this.isRunning()) return;
    const createdAt = new Date().toISOString();
    const content =
      fullContent || (this.livePartial?.streamId === streamId ? this.livePartial.content : '');
    if (content.trim()) {
      const msg: PersistedMessage = { id: 'a:' + streamId, role: 'assistant', content, createdAt };
      this.recordHistory(msg);
      this.broadcast({ type: 'done', streamId, content, createdAt });
    }
    if (this.livePartial?.streamId === streamId) this.livePartial = null;
  }

  publishError(streamId: string, message: string): void {
    if (!this.isRunning()) return;
    this.broadcast({ type: 'error', streamId, message: String(message || 'Stream error') });
    if (this.livePartial?.streamId === streamId) this.livePartial = null;
  }

  /**
   * Publish a non-streaming assistant response (e.g. from shortcut-triggered actions like
   * Code Hint, What to Answer, Brainstorm, Recap, etc.).  The label is shown in the phone
   * UI as the card's header (e.g. "Code Hint", "What to Answer").
   */
  publishAssistantMessage(id: string, content: string, label: string): void {
    if (!this.isRunning() || !content?.trim()) return;
    const createdAt = new Date().toISOString();
    const msg: PersistedMessage = {
      id: 'a:' + id,
      role: 'assistant',
      content,
      createdAt,
      label,
    };
    this.recordHistory(msg);
    this.broadcast({ type: 'assistant', id: msg.id, content: msg.content, label, createdAt });
  }

  /**
   * Broadcast a one-shot acknowledgement to all connected phones.
   * Used for stealth operations that succeed silently on the desktop side
   * (e.g. "Screenshot captured — queued for AI") so the phone shows a toast.
   */
  publishAck(action: string, message: string): void {
    if (!this.isRunning()) return;
    this.broadcast({ type: 'ack', action, message });
  }

  /** Returns true when at least one phone browser is connected. */
  hasClients(): boolean {
    return this.phoneClientCount() > 0;
  }

  /**
   * Subscribe to commands sent from the phone browser.
   * Returns an unsubscribe function.
   */
  onPhoneCommand(listener: (cmd: PhoneCommand) => void): () => void {
    this.phoneCommandListeners.add(listener);
    return () => this.phoneCommandListeners.delete(listener);
  }

  // ----- companion browser extension (v2) public API -----

  /**
   * Open the one-click /pair window for the companion extension. The user clicks
   * "Connect browser extension" in Settings → this arms /pair for 60s; the next
   * /pair POST from the pinned extension origin succeeds and burns the window.
   */
  armExtensionPairing(): { armedMs: number } {
    this.armedUntil = Date.now() + PAIR_ARM_WINDOW_MS;
    console.log('[PhoneMirror] extension pairing armed for', PAIR_ARM_WINDOW_MS, 'ms');
    return { armedMs: PAIR_ARM_WINDOW_MS };
  }

  /** True while the /pair window is open (set by armExtensionPairing). */
  private isArmed(): boolean {
    return Date.now() < this.armedUntil;
  }

  /** True when at least one companion extension is connected over /ws. */
  hasExtensionClient(): boolean {
    for (const c of this.extClients) {
      if (c.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  /** Count of connected PHONE clients (excludes companion extension sockets). */
  private phoneClientCount(): number {
    if (!this.wss) return 0;
    let n = 0;
    for (const c of this.wss.clients) {
      if (this.extClients.has(c)) continue;
      n++;
    }
    return n;
  }

  /**
   * Set the resolver for the window that should receive captured DOM. This is
   * the overlay window that mounts NativelyInterface — captured page content is
   * only meaningful when an active session/overlay exists. When the resolver
   * returns no live window, /dom answers 409 no_active_session.
   */
  setOverlayResolver(fn: () => BrowserWindow | null): void {
    this.overlayResolver = fn;
  }

  /**
   * Ask the most-recently-active companion extension to capture the active tab
   * (or `tabId`) and POST it to /dom. Resolves when the extension acks `done`,
   * or `{ok:false}` on error/timeout/no-extension so the caller can fall back
   * to a screenshot. The DOM itself flows over /dom, not this promise.
   */
  requestDomCapture(opts?: { tabId?: number; timeoutMs?: number }): Promise<{ ok: boolean; reason?: string }> {
    const target = this.pickExtensionClient();
    if (!target) return Promise.resolve({ ok: false, reason: 'no-extension' });
    const reqId = generateToken();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCaptures.delete(reqId);
        resolve({ ok: false, reason: 'timeout' });
      }, opts?.timeoutMs ?? CAPTURE_TIMEOUT_MS);
      this.pendingCaptures.set(reqId, { resolve, timer });
      try {
        target.send(
          JSON.stringify({ type: 'capture-dom', reqId, tabId: opts?.tabId }),
        );
      } catch (_) {
        clearTimeout(timer);
        this.pendingCaptures.delete(reqId);
        resolve({ ok: false, reason: 'send-failed' });
      }
    });
  }

  /**
   * Ask the active extension for its open-tab list (multi-tab picker). Resolves
   * with [] on timeout / no extension. Plumbed now even before a UI consumes it.
   */
  listTabs(timeoutMs?: number): Promise<ExtensionTab[]> {
    const target = this.pickExtensionClient();
    if (!target) return Promise.resolve([]);
    const reqId = generateToken();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingTabs.delete(reqId);
        resolve([]);
      }, timeoutMs ?? LIST_TABS_TIMEOUT_MS);
      this.pendingTabs.set(reqId, { resolve, timer });
      try {
        target.send(JSON.stringify({ type: 'list-tabs', reqId }));
      } catch (_) {
        clearTimeout(timer);
        this.pendingTabs.delete(reqId);
        resolve([]);
      }
    });
  }

  /**
   * Choose which extension socket to push to when several are connected: the one
   * whose browser was most recently active (extActiveAt), else any open socket.
   */
  private pickExtensionClient(): WebSocket | null {
    let best: WebSocket | null = null;
    let bestAt = -1;
    for (const c of this.extClients) {
      if (c.readyState !== WebSocket.OPEN) continue;
      const at = this.extActiveAt.get(c) ?? 0;
      if (at >= bestAt) {
        bestAt = at;
        best = c;
      }
    }
    return best;
  }

  /**
   * The live window that should receive captured DOM. Prefers the configured
   * overlay resolver (the window mounting NativelyInterface); falls back to any
   * live BrowserWindow only if no resolver is set (keeps standalone use working).
   * Returns null when no live window exists → /dom answers 409.
   */
  private resolveDomTargetWindow(): BrowserWindow | null {
    if (this.overlayResolver) {
      try {
        const win = this.overlayResolver();
        if (win && !win.isDestroyed()) return win;
        return null;
      } catch (_) {
        return null;
      }
    }
    const fallback =
      BrowserWindow.getFocusedWindow() ||
      BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ||
      null;
    return fallback && !fallback.isDestroyed() ? fallback : null;
  }

  /**
   * Route an inbound control frame from a companion extension socket. Resolves
   * pending requestDomCapture()/listTabs() promises and records browser activity
   * for multi-browser arbitration. Returns true if the frame was an extension
   * control frame (so the phone-command path is skipped).
   */
  private handleExtensionFrame(ws: WebSocket, msg: Record<string, unknown>): boolean {
    switch (msg.type) {
      case 'hello':
        if (msg.role === 'extension') {
          this.extClients.add(ws);
          this.extActiveAt.set(ws, Date.now());
          console.log('[PhoneMirror] companion extension connected');
          return true;
        }
        return false;
      case 'active':
        if (this.extClients.has(ws)) this.extActiveAt.set(ws, Date.now());
        return true;
      case 'capture-ack': {
        if (typeof msg.reqId !== 'string') return true;
        this.extActiveAt.set(ws, Date.now());
        const status = msg.status;
        // 'started'/'posting' are progress — keep waiting. 'done'/'error' settle.
        if (status === 'done' || status === 'error') {
          const pending = this.pendingCaptures.get(msg.reqId);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingCaptures.delete(msg.reqId);
            pending.resolve(
              status === 'done'
                ? { ok: true }
                : { ok: false, reason: typeof msg.error === 'string' ? msg.error : 'error' },
            );
          }
        }
        return true;
      }
      case 'tabs': {
        if (typeof msg.reqId !== 'string') return true;
        const pending = this.pendingTabs.get(msg.reqId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingTabs.delete(msg.reqId);
          const tabs = Array.isArray(msg.tabs)
            ? (msg.tabs as unknown[])
                .map((t) => t as Record<string, unknown>)
                .filter((t) => typeof t.id === 'number')
                .map((t) => ({
                  id: t.id as number,
                  title: typeof t.title === 'string' ? t.title : '',
                  url: typeof t.url === 'string' ? t.url : '',
                }))
            : [];
          pending.resolve(tabs);
        }
        return true;
      }
      default:
        return false;
    }
  }

  // ----- snapshot / status -----

  async snapshot(): Promise<PhoneMirrorInfo> {
    const enabled = !!SettingsManager.getInstance().get('phoneMirrorEnabled');
    if (!this.isRunning()) {
      const info: PhoneMirrorInfo = {
        running: false,
        enabled,
        exposeOnLan: this.exposeOnLan,
        port: 0,
        loopbackUrl: null,
        primaryUrl: null,
        lanUrls: [],
        token: null,
        qrDataUrl: null,
        clients: 0,
      };
      this.cachedInfo = info;
      return info;
    }
    const loopbackUrl = `http://127.0.0.1:${this.port}/?t=${this.token}`;
    const lanUrls = this.exposeOnLan
      ? getLanIPs().map((ip) => `http://${ip}:${this.port}/?t=${this.token}`)
      : [];
    // If LAN is on, only advertise a real LAN URL — falling back to 127.0.0.1
    // would print a QR code the phone cannot reach (loopback ≠ phone).
    const primaryUrl = this.exposeOnLan ? lanUrls[0] || null : loopbackUrl;
    let qrDataUrl: string | null = null;
    if (primaryUrl) {
      if (this.cachedQrUrl === primaryUrl && this.cachedQrDataUrl) {
        qrDataUrl = this.cachedQrDataUrl;
      } else {
        qrDataUrl = await safeQr(primaryUrl);
        this.cachedQrUrl = primaryUrl;
        this.cachedQrDataUrl = qrDataUrl;
      }
    } else {
      this.cachedQrUrl = null;
      this.cachedQrDataUrl = null;
    }
    const info: PhoneMirrorInfo = {
      running: true,
      enabled,
      exposeOnLan: this.exposeOnLan,
      port: this.port,
      loopbackUrl,
      primaryUrl,
      lanUrls,
      token: this.token,
      qrDataUrl,
      clients: this.phoneClientCount(),
    };
    this.cachedInfo = info;
    return info;
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  // ----- internals -----

  private async _start(exposeOnLan: boolean, persistEnabled: boolean): Promise<PhoneMirrorInfo> {
    this.exposeOnLan = exposeOnLan;
    // Reuse the persisted token so the extension/phone pair ONCE (stable across
    // restarts). Mint + persist only when there is none yet. A deliberate Rotate
    // is the only thing that changes it (see rotateToken).
    this.token = loadOrCreatePersistedToken();
    this.invalidateQrCache();

    const host = exposeOnLan ? '0.0.0.0' : '127.0.0.1';
    const basePort = DEFAULT_PORT;
    const server = http.createServer((req, res) => this.handleHttp(req, res));
    server.on('clientError', (_err, socket) => {
      try {
        socket.destroy();
      } catch (_) {
        /* noop */
      }
    });

    const port = await listenWithProbe(server, host, basePort, PORT_PROBE_RANGE);
    this.server = server;
    this.port = port;

    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;
    server.on('upgrade', (req, socket, head) =>
      this.handleUpgrade(req as http.IncomingMessage, socket as any, head),
    );
    wss.on('connection', (ws, req) => this.handleWsConnection(ws, req));

    if (persistEnabled) {
      SettingsManager.getInstance().set('phoneMirrorEnabled', true);
      SettingsManager.getInstance().set('phoneMirrorExposeOnLan', exposeOnLan);
    }

    const info = await this.snapshot();
    this.emitStatus(info);
    console.log(`[PhoneMirror] listening on ${host}:${port} (lan=${exposeOnLan})`);
    return info;
  }

  private async _teardown(): Promise<void> {
    // Cancel any pending debounced status emit so it doesn't fire after teardown.
    if (this.statusDebounceTimer !== null) {
      clearTimeout(this.statusDebounceTimer);
      this.statusDebounceTimer = null;
    }
    const wss = this.wss;
    const server = this.server;
    this.wss = null;
    this.server = null;
    this.port = 0;
    this.token = '';
    this.livePartial = null;
    this.rateBuckets.clear();
    this.armedUntil = 0;
    this.extClients.clear();
    // Settle any in-flight extension requests so callers don't hang on shutdown.
    for (const { resolve, timer } of this.pendingCaptures.values()) {
      clearTimeout(timer);
      resolve({ ok: false, reason: 'shutting-down' });
    }
    this.pendingCaptures.clear();
    for (const { resolve, timer } of this.pendingTabs.values()) {
      clearTimeout(timer);
      resolve([]);
    }
    this.pendingTabs.clear();
    if (wss) {
      for (const c of wss.clients) {
        try {
          c.close(1001, 'shutting down');
        } catch (_) {
          /* noop */
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const remote = req.socket.remoteAddress || '0.0.0.0';
    if (!this.rateAllow(remote)) {
      res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '30' });
      res.end('Too many requests');
      return;
    }

    const fullUrl = new URL(req.url || '/', 'http://localhost');
    const requestOrigin = req.headers.origin || '';
    // Enforce strict 32-character [a-p] Chrome extension ID structure to prevent generic extension spoofing
    const originMatch = requestOrigin.match(/^chrome-extension:\/\/([a-p]{32})$/);
    const allowedOrigin = originMatch ? requestOrigin : '';

    // CORS preflight options check for /dom route specifically
    if (req.method === 'OPTIONS' && fullUrl.pathname === '/dom') {
      const headers: Record<string, string> = {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      };
      if (allowedOrigin) {
        headers['Access-Control-Allow-Origin'] = allowedOrigin;
      }
      res.writeHead(204, headers);
      res.end();
      return;
    }

    const provided = fullUrl.searchParams.get('t');

    // Health endpoint — minimal info, never reveals token or DB paths.
    if (fullUrl.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, clients: this.phoneClientCount() }));
      return;
    }

    // Cross-process companion extension DOM context bridge
    if (fullUrl.pathname === '/dom') {
      if (req.method !== 'POST') {
        const headers: Record<string, string> = { 'Content-Type': 'text/plain' };
        if (allowedOrigin) headers['Access-Control-Allow-Origin'] = allowedOrigin;
        res.writeHead(405, headers);
        res.end('Method Not Allowed');
        return;
      }

      if (!provided || !timingSafeEqualStr(provided, this.token)) {
        const headers: Record<string, string> = { 'Content-Type': 'text/plain' };
        if (allowedOrigin) headers['Access-Control-Allow-Origin'] = allowedOrigin;
        res.writeHead(401, headers);
        res.end('Pairing token missing or invalid.');
        return;
      }

      let body = '';
      let limitExceeded = false;
      req.on('data', (chunk) => {
        if (limitExceeded) return;
        body += chunk;
        if (body.length > 500000) {
          limitExceeded = true;
          const headers: Record<string, string> = { 'Content-Type': 'text/plain' };
          if (allowedOrigin) headers['Access-Control-Allow-Origin'] = allowedOrigin;
          res.writeHead(413, headers);
          res.end('Payload Too Large');
          req.socket.destroy();
        }
      });
      req.on('end', () => {
        if (limitExceeded) return;
        try {
          const parsed = JSON.parse(body);
          if (parsed && typeof parsed.dom === 'string') {
            const jsonHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
            if (allowedOrigin) jsonHeaders['Access-Control-Allow-Origin'] = allowedOrigin;

            // A probe is a liveness/auth check (connection status, manual-pair
            // validation). It authenticated above, so answer 200 — but NEVER
            // deliver it to the overlay, or a phantom "14 chars" page-context
            // chip would appear on every status check.
            if (parsed.probe === true) {
              res.writeHead(200, jsonHeaders);
              res.end(JSON.stringify({ success: true }));
              return;
            }

            const cappedDom = parsed.dom.substring(0, DOM_CONTEXT_MAX_CHARS);
            // Deliver to the overlay window (the one that mounts NativelyInterface).
            // No live overlay → no active session to receive context → 409, so the
            // extension can tell the user to start a Natively session first.
            const targetWin = this.resolveDomTargetWindow();
            if (!targetWin) {
              res.writeHead(409, jsonHeaders);
              res.end(JSON.stringify({ error: 'no_active_session' }));
              return;
            }
            const meta = sanitizeCaptureMeta(parsed.meta);
            targetWin.webContents.send('dom-context-received', cappedDom, meta);
            res.writeHead(200, jsonHeaders);
            res.end(JSON.stringify({ success: true }));
            return;
          }
        } catch (_) {}
        const headers: Record<string, string> = { 'Content-Type': 'text/plain' };
        if (allowedOrigin) headers['Access-Control-Allow-Origin'] = allowedOrigin;
        res.writeHead(400, headers);
        res.end('Bad Request');
      });
      return;
    }

    // One-click pairing for the companion extension. Strictly gated:
    //  - loopback caller only (never reachable off-box even with exposeOnLan),
    //  - Origin must EXACTLY equal the pinned extension origin (not the structural
    //    [a-p]{32} check /dom uses),
    //  - must be armed (user clicked "Connect browser extension"); single-use.
    if (fullUrl.pathname === '/pair') {
      const pairOrigin = requestOrigin === PINNED_EXTENSION_ORIGIN ? requestOrigin : '';
      if (req.method === 'OPTIONS') {
        const headers: Record<string, string> = {
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        };
        if (pairOrigin) headers['Access-Control-Allow-Origin'] = pairOrigin;
        res.writeHead(204, headers);
        res.end();
        return;
      }
      const jsonHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (pairOrigin) jsonHeaders['Access-Control-Allow-Origin'] = pairOrigin;

      if (req.method !== 'POST') {
        res.writeHead(405, jsonHeaders);
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
        return;
      }
      // Loopback-only: a phone on the LAN must never reach /pair.
      if (!isLoopbackAddress(remote) || !pairOrigin) {
        res.writeHead(403, jsonHeaders);
        res.end(JSON.stringify({ error: 'forbidden' }));
        return;
      }
      if (!this.isArmed()) {
        res.writeHead(410, jsonHeaders);
        res.end(JSON.stringify({ error: 'not_armed' }));
        return;
      }
      // Burn the window — single-use.
      this.armedUntil = 0;
      console.log('[PhoneMirror] extension paired via one-click /pair');
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({ token: this.token, port: this.port }));
      return;
    }

    if (fullUrl.pathname !== '/' && fullUrl.pathname !== '/index.html') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    if (!provided || !timingSafeEqualStr(provided, this.token)) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Pairing token missing or invalid.');
      return;
    }

    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self' ws: wss:",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join('; ');

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(PHONE_MIRROR_HTML);
  }

  private handleUpgrade(req: http.IncomingMessage, socket: any, head: Buffer): void {
    const remote = req.socket.remoteAddress || '0.0.0.0';
    if (!this.rateAllow(remote)) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }

    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const provided = url.searchParams.get('t') || '';
    if (!timingSafeEqualStr(provided, this.token)) {
      // Custom 4401 close code signals "auth failed" to the client (won't reconnect).
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const wss = this.wss;
    if (!wss) {
      socket.destroy();
      return;
    }

    // Drop any client that doesn't complete handshake quickly — avoids slow-loris.
    let upgraded = false;
    const handshakeTimer = setTimeout(() => {
      if (!upgraded) socket.destroy();
    }, HANDSHAKE_TIMEOUT_MS);
    wss.handleUpgrade(req, socket, head, (ws) => {
      upgraded = true;
      clearTimeout(handshakeTimer);
      wss.emit('connection', ws, req);
    });
  }

  private handleWsConnection(ws: WebSocket, req: http.IncomingMessage): void {
    // Send recent history immediately so a phone joining mid-session has context.
    try {
      ws.send(JSON.stringify({ type: 'history', messages: this.history.slice(-HISTORY_LIMIT) }));
      // Replay in-flight partial as a SINGLE token frame containing the full
      // accumulated content so far.  Previously this sent one frame per token
      // (up to 500+ frames for a long response) — now it's always 1 frame.
      if (this.livePartial && this.livePartial.content) {
        ws.send(
          JSON.stringify({
            type: 'token',
            streamId: this.livePartial.streamId,
            token: this.livePartial.content,
          }),
        );
      }
    } catch (_) {
      /* client may be gone already */
    }

    // Keepalive heartbeat. Drop dead clients within ~45s.
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    const ping = setInterval(() => {
      if (!alive) {
        try {
          ws.terminate();
        } catch (_) {}
        return;
      }
      alive = false;
      try {
        ws.ping();
      } catch (_) {}
    }, 15_000);

    ws.on('close', () => {
      clearInterval(ping);
      // Drop any extension bookkeeping for this socket (no-op for phones).
      this.extClients.delete(ws);
      this.emitStatusClientCount();
    });
    ws.on('error', () => {
      /* swallow — close fires next */
    });

    // Parse and route commands. A socket is either a phone (chat/action/
    // screenshot) or a companion extension (hello/capture-ack/tabs/active).
    ws.on('message', (data: any) => {
      try {
        const raw = typeof data === 'string' ? data : (data as Buffer).toString('utf8');
        if (raw.length > 4096) return; // guard oversized payloads
        const cmd = JSON.parse(raw) as unknown;
        if (!cmd || typeof cmd !== 'object') return;
        const c = cmd as Record<string, unknown>;

        // Companion-extension control frames are handled separately and must not
        // fall through to the phone-command path. handleExtensionFrame returns
        // true when it consumed the frame.
        if (this.handleExtensionFrame(ws, c)) return;

        let validated: PhoneCommand | null = null;
        if (
          c.type === 'chat' &&
          typeof c.message === 'string' &&
          c.message.trim().length > 0 &&
          c.message.length <= 2000
        ) {
          validated = { type: 'chat', message: c.message.trim() };
        } else if (
          c.type === 'action' &&
          typeof c.action === 'string' &&
          /^[a-zA-Z:_-]{1,64}$/.test(c.action)
        ) {
          validated = { type: 'action', action: c.action };
        } else if (c.type === 'screenshot') {
          validated = { type: 'screenshot' };
        }

        if (validated) {
          console.log(`[PhoneMirror] phone command: ${validated.type}`);
          this.emitPhoneCommand(validated);
        }
      } catch (_) {
        /* malformed JSON — ignore */
      }
    });

    console.log(`[PhoneMirror] phone connected from ${req.socket.remoteAddress}`);
    this.emitStatusClientCount();
  }

  private broadcast(event: StreamEvent): void {
    const wss = this.wss;
    // Skip JSON serialization entirely when no phones are watching — this path
    // is hot (every LLM token goes through it) so the early-exit matters.
    if (!wss || wss.clients.size === 0) return;
    const payload = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      // Phone StreamEvents (history/token/done/chat) are for phones only — never
      // leak them to a companion extension socket.
      if (this.extClients.has(client)) continue;
      // Backpressure guard: skip if buffered amount has run away (slow client).
      if ((client as any).bufferedAmount > 1_000_000) continue;
      try {
        client.send(payload);
      } catch (_) {
        /* noop */
      }
    }
  }

  private recordHistory(msg: PersistedMessage): void {
    this.history.push(msg);
    // slice+reassign is O(1) GC pressure vs splice(0,n) which shifts every element.
    if (this.history.length > HISTORY_LIMIT * 2) {
      this.history = this.history.slice(-HISTORY_LIMIT);
    }
  }

  private rateAllow(ip: string): boolean {
    const now = Date.now();
    let bucket = this.rateBuckets.get(ip);
    if (!bucket || bucket.resetAt < now) {
      bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
      this.rateBuckets.set(ip, bucket);
    }
    bucket.count += 1;
    // Cheap LRU pruning so the map can't grow unbounded.
    if (this.rateBuckets.size > 256) {
      for (const [k, v] of this.rateBuckets) {
        if (v.resetAt < now) this.rateBuckets.delete(k);
      }
    }
    return bucket.count <= RATE_HTTP_LIMIT;
  }

  private disconnectAllClients(code: number, reason: string): void {
    if (!this.wss) return;
    for (const c of this.wss.clients) {
      try {
        c.close(code, reason);
      } catch (_) {}
    }
  }

  private invalidateQrCache(): void {
    this.cachedQrUrl = null;
    this.cachedQrDataUrl = null;
  }

  private emitStatusClientCount(): void {
    if (this.statusListeners.size === 0) return;
    const clients = this.phoneClientCount();
    if (this.cachedInfo && clients !== this.cachedInfo.clients) {
      const info = { ...this.cachedInfo, clients };
      this.cachedInfo = info;
      this.emitStatus(info);
      return;
    }
    this.emitStatus();
  }

  private emitStatus(prebuilt?: PhoneMirrorInfo): void {
    if (this.statusListeners.size === 0) return;
    // Debounce: rapid connect/disconnect storms (bad network, iOS reconnect loop)
    // used to regenerate the QR code on every event — each safeQr() call costs
    // ~3 ms CPU.  Coalesce into one emission within a 150 ms window.
    if (this.statusDebounceTimer !== null) clearTimeout(this.statusDebounceTimer);
    this.statusDebounceTimer = setTimeout(async () => {
      this.statusDebounceTimer = null;
      const info = prebuilt || (await this.snapshot());
      for (const l of this.statusListeners) {
        try {
          l(info);
        } catch (_) {
          /* noop */
        }
      }
    }, 150);
  }

  private emitPhoneCommand(cmd: PhoneCommand): void {
    for (const l of this.phoneCommandListeners) {
      try {
        l(cmd);
      } catch (_) {
        /* noop */
      }
    }
  }
}

// ----- helpers -----

function generateToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Return the persisted Phone Mirror token, minting + persisting one on first use.
 * Persisting makes the token stable across restarts so the extension/phone pair
 * once; rotation (rotateToken) is the only thing that changes it. Falls back to
 * an in-memory token if CredentialsManager isn't ready (token still works for
 * this session, just not persisted).
 */
function loadOrCreatePersistedToken(): string {
  try {
    const cm = CredentialsManager.getInstance();
    const existing = cm.getPhoneMirrorToken();
    if (existing && /^[A-Za-z0-9_-]{16,}$/.test(existing)) return existing;
    const fresh = generateToken();
    cm.setPhoneMirrorToken(fresh);
    return fresh;
  } catch (_) {
    return generateToken();
  }
}

/** True for IPv4/IPv6 loopback remote addresses (gates the /pair endpoint). */
function isLoopbackAddress(addr: string): boolean {
  if (!addr) return false;
  // Node may report IPv4-mapped IPv6 (::ffff:127.0.0.1) or bare ::1 / 127.x.
  return (
    addr === '::1' ||
    addr === '::ffff:127.0.0.1' ||
    addr.startsWith('127.') ||
    addr.startsWith('::ffff:127.')
  );
}

/**
 * Validate + clamp the optional capture meta from the extension before it crosses
 * the IPC boundary to the renderer's "Page context" chip. All fields optional;
 * strings are length-capped; anything malformed is dropped.
 */
function sanitizeCaptureMeta(raw: unknown): DomCaptureMeta | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const m = raw as Record<string, unknown>;
  const str = (v: unknown, max: number): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v.substring(0, max) : undefined;
  const out: DomCaptureMeta = {
    title: str(m.title, 300),
    url: str(m.url, 2048),
    source: str(m.source, 64),
    pageType: str(m.pageType, 64),
    firstLine: str(m.firstLine, 300),
  };
  // Drop the object entirely if nothing useful survived.
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still compare to keep timing roughly constant.
    const dummy = Buffer.alloc(ab.length || 1);
    crypto.timingSafeEqual(ab.length ? ab : dummy, ab.length ? dummy : ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

// Filter out interfaces a phone on the same WiFi will NEVER be able to reach:
// - utun*: VPN tunnels (Tailscale, system VPN, WireGuard) — not on the LAN
// - awdl*, llw*: Apple Wireless Direct Link / low-latency WLAN — peer-to-peer only
// - anpi*, ap*: Apple Network Privacy / hotspot interfaces
// - bridge*: Internet Sharing / Thunderbolt bridge — different subnet
// - vmnet*, vboxnet*, docker*: virtualization-only networks
// - veth*, br-*: Linux container networks
const VIRTUAL_IFACE_RE =
  /^(utun|awdl|llw|anpi|ap\d|bridge|vmnet|vboxnet|docker|veth|br-|gif|stf|tap)/i;

function isPrivateLanIPv4(ip: string): boolean {
  // RFC1918 — the only ranges a phone on the same Wi-Fi will share with the desktop.
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('172.')) {
    const second = parseInt(ip.split('.')[1] || '0', 10);
    return second >= 16 && second <= 31;
  }
  return false;
}

function rankLanIp(name: string, ip: string): number {
  // Lower score sorts earlier. We prefer:
  //   1. en0/en1 (Wi-Fi or Ethernet on macOS) over higher en* (often virtual).
  //   2. 192.168.x.x (home routers) over 10.x and 172.16-31.x.
  let score = 100;
  const m = name.match(/^en(\d+)$/i);
  if (m)
    score = parseInt(m[1], 10); // en0 -> 0, en1 -> 1, ...
  else if (/^eth\d+$|^enp/i.test(name)) score = 2;
  else if (/^wlan\d+|^wlp/i.test(name)) score = 1;
  if (ip.startsWith('192.168.')) score += 0;
  else if (ip.startsWith('10.')) score += 10;
  else score += 20; // 172.16-31.x
  return score;
}

function getLanIPs(): string[] {
  const candidates: { ip: string; name: string }[] = [];
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list) continue;
    if (VIRTUAL_IFACE_RE.test(name)) continue;
    for (const a of list) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (!isPrivateLanIPv4(a.address)) continue;
      candidates.push({ ip: a.address, name });
    }
  }
  candidates.sort((a, b) => rankLanIp(a.name, a.ip) - rankLanIp(b.name, b.ip));
  // De-dup while preserving order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    if (seen.has(c.ip)) continue;
    seen.add(c.ip);
    out.push(c.ip);
  }
  return out;
}

async function listenWithProbe(
  server: http.Server,
  host: string,
  basePort: number,
  range: number,
): Promise<number> {
  for (let i = 0; i < range; i++) {
    const port = basePort + i;
    const ok = await tryListen(server, host, port);
    if (ok) return port;
  }
  // Final attempt: ephemeral port chosen by OS.
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
      else reject(new Error('Failed to bind ephemeral port'));
    });
  });
}

function tryListen(server: http.Server, host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onError = () => {
      server.removeListener('listening', onListening);
      resolve(false);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(port, host);
    } catch (_) {
      resolve(false);
    }
  });
}

async function safeQr(text: string): Promise<string | null> {
  try {
    return await QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 1, scale: 6 });
  } catch (_) {
    return null;
  }
}

// Avoid unused-symbol TS error for STATUS_LISTENERS_KEY; reserved for future external coordination.
void STATUS_LISTENERS_KEY;
// Reference Electron's `app` to keep the import live in case we later need userData paths.
void app;
