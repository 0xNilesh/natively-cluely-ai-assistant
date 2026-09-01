/**
 * WHY `canAutoAnswer()` said no.
 *
 * The gate returned a bare boolean and the pipeline logged a bare
 * `engine_busy_or_cooling`, which made a legitimate 800 ms throttle
 * indistinguishable from a permanently wedged busy flag. A live session could
 * refuse every dispatch for an entire meeting and the record looked exactly
 * like healthy pacing — which is how the dispatch bug survived so long.
 *
 * Split out as a pure function for the same reason as autoAnswerGate.ts: every
 * branch is reachable from a test, and both the log line and the
 * `auto_answer_ignored` telemetry read the SAME description, so the console and
 * the record can never disagree about why an answer did not fire.
 */

export type AutoAnswerBusyCode =
    /** A What-to-Answer run genuinely owns the engine (manual, automatic or speculative). */
    | 'answer_in_flight'
    /**
     * `activeMode` says a What-to-Answer run owns the engine, but NOTHING holds
     * the cancellation slot — so no run will ever release it.
     *
     * This is the wedge: `runWhatShouldISay` set the mode before its first
     * await and abandoned the request through a path that did not restore it
     * (superseded generation, aborted stream, empty-context speculative
     * return). `SimpleAutoAnswer` is woken by the `mode_changed('idle')` event,
     * so a wedged flag both fails `canAutoAnswer()` and removes the wake-up:
     * every later verdict parks for RETRY_TTL_MS and reports
     * `engine_busy_or_cooling` for the rest of the meeting.
     *
     * `runWhatShouldISay` now restores the mode in its `finally`, so this code
     * should be unreachable. It stays as the tripwire that NAMES any residual
     * leak instead of hiding it behind the generic busy reason.
     */
    | 'mode_wedged'
    /** Recap / follow-up / clarify / brainstorm owns the engine. */
    | 'mode_other'
    /** The automatic-trigger cooldown has not elapsed. This one is legitimate pacing. */
    | 'trigger_cooldown';

export interface AutoAnswerBusyReason {
    code: AutoAnswerBusyCode;
    /** `IntelligenceEngine.activeMode` at the moment of the check. */
    mode: string;
    /** Whether a What-to-Answer request still owns the cancellation slot. */
    answerInFlight: boolean;
    /** Milliseconds left on the automatic-trigger cooldown (0 unless that is the blocker). */
    cooldownRemainingMs: number;
}

export interface AutoAnswerBusyInput {
    /** `activeMode`. 'idle' and 'assist' are the states maybeSpeculate treats as free. */
    activeMode: string;
    /** True while a `runWhatShouldISay` request owns `whatToAnswerCancellationToken`. */
    answerInFlight: boolean;
    now: number;
    lastTriggerTime: number;
    automaticTriggerCooldown: number;
}

/**
 * Pure. Returns null when the engine accepts an automatic answer, otherwise the
 * single blocking condition — mode first, because a busy mode outlives the
 * cooldown and is the interesting failure.
 */
export function describeAutoAnswerBusy(input: AutoAnswerBusyInput): AutoAnswerBusyReason | null {
    const modeFree = input.activeMode === 'idle' || input.activeMode === 'assist';
    if (!modeFree) {
        const code: AutoAnswerBusyCode = input.activeMode === 'what_to_say'
            ? (input.answerInFlight ? 'answer_in_flight' : 'mode_wedged')
            : 'mode_other';
        return { code, mode: input.activeMode, answerInFlight: input.answerInFlight, cooldownRemainingMs: 0 };
    }

    const elapsed = input.now - input.lastTriggerTime;
    if (elapsed < input.automaticTriggerCooldown) {
        return {
            code: 'trigger_cooldown',
            mode: input.activeMode,
            answerInFlight: input.answerInFlight,
            cooldownRemainingMs: Math.max(0, input.automaticTriggerCooldown - elapsed),
        };
    }

    return null;
}

/** One short token for a log line and for the telemetry property. Never carries transcript text. */
export function formatAutoAnswerBusy(reason: AutoAnswerBusyReason): string {
    return reason.code === 'trigger_cooldown'
        ? `trigger_cooldown(${reason.cooldownRemainingMs}ms)`
        : `${reason.code}(${reason.mode})`;
}
