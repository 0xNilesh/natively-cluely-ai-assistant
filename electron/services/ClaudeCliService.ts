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
 * ── Prep session (`--resume` / `--fork-session`) ───────────────────────────
 * The THIRD way turns can be linked, and the one a user actually configures.
 * Before an interview you talk to `claude` normally — paste the JD, paste the
 * CV, argue about tone — and hand Natively that session id
 * (`claudeCliSessionId`). At the FIRST turn of a meeting the service runs
 * `--resume <prep-id> --fork-session`, which replays that whole conversation as
 * context and returns a NEW session id; every later turn resumes the FORKED id
 * WITHOUT `--fork-session`, so the meeting accumulates and follow-ups work
 * while the prep session itself is left pristine for the next interview.
 *
 * PRECEDENCE. This supersedes 'meeting' session mode above — both give
 * per-meeting continuity, and running both at once is incoherent (a
 * stdin-held process resuming a session on every turn double-counts the
 * history). When a prep id is set, that is the mechanism for the meeting and
 * beginSession() is a no-op; with a blank prep id, session mode behaves
 * exactly as it does today. One mechanism per meeting, chosen by one setting.
 *
 * Four properties of this path are load-bearing:
 *
 *  - `--fork-session` requires session persistence, so `--no-session-persistence`
 *    is DROPPED here and ONLY here. Meeting turns then land in the user's
 *    ~/.claude — accepted deliberately, because it is also what makes the
 *    forked id worth persisting: `claude --resume <id>` after the interview
 *    puts you back in the exact conversation. A blank prep id keeps
 *    `--no-session-persistence` and nothing about the turn is written.
 *  - The system prompt supplied ON RESUME wins over the one the session was
 *    created with (verified, `claude` 2.1.252). So Natively keeps passing its
 *    own `--system-prompt`: the prep session supplies CONTEXT, this persona
 *    still governs BEHAVIOUR. There is no conflict to design around — but it
 *    does mean the prep conversation is replayed VERBATIM, tool calls and file
 *    reads included, which is why the settings field tells the user to seed a
 *    clean conversation rather than a working session.
 *  - Resumed turns are NOT prewarmed. A parked process is booted before its
 *    turn is written, so one parked with `--resume <forked-id>` could have
 *    snapshotted the session before the PREVIOUS turn appended to it. Paying
 *    the cold boot beats risking an answer against a stale conversation.
 *  - The judge NEVER travels this path. See ClaudeCliRunOptions.isolated.
 *
 * Measured on `claude` 2.1.252 (2026-09-01), median of 4, against realistic
 * prep conversations of ~9.7k and ~31.7k tokens:
 *
 *   no prep session (today)          TTFT 1.9s   total 8.3s
 *   fork from 9.7k prep              TTFT 2.2s   total 5.2s
 *   fork from 31.7k prep             TTFT 2.6s   total 5.6s
 *   resume forked, 10.1k             TTFT 2.8s   total 3.9s
 *   resume forked, 32.2k             TTFT 2.6s   total 3.9s
 *
 * So the replay costs ~0.3-0.9s of TTFT and is nearly flat in prep size — the
 * whole conversation comes back as a prompt-cache read. A blank prep id opts
 * out of even that.
 *
 * ── Effort ─────────────────────────────────────────────────────────────────
 * `--effort low|medium|high|xhigh|max` is ORTHOGONAL to `--model`: it changes
 * how much the model deliberates, not which model runs, so `opus` at `low` is
 * a valid and useful combination and effort must never be implemented as a
 * model downgrade. 'default' means "do not pass the flag at all", which is
 * distinct from every level. Measured on this workload (2026-09-01): on a
 * normal conversational interview question it changes nothing measurable (0
 * thinking tokens at both low and high); on a genuinely hard design question
 * `high` roughly doubles total answer time (~7.7s → ~14.8s) for ~3x the output
 * and ~500-800 thinking tokens. Effort is in argv, so it is part of the
 * warm-pool key — changing it mid-meeting costs one cold spawn.
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
/**
 * The prep session id in Settings does not resolve to a conversation.
 *
 * This one is deliberately LOUD rather than a silent degradation. The user
 * configured a prep session precisely so answers would be grounded in it;
 * quietly running without it returns confident, generic answers and nothing
 * anywhere says the context was missing. Failing the turn is recoverable in
 * seconds (fix the id, or clear it); a meeting's worth of ungrounded answers
 * is not.
 */
export const CLAUDE_CLI_PREP_SESSION_MISSING_MESSAGE =
  'The Claude Code prep session was not found. Check the session ID in '
  + 'Settings → AI Providers, or clear it to answer without prep context.';

/** True when `err` is one of the actionable Claude CLI failures above. */
export function isClaudeCliError(err: unknown): boolean {
  const message = (err as { message?: unknown } | null | undefined)?.message;
  if (typeof message !== 'string') return false;
  return message.includes(CLAUDE_CLI_NOT_FOUND_MESSAGE)
    || message.includes(CLAUDE_CLI_NOT_SIGNED_IN_MESSAGE)
    || message.includes(CLAUDE_CLI_PREP_SESSION_MISSING_MESSAGE);
}

/**
 * Per-turn deliberation, passed as `--effort`.
 *
 * 'default' is NOT a level — it means "omit the flag", which is distinct from
 * asking for any particular amount and is how the setting stays inert for
 * users who never touch it. Mirrors the `'none'` sentinel in
 * `codexCliModelReasoningEffort`, renamed because `--effort` has no `none`
 * level and "none" would read as "think as little as possible".
 */
export type ClaudeCliEffort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const CLAUDE_CLI_EFFORT_LEVELS: readonly ClaudeCliEffort[] =
  ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

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
  /**
   * Prep conversation to ground every answer in, resumed and forked at meeting
   * start. See the header. BLANK (the default) MEANS EXACTLY TODAY'S BEHAVIOUR
   * — no resume, no replay, `--no-session-persistence` retained, no latency
   * cost — and that is the property that makes the replay cost a user choice
   * rather than something imposed. Do not give this a non-empty default.
   */
  prepSessionId: string;
  /** Per-turn deliberation. 'default' omits `--effort`. See ClaudeCliEffort. */
  effort: ClaudeCliEffort;
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
  /** Per-turn deliberation for THIS call. Omitted/'default' passes no --effort. */
  effort?: ClaudeCliEffort;
  /**
   * This turn must not touch ANY per-meeting continuity mechanism — no prep
   * session, no stdin session, `--no-session-persistence` retained.
   *
   * Set by every caller that is not a live answer, and load-bearing for
   * exactly one of them: Auto Answer's judge. The judge only classifies "is
   * this a question worth answering", it does not need 20k tokens of prep
   * context for a yes/no, and it is the ONLY caller that genuinely overlaps
   * another turn — a session is strictly serial and its frames carry no
   * request id, so keeping the judge out is what makes one per-meeting session
   * safe at all. (It was NOT out before this flag existed: the judge falls
   * through to `generateContentStructured`, which routes to this provider at
   * Priority 0 whenever a claude-cli model is selected, and its argv matched
   * the meeting session's signature exactly — so on a Gemini-less install
   * every judge verdict was landing in the meeting conversation.)
   */
  isolated?: boolean;
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
  // Blank = today's behaviour, exactly. See ClaudeCliConfig.prepSessionId.
  prepSessionId: '',
  // 'default' = no --effort flag, i.e. whatever the CLI does on its own.
  effort: 'default',
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
  /** Present on `system`/`init` and on `result`. See extractClaudeSessionId. */
  session_id?: string;
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
 * Placeholder for an `is_error` result frame that carries no message at all.
 *
 * Not cosmetic: `--resume` of a session that does not exist produces exactly
 * that frame (`subtype: "error_during_execution"`, no `result` field) and puts
 * the real sentence — "No conversation found with session ID: …" — on STDERR.
 * stream() therefore treats this specific string as "the frame knows nothing",
 * and lets describeClaudeCliFailure read stderr instead. Exported so that
 * deference cannot silently stop matching after a reword.
 */
export const CLAUDE_CLI_UNEXPLAINED_ERROR = 'Claude Code reported an error but gave no message.';

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
    return CLAUDE_CLI_UNEXPLAINED_ERROR;
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
 * The session id a frame reports, or ''.
 *
 * Both the `system`/`init` frame and the terminal `result` frame carry it, and
 * with `--fork-session` both carry the NEW id rather than the one that was
 * resumed — which is the whole mechanism by which a forked meeting session
 * becomes knowable. `init` arrives first, so the id is available long before
 * the answer finishes; the `result` frame is read too, so a CLI that ever
 * stops emitting `init` cannot silently lose the capture.
 *
 * Only accepted from those two frame types. Subagent and tool frames can also
 * carry a `session_id`, and adopting one of those as the meeting's id would
 * point the persisted "resume your interview" link at the wrong conversation.
 */
export function extractClaudeSessionId(frame: ClaudeStreamFrame): string {
  if (!frame || typeof frame !== 'object') return '';
  if (frame.parent_tool_use_id) return '';
  const isInit = frame.type === 'system' && frame.subtype === 'init';
  if (!isInit && frame.type !== 'result') return '';
  const id = (frame as { session_id?: unknown }).session_id;
  return typeof id === 'string' && id.trim() ? id.trim() : '';
}

/**
 * True when a CLI failure means "that session id does not exist".
 *
 * `claude --resume <unknown-uuid>` exits 1 with
 * `No conversation found with session ID: <id>` (verified, 2.1.252). Matched
 * on the stable half of the sentence so a reworded suffix still classifies.
 */
export function looksLikeMissingSessionError(text: string): boolean {
  const lower = (text || '').toLowerCase();
  return lower.includes('no conversation found')
    || (lower.includes('session') && lower.includes('not found'));
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
  // Before the auth arm: a dead prep session id is a CONFIGURATION problem the
  // user can fix in one field, and "not signed in" would send them to a
  // terminal to re-login for no reason.
  if (looksLikeMissingSessionError(text)) {
    return `${CLAUDE_CLI_PREP_SESSION_MISSING_MESSAGE} (${truncate(text, 200)})`;
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
// Prep session (--resume / --fork-session)
// =============================================================================

/** What the meeting detail page and the Settings panel need to show. */
export interface ClaudeCliPrepSessionStatus {
  meetingId: string;
  /** The configured prep conversation this meeting was forked from. */
  prepSessionId: string;
  /** The forked, per-meeting id. null until the first turn has completed. */
  forkedSessionId: string | null;
  /** Turns served on the forked session. */
  turns: number;
  /** Sticky failure. Non-null means every later turn is refused, loudly. */
  failure: string | null;
  /**
   * Prompt tokens the CLI reported reading back on the last completed turn —
   * i.e. what the prep conversation actually costs per turn. Falls out of the
   * `result` frame the capture already parses; nothing counts tokens for it.
   */
  lastContextTokens: number | null;
}

/**
 * How one turn should be attached to the prep/meeting conversation.
 *
 * `capture` is true for exactly one turn per meeting — the fork — because the
 * id that comes back from it IS the meeting. `owned` says whether this plan
 * holds the serialisation slot, so release() knows whether it may clear it.
 */
interface ClaudeCliResumePlan {
  resumeSessionId: string;
  fork: boolean;
  capture: boolean;
  owned: boolean;
}

/**
 * Owns the at-most-one armed prep session, for the same reason
 * ClaudeCliSessionManager owns at most one live session: Natively runs one
 * meeting at a time, and a map keyed by meeting id would add bookkeeping for a
 * case that cannot happen while making "forget everything on quit" easier to
 * get wrong.
 *
 * THE OVERLAP DECISION, again, and it lands somewhere different from
 * ClaudeCliSessionManager.claim(). Two processes resuming the SAME id both
 * append to it and fork its history unpredictably, so overlapping turns cannot
 * share the meeting session either. But here the loser has a better option
 * than running with no context at all: it resumes the PREP id with
 * `--fork-session`, which is a pure read of the prep conversation (forking
 * writes a new file, it does not mutate the source), so the overlapping turn
 * keeps the full prep grounding. What it gives up is the meeting's own
 * history, and its answer is not appended to the meeting session — the same
 * gap session mode already accepts, and the right trade for a SPECULATIVE turn
 * that is often discarded. Queueing was rejected for the reason it is always
 * rejected here: a live interview cannot afford one turn waiting on another.
 */
class ClaudeCliPrepSessionManager {
  private static instance: ClaudeCliPrepSessionManager | null = null;

  private state: {
    meetingId: string;
    prepSessionId: string;
    forkedSessionId: string | null;
    turns: number;
    inFlight: boolean;
    failure: string | null;
    lastContextTokens: number | null;
  } | null = null;

  /**
   * The forked id of the meeting that just ended.
   *
   * Needed because the two events happen in the wrong order for a simple
   * read-then-clear: endMeeting kills the session in its SYNCHRONOUS section
   * (main.ts, so the process dies immediately and the model reset that follows
   * cannot corrupt it), while the meeting row is written later, from
   * MeetingPersistence.stopMeeting. Without this the id would always be gone by
   * the time anything wanted to persist it.
   *
   * Cleared at every meeting start — including a meeting with no prep session
   * at all, which is the case that would otherwise stamp the PREVIOUS
   * interview's session id onto an unrelated meeting row.
   */
  private lastForkedSessionId: string | null = null;

  public static getInstance(): ClaudeCliPrepSessionManager {
    if (!this.instance) this.instance = new ClaudeCliPrepSessionManager();
    return this.instance;
  }

  /** Arm the prep session for a meeting. A blank id disarms. */
  public begin(meetingId: string, prepSessionId: string): void {
    const trimmed = (prepSessionId || '').trim();
    if (!trimmed) {
      this.end('no prep session configured');
      this.lastForkedSessionId = null;
      return;
    }
    this.lastForkedSessionId = null;
    this.state = {
      meetingId,
      prepSessionId: trimmed,
      forkedSessionId: null,
      turns: 0,
      inFlight: false,
      failure: null,
      lastContextTokens: null,
    };
  }

  public end(reason: string): void {
    if (this.state && process.env.CLAUDE_CLI_DEBUG) {
      console.log(`[ClaudeCliService] prep session released (${reason}) after ${this.state.turns} turn(s)`);
    }
    if (this.state?.forkedSessionId) this.lastForkedSessionId = this.state.forkedSessionId;
    this.state = null;
  }

  /** Forget a finished meeting's forked id. See lastForkedSessionId. */
  public forgetLastMeeting(): void {
    this.lastForkedSessionId = null;
  }

  public get armed(): boolean { return this.state !== null; }

  /** Sticky failure, or null. Read by stream() BEFORE it spawns anything. */
  public get failure(): string | null { return this.state?.failure ?? null; }

  /** The forked meeting session id — live, or the one the last meeting ended with. */
  public get forkedSessionId(): string | null {
    return this.state?.forkedSessionId ?? this.lastForkedSessionId;
  }

  public status(): ClaudeCliPrepSessionStatus | null {
    const s = this.state;
    if (!s) return null;
    return {
      meetingId: s.meetingId,
      prepSessionId: s.prepSessionId,
      forkedSessionId: s.forkedSessionId,
      turns: s.turns,
      failure: s.failure,
      lastContextTokens: s.lastContextTokens,
    };
  }

  /**
   * Record a failure that must stop every later turn.
   *
   * Sticky ON PURPOSE. A bad prep id fails identically on every turn, so
   * retrying it silently would spend the whole meeting spawning doomed
   * processes while the user watches answers not arrive. One loud refusal that
   * names the fix beats a hundred quiet ones.
   */
  public noteFailure(message: string): void {
    if (this.state && !this.state.failure) this.state.failure = message;
  }

  /** The plan for one turn, or null when there is no prep session to use. */
  public planTurn(): ClaudeCliResumePlan | null {
    const s = this.state;
    if (!s || s.failure) return null;

    if (s.inFlight) {
      // Overlap. Fork the prep conversation again rather than touching the
      // meeting session concurrently — see the class comment.
      return { resumeSessionId: s.prepSessionId, fork: true, capture: false, owned: false };
    }

    s.inFlight = true;
    if (s.forkedSessionId) {
      return { resumeSessionId: s.forkedSessionId, fork: false, capture: false, owned: true };
    }
    return { resumeSessionId: s.prepSessionId, fork: true, capture: true, owned: true };
  }

  /**
   * End a turn.
   *
   * `sessionId` is adopted as the meeting's id only for a capturing turn that
   * actually SUCCEEDED. A failed `--resume` still reports a session_id (the
   * one it was asked for, which by then is known not to exist), so capturing
   * unconditionally would persist a dead id onto the meeting row and hand the
   * user a "resume your interview" link that resolves to nothing.
   */
  public release(plan: ClaudeCliResumePlan, outcome: { sessionId: string | null; failed: boolean; contextTokens?: number | null }): void {
    const s = this.state;
    if (!s) return;
    if (plan.owned) s.inFlight = false;
    if (outcome.failed) return;
    if (plan.capture && outcome.sessionId) s.forkedSessionId = outcome.sessionId;
    if (plan.owned) s.turns += 1;
    if (typeof outcome.contextTokens === 'number' && outcome.contextTokens > 0) {
      s.lastContextTokens = outcome.contextTokens;
    }
  }
}

/**
 * Prompt tokens a `result` frame says this turn actually read.
 *
 * Cache reads plus fresh input, because from the user's point of view the prep
 * conversation costs the same whether it was cached or not — it is the size of
 * what gets replayed. Returns null when the frame carries no usage.
 */
function extractClaudeContextTokens(frame: ClaudeStreamFrame): number | null {
  if (!frame || frame.type !== 'result') return null;
  const usage = (frame as { usage?: Record<string, unknown> }).usage;
  if (!usage || typeof usage !== 'object') return null;
  const sum = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
    .reduce((acc, key) => acc + (typeof usage[key] === 'number' ? usage[key] as number : 0), 0);
  return sum > 0 ? sum : null;
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
   *
   * The two OPTIONAL flags, both absent by default so that calling this with a
   * model alone still produces byte-for-byte today's argv:
   *
   *   --effort <level>            per-turn deliberation, ORTHOGONAL to --model.
   *                               Omitted entirely at 'default'.
   *   --resume <id> [--fork-session]
   *                               continue the prep/meeting conversation. This
   *                               arm DROPS --no-session-persistence, because
   *                               --fork-session cannot write a forked session
   *                               without it — the one place a Natively turn is
   *                               allowed to reach ~/.claude, and only when the
   *                               user has configured a prep session.
   */
  public static buildArgs(
    model: string,
    options: { effort?: ClaudeCliEffort; resume?: { sessionId: string; fork: boolean } } = {},
  ): string[] {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--tools', '',
      '--strict-mcp-config',
      '--setting-sources', '',
    ];

    if (options.resume?.sessionId) {
      args.push('--resume', options.resume.sessionId);
      if (options.resume.fork) args.push('--fork-session');
    } else {
      args.push('--no-session-persistence');
    }

    args.push('--system-prompt', CLAUDE_CLI_BASE_SYSTEM_PROMPT, '--model', model);

    // After --model, so the ORDER states the relationship: effort is a
    // separate axis applied on top of whatever model was chosen, never a
    // substitute for choosing a smaller one.
    if (options.effort && options.effort !== 'default') args.push('--effort', options.effort);

    return args;
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
      // Trimmed, never defaulted: '' is the meaningful value (no prep session,
      // today's behaviour) and must survive normalization untouched.
      prepSessionId: typeof config.prepSessionId === 'string' ? config.prepSessionId.trim() : '',
      effort: (CLAUDE_CLI_EFFORT_LEVELS as readonly string[]).includes(config.effort as string)
        ? config.effort as ClaudeCliEffort
        : DEFAULT_CLAUDE_CLI_CONFIG.effort,
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
    const pool = ClaudeCliProcessPool.getInstance();
    const prep = ClaudeCliPrepSessionManager.getInstance();

    // Refuse BEFORE spawning anything. A prep session that has already failed
    // once fails identically every time, and the whole point of configuring
    // one is that answers are grounded in it — so this throws rather than
    // quietly producing a generic answer nobody can tell is ungrounded.
    if (!options.isolated && prep.failure) throw new Error(prep.failure);

    // Turn FIRST, for the same reason the session claim is taken after it: this
    // await can throw (every attached image failed to encode), and a plan taken
    // before it would leave the prep session's in-flight slot held forever —
    // every later turn of the meeting would then take the overlap path and lose
    // the meeting's own history.
    const turn = await this.buildTurnMessage(options);

    // Isolated callers (Auto Answer's judge above all — see
    // ClaudeCliRunOptions.isolated) never see a prep session and never claim
    // the stdin session. Resolved once, here, so both mechanisms are gated by
    // the same flag and neither can be exempted by accident later.
    const plan = options.isolated ? null : prep.planTurn();
    const args = this.buildArgs(options.model, {
      effort: options.effort,
      resume: plan ? { sessionId: plan.resumeSessionId, fork: plan.fork } : undefined,
    });

    // A live meeting session takes this turn when it is free. claim() returns
    // null for every other case — no session, busy with an overlapping turn,
    // caps exceeded, different model — and the one-off path below runs instead.
    // Built the turn FIRST so the claim is never held across an await.
    //
    // Skipped entirely on the prep path: the two mechanisms are alternatives,
    // not layers, and a stdin-held process that also resumed a session on
    // every turn would replay the conversation on top of the copy it is
    // already holding. begin()/beginSession() keep them mutually exclusive at
    // meeting start; this is the belt to that braces.
    const session = (options.isolated || plan)
      ? null
      : ClaudeCliSessionManager.getInstance().claim(
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

    // acquire() can throw synchronously (spawn ENOENT on a bad binary path).
    // The plan's in-flight slot is taken by now, and the try/finally that
    // normally releases it starts further down — so release here or every later
    // turn of the meeting silently takes the overlap path.
    let acquired: { child: ChildProcessWithoutNullStreams; warm: boolean; stderr: string };
    try {
      acquired = pool.acquire(resolved, args);
    } catch (error) {
      if (plan) prep.release(plan, { sessionId: null, failed: true });
      clearTimeout(deadlineTimer);
      combined.dispose();
      throw error;
    }
    const child = acquired.child;

    // Replace the process we just took, so the NEXT request is warm too. Done
    // after acquire() and before any awaiting, so the refill overlaps this
    // request's own model latency instead of adding to the next one's.
    //
    // NOT on the resume path. A parked process boots — and, resuming, reads the
    // session — before its turn is ever written, so one parked now would hold a
    // snapshot taken BEFORE this turn appends to the session, and would answer
    // the next question against a conversation missing the last exchange. The
    // ~0.9s cold boot is the price of a turn that sees what actually happened.
    const maxWarm = plan ? 0 : (options.maxWarmProcesses ?? DEFAULT_CLAUDE_CLI_CONFIG.maxWarmProcesses);
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
    // Captured from the init/result frames on the resume path. See
    // extractClaudeSessionId — with --fork-session this is the NEW id, which
    // becomes the meeting's session.
    let observedSessionId: string | null = null;
    let observedContextTokens: number | null = null;

    // Single-slot wakeup, same shape as the pre-rewrite Codex subprocess
    // reader: producers push and wake, the generator drains and sleeps.
    const queue: string[] = [];
    let notify: (() => void) | null = null;
    const wake = () => { const n = notify; notify = null; n?.(); };

    // Only read on the resume path. Split out so both the streaming and the
    // flush-on-exit decode go through the same capture, rather than the
    // trailing frame quietly not counting.
    const observeFrame = (frame: ClaudeStreamFrame) => {
      if (!plan) return;
      const id = extractClaudeSessionId(frame);
      if (id) observedSessionId = id;
      const tokens = extractClaudeContextTokens(frame);
      if (tokens !== null) observedContextTokens = tokens;
    };

    const onStdout = (chunk: Buffer) => {
      for (const frame of parser.push(chunk.toString('utf8'))) {
        observeFrame(frame);
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
        observeFrame(frame);
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

      if (plan) {
        // "Failed" narrowly: the turn never attached to the session. A
        // BARGE-IN is not a failure — the fork happened, the id is real, and
        // the partial answer is genuinely in the conversation — so it still
        // captures, which is what keeps a cancelled first question from
        // orphaning the meeting's session id.
        const failed = !!spawnError
          || (!emittedAny && (!!reducer.error || (exitCode !== null && exitCode !== 0)));
        prep.release(plan, {
          sessionId: observedSessionId,
          failed,
          contextTokens: observedContextTokens,
        });
        // Sticky ONLY for the configuration failure. A transient error (a
        // model hiccup, a dropped connection) must leave the prep session
        // armed so the next turn retries; a prep id that does not resolve will
        // never resolve, and retrying it silently for a whole meeting is the
        // outcome this refuses.
        if (failed && looksLikeMissingSessionError(stderr)) {
          prep.noteFailure(describeClaudeCliFailure(exitCode, stderr, resolved));
        }
      }
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
      // An is_error frame that carries no message says only THAT it failed —
      // which is exactly the shape `--resume <missing-id>` produces, with the
      // usable sentence on stderr. Defer to stderr in that one case so the
      // user is told the prep session is missing instead of "Claude Code
      // reported an error but gave no message." A frame that DID explain
      // itself still wins, per extractClaudeStreamError.
      if (streamFailure.message.includes(CLAUDE_CLI_UNEXPLAINED_ERROR) && stderr.trim()) {
        throw new Error(describeClaudeCliFailure(exitCode, stderr, resolved));
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
      // Effort is part of argv, so it is part of the pool key — park for the
      // CONFIGURED effort or the warm process is never the one a request asks
      // for. (A mid-meeting effort change therefore costs one cold spawn; that
      // is the price of a control the user can move between questions.)
      pool.prewarm(resolved, this.buildArgs(model, { effort: config.effort }), 1);
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
   *
   * A configured PREP SESSION supersedes this entirely — see beginPrepSession
   * and the header. Both mechanisms give per-meeting continuity and running
   * them together would replay the conversation on top of the copy the held
   * process already has, so exactly one is armed per meeting.
   */
  public static beginSession(config: ClaudeCliConfig, meetingId: string, model?: string): void {
    // Defensive, per the RAGManager F-411 pattern: a crash or force-quit never
    // ran endSession(), so start is the reliable place to clear a stale one.
    this.endSession('stale session cleared at meeting start');
    if (config.prepSessionId) return;
    if (config.sessionMode !== 'meeting') return;
    if (!config.enabled) return;
    if (!this.binaryLooksAvailable(config.path)) return;
    const resolved = this.resolvePath(config.path);
    const chosen = (model || config.model).trim() || config.model;
    ClaudeCliSessionManager.getInstance().begin(
      resolved,
      this.buildArgs(chosen, { effort: config.effort }),
      chosen,
      meetingId,
      config.maxWarmProcesses,
    );
  }

  // ---------------------------------------------------------------------------
  // Prep session
  // ---------------------------------------------------------------------------

  /**
   * Arm the configured prep session for a meeting, or disarm if there is none.
   *
   * Called unconditionally at meeting start — including with a blank prep id,
   * which is what clears a previous meeting's fork. A crash or force-quit never
   * ran endPrepSession(), so start is the only reliable place to do it (the
   * same RAGManager F-411 reasoning as beginSession).
   *
   * Returns the actionable error when the configured id does not resolve to a
   * conversation on disk, so the caller can tell the user NOW rather than
   * letting them find out one unanswered question at a time. The check is a
   * filesystem lookup, never a subprocess: meeting start is latency-critical
   * and a `claude --resume` probe would cost a full cold boot plus an API call.
   */
  public static beginPrepSession(config: ClaudeCliConfig, meetingId: string): string | null {
    const manager = ClaudeCliPrepSessionManager.getInstance();
    manager.end('stale prep session cleared at meeting start');
    // Before every early return below. A meeting that uses no prep session must
    // not inherit the previous interview's forked id and stamp it on its own
    // row — the user would follow that link into someone else's conversation.
    manager.forgetLastMeeting();
    if (!config.enabled) return null;
    const prepId = (config.prepSessionId || '').trim();
    if (!prepId) return null;

    manager.begin(meetingId, prepId);
    const located = this.locateSessionTranscript(prepId);
    // `checked: false` means ~/.claude could not be read at all (no such
    // directory, a sandbox, a relocated HOME). That is NOT evidence the session
    // is missing, and failing the meeting on it would be a false alarm the user
    // cannot act on. Stay armed and let the turn-time `--resume` — which is
    // authoritative — be the one to refuse.
    if (!located.checked || located.path) return null;

    // Arm-then-fail rather than never arm: the sticky failure is what makes
    // every turn of this meeting refuse loudly. Arming and then falling back to
    // ungrounded answers is the one outcome this must not produce.
    const message = `${CLAUDE_CLI_PREP_SESSION_MISSING_MESSAGE} (id: ${prepId})`;
    manager.noteFailure(message);
    return message;
  }

  /** Release the prep session. Safe to call at any time. */
  public static endPrepSession(reason = 'meeting ended'): void {
    ClaudeCliPrepSessionManager.getInstance().end(reason);
  }

  /** Live prep-session state, or null. Diagnostics, tests, and persistence. */
  public static prepSessionStatus(): ClaudeCliPrepSessionStatus | null {
    return ClaudeCliPrepSessionManager.getInstance().status();
  }

  /**
   * The forked, per-meeting session id, once the first turn has produced one.
   *
   * This is what gets persisted on the meeting row: paste it into
   * `claude --resume <id>` after the interview and you are back in the exact
   * conversation, every question and every answer.
   */
  public static meetingSessionId(): string | null {
    return ClaudeCliPrepSessionManager.getInstance().forkedSessionId;
  }

  /**
   * Look for a session id's transcript under `~/.claude`.
   *
   * Sessions are stored per PROJECT (`~/.claude/projects/<slug>/<uuid>.jsonl`)
   * but `--resume <id>` resolves an explicit id from ANY working directory —
   * verified 2026-09-01, resuming from /tmp a session created elsewhere — so
   * this searches every project rather than deriving a slug from a cwd that
   * would be wrong anyway (Natively spawns in os.tmpdir(); see spawnClaude).
   *
   * `checked` is the important half of the return. It separates "looked, and
   * the session is not there" (worth failing on) from "could not look at all"
   * (worth saying nothing about). Collapsing the two into a bare null is how a
   * user with a relocated HOME would be told their perfectly good session id
   * was invalid.
   */
  public static locateSessionTranscript(sessionId: string): { checked: boolean; path: string | null } {
    const id = (sessionId || '').trim();
    // Path-segment characters in a config field must never reach a join(): a
    // value like '../../x' would walk out of ~/.claude entirely. A malformed id
    // is genuinely not a session, so this counts as a completed check.
    if (!id || id.includes('/') || id.includes('\\') || id.includes('..')) {
      return { checked: true, path: null };
    }
    let entries: fs.Dirent[];
    const projects = path.join(os.homedir(), '.claude', 'projects');
    try {
      entries = fs.readdirSync(projects, { withFileTypes: true });
    } catch {
      return { checked: false, path: null };
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(projects, entry.name, `${id}.jsonl`);
      try {
        if (fs.existsSync(candidate)) return { checked: true, path: candidate };
      } catch { /* unreadable project dir — keep looking */ }
    }
    return { checked: true, path: null };
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
   * per-meeting continuity is still active afterwards.
   */
  public static reapplyConfigToSession(config: ClaudeCliConfig): boolean {
    const prep = ClaudeCliPrepSessionManager.getInstance().status();
    const current = ClaudeCliSessionManager.getInstance().status();
    const meetingId = prep?.meetingId ?? current?.meetingId ?? null;
    if (!meetingId) return false;

    // An armed prep session whose ID DID NOT CHANGE is left completely alone.
    // Re-arming would drop the forked id, and the fork IS the interview — a
    // user who saved an unrelated setting (effort, timeout, warm count) two
    // questions into a meeting would silently lose every answer so far from the
    // conversation, and the persisted "resume your interview" id with it. Only
    // a genuine change of prep session justifies starting over.
    if (prep && prep.prepSessionId === config.prepSessionId && config.enabled) {
      return true;
    }

    // Prep changed (set, cleared, or replaced): re-arm from scratch. Ordered
    // prep-first because beginSession() defers to a configured prep id.
    this.beginPrepSession(config, meetingId);
    // History cannot survive an argv change — a different --model is a
    // different conversation — so the replacement starts empty. That is
    // strictly better than the alternatives: silently dropping the session, or
    // continuing to speak to a model the user just deselected.
    this.beginSession(config, meetingId, current?.model ?? undefined);
    if (!config.enabled) return false;
    return !!config.prepSessionId || config.sessionMode === 'meeting';
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
