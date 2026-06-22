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
// Config-from-settings + cached health-gating: the retain/recall paths gate on
// isAvailable(), so a running (local or Cloud) server works in a packaged build — config
// flows from SettingsManager, not just shell env. Auto-spawn IS implemented and ZERO-CONFIG:
// when the memory flag is on + a baseUrl is configured + the server is not already healthy +
// autoStart is on (default), start() spawns the server (detached, group-killed on quit via
// stopSync) and polls for readiness. The launch command resolves from
// HINDSIGHT_SERVER_COMMAND env → the hindsightServerCommand setting → a DEFAULT that runs the
// bundled `scripts/hindsight-start.sh` — but the default is gated on that script actually
// existing on disk, so in dev it auto-starts out-of-the-box while a packaged build (which does
// NOT bundle the script) stays Noop instead of spawning a broken command. Cloud / a user-run
// server stays healthy → no spawn.
//
// LLM credential forwarding: when spawning a local server, buildCredentialEnv() reads
// CredentialsManager and maps every configured AI provider key into the env vars that
// hindsight-start.sh + hindsight-llm-config.mjs expect. This is the ONLY way the packaged
// app can forward keys — CredentialsManager encrypts them at rest and they never live in
// process.env. The child inherits process.env PLUS these injected keys; the shell script
// then builds a litellm.Router chain from whatever subset is present.

import type { HindsightConfig } from '../intelligence/memory/HindsightClientAdapter';
import type { ChildProcess } from 'child_process';

interface SettingsLike {
  get(key: string): unknown;
}

const HEALTH_TIMEOUT_MS = 1000;       // match OllamaManager.checkIsRunning
const AVAILABILITY_TTL_MS = 30_000;   // cache health so per-retain/recall calls are cheap
const SPAWN_POLL_INTERVAL_MS = 5000;  // poll for readiness (like OllamaManager)
const SPAWN_MAX_ATTEMPTS = 36;        // 36 * 5s = 180s (first boot downloads embedding models)

export class HindsightManager {
  private static instance: HindsightManager | null = null;
  static getInstance(): HindsightManager {
    if (!HindsightManager.instance) HindsightManager.instance = new HindsightManager();
    return HindsightManager.instance;
  }

  /** Cached health result + when it was taken. */
  private lastHealthy = false;
  private lastCheckedAt = 0;
  /** True only when WE spawned the server (so we kill it on quit). A user-run or Cloud
   *  server is never app-managed and is left running. */
  private isAppManaged = false;
  private serverProcess: ChildProcess | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private spawnAttempts = 0;
  /** Where the spawned server's stdout/stderr is written (for failure diagnostics). */
  private logPath: string | null = null;

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

  /**
   * Stable per-install memory scope id. Used as the Hindsight `userId` so the bank/tags
   * are unique to THIS install. Matters for the Cloud path: two different installs that
   * point at the same Cloud account would otherwise both write to bank `user_local` with
   * identical tags and MERGE each other's memories. Derived from the persisted install
   * UUID (getOrCreateInstallId). Falls back to 'local' if unavailable (local-only path is
   * single-user so the constant is safe there).
   */
  private _localUserId: string | null = null;
  localUserId(): string {
    if (this._localUserId) return this._localUserId;
    try {
      const { getOrCreateInstallId } = require('./InstallPingManager');
      const id = String(getOrCreateInstallId() || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
      this._localUserId = id ? `local_${id}` : 'local';
    } catch {
      this._localUserId = 'local';
    }
    return this._localUserId;
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
    // Cold start: never health-checked yet (e.g. start() hasn't run / completed). Be
    // OPTIMISTIC — return true and kick a check. Worst case is one recall to a down server
    // (already timeout-bounded); the alternative (return false) would wrongly skip recall
    // for a configured+healthy server on the first question after launch.
    if (this.lastCheckedAt === 0) { void this.healthCheck(); return true; }
    const stale = Date.now() - this.lastCheckedAt > AVAILABILITY_TTL_MS;
    if (stale) { void this.healthCheck(); } // fire-and-forget refresh; never awaited here
    return this.lastHealthy;
  }

  /** Is the memory feature flag enabled? (read fresh, never throws.) */
  private memoryFlagOn(): boolean {
    try {
      const { isIntelligenceFlagEnabled } = require('../intelligence/intelligenceFlags');
      return Boolean(isIntelligenceFlagEnabled('hindsightMemory'));
    } catch {
      return false;
    }
  }

  /**
   * Locate the bundled `scripts/hindsight-start.sh` launcher on disk, returning its absolute
   * path or null if it isn't present.
   *
   * DEV vs PACKAGED — this is the crux of the zero-config default:
   *   • DEV (`npm start`): the compiled manager lives at
   *     <root>/dist-electron/electron/services/HindsightManager.js and app.getAppPath()
   *     === <root>, so <appPath>/scripts/hindsight-start.sh resolves and exists.
   *   • PACKAGED (.app): the script + python dev-server are NOT bundled into the asar
   *     (deliberately — Hindsight is a heavy user-provisioned sidecar, see file header), so
   *     <appPath>/scripts/... does NOT exist. We MUST detect that and NOT spawn a broken
   *     `bash <missing>` command; instead the caller stays Noop and graceful-degrades.
   *
   * We probe a few candidate roots and return the first that actually exists on disk. Using
   * fs.existsSync is what makes the default safe: the zero-config `bash <script>` default is
   * ONLY produced when the script is genuinely present, so a packaged build with no script
   * never gets a defaulted (and doomed) command.
   */
  private locateLauncherScript(): string | null {
    try {
      const fs = require('fs') as typeof import('fs');
      const path = require('path') as typeof import('path');
      const candidateRoots: string[] = [];
      // 1. Electron app root (project root in dev; asar/Resources in packaged).
      try {
        const { app } = require('electron') as typeof import('electron');
        const appPath = app?.getAppPath?.();
        if (appPath) candidateRoots.push(appPath);
      } catch { /* electron not available (headless/test) — fall through to other roots */ }
      // 2. Walk up from this compiled module: dist-electron/electron/services → <root>.
      //    Robust if app.getAppPath() is unavailable but the on-disk layout is intact.
      candidateRoots.push(path.resolve(__dirname, '..', '..', '..'));
      // 3. Process cwd (dev `npm start` runs from the project root).
      candidateRoots.push(process.cwd());

      const seen = new Set<string>();
      for (const root of candidateRoots) {
        if (!root || seen.has(root)) continue;
        seen.add(root);
        const scriptPath = path.join(root, 'scripts', 'hindsight-start.sh');
        try { if (fs.existsSync(scriptPath)) return scriptPath; } catch { /* keep probing */ }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Should we auto-spawn a local server? Resolve the launch command + autoStart toggle.
   *
   * Precedence: explicit HINDSIGHT_SERVER_COMMAND env → persisted hindsightServerCommand
   * setting → ZERO-CONFIG DEFAULT (`bash <abs path to scripts/hindsight-start.sh>`).
   *
   * The zero-config default is what makes auto-start work out-of-the-box: the renderer never
   * persists a serverCommand, so without this the command was always empty → auto-start
   * no-op on every launch (the reported bug). The default is gated on the launcher script
   * actually existing on disk (locateLauncherScript), so a packaged build that doesn't bundle
   * the script returns null here and the caller stays Noop instead of spawning a broken
   * `bash <missing-path>`.
   */
  private autoStartCommand(): string | null {
    try {
      const s = this.settings();
      // Default ON (auto-start-when-installed, per the design) unless explicitly disabled.
      const autoStart = (s?.get('hindsightAutoStart') as boolean | undefined) ?? true;
      if (!autoStart) return null;
      const explicit = (process.env.HINDSIGHT_SERVER_COMMAND
        || (s?.get('hindsightServerCommand') as string | undefined)
        || '').trim();
      if (explicit) return explicit;
      // Zero-config fallback: run the bundled launcher IFF it exists on disk. Quote the path
      // (it's absolute and may contain spaces, e.g. "/Users/.../Application Support/...").
      const script = this.locateLauncherScript();
      return script ? `bash "${script}"` : null;
    } catch {
      return null;
    }
  }

  /**
   * Build a PATH that works when the app is launched from Finder (GUI), not a terminal.
   *
   * macOS GUI apps inherit a MINIMAL PATH (typically just /usr/bin:/bin:/usr/sbin:/sbin),
   * NOT the user's interactive shell PATH. So a spawned `bash scripts/hindsight-start.sh`
   * can fail to find `python3`/`node`/`hindsight` even though they work in the user's
   * terminal. We prepend the common install locations (Homebrew Intel + Apple Silicon,
   * the python.org framework bins, /usr/local) to whatever PATH we inherited so the child
   * can resolve them. No-op on non-darwin. Never throws.
   */
  private augmentPath(): string {
    const existing = process.env.PATH || '';
    if (process.platform !== 'darwin') return existing;
    try {
      const fs = require('fs') as typeof import('fs');
      const path = require('path') as typeof import('path');
      const extras: string[] = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
      // python.org installs to /Library/Frameworks/Python.framework/Versions/<x.y>/bin —
      // glob the versions that actually exist (newest first), e.g. the user's 3.12.
      try {
        const fwBase = '/Library/Frameworks/Python.framework/Versions';
        if (fs.existsSync(fwBase)) {
          const versions = fs.readdirSync(fwBase)
            .filter((v) => /^\d/.test(v))
            .sort()
            .reverse()
            .map((v) => path.join(fwBase, v, 'bin'));
          extras.push(...versions);
        }
      } catch { /* framework dir not present — skip */ }
      const parts = existing ? existing.split(':') : [];
      // Prepend extras that aren't already present, preserving the inherited PATH after them.
      const merged: string[] = [];
      for (const p of [...extras, ...parts]) {
        if (p && !merged.includes(p)) merged.push(p);
      }
      return merged.join(':');
    } catch {
      return existing;
    }
  }

  /**
   * Startup hook. Primes the health cache; if the memory flag is on, a baseUrl is
   * configured, the server is NOT already healthy, and an auto-start command is set,
   * spawns it (auto-start-when-installed, like OllamaManager) and polls for readiness.
   * Never blocks startup, never throws. No-op when unconfigured / flag off / Cloud
   * (Cloud is already healthy so no spawn).
   */
  async start(): Promise<void> {
    try {
      const cfg = this.getHindsightConfig();
      if (!cfg) return;                 // no baseUrl → feature off, stay Noop
      if (!this.memoryFlagOn()) return; // flag off → don't manage anything

      const healthy = await this.healthCheck();
      if (healthy) {
        console.log('[HindsightManager] server already running — connecting (not app-managed).', { baseUrl: cfg.baseUrl });
        this.isAppManaged = false;
        return;
      }

      const cmd = this.autoStartCommand();
      if (!cmd) {
        console.log('[HindsightManager] server not running + auto-start off/unset — staying Noop until a server appears.', { baseUrl: cfg.baseUrl });
        return;
      }

      console.log('[HindsightManager] server not detected — auto-starting:', cmd);
      this.spawnServer(cmd);
      this.pollUntilReady();
    } catch (e: any) {
      console.warn('[HindsightManager] start skipped (non-fatal):', e?.message);
    }
  }

  /**
   * Build the environment that the spawned Hindsight server process should see.
   *
   * The packaged app never exposes user credentials in process.env — they live in
   * CredentialsManager (encrypted on disk). This method reads every configured AI
   * provider key and maps it to the standard env var that hindsight-llm-config.mjs
   * (and transitively litellm) expects. The result is merged with process.env so the
   * child gets the full ambient env PLUS the credential overrides.
   *
   * Provider priority mirrors hindsight-llm-config.mjs:
   *   Gemini → OpenAI → Anthropic → DeepSeek → Groq → LiteLLM gateway → Ollama
   *
   * Never throws — a missing CredentialsManager (e.g. test environment) is silently
   * handled and the child falls back to env-var defaults (dev .env path).
   */
  private buildCredentialEnv(): Record<string, string> {
    const extra: Record<string, string> = {};
    try {
      const { CredentialsManager } = require('./CredentialsManager') as typeof import('./CredentialsManager');
      const cm = CredentialsManager.getInstance();

      const gemini = cm.getGeminiApiKey();
      if (gemini) extra.GEMINI_API_KEY = gemini;

      const openai = cm.getOpenaiApiKey();
      if (openai) extra.OPENAI_API_KEY = openai;

      const claude = cm.getClaudeApiKey();
      if (claude) extra.ANTHROPIC_API_KEY = claude;

      const deepseek = cm.getDeepseekApiKey();
      if (deepseek) extra.DEEPSEEK_API_KEY = deepseek;

      const groq = cm.getGroqApiKey();
      if (groq) extra.GROQ_API_KEY = groq;

      // LiteLLM gateway — treated as an OpenAI-compatible endpoint. The shell script
      // passes OPENAI_API_KEY to litellm; OPENAI_API_BASE redirects calls to the gateway.
      // Only applied when a base URL is configured (key alone is meaningless without URL).
      const litellmUrl = cm.getLitellmBaseURL();
      if (litellmUrl?.trim()) {
        extra.OPENAI_API_BASE = litellmUrl.trim();
        // Prefer the explicit LiteLLM key; fall back to the OpenAI key already set above.
        const litellmKey = cm.getLitellmApiKey();
        if (litellmKey) extra.OPENAI_API_KEY = litellmKey;
        // Guard: if neither key is present, litellm still needs a non-empty string.
        if (!extra.OPENAI_API_KEY) extra.OPENAI_API_KEY = 'natively-gateway';
      }

      // Ollama — no API key; signal availability via the enable flag and pass the base URL.
      // LLMHelper always defaults to 127.0.0.1:11434 when OLLAMA_URL is unset; mirror that.
      const ollamaUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
      // Only enable Ollama for Hindsight when the app is actively using it (avoid forcing
      // a heavyweight local model when the user has cloud keys configured).
      try {
        const { llmHelper } = require('../LLMHelper') as { llmHelper: { isUsingOllama(): boolean } };
        if (llmHelper?.isUsingOllama?.()) {
          extra.HINDSIGHT_LLM_ENABLE_OLLAMA = 'true';
          extra.HINDSIGHT_LLM_OLLAMA_BASE = ollamaUrl;
        }
      } catch { /* LLMHelper not available yet — skip Ollama */ }
    } catch (e: any) {
      console.warn('[HindsightManager] buildCredentialEnv: could not read CredentialsManager (non-fatal):', e?.message);
    }

    if (Object.keys(extra).length > 0) {
      const providerList = Object.keys(extra)
        .filter((k) => k.endsWith('_API_KEY') || k === 'HINDSIGHT_LLM_ENABLE_OLLAMA')
        .map((k) => k.replace('_API_KEY', '').replace('HINDSIGHT_LLM_ENABLE_', '').toLowerCase())
        .join(', ');
      console.log(`[HindsightManager] credential env: forwarding providers → ${providerList || 'none'}`);
    } else {
      console.warn('[HindsightManager] credential env: no provider keys found — Hindsight server will fall back to its own env defaults');
    }

    return extra;
  }

  /** Resolve a writable path for the spawned server's log. Prefers the app's userData dir
   *  (works in a packaged build); falls back to the OS temp dir. Null only if both fail. */
  private resolveServerLogPath(): string | null {
    try {
      const path = require('path') as typeof import('path');
      let dir: string | null = null;
      try {
        const { app } = require('electron') as typeof import('electron');
        dir = app?.getPath?.('userData') || null;
      } catch { /* electron unavailable (headless/test) */ }
      if (!dir) {
        try { dir = (require('os') as typeof import('os')).tmpdir(); } catch { dir = null; }
      }
      return dir ? path.join(dir, 'hindsight-server.log') : null;
    } catch {
      return null;
    }
  }

  /** On a non-zero server exit, tail the captured log into the app log so the failure cause
   *  (missing module, bad key, port in use) is visible instead of a bare exit code. */
  private logServerFailureTail(): void {
    try {
      if (!this.logPath) return;
      const fs = require('fs') as typeof import('fs');
      const raw = fs.readFileSync(this.logPath, 'utf8');
      const tail = raw.split('\n').filter(Boolean).slice(-12).join('\n');
      if (tail) {
        console.error('[HindsightManager] server launcher failed — last log lines:\n' + tail);
        console.error(`[HindsightManager] full log: ${this.logPath}`);
      }
    } catch { /* no log / unreadable — nothing more we can surface */ }
  }

  /** Spawn the configured server command (shell form, like `bash scripts/hindsight-start.sh`).
   *  Degrades gracefully on error ("python/script not found") — app unaffected. */
  private spawnServer(command: string): void {
    try {
      const { spawn } = require('child_process') as typeof import('child_process');
      this.isAppManaged = true;
      // Shell form so a multi-token command (`bash scripts/...`) works cross-platform.
      // detached:true on POSIX puts the server in its OWN process group, so on quit we can
      // synchronously kill the WHOLE tree (Python + embedded Postgres workers, which
      // re-parent/daemonize) with one `process.kill(-pid)` inside before-quit — tree-kill
      // is async and the app can exit before it finishes, orphaning Postgres. (Windows has
      // no process groups; we fall back to taskkill /T in stopSync.)
      const isWin = process.platform === 'win32';
      // cwd: prefer the directory CONTAINING scripts/ (the project root) so the launcher's
      // internal relative calls (`node scripts/hindsight-llm-config.mjs`) resolve. The script
      // itself also cd's to its own ../, so this is belt-and-braces; fall back to cwd().
      const script = this.locateLauncherScript();
      let spawnCwd = process.cwd();
      if (script) {
        try {
          const path = require('path') as typeof import('path');
          spawnCwd = path.resolve(path.dirname(script), '..');
        } catch { /* keep process.cwd() */ }
      }
      // Capture the child's stdout+stderr to a log file rather than discarding it (the old
      // stdio:'ignore' made spawn failures invisible — a crash showed only "exited {code:1}"
      // with no reason). On a non-zero exit we tail this file into the app log so the cause
      // (e.g. "No module named 'hindsight'", bad API key) is diagnosable. Best-effort: if the
      // log can't be opened we fall back to 'ignore' so spawning still works.
      this.logPath = this.resolveServerLogPath();
      let outFd: number | null = null;
      try {
        if (this.logPath) {
          const fs = require('fs') as typeof import('fs');
          outFd = fs.openSync(this.logPath, 'a');
        }
      } catch { outFd = null; }
      const stdio: any = outFd !== null ? ['ignore', outFd, outFd] : 'ignore';

      this.serverProcess = spawn(command, {
        shell: true,
        detached: !isWin,   // own process group on POSIX for group-kill on quit
        windowsHide: true,
        stdio,
        cwd: spawnCwd,
        // Forward credentials from CredentialsManager into the child's env so the
        // packaged app doesn't need .env or manual GEMINI_API_KEY exports. The shell
        // script (hindsight-start.sh) picks these up and builds the litellm router.
        // augmentPath() fixes the Finder-launch minimal-PATH caveat (python3 not found).
        env: { ...process.env, PATH: this.augmentPath(), ...this.buildCredentialEnv() },
      });
      // The parent no longer needs the fd once the child owns it.
      if (outFd !== null) { try { require('fs').closeSync(outFd); } catch { /* noop */ } }
      // Don't let the detached child keep the parent event loop alive.
      this.serverProcess.unref?.();
      this.serverProcess.on('error', (err: any) => {
        console.error('[HindsightManager] failed to start server (is it installed?):', err?.message);
        this.isAppManaged = false;
        this.serverProcess = null;
        if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null; }
      });
      this.serverProcess.on('close', (code: number | null) => {
        console.log('[HindsightManager] server process exited', { code });
        // A non-zero exit before readiness means the launcher failed — surface the tail of its
        // log so the reason is visible in the app log instead of a bare exit code.
        if (code && code !== 0) this.logServerFailureTail();
        this.serverProcess = null;
      });
    } catch (e: any) {
      console.error('[HindsightManager] exception spawning server:', e?.message);
      this.isAppManaged = false;
    }
  }

  /** Poll /health every 5s for up to ~3min (first boot downloads embedding models). */
  private pollUntilReady(): void {
    // Guard against a leaked interval if pollUntilReady is ever entered twice (e.g. a
    // future second start()): clear any prior one before arming a new one.
    if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null; }
    this.spawnAttempts = 0;
    this.pollInterval = setInterval(async () => {
      this.spawnAttempts++;
      const healthy = await this.healthCheck();
      if (healthy) {
        console.log(`[HindsightManager] server ready after ~${this.spawnAttempts * 5}s`);
        if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null; }
        return;
      }
      if (this.spawnAttempts >= SPAWN_MAX_ATTEMPTS) {
        console.warn('[HindsightManager] timeout waiting for server — staying Noop. Check the install / command.');
        if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null; }
      }
    }, SPAWN_POLL_INTERVAL_MS);
    this.pollInterval.unref?.(); // never keep the process alive for this
  }

  /**
   * SYNCHRONOUS quit hook. Kills the server tree ONLY if WE spawned it (a user-run or
   * Cloud server is left untouched). Must be synchronous: the `before-quit` handler can let
   * the app exit before any async work (tree-kill) completes, orphaning the Python+Postgres
   * tree. Because the server was spawned detached (its own process group on POSIX), one
   * `process.kill(-pid, SIGKILL)` takes down the whole group right now. Never throws.
   */
  stopSync(): void {
    try {
      if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null; }
      if (!this.isAppManaged || !this.serverProcess?.pid) return;
      const pid = this.serverProcess.pid;
      if (process.platform === 'win32') {
        // No process groups on Windows — taskkill the tree synchronously.
        try {
          require('child_process').execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        } catch { try { process.kill(pid); } catch { /* gone */ } }
      } else {
        // Negative pid → kill the whole process group (server + Postgres workers).
        try { process.kill(-pid, 'SIGKILL'); }
        catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      }
      this.serverProcess = null;
      this.isAppManaged = false;
      console.log('[HindsightManager] app-managed server tree terminated on quit.');
    } catch (e: any) {
      console.warn('[HindsightManager] stopSync skipped (non-fatal):', e?.message);
    }
  }

  /** Async wrapper kept for API compatibility / non-quit callers. Delegates to stopSync. */
  async stop(): Promise<void> {
    this.stopSync();
  }
}
