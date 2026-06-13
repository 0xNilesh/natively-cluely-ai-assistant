// electron/services/HindsightManager.ts
//
// Production hosting for the optional Hindsight long-term-memory server.
//
// Hindsight's server is Python + an embedded Postgres + a HuggingFace embedding model —
// far too heavy to bundle into the signed Electron app. So, exactly like Ollama
// (OllamaManager) and Codex CLI (codexCliEnabled/codexCliPath), it's treated as an
// OPTIONAL, USER-PROVISIONED sidecar: the app health-checks it and degrades to Noop if
// it isn't there. Two supported targets, same code path:
//   • Local  — user runs `bash scripts/hindsight-start.sh` (or `pip install hindsight-all`
//              + the server) and points baseUrl at http://localhost:8888.
//   • Cloud  — user pastes their Hindsight Cloud baseUrl + apiKey.
//
// THIS PASS: config-from-settings + cached health-gating only. The retain/recall paths
// gate on isAvailable(), so a running (local or Cloud) server works in a packaged build —
// config flows from SettingsManager, not just shell env. The auto-spawn/process-lifecycle
// (start/stop/pollUntilReady) is DEFERRED to a follow-up; see startManagedServer() TODO.

import type { HindsightConfig } from '../intelligence/memory/HindsightClientAdapter';

interface SettingsLike {
  get(key: string): unknown;
}

const HEALTH_TIMEOUT_MS = 1000;     // match OllamaManager.checkIsRunning
const AVAILABILITY_TTL_MS = 30_000; // cache health so per-retain/recall calls are cheap

export class HindsightManager {
  private static instance: HindsightManager | null = null;
  static getInstance(): HindsightManager {
    if (!HindsightManager.instance) HindsightManager.instance = new HindsightManager();
    return HindsightManager.instance;
  }

  /** Cached health result + when it was taken. */
  private lastHealthy = false;
  private lastCheckedAt = 0;
  /** Reserved for the deferred auto-spawn follow-up. */
  private isAppManaged = false;

  /** Lazily read SettingsManager — avoids a hard import cycle + works headless (returns null). */
  private settings(): SettingsLike | null {
    try {
      const { SettingsManager } = require('./SettingsManager');
      return SettingsManager.getInstance();
    } catch {
      return null;
    }
  }

  /**
   * Resolve the Hindsight config: env (dev) takes precedence over the persisted setting
   * (packaged app). Returns null when no baseUrl is configured (→ feature off).
   */
  getHindsightConfig(): HindsightConfig | null {
    try {
      const s = this.settings();
      const baseUrl = (process.env.HINDSIGHT_BASE_URL
        || (s?.get('hindsightBaseUrl') as string | undefined)
        || '').trim();
      if (!baseUrl) return null;
      const apiKey = (process.env.HINDSIGHT_API_KEY
        || (s?.get('hindsightApiKey') as string | undefined)
        || '').trim() || undefined;
      const timeoutMs = Number(process.env.HINDSIGHT_TIMEOUT_MS) || 800;
      return { baseUrl, apiKey, timeoutMs };
    } catch {
      return null;
    }
  }

  /** GET <baseUrl>/health with a 1s timeout. Returns false on any error/timeout. */
  async healthCheck(): Promise<boolean> {
    const cfg = this.getHindsightConfig();
    if (!cfg) return false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
      const headers: Record<string, string> = {};
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
      const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/health`, {
        signal: controller.signal,
        headers,
      });
      clearTimeout(timer);
      const ok = res.ok;
      this.lastHealthy = ok;
      this.lastCheckedAt = Date.now();
      return ok;
    } catch {
      this.lastHealthy = false;
      this.lastCheckedAt = Date.now();
      return false;
    }
  }

  /**
   * Cheap gate for the retain/recall paths: a baseUrl is configured AND a recent health
   * check passed. Caches for AVAILABILITY_TTL_MS so calling it per answer is free; kicks
   * a background re-check when stale (never blocks the caller). Returns the cached value
   * immediately — callers that need a fresh result await healthCheck() directly.
   */
  isAvailable(): boolean {
    if (!this.getHindsightConfig()) return false;
    const stale = Date.now() - this.lastCheckedAt > AVAILABILITY_TTL_MS;
    if (stale) { void this.healthCheck(); } // fire-and-forget refresh; never awaited here
    return this.lastHealthy;
  }

  /**
   * Startup hook. THIS PASS: just prime the health cache so the first retain/recall sees
   * a real value (no spawn). Safe to call always; no-op when unconfigured. Never throws.
   */
  async start(): Promise<void> {
    try {
      const cfg = this.getHindsightConfig();
      if (!cfg) return; // feature off (no baseUrl) — stay Noop
      const healthy = await this.healthCheck();
      console.log('[HindsightManager] start', { baseUrl: cfg.baseUrl, healthy });
      // DEFERRED (follow-up): if !healthy AND a local server command is configured AND the
      // memory flag is on → auto-spawn it here (auto-start-when-installed, like Ollama):
      //   spawn(serverCommand, { stdio:'ignore' }); this.isAppManaged = true; pollUntilReady();
      // Not built this pass — a server (local or Cloud) must already be running.
    } catch (e: any) {
      console.warn('[HindsightManager] start skipped (non-fatal):', e?.message);
    }
  }

  /** Quit hook. Only relevant once auto-spawn exists (kill the managed server to avoid an
   *  orphaned Postgres). No-op this pass since nothing is app-managed. Never throws. */
  async stop(): Promise<void> {
    if (!this.isAppManaged) return;
    // DEFERRED: terminate the spawned server process group here.
  }
}
