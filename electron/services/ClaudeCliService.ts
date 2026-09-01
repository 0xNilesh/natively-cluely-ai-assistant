/**
 * ClaudeCliService — local `claude` (Claude Code) CLI provider.
 *
 * Sibling of CodexCliService, with one structural difference that is worth
 * stating up front: Codex is no longer a subprocess provider. It was rewritten
 * to speak HTTPS to chatgpt.com/backend-api with an OAuth bearer token (see the
 * header of CodexCliService.ts), so there is no live subprocess template in the
 * tree to copy. What is mirrored here is Codex's *public shape* — config type,
 * DEFAULT_*_CONFIG, normalizeConfig, run/stream, the actionable-error constants,
 * the idle-timeout guard and combineSignals — while the transport is a child
 * process, closer to the pre-rewrite Codex implementation.
 *
 * Wire protocol (verified against `claude` 2.1.251):
 *
 *   claude -p --input-format stream-json --output-format stream-json \
 *          --include-partial-messages --verbose --tools "" \
 *          --strict-mcp-config --setting-sources "" --no-session-persistence \
 *          --system-prompt <base persona> --model <model>
 *
 * stdout is NDJSON, one JSON object per line. The frames that matter:
 *
 *   {"type":"system","subtype":"init",...}                      session ready
 *   {"type":"stream_event","event":{"type":"content_block_delta",
 *      "delta":{"type":"text_delta","text":"h"}}}               incremental text
 *   {"type":"assistant","message":{"content":[{"type":"text",
 *      "text":"hello world"}]}}                                 whole message
 *   {"type":"result","subtype":"success","is_error":false,
 *      "result":"hello world",...}                              terminal
 *   {"type":"result","is_error":true,"result":"<human message>"} terminal error
 *
 * Deltas are forwarded as they arrive — never buffered — so the word-by-word
 * answer rendering added in 2.8.8 is preserved. The `assistant` frame repeats
 * the text the deltas already produced, so it is only emitted when no delta
 * ever arrived (i.e. --include-partial-messages produced nothing).
 *
 * ── Latency ────────────────────────────────────────────────────────────────
 * A cold `claude -p` costs ~1.4s of process boot before the first byte of
 * model output, measured on `claude` 2.1.251 (3 runs: 1406/1471/1404 ms of
 * wall time in excess of the CLI's own reported duration_ms). Auto Answer
 * cannot afford that on every turn.
 *
 * The CLI defers its session init until the first stdin message arrives, which
 * makes the boot cost prewarmable: spawn the process with
 * `--input-format stream-json` and it sits idle, fully booted, having issued no
 * API call, until we write the turn. Measured with the same 3-run method, the
 * post-write overhead drops to ~0.55s (549/550/548 ms) — ~870ms saved per
 * request. ClaudeCliProcessPool below keeps a small number of such processes
 * parked and hands one to each request.
 *
 * ── Concurrency ────────────────────────────────────────────────────────────
 * In the default 'isolated' mode every request gets its OWN process, warm or
 * cold, and exactly one turn is ever written to it before stdin closes. Nothing
 * is shared, so two overlapping calls (Auto Answer prefetching while its judge
 * is still deciding) cannot see each other's context and neither blocks on the
 * other. This matches the Codex HTTP path's semantics exactly — `store: false`,
 * one self-contained user turn per call.
 *
 * 'meeting' mode is the opt-in opposite: ONE process is held open for a
 * meeting and every turn goes to it, so the model remembers the conversation.
 * A session is strictly serial, so the overlap the isolated path handles for
 * free has to be decided explicitly — it is, in
 * ClaudeCliSessionManager.claim(), which hands an overlapping turn its own
 * one-off process rather than queueing it. Read that comment before changing
 * anything here; the queueing option is the one that looks obvious and is
 * wrong for a live interview.
 *
 * ── Cancellation ───────────────────────────────────────────────────────────
 * In isolated mode, abort (barge-in), idle timeout, and early consumer `break`
 * all run the same teardown: SIGTERM to the child, SIGKILL after
 * CHILD_KILL_GRACE_MS if it has not exited. Nothing is left orphaned.
 *
 * In session mode the process must OUTLIVE a cancelled turn, so a barge-in
 * detaches the consumer and the reader keeps draining to the turn's terminal
 * frame in the background (see ClaudeCliSession.runTurn). The session itself is
 * disposed on meeting end, on app quit, on a mid-meeting config change, and
 * whenever a turn times out. A crashed main process cannot run any of those —
 * the backstop there is the stdin pipe: it closes when this process dies, the
 * CLI sees EOF, and it exits on its own.
 */

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';

// Extension → MIME for the RAW fallback path only (the normal path re-encodes
// to JPEG via sharp, so its MIME is fixed). Mirrors CodexCliService — the
// Anthropic content-block API accepts the same four formats.
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// Same bounds as CodexCliService.encodeImageForRequest — see the rationale
// there. A raw send above the cap is how a request silently exceeds the API's
// image limit; below the floor it is a truncated/0-byte capture, not an image.
const RAW_IMAGE_MAX_BYTES = 500 * 1024;
const RAW_IMAGE_MIN_BYTES = 64;

/** Grace between SIGTERM and SIGKILL when tearing a child down. */
const CHILD_KILL_GRACE_MS = 2_000;

/** How long a prewarmed, unused process is kept before being reaped. */
const WARM_IDLE_TTL_MS = 5 * 60_000;

/**
 * Turn and age caps for a persistent meeting session.
 *
 * Context accumulation is the POINT of session mode, but it is also its cost:
 * every turn re-sends the whole conversation, so a session left running across
 * a long meeting gets steadily slower and more expensive, and old questions
 * start colouring new answers. At the cap the session is retired and a fresh
 * one takes over — the user loses history, which is the lesser harm against an
 * answer that arrives too late to be useful in a live interview.
 */
const SESSION_MAX_TURNS = 24;
const SESSION_MAX_AGE_MS = 30 * 60_000;

/** Cap on stderr retained per child, so a chatty binary can't grow unbounded. */
const STDERR_CAP_BYTES = 8 * 1024;

/**
 * Base system prompt, passed in argv and therefore CONSTANT for every request.
 *
 * It has to be constant: it is part of the warm-pool signature, so a per-turn
 * value would invalidate the pool on every call and give back the ~870ms the
 * pool exists to save. The per-turn system prompt Natively builds is instead
 * prepended to the user turn (see buildTurnText), which is the same thing
 * LLMHelper.buildCodexCliPrompt does for the Codex path.
 *
 * `claude -p` without --system-prompt runs as the Claude Code coding agent;
 * this replaces that persona with a plain answering one.
 */
export const CLAUDE_CLI_BASE_SYSTEM_PROMPT =
  'You are a concise, helpful assistant. Answer the user\'s message directly. '
  + 'You have no tools and no filesystem access: never offer to run commands, read or write files, '
  + 'or describe your environment. Reply with the answer itself and nothing else.';

// The two failures that are ACTIONABLE by the user, so callers may show them
// verbatim instead of a generic "the model failed". Exported and matched via
// isClaudeCliError() rather than re-typed as string literals at each call site
// — a reword here would otherwise silently stop matching. Mirrors
// CODEX_NOT_SIGNED_IN_MESSAGE / CODEX_SESSION_EXPIRED_MESSAGE.
export const CLAUDE_CLI_NOT_FOUND_MESSAGE =
  'Claude Code CLI not found. Install it, or set the binary path in Settings → AI Providers.';
export const CLAUDE_CLI_NOT_SIGNED_IN_MESSAGE =
  'Claude Code is not signed in. Run `claude` in a terminal and complete login, then try again.';

/** True when `err` is one of the actionable Claude CLI failures above. */
export function isClaudeCliError(err: unknown): boolean {
  const message = (err as { message?: unknown } | null | undefined)?.message;
  if (typeof message !== 'string') return false;
  return message.includes(CLAUDE_CLI_NOT_FOUND_MESSAGE)
    || message.includes(CLAUDE_CLI_NOT_SIGNED_IN_MESSAGE);
}

/**
 * How turns map onto `claude` processes.
 *
 *  - 'isolated' (default) — one process per message, stdin closed after a
 *    single turn. Nothing is shared, so overlapping requests cannot see each
 *    other and no context leaks between questions.
 *  - 'meeting' — ONE process is held open for the duration of a meeting and
 *    every turn of that meeting is written to it, so the model remembers the
 *    conversation. See ClaudeCliSession for what happens when two turns
 *    overlap (they cannot share one serial session, so the loser runs
 *    isolated) and for the turn/age caps that stop the prompt bloating.
 */
export type ClaudeCliSessionMode = 'isolated' | 'meeting';

export const CLAUDE_CLI_SESSION_MODES: readonly ClaudeCliSessionMode[] = ['isolated', 'meeting'] as const;

export interface ClaudeCliConfig {
  enabled: boolean;
  /** Binary path. 'claude' means "resolve on PATH, then fall back to
   *  autoDetectPath()". Unlike the Codex `path` field this is NOT deprecated —
   *  it is the transport. */
  path: string;
  model: string;
  fastModel: string;
  /** Idle timeout: reset on every delta, so a slow-but-live answer is never cut. */
  timeoutMs: number;
  /** How many prewarmed processes to keep parked. 0 disables prewarming. */
  maxWarmProcesses: number;
  /** See ClaudeCliSessionMode. Default 'isolated' — the pre-session behaviour. */
  sessionMode: ClaudeCliSessionMode;
}

export interface ClaudeCliRunOptions {
  prompt: string;
  model: string;
  timeoutMs: number;
  imagePaths?: string[];
  /** Per-turn system prompt. Prepended to the user turn rather than passed as
   *  --system-prompt; see CLAUDE_CLI_BASE_SYSTEM_PROMPT for why. */
  instructions?: string;
  signal?: AbortSignal;
  /** Prewarm cap for this call. Defaults to DEFAULT_CLAUDE_CLI_CONFIG's value. */
  maxWarmProcesses?: number;
}

export const DEFAULT_CLAUDE_CLI_CONFIG: ClaudeCliConfig = {
  enabled: false,
  path: 'claude',
  // Aliases rather than pinned ids: `claude --model` resolves 'sonnet'/'opus'/
  // 'haiku' to the current release, so the picker does not go stale the way a
  // hard-coded claude-sonnet-4-6 would.
  model: 'sonnet',
  fastModel: 'haiku',
  timeoutMs: 60_000,
  maxWarmProcesses: 2,
  // Default 'isolated': the mode with no cross-turn coupling. Persistent
  // sessions are opt-in because they trade independence for continuity.
  sessionMode: 'isolated',
};

export const CLAUDE_CLI_MODEL_ALIASES: readonly string[] = ['sonnet', 'opus', 'haiku', 'fable'] as const;

// =============================================================================
// Stream-json parsing (pure — no process, no I/O)
// =============================================================================

/** One decoded NDJSON frame. Deliberately loose: the CLI adds fields between
 *  releases and we only read the handful documented at the top of this file. */
export interface ClaudeStreamFrame {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  message?: { content?: unknown; model?: unknown } | null;
  event?: { type?: string; delta?: { type?: string; text?: unknown } | null } | null;
  parent_tool_use_id?: string | null;
  error?: { message?: unknown } | null;
  [key: string]: unknown;
}

/**
 * Incremental NDJSON reader.
 *
 * `push()` is fed raw stdout chunks, which split anywhere — mid-line, mid-UTF8
 * sequence, several lines at once — and returns only the frames that are
 * complete. A line that is not valid JSON is DROPPED, not thrown: the CLI
 * prints the occasional non-JSON diagnostic on stdout, and killing an
 * otherwise-good answer over one is worse than ignoring it.
 */
export class ClaudeStreamJsonParser {
  private buffer = '';

  /** Lines that failed JSON.parse. Surfaced only for diagnostics/tests. */
  public readonly malformedLines: string[] = [];

  public push(chunk: string): ClaudeStreamFrame[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    // The last element is either '' (chunk ended on a newline) or a partial
    // line; either way it stays buffered until more bytes arrive.
    this.buffer = lines.pop() ?? '';
    return this.decode(lines);
  }

  /** Decode whatever is left after the stream closes (last line, no newline). */
  public flush(): ClaudeStreamFrame[] {
    const rest = this.buffer;
    this.buffer = '';
    return this.decode([rest]);
  }

  private decode(lines: string[]): ClaudeStreamFrame[] {
    const frames: ClaudeStreamFrame[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          frames.push(parsed as ClaudeStreamFrame);
          continue;
        }
      } catch { /* fall through to malformed */ }
      this.malformedLines.push(trimmed);
    }
    return frames;
  }
}

/**
 * Text delta from a `stream_event` frame, or '' when the frame carries none.
 *
 * Only `text_delta` counts. `thinking_delta` and `signature_delta` are extended
 * thinking, which is NOT the answer and must never reach the renderer;
 * `input_json_delta` is tool input, which cannot occur under `--tools ""` but
 * is excluded anyway so a future config change cannot leak argv JSON into an
 * answer. Deltas carrying a `parent_tool_use_id` are subagent output and are
 * likewise not this turn's answer.
 */
export function extractClaudeTextDelta(frame: ClaudeStreamFrame): string {
  if (!frame || frame.type !== 'stream_event') return '';
  if (frame.parent_tool_use_id) return '';
  const event = frame.event;
  if (!event || event.type !== 'content_block_delta') return '';
  const delta = event.delta;
  if (!delta || delta.type !== 'text_delta') return '';
  return typeof delta.text === 'string' ? delta.text : '';
}

/**
 * The CLI's marker for a message it fabricated locally rather than receiving
 * from the model. It uses one to deliver failures ("There's an issue with the
 * selected model (…)") in the shape of an ordinary assistant turn.
 */
const SYNTHETIC_MODEL_MARKER = '<synthetic>';

/**
 * Whole-message text from an `assistant` frame.
 *
 * Used ONLY as the fallback for a stream that produced no partial deltas (an
 * older CLI, or --include-partial-messages rejected). Emitting it alongside the
 * deltas would duplicate the entire answer, so the caller gates on whether any
 * delta was seen.
 *
 * SYNTHETIC messages are excluded, and that exclusion is load-bearing rather
 * than cosmetic. Verified against `claude` 2.1.251: an unusable --model makes
 * the CLI emit `{"type":"assistant","message":{"model":"<synthetic>","content":
 * [{"type":"text","text":"There's an issue with the selected model (…)"}]}}`
 * and only THEN the `is_error` result frame. Treating that as answer text made
 * the stream "succeed" — the error was returned to the user as the answer, and
 * the fallback chain recorded the provider healthy. The result frame's
 * is_error must be what decides, so the envelope never becomes output.
 */
export function extractClaudeAssistantText(frame: ClaudeStreamFrame): string {
  if (!frame || frame.type !== 'assistant') return '';
  if (frame.parent_tool_use_id) return '';
  if (frame.message?.model === SYNTHETIC_MODEL_MARKER) return '';
  const content = frame.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(block => (block && typeof block === 'object' && (block as any).type === 'text' && typeof (block as any).text === 'string')
      ? (block as any).text as string
      : '')
    .join('');
}

/**
 * Human-readable error from a terminal frame, or '' when the frame is not an
 * error. The CLI puts its message in `result` on an `is_error` result frame
 * (e.g. "There's an issue with the selected model (…)"), which is far more
 * useful to a user than the exit code, so it wins over both.
 */
export function extractClaudeStreamError(frame: ClaudeStreamFrame): string {
  if (!frame || typeof frame !== 'object') return '';
  if (frame.type === 'result' && frame.is_error === true) {
    if (typeof frame.result === 'string' && frame.result.trim()) return frame.result;
    return 'Claude Code reported an error but gave no message.';
  }
  if (frame.type === 'error') {
    if (typeof frame.error?.message === 'string') return frame.error.message;
    if (typeof frame.result === 'string' && frame.result) return frame.result;
  }
  return '';
}

/** True for the frame that ends a turn. */
export function isClaudeTerminalFrame(frame: ClaudeStreamFrame): boolean {
  return !!frame && frame.type === 'result';
}

/**
 * Turns decoded frames into the text chunks a consumer should see.
 *
 * Extracted so the one-shot path and the persistent-session path cannot drift:
 * the rules below are subtle enough that two copies would eventually disagree
 * about when an answer gets duplicated or when an error gets swallowed.
 *
 * The rules, in the order they matter:
 *   1. `text_delta` frames are the answer, streamed. The first one latches
 *      `sawTextDelta`.
 *   2. A whole `assistant` message is emitted ONLY if no delta ever arrived —
 *      it repeats what the deltas already produced, so emitting both would
 *      duplicate the entire answer. (Synthetic error envelopes are filtered
 *      upstream by extractClaudeAssistantText.)
 *   3. The terminal `result` frame also carries the whole answer. It is emitted
 *      only when nothing else produced anything at all.
 *   4. An `is_error` result records the error instead of producing text.
 */
export class ClaudeTurnReducer {
  private sawTextDelta = false;
  /** True once any chunk has been produced by this reducer. */
  public producedAny = false;
  public sawTerminalFrame = false;
  public error: Error | null = null;

  /** Chunks this frame contributes, in order. Usually zero or one. */
  public accept(frame: ClaudeStreamFrame): string[] {
    const out: string[] = [];

    const delta = extractClaudeTextDelta(frame);
    if (delta) {
      this.sawTextDelta = true;
      this.producedAny = true;
      return [delta];
    }

    if (!this.sawTextDelta) {
      const whole = extractClaudeAssistantText(frame);
      if (whole) out.push(whole);
    }

    const err = extractClaudeStreamError(frame);
    if (err && !this.error) this.error = new Error(`Claude Code CLI: ${err}`);

    if (isClaudeTerminalFrame(frame)) {
      this.sawTerminalFrame = true;
      if (!this.error && !this.producedAny && out.length === 0
        && typeof frame.result === 'string' && frame.result) {
        out.push(frame.result);
      }
    }

    if (out.length) this.producedAny = true;
    return out;
  }
}

/**
 * Map raw stderr / an exit code onto a user-facing message.
 *
 * Ordered most-specific first. The auth case matters most: without it a
 * signed-out CLI surfaces as a bare "exited with code 1", and the user has no
 * way to know the fix is `claude` in a terminal.
 */
export function describeClaudeCliFailure(exitCode: number | null, stderr: string, binPath: string): string {
  const text = (stderr || '').trim();
  const lower = text.toLowerCase();
  if (lower.includes('enoent') || lower.includes('command not found') || lower.includes('is not recognized')) {
    return `${CLAUDE_CLI_NOT_FOUND_MESSAGE} (tried "${binPath}")`;
  }
  if (lower.includes('not logged in') || lower.includes('please run /login')
    || lower.includes('invalid api key') || lower.includes('authentication_error')
    || lower.includes('oauth token has expired') || lower.includes('unauthorized')) {
    return CLAUDE_CLI_NOT_SIGNED_IN_MESSAGE;
  }
  if (text) return `Claude Code CLI: ${truncate(text, 500)}`;
  return `Claude Code CLI exited with code ${exitCode}.`;
}

// =============================================================================
// Warm-process pool
// =============================================================================

interface PooledProcess {
  child: ChildProcessWithoutNullStreams;
  signature: string;
  /** stderr produced before hand-off (a bad binary fails here, not at write). */
  stderr: string;
  exited: boolean;
  idleTimer: ReturnType<typeof setTimeout>;
  /** Kept so acquire() can detach EXACTLY the pool's own listeners. A blanket
   *  removeAllListeners() would also strip the permanent 'error' sink that
   *  spawnClaude installs, and an EventEmitter with zero 'error' listeners
   *  THROWS — taking the whole main process down with it. */
  onError: () => void;
  onExit: () => void;
  onStderr: (chunk: Buffer) => void;
}

/**
 * A small park of spawned-but-unfed `claude` processes.
 *
 * The CLI does nothing — no session init, no API call — until the first stdin
 * message, so parking one costs a node process and nothing else. See the
 * measurements in the file header for what this buys.
 *
 * Entries are keyed by the full argv signature. In practice that is
 * (binary, model), because everything else in buildArgs() is constant, so the
 * key space is tiny and a repeated Auto Answer turn always hits.
 */
class ClaudeCliProcessPool {
  private static instance: ClaudeCliProcessPool | null = null;
  private readonly idle = new Map<string, PooledProcess[]>();

  public static getInstance(): ClaudeCliProcessPool {
    if (!this.instance) this.instance = new ClaudeCliProcessPool();
    return this.instance;
  }

  public static signature(binPath: string, args: readonly string[]): string {
    // NUL, written as an escape rather than as a literal control byte. As a
    // literal it made `file` and `grep` classify this whole module as binary,
    // which silently drops it out of every grep-based code search.
    // The separator itself must not be a space: `--system-prompt` carries a
    // multi-word value, so a space-joined signature would let two different
    // argv vectors collide onto one pool key.
    return [binPath, ...args].join('\u0000');
  }

  /**
   * Hand back a booted process for this signature, or spawn a cold one.
   *
   * Never blocks and never queues: two concurrent callers get two processes.
   * That is deliberate — see the Concurrency note in the file header.
   */
  public acquire(binPath: string, args: readonly string[]): { child: ChildProcessWithoutNullStreams; warm: boolean; stderr: string } {
    const signature = ClaudeCliProcessPool.signature(binPath, args);
    const bucket = this.idle.get(signature);
    while (bucket && bucket.length > 0) {
      const pooled = bucket.pop()!;
      clearTimeout(pooled.idleTimer);
      // A pooled child can die while parked (binary replaced mid-session, OOM
      // killer, user `pkill claude`). Handing that out would fail the request
      // for a reason that has nothing to do with it, so drop it and try again.
      if (pooled.exited || pooled.child.exitCode !== null || pooled.child.signalCode !== null) continue;
      // Detach the pool's own bookkeeping BEFORE handing the process over.
      // The 'exit'/'error' listeners installed by prewarm() call evict(), which
      // kills the child — leaving them attached would let the pool tear down a
      // process that is mid-request.
      pooled.child.off('exit', pooled.onExit);
      pooled.child.off('error', pooled.onError);
      pooled.child.stderr.off('data', pooled.onStderr);
      return { child: pooled.child, warm: true, stderr: pooled.stderr };
    }
    return { child: spawnClaude(binPath, args), warm: false, stderr: '' };
  }

  /** Park one more process for this signature, up to `max`. No-op when max<=0. */
  public prewarm(binPath: string, args: readonly string[], max: number): void {
    if (!Number.isFinite(max) || max <= 0) return;
    const signature = ClaudeCliProcessPool.signature(binPath, args);
    const bucket = this.idle.get(signature) ?? [];
    if (bucket.length >= max) return;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnClaude(binPath, args);
    } catch {
      // A bad binary path must not take the app down from a background
      // prewarm; the next real request surfaces the error properly.
      return;
    }

    const pooled: PooledProcess = {
      child,
      signature,
      stderr: '',
      exited: false,
      idleTimer: setTimeout(() => this.evict(pooled), WARM_IDLE_TTL_MS),
      onError: () => { pooled.exited = true; this.evict(pooled); },
      onExit: () => { pooled.exited = true; this.evict(pooled); },
      onStderr: (chunk: Buffer) => { pooled.stderr = appendCapped(pooled.stderr, chunk.toString()); },
    };
    // Unref so a parked process can never hold the event loop open.
    pooled.idleTimer.unref?.();
    child.stderr.on('data', pooled.onStderr);
    // on(), not once(): a child can emit 'error' more than once — a bad path
    // emits the async ENOENT, and a kill() issued before that lands can emit a
    // second one. A spent `once` listener leaves the emitter with none, and an
    // unhandled 'error' event is a hard process crash.
    child.on('error', pooled.onError);
    child.on('exit', pooled.onExit);
    bucket.push(pooled);
    this.idle.set(signature, bucket);
  }

  /** Kill and forget one entry. Safe to call repeatedly. */
  private evict(pooled: PooledProcess): void {
    clearTimeout(pooled.idleTimer);
    const bucket = this.idle.get(pooled.signature);
    if (bucket) {
      const at = bucket.indexOf(pooled);
      if (at >= 0) bucket.splice(at, 1);
      if (bucket.length === 0) this.idle.delete(pooled.signature);
    }
    if (!pooled.exited) killChild(pooled.child);
  }

  /** Tear the whole pool down (app quit, provider disabled, path changed). */
  public dispose(): void {
    for (const bucket of this.idle.values()) {
      for (const pooled of [...bucket]) this.evict(pooled);
    }
    this.idle.clear();
  }

  /** Parked count, for tests and diagnostics. */
  public size(): number {
    let total = 0;
    for (const bucket of this.idle.values()) total += bucket.length;
    return total;
  }
}

function spawnClaude(binPath: string, args: readonly string[]): ChildProcessWithoutNullStreams {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1' };
  // Electron sets ELECTRON_RUN_AS_NODE on its own helper processes. Inheriting
  // it makes a spawned node-based CLI reinterpret its argv, so it is deleted
  // rather than set to undefined (which some Node versions stringify).
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(binPath, [...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // Run outside the user's project so `claude` cannot auto-discover a
    // CLAUDE.md, a .claude/ directory, or a git repo whose contents would
    // silently join the prompt. --setting-sources "" already excludes settings
    // files; this covers the cwd-derived context they do not.
    cwd: os.tmpdir(),
    env,
  });
  // PERMANENT sink, never removed. On an EventEmitter, an 'error' event with no
  // listener is re-thrown as an uncaught exception — which in the main process
  // means the whole app dies. Every window in which that can happen here is
  // real: a parked process between prewarm() and acquire(), a request child
  // after stream()'s finally has detached its handler, and the double-emit a
  // failed spawn produces when kill() races the async ENOENT. Consumers still
  // add their own 'error' listeners on top; this only guarantees the count is
  // never zero.
  child.on('error', () => { /* handled by whoever owns the child, if anyone */ });
  return child;
}

/** SIGTERM, then SIGKILL after a grace period if it is still alive. */
function killChild(child: ChildProcess): void {
  // No pid means the spawn itself failed (ENOENT). There is nothing to signal,
  // and asking Node to kill it makes it emit a SECOND 'error'.
  if (!child.pid) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  const escalate = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }, CHILD_KILL_GRACE_MS);
  escalate.unref?.();
  child.once('exit', () => clearTimeout(escalate));
}

function appendCapped(current: string, addition: string): string {
  if (current.length >= STDERR_CAP_BYTES) return current;
  return (current + addition).slice(0, STDERR_CAP_BYTES);
}

// =============================================================================
// Persistent meeting session
// =============================================================================

export interface ClaudeCliSessionStatus {
  active: boolean;
  meetingId: string | null;
  /** Turns COMPLETED on this session. */
  turns: number;
  ageMs: number;
  /** True while a turn is being written, read, or drained after a barge-in. */
  busy: boolean;
  model: string | null;
}

/** Per-turn state for the session reader. One at a time, by construction. */
interface SessionTurnState {
  reducer: ClaudeTurnReducer;
  queue: string[];
  /** Terminal frame seen, or the process died. */
  done: boolean;
  /** The consumer stopped listening (barge-in / early return). */
  detached: boolean;
  notify: (() => void) | null;
}

/**
 * ONE `claude` process held open across a meeting, fed one turn at a time.
 *
 * WHY A LONG-LIVED STDIN PROCESS RATHER THAN `--resume`
 *
 * The CLI can also continue a conversation with `--resume <session-id>`, which
 * would give a fresh process per turn. It was rejected on three counts:
 *
 *  1. `--resume` requires the session to be WRITTEN TO DISK, so
 *     `--no-session-persistence` would have to be dropped and every Natively
 *     turn would land in the user's own `~/.claude` history. That is a privacy
 *     regression the isolated path deliberately does not have.
 *  2. It pays the full ~1.4s cold boot on every turn, plus a replay cost that
 *     grows with the conversation — the opposite of what the warm pool exists
 *     to fix.
 *  3. It buys no concurrency: two processes resuming the same session id both
 *     append to it and fork the history, so overlapping turns are no more
 *     serviceable than they are here.
 *
 * Holding stdin open keeps the process warm, keeps history in memory, and
 * keeps `--no-session-persistence`.
 *
 * WHAT A SESSION CANNOT DO
 *
 * It is strictly SERIAL: the CLI reads turns off stdin in order and its output
 * frames carry no request id, so two in-flight turns could not be told apart.
 * Auto Answer prefetches a speculative answer while its judge is still
 * deciding, so overlap is the normal case, not an edge case. The resolution is
 * in ClaudeCliSessionManager.claim(): the second turn does not queue, it runs
 * on its own one-off process. See there for the reasoning.
 */
class ClaudeCliSession {
  private readonly parser = new ClaudeStreamJsonParser();
  private readonly startedAt = Date.now();
  private turnState: SessionTurnState | null = null;
  private stderr = '';
  private turnsDone = 0;
  private busy = false;
  private dead = false;
  private disposed = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    public readonly signature: string,
    public readonly model: string,
    public readonly meetingId: string,
  ) {
    // Listeners live for the whole session, not per turn: the CLI's stdout is
    // one continuous NDJSON stream across every turn, so re-attaching per turn
    // would drop frames that arrive between them.
    this.child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => { this.stderr = appendCapped(this.stderr, chunk.toString()); });
    this.child.once('exit', () => this.onDeath());
    this.child.once('error', () => this.onDeath());
    // stdin stays OPEN — that is the whole mechanism. It also means the
    // process dies on its own if this one does: the pipe closes, the CLI sees
    // EOF, and it exits. That is what keeps a crashed main process from
    // leaving an orphan, since no timer of ours could run to clean it up.
    this.child.stdin.on('error', () => { /* death is handled by 'exit' */ });
  }

  private onStdout(chunk: Buffer): void {
    const state = this.turnState;
    for (const frame of this.parser.push(chunk.toString('utf8'))) {
      // Frames arriving between turns are lifecycle noise (rate-limit events,
      // status). With no turn to attribute them to, dropping is correct.
      if (!state) continue;
      for (const text of state.reducer.accept(frame)) state.queue.push(text);
      if (state.reducer.sawTerminalFrame) state.done = true;
    }
    if (state) this.wake(state);
  }

  private onDeath(): void {
    this.dead = true;
    const state = this.turnState;
    if (state) {
      state.done = true;
      this.wake(state);
    }
  }

  private wake(state: SessionTurnState): void {
    const n = state.notify;
    state.notify = null;
    n?.();
  }

  public get alive(): boolean {
    return !this.dead && !this.disposed && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Caps exceeded, or the process is gone — the manager should recycle it. */
  public get retired(): boolean {
    if (!this.alive) return true;
    if (this.turnsDone >= SESSION_MAX_TURNS) return true;
    return Date.now() - this.startedAt >= SESSION_MAX_AGE_MS;
  }

  public get isBusy(): boolean { return this.busy; }

  /** Turns this session has actually completed. */
  public get completedTurns(): number { return this.turnsDone; }

  public status(): ClaudeCliSessionStatus {
    return {
      active: this.alive,
      meetingId: this.meetingId,
      turns: this.turnsDone,
      ageMs: Date.now() - this.startedAt,
      busy: this.busy,
      model: this.model,
    };
  }

  /**
   * Take the session for exactly one turn, or refuse.
   *
   * Refusal is never a queue. A live interview cannot afford one turn waiting
   * on another; the caller runs a one-off process instead.
   */
  public tryClaim(signature: string): boolean {
    if (!this.alive) return false;
    if (this.busy) return false;
    if (this.retired) return false;
    // argv identity, so a fast-model turn never lands on a session bound to the
    // main model (different --model means a different conversation).
    if (this.signature !== signature) return false;
    this.busy = true;
    return true;
  }

  /** Release a claim that was taken but never run (write failed before start). */
  public abandonClaim(): void {
    this.turnState = null;
    this.busy = false;
  }

  /**
   * Run one turn on this session.
   *
   * Differs from the one-shot path in exactly two ways, both deliberate:
   *  - the process is NOT killed when the turn ends, and
   *  - a consumer that walks away (barge-in) does not end the turn. The reader
   *    keeps draining to the terminal frame in the background so the session is
   *    left in a usable state for the next question. Draining also means the
   *    unshown answer stays in the model's context, which is the honest record
   *    of what happened; the alternative — killing the session on every
   *    barge-in — would throw away the whole meeting's history for one
   *    cancelled answer.
   */
  public async *runTurn(
    turn: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): AsyncGenerator<string, void, unknown> {
    const state: SessionTurnState = {
      reducer: new ClaudeTurnReducer(),
      queue: [],
      done: false,
      detached: false,
      notify: null,
    };
    this.turnState = state;

    // Idle guard: reset on every chunk, so a slow-but-live answer is never cut.
    // Unlike the one-shot path, firing it RETIRES the session — a process that
    // has gone quiet mid-turn can no longer be trusted to be at a turn boundary.
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      timedOut = true;
      this.dispose('turn timed out');
    }, timeoutMs);
    const resetDeadline = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        this.dispose('turn timed out');
      }, timeoutMs);
    };

    let aborted = false;
    const onAbort = () => { aborted = true; this.wake(state); };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      this.child.stdin.write(`${JSON.stringify(turn)}\n`);
    } catch (error: any) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      this.dispose('stdin write failed');
      throw new Error(`Claude Code CLI session write failed: ${error?.message || error}`);
    }

    let emittedAny = false;
    try {
      while (!state.done || state.queue.length > 0) {
        while (state.queue.length > 0) {
          if (aborted) break;
          resetDeadline();
          emittedAny = true;
          yield state.queue.shift()!;
        }
        if (aborted || state.done) break;
        await new Promise<void>(resolve => { state.notify = resolve; });
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (state.done) {
        clearTimeout(timer);
        this.completeTurn(state);
      } else {
        // Consumer gone, turn still running. Keep reading so the session lands
        // back on a turn boundary; `busy` stays true throughout, so an
        // overlapping request falls through to a one-off process rather than
        // interleaving with this drain.
        state.detached = true;
        void this.drainDetached(state, timer);
      }
    }

    if (aborted) return;                 // barge-in: partials already shown stand
    if (timedOut) {
      if (emittedAny) return;
      throw new Error(`Claude Code CLI session timed out after ${timeoutMs}ms with no output.`);
    }
    const failure = state.reducer.error;
    if (failure) {
      if (emittedAny) {
        console.warn('[ClaudeCliService] session turn ended after partial output:', failure.message);
        return;
      }
      throw failure;
    }
    if (!emittedAny) {
      // The process died mid-turn, or answered with nothing at all.
      const detail = this.stderr.trim()
        ? describeClaudeCliFailure(this.child.exitCode, this.stderr, this.model)
        : 'Claude Code CLI session returned an empty response.';
      throw new Error(detail);
    }
  }

  private completeTurn(state: SessionTurnState): void {
    if (this.turnState !== state) return;
    this.turnState = null;
    this.turnsDone += 1;
    this.busy = false;
  }

  /** Read a detached turn to its terminal frame, then free the session. */
  private async drainDetached(state: SessionTurnState, timer: ReturnType<typeof setTimeout>): Promise<void> {
    try {
      while (!state.done) {
        await new Promise<void>(resolve => { state.notify = resolve; });
        state.queue.length = 0; // nobody is listening; do not grow unbounded
      }
    } finally {
      clearTimeout(timer);
      this.completeTurn(state);
    }
  }

  public dispose(reason: string): void {
    if (this.disposed) return;
    this.disposed = true;
    const state = this.turnState;
    if (state) {
      state.done = true;
      this.wake(state);
    }
    this.turnState = null;
    this.busy = false;
    try { this.child.stdin.end(); } catch { /* already gone */ }
    killChild(this.child);
    if (process.env.CLAUDE_CLI_DEBUG) {
      console.log(`[ClaudeCliService] session disposed (${reason}) after ${this.turnsDone} turn(s)`);
    }
  }
}

/**
 * Owns the at-most-one live session.
 *
 * At most one because a session is bound to a meeting and Natively runs one
 * meeting at a time; a map keyed by meeting id would add bookkeeping for a
 * case that cannot occur, and would make "dispose everything on quit" easier
 * to get wrong.
 */
class ClaudeCliSessionManager {
  private static instance: ClaudeCliSessionManager | null = null;
  private session: ClaudeCliSession | null = null;
  /** Enough to rebuild a session after the caps retire one. */
  private spec: { binPath: string; args: readonly string[]; model: string; meetingId: string; maxWarm: number } | null = null;

  public static getInstance(): ClaudeCliSessionManager {
    if (!this.instance) this.instance = new ClaudeCliSessionManager();
    return this.instance;
  }

  public begin(binPath: string, args: readonly string[], model: string, meetingId: string, maxWarm: number): void {
    this.end('replaced');
    this.spec = { binPath, args, model, meetingId, maxWarm };
    this.session = this.spawnSession();
  }

  private spawnSession(): ClaudeCliSession | null {
    const spec = this.spec;
    if (!spec) return null;
    try {
      // Take a PREWARMED process when one is parked: a session that starts on a
      // booted process answers its first turn ~0.9s faster, which matters most
      // for the first question of a meeting.
      const pool = ClaudeCliProcessPool.getInstance();
      const acquired = pool.acquire(spec.binPath, spec.args);
      try { pool.prewarm(spec.binPath, spec.args, spec.maxWarm); } catch { /* best effort */ }
      return new ClaudeCliSession(
        acquired.child,
        ClaudeCliProcessPool.signature(spec.binPath, spec.args),
        spec.model,
        spec.meetingId,
      );
    } catch (e: any) {
      // A session is an optimisation over the isolated path. Failing to start
      // one must never fail the meeting; turns just run isolated.
      console.warn('[ClaudeCliService] could not start meeting session:', e?.message);
      return null;
    }
  }

  /**
   * The session to run this turn on, or null to run it isolated.
   *
   * THE OVERLAP DECISION. Auto Answer starts a speculative answer while the
   * judge is still deciding, so a second turn routinely arrives while the first
   * is in flight. Three options were considered:
   *
   *   queue it      — rejected outright. The whole point of the prefetch is to
   *                   have the answer ready the moment the judge says yes;
   *                   making it wait for the turn it was meant to overlap adds
   *                   the exact latency the feature exists to remove, in the
   *                   one situation (a live interview) where it is least
   *                   affordable.
   *   reject it     — rejected. The prefetch simply would not happen, so
   *                   enabling session mode would silently disable a feature.
   *   run it alone  — CHOSEN. The loser gets its own one-off process, i.e.
   *                   exactly today's isolated behaviour. It is never slower
   *                   than isolated mode and never blocks.
   *
   * What the loser gives up, stated plainly: it does not see the meeting's
   * history, and its own text is not appended to the session, so the session
   * has a gap. For a SPECULATIVE turn that is arguably right — a speculative
   * answer is often discarded, and appending a discarded answer to the meeting
   * context would poison every later turn. It is a real limitation for a
   * genuine back-to-back pair, and it is the price of a serial transport.
   */
  public claim(signature: string): ClaudeCliSession | null {
    const session = this.session;
    if (!session) return null;

    // Recycle FIRST, and only for the reasons that actually make a session
    // unusable: the turn/age caps, or a dead process. Getting this wrong is
    // easy and expensive — an earlier version recycled on any refusal, so a
    // single fast-model turn (different --model, different signature) silently
    // destroyed the meeting's whole history.
    if (session.retired) {
      const servedNothing = session.completedTurns === 0;
      session.dispose('retired');
      // A session that died without ever completing a turn is a broken
      // configuration (bad binary path, a CLI that exits at once), not a
      // used-up one. Respawning it would start a fresh doomed process on every
      // single turn for the rest of the meeting. Stop, and let the isolated
      // path surface the real error — its messages are the actionable ones.
      this.session = servedNothing && !session.alive ? null : this.spawnSession();
      if (!this.session) this.spec = null;
      return null;
    }

    if (session.tryClaim(signature)) return session;

    // Refused but healthy: either busy with an overlapping turn (see the
    // decision above) or bound to a different model. Both run isolated and
    // leave the session exactly as it is.
    return null;
  }

  public end(reason: string): void {
    this.session?.dispose(reason);
    this.session = null;
    this.spec = null;
  }

  public status(): ClaudeCliSessionStatus | null {
    return this.session ? this.session.status() : null;
  }
}

// =============================================================================
// ClaudeCliService — public static surface
// =============================================================================

export class ClaudeCliService {
  /**
   * argv for one non-interactive turn.
   *
   * Every flag here is load-bearing:
   *   -p                          non-interactive
   *   --input-format stream-json  turn arrives on stdin AFTER boot — this is
   *                               what makes the process prewarmable
   *   --output-format stream-json NDJSON frames instead of plain text
   *   --include-partial-messages  emits content_block_delta; without it the
   *                               first text arrives as one whole `assistant`
   *                               frame and word-by-word rendering is lost
   *   --verbose                   required alongside --print + stream-json
   *   --tools ""                  no Bash/Edit/Read. Natively asks questions;
   *                               it must never let the CLI act on the machine
   *   --strict-mcp-config         ignore the user's MCP servers
   *   --setting-sources ""        ignore user/project/local settings and hooks
   *   --no-session-persistence    nothing about a Natively turn is written to
   *                               the user's ~/.claude session history
   *   --system-prompt             replaces the Claude Code coding-agent persona
   *
   * Deliberately does NOT include the per-turn system prompt — that would make
   * the argv (and so the warm-pool key) vary per request. See
   * CLAUDE_CLI_BASE_SYSTEM_PROMPT.
   */
  public static buildArgs(model: string): string[] {
    return [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--tools', '',
      '--strict-mcp-config',
      '--setting-sources', '',
      '--no-session-persistence',
      '--system-prompt', CLAUDE_CLI_BASE_SYSTEM_PROMPT,
      '--model', model,
    ];
  }

  public static normalizeConfig(config: Partial<ClaudeCliConfig> = {}): ClaudeCliConfig {
    const timeoutMs = Number(config.timeoutMs);
    const maxWarm = Number(config.maxWarmProcesses);
    return {
      enabled: !!config.enabled,
      path: (config.path || DEFAULT_CLAUDE_CLI_CONFIG.path).trim() || DEFAULT_CLAUDE_CLI_CONFIG.path,
      model: (config.model || DEFAULT_CLAUDE_CLI_CONFIG.model).trim() || DEFAULT_CLAUDE_CLI_CONFIG.model,
      fastModel: (config.fastModel || DEFAULT_CLAUDE_CLI_CONFIG.fastModel).trim() || DEFAULT_CLAUDE_CLI_CONFIG.fastModel,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_CLAUDE_CLI_CONFIG.timeoutMs,
      // 0 is a MEANINGFUL value ("never prewarm"), so it must survive
      // normalization — hence >= 0 rather than the truthiness check the other
      // numeric field uses. Capped so a typo cannot park 500 node processes.
      maxWarmProcesses: Number.isFinite(maxWarm) && maxWarm >= 0
        ? Math.min(Math.floor(maxWarm), 8)
        : DEFAULT_CLAUDE_CLI_CONFIG.maxWarmProcesses,
      sessionMode: (CLAUDE_CLI_SESSION_MODES as readonly string[]).includes(config.sessionMode as string)
        ? config.sessionMode as ClaudeCliSessionMode
        : DEFAULT_CLAUDE_CLI_CONFIG.sessionMode,
    };
  }

  // ---------------------------------------------------------------------------
  // Binary resolution
  // ---------------------------------------------------------------------------

  /**
   * Common install locations, checked when the configured path does not
   * resolve. Ordered by how explicit the install is.
   *
   * This is not belt-and-braces: a packaged Electron app launched from Finder
   * inherits a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so a bare
   * `claude` that works in the user's terminal ENOENTs inside Natively. The
   * native installer's ~/.local/bin is first because it is where `claude
   * install` puts the binary.
   */
  public static getCandidatePaths(): string[] {
    const home = os.homedir();
    if (process.platform === 'win32') {
      const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
      const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
      return [
        path.join(home, '.local', 'bin', 'claude.exe'),
        path.join(local, 'Programs', 'claude', 'claude.exe'),
        path.join(roaming, 'npm', 'claude.cmd'),
        path.join(local, 'Yarn', 'bin', 'claude.cmd'),
      ];
    }
    return [
      path.join(home, '.local', 'bin', 'claude'),
      path.join(home, '.claude', 'local', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      path.join(home, '.bun', 'bin', 'claude'),
      path.join(home, '.volta', 'bin', 'claude'),
      path.join(home, '.npm-global', 'bin', 'claude'),
      '/usr/bin/claude',
    ];
  }

  /**
   * First location that holds an executable `claude`, or null.
   *
   * PATH is searched FIRST so a dev build (or an app launched from a terminal,
   * which does inherit the user's PATH) uses the same binary the user's shell
   * would, rather than an older copy that happens to sit earlier in the
   * hard-coded candidate list. The candidates are the fallback for the
   * launched-from-Finder case where PATH is `/usr/bin:/bin:/usr/sbin:/sbin`.
   *
   * Purely a filesystem check — does NOT shell out, so it is safe to call on
   * every availability probe.
   */
  public static autoDetectPath(): string | null {
    const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude'];
    const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const dir of pathDirs) {
      for (const name of names) {
        const candidate = path.join(dir, name);
        if (this.isExecutableFile(candidate)) return candidate;
      }
    }
    for (const candidate of this.getCandidatePaths()) {
      if (this.isExecutableFile(candidate)) return candidate;
    }
    return null;
  }

  private static isExecutableFile(candidate: string): boolean {
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) return false;
      if (process.platform === 'win32') return true;
      // eslint-disable-next-line no-bitwise
      return (stat.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  }

  /**
   * Cheap "would a spawn plausibly succeed?" probe, for the per-request
   * availability gate.
   *
   * An explicit path is taken as the user's assertion that it exists — a typo
   * should surface as a real error on the request, not silently drop the
   * provider out of the picker. A BARE command is only credible if we can
   * actually locate it, because seating a provider that is guaranteed to ENOENT
   * costs a wasted attempt and an unhealthy mark on every request.
   */
  public static binaryLooksAvailable(configuredPath: string): boolean {
    const input = (configuredPath || '').trim() || DEFAULT_CLAUDE_CLI_CONFIG.path;
    const explicit = input.includes(path.sep) || (process.platform === 'win32' && input.includes('/'));
    if (explicit) return true;
    try {
      return this.autoDetectPath() !== null;
    } catch {
      return false;
    }
  }

  /**
   * The path to actually spawn.
   *
   * A configured absolute path is honoured as given (so a user who points at a
   * specific build gets that build, and a typo surfaces as a real error rather
   * than being silently "fixed" to some other binary). A BARE command depends
   * on PATH, which is exactly the case that fails inside a packaged app, so
   * that one falls back to auto-detection.
   */
  public static resolvePath(configured: string): string {
    const input = (configured || '').trim() || DEFAULT_CLAUDE_CLI_CONFIG.path;
    if (input.includes(path.sep) || (process.platform === 'win32' && input.includes('/'))) return input;
    return this.autoDetectPath() ?? input;
  }

  /**
   * Run `<bin> --version` and report whether it works.
   *
   * Backs the Settings "Test Connection" button. A bare command that ENOENTs is
   * retried against autoDetectPath() and the working path is returned so the
   * caller can persist it — the same recovery the old subprocess Codex provider
   * did, and the thing that makes the button useful rather than just red.
   */
  public static async validateExecutable(
    input: string,
    timeoutMs = 15_000,
  ): Promise<{ success: boolean; error?: string; resolvedPath?: string; version?: string }> {
    const tryOne = (binPath: string): Promise<{ success: boolean; error?: string; version?: string }> => new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(binPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: os.tmpdir() });
      } catch (e: any) {
        resolve({ success: false, error: `${CLAUDE_CLI_NOT_FOUND_MESSAGE} (tried "${binPath}": ${e?.message || e})` });
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      const settle = (value: { success: boolean; error?: string; version?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        killChild(child);
        settle({ success: false, error: `Claude Code CLI validation timed out for "${binPath}".` });
      }, timeoutMs);
      timer.unref?.();
      child.stdout?.on('data', c => { stdout = appendCapped(stdout, c.toString()); });
      child.stderr?.on('data', c => { stderr = appendCapped(stderr, c.toString()); });
      child.on('error', error => settle({
        success: false,
        error: `${CLAUDE_CLI_NOT_FOUND_MESSAGE} (tried "${binPath}": ${error.message})`,
      }));
      child.on('close', code => {
        if (code === 0) settle({ success: true, version: stdout.trim() || undefined });
        else settle({ success: false, error: describeClaudeCliFailure(code, stderr, binPath) });
      });
    });

    const configured = (input || '').trim() || DEFAULT_CLAUDE_CLI_CONFIG.path;
    const first = await tryOne(configured);
    if (first.success) return { success: true, resolvedPath: configured, version: first.version };

    const looksBare = !configured.includes(path.sep) && !(process.platform === 'win32' && configured.includes('/'));
    if (looksBare) {
      const detected = this.autoDetectPath();
      if (detected && detected !== configured) {
        const second = await tryOne(detected);
        if (second.success) return { success: true, resolvedPath: detected, version: second.version };
      }
    }
    return { success: false, error: first.error };
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  /**
   * Collect the full response into a single string. Thin wrapper over
   * `stream()`. Prefer `stream()` for user-visible surfaces. Signature mirrors
   * CodexCliService.run.
   */
  public static async run(binPath: string, options: ClaudeCliRunOptions): Promise<string> {
    if (options.signal?.aborted) throw new Error('Claude Code request aborted before start.');
    let out = '';
    for await (const chunk of this.stream(binPath, options)) out += chunk;
    return out;
  }

  /**
   * Stream the answer as a series of text deltas.
   *
   * Deltas are yielded the moment they are decoded — nothing is buffered until
   * the process exits. The idle timeout resets on every delta, so a long answer
   * that is actively streaming is never cut off; it only fires when the process
   * has genuinely gone quiet. Same contract as CodexCliService.stream.
   */
  public static async *stream(binPath: string, options: ClaudeCliRunOptions): AsyncGenerator<string, void, unknown> {
    if (options.signal?.aborted) throw new Error('Claude Code request aborted before start.');

    const resolved = this.resolvePath(binPath);
    const args = this.buildArgs(options.model);
    const pool = ClaudeCliProcessPool.getInstance();

    const turn = await this.buildTurnMessage(options);

    // A live meeting session takes this turn when it is free. claim() returns
    // null for every other case — no session, busy with an overlapping turn,
    // caps exceeded, different model — and the one-off path below runs instead.
    // Built the turn FIRST so the claim is never held across an await.
    const session = ClaudeCliSessionManager.getInstance().claim(
      ClaudeCliProcessPool.signature(resolved, args),
    );
    if (session) {
      yield* session.runTurn(turn, options.timeoutMs, options.signal);
      return;
    }

    // Idle-timeout guard, mirroring CodexCliService.stream: the timer RESETS on
    // every yielded delta, so this is a kill for a genuinely stuck process, not
    // a wall-clock cap on the answer.
    const deadlineController = new AbortController();
    let deadlineTimer: ReturnType<typeof setTimeout> = setTimeout(() => deadlineController.abort(), options.timeoutMs);
    const resetDeadline = () => {
      clearTimeout(deadlineTimer);
      deadlineTimer = setTimeout(() => deadlineController.abort(), options.timeoutMs);
    };
    const combined = combineSignals(options.signal, deadlineController.signal);

    const acquired = pool.acquire(resolved, args);
    const child = acquired.child;

    // Replace the process we just took, so the NEXT request is warm too. Done
    // after acquire() and before any awaiting, so the refill overlaps this
    // request's own model latency instead of adding to the next one's.
    const maxWarm = options.maxWarmProcesses ?? DEFAULT_CLAUDE_CLI_CONFIG.maxWarmProcesses;
    try { pool.prewarm(resolved, args, maxWarm); } catch { /* best effort */ }

    const parser = new ClaudeStreamJsonParser();
    // Shared with the persistent-session path — see ClaudeTurnReducer for why
    // the duplicate-suppression rules live in one place.
    const reducer = new ClaudeTurnReducer();
    let stderr = acquired.stderr;
    let emittedAny = false;
    let spawnError: Error | null = null;
    let exitCode: number | null = null;
    let exited = false;

    // Single-slot wakeup, same shape as the pre-rewrite Codex subprocess
    // reader: producers push and wake, the generator drains and sleeps.
    const queue: string[] = [];
    let notify: (() => void) | null = null;
    const wake = () => { const n = notify; notify = null; n?.(); };

    const onStdout = (chunk: Buffer) => {
      for (const frame of parser.push(chunk.toString('utf8'))) {
        for (const text of reducer.accept(frame)) queue.push(text);
      }
      wake();
    };
    const onStderr = (chunk: Buffer) => { stderr = appendCapped(stderr, chunk.toString()); };
    const onError = (error: Error) => {
      spawnError = new Error(`${CLAUDE_CLI_NOT_FOUND_MESSAGE} (tried "${resolved}": ${error.message})`);
      exited = true;
      wake();
    };
    const onExit = (code: number | null) => {
      exitCode = code;
      exited = true;
      // Anything left in the buffer without a trailing newline.
      for (const frame of parser.flush()) {
        for (const text of reducer.accept(frame)) queue.push(text);
      }
      wake();
    };
    const onAbort = () => { killChild(child); wake(); };

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('error', onError);
    child.once('exit', onExit);
    combined.signal.addEventListener('abort', onAbort, { once: true });

    // Write the single user turn and close stdin. One turn per process, always:
    // that is what keeps concurrent requests from sharing context.
    try {
      child.stdin.on('error', (error: Error) => {
        // EPIPE here means the child died before reading the turn; the exit
        // handler produces the real message, so don't clobber it.
        if (!spawnError && (error as NodeJS.ErrnoException).code !== 'EPIPE') {
          spawnError = new Error(`Claude Code CLI stdin failed for "${resolved}": ${error.message}`);
        }
        wake();
      });
      child.stdin.write(`${JSON.stringify(turn)}\n`);
      child.stdin.end();
    } catch (error: any) {
      spawnError = new Error(`Claude Code CLI stdin failed for "${resolved}": ${error.message}`);
      exited = true;
    }

    try {
      while (!exited || queue.length > 0) {
        while (queue.length > 0) {
          resetDeadline();
          emittedAny = true;
          yield queue.shift()!;
        }
        if (exited) break;
        await new Promise<void>(resolve => { notify = resolve; });
      }
    } finally {
      // Runs for EVERY exit path — normal completion, throw, and the consumer
      // breaking out of its `for await` (barge-in). Killing here is what keeps
      // an aborted request from orphaning a `claude` process.
      clearTimeout(deadlineTimer);
      combined.signal.removeEventListener('abort', onAbort);
      combined.dispose();
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('error', onError);
      child.off('exit', onExit);
      killChild(child);
    }

    if (options.signal?.aborted) {
      // Caller asked us to stop. Partials already yielded stand; a throw here
      // would turn a deliberate barge-in into a visible error.
      return;
    }
    if (deadlineController.signal.aborted && !reducer.sawTerminalFrame) {
      if (emittedAny) return;
      throw new Error(`Claude Code CLI timed out after ${options.timeoutMs}ms with no output.`);
    }
    if (spawnError) throw spawnError;
    const streamFailure = reducer.error;
    if (streamFailure) {
      // Same policy as the pre-rewrite Codex reader: once partial output has
      // reached the user, ending the stream beats appending an error to a
      // half-written answer.
      if (emittedAny) {
        console.warn('[ClaudeCliService] stream ended after partial output:', streamFailure.message);
        return;
      }
      throw streamFailure;
    }
    if (exitCode !== null && exitCode !== 0 && !emittedAny) {
      throw new Error(describeClaudeCliFailure(exitCode, stderr, resolved));
    }
    if (!emittedAny) {
      throw new Error(stderr.trim()
        ? describeClaudeCliFailure(exitCode, stderr, resolved)
        : 'Claude Code CLI returned an empty response.');
    }
  }

  /**
   * Spawn `maxWarmProcesses` idle processes now, so the FIRST request is warm
   * too. Called when the provider is enabled or its model changes.
   */
  public static prewarm(config: ClaudeCliConfig): void {
    if (!config.enabled || config.maxWarmProcesses <= 0) return;
    const resolved = this.resolvePath(config.path);
    const pool = ClaudeCliProcessPool.getInstance();
    for (const model of new Set([config.model, config.fastModel])) {
      // Only one per model: parking the full cap for every model would double
      // the idle process count for a fast model that may never be used.
      pool.prewarm(resolved, this.buildArgs(model), 1);
    }
  }

  /** Kill every parked process. Call on quit, on disable, and on path change. */
  public static disposeWarmPool(): void {
    ClaudeCliProcessPool.getInstance().dispose();
  }

  /** Parked process count. Diagnostics and tests only. */
  public static warmPoolSize(): number {
    return ClaudeCliProcessPool.getInstance().size();
  }

  // ---------------------------------------------------------------------------
  // Persistent meeting session
  // ---------------------------------------------------------------------------

  /**
   * Open the meeting session, if this config asks for one.
   *
   * A no-op for `sessionMode: 'isolated'`, for a disabled provider, and when the
   * binary cannot be found — in every one of those cases turns keep running on
   * one-off processes, which is the behaviour with no session at all.
   *
   * `model` is the model the session is BOUND to; it comes from the caller
   * (LLMHelper resolves the selected `claude-cli:<model>` id) rather than from
   * `config.model`, so an explicitly picked model is what the session speaks.
   * The binding matters at meeting end too: the app resets the selected model
   * during teardown, so nothing here may re-read it later.
   */
  public static beginSession(config: ClaudeCliConfig, meetingId: string, model?: string): void {
    // Defensive, per the RAGManager F-411 pattern: a crash or force-quit never
    // ran endSession(), so start is the reliable place to clear a stale one.
    this.endSession('stale session cleared at meeting start');
    if (config.sessionMode !== 'meeting') return;
    if (!config.enabled) return;
    if (!this.binaryLooksAvailable(config.path)) return;
    const resolved = this.resolvePath(config.path);
    const chosen = (model || config.model).trim() || config.model;
    ClaudeCliSessionManager.getInstance().begin(
      resolved,
      this.buildArgs(chosen),
      chosen,
      meetingId,
      config.maxWarmProcesses,
    );
  }

  /** Close the meeting session and kill its process. Safe to call at any time. */
  public static endSession(reason = 'meeting ended'): void {
    ClaudeCliSessionManager.getInstance().end(reason);
  }

  /**
   * Re-open the session against a changed config, keeping the same meeting.
   *
   * Settings can be saved mid-meeting, and LLMHelper.setClaudeCliConfig tears
   * the warm pool down unconditionally when that happens. Without this the live
   * session would either be killed silently (feature off for the rest of the
   * meeting) or left bound to argv the user has just changed. Returns true when
   * a session was carried over.
   */
  public static reapplyConfigToSession(config: ClaudeCliConfig): boolean {
    const current = ClaudeCliSessionManager.getInstance().status();
    if (!current?.meetingId) return false;
    // History cannot survive an argv change — a different --model is a
    // different conversation — so the replacement starts empty. That is
    // strictly better than the alternatives: silently dropping the session, or
    // continuing to speak to a model the user just deselected.
    this.beginSession(config, current.meetingId, current.model ?? undefined);
    return config.sessionMode === 'meeting' && config.enabled;
  }

  /** Live session state, or null. Diagnostics, tests, and the Settings panel. */
  public static sessionStatus(): ClaudeCliSessionStatus | null {
    return ClaudeCliSessionManager.getInstance().status();
  }

  // ---------------------------------------------------------------------------
  // Turn construction
  // ---------------------------------------------------------------------------

  /**
   * The per-turn text. Mirrors LLMHelper.buildCodexCliPrompt — the system
   * prompt is prepended rather than passed as --system-prompt, because argv is
   * the warm-pool key. See CLAUDE_CLI_BASE_SYSTEM_PROMPT.
   */
  public static buildTurnText(prompt: string, instructions?: string): string {
    return [instructions, prompt].filter(Boolean).join('\n\n');
  }

  /** The stdin frame for one user turn, in the CLI's stream-json input shape. */
  private static async buildTurnMessage(options: ClaudeCliRunOptions): Promise<Record<string, unknown>> {
    const content: Array<Record<string, unknown>> = [
      { type: 'text', text: this.buildTurnText(options.prompt, options.instructions) },
    ];

    if (options.imagePaths?.length) {
      let encoded = 0;
      for (const imagePath of options.imagePaths) {
        const block = await this.encodeImageBlock(imagePath);
        if (!block) continue;
        encoded++;
        content.push(block);
      }
      // Images were requested and none survived encoding. Throwing beats
      // sending the prompt alone: a text-only turn returns a confident answer
      // that never saw the screenshot ("I don't see an image"), and the
      // fallback chain records this provider as healthy. Same reasoning, and
      // the same trade-off, as CodexCliService.buildRequestBody.
      if (encoded === 0) {
        throw new Error(
          `Claude Code could not read any of the ${options.imagePaths.length} attached image(s). `
          + 'They may have been cleaned up, be empty, or exceed the size limit.',
        );
      }
    }

    return { type: 'user', message: { role: 'user', content } };
  }

  /**
   * One screenshot as an Anthropic base64 image block, or null to skip it.
   * Downscale-then-JPEG for the same reasons as
   * CodexCliService.encodeImageForRequest — a raw Retina PNG is 5-15 MB and the
   * extra pixels buy nothing above the model's tile budget.
   */
  private static async encodeImageBlock(imagePath: string): Promise<Record<string, unknown> | null> {
    try {
      const compressed = await sharp(imagePath)
        .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: compressed.toString('base64') } };
    } catch (compressErr: any) {
      console.warn(`[ClaudeCliService] Image compression failed, trying raw: ${imagePath}`, compressErr?.message);
    }

    try {
      const raw = await fs.promises.readFile(imagePath);
      if (raw.length > RAW_IMAGE_MAX_BYTES) {
        console.warn(`[ClaudeCliService] Raw image too large to send (${raw.length} bytes), skipping: ${imagePath}`);
        return null;
      }
      if (raw.length < RAW_IMAGE_MIN_BYTES) {
        console.warn(`[ClaudeCliService] Image is empty or truncated (${raw.length} bytes), skipping: ${imagePath}`);
        return null;
      }
      const mediaType = IMAGE_MIME_BY_EXT[path.extname(imagePath).toLowerCase()] || 'image/png';
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data: raw.toString('base64') } };
    } catch (e: any) {
      console.warn(`[ClaudeCliService] Failed to read image, skipping: ${imagePath}`, e?.message);
      return null;
    }
  }
}

// =============================================================================
// Module-private helpers
// =============================================================================

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

interface CombinedSignal {
  readonly signal: AbortSignal;
  dispose(): void;
}

/** AbortSignal.any() is Node 20+; keep our own for compat with the Electron
 *  versions we ship. Copied from CodexCliService so the two stay siblings. */
function combineSignals(...signals: (AbortSignal | undefined)[]): CombinedSignal {
  const filtered = signals.filter((s): s is AbortSignal => !!s);
  const ctrl = new AbortController();
  const onAbort = (e: Event) => ctrl.abort((e.target as AbortSignal)?.reason);
  for (const s of filtered) {
    if (s.aborted) { ctrl.abort(s.reason); break; }
    s.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    dispose() {
      for (const s of filtered) {
        try { s.removeEventListener('abort', onAbort); } catch { /* swallow */ }
      }
    },
  };
}
