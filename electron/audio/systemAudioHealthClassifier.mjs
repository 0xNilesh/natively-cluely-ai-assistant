const DEFAULT_WATCHDOG_MS = 12_000;
const DEFAULT_ZERO_OBSERVATION_MS = 12_000;
const DEFAULT_MEANINGFUL_PEAK_TO_PEAK = 100;
const DEFAULT_INTER_CHUNK_GAP_LOG_MS = 2_000;
const DEFAULT_OVERFLOW_LOG_INTERVAL_MS = 10_000;

function peakToPeakInt16LE(chunk) {
  if (!Buffer.isBuffer(chunk) || chunk.length < 2) return 0;

  let min = 32767;
  let max = -32768;
  const stride = Math.max(2, (chunk.length >> 5) & ~1);
  for (let i = 0; i + 1 < chunk.length; i += stride) {
    const sample = chunk.readInt16LE(i);
    if (sample < min) min = sample;
    if (sample > max) max = sample;
  }
  return max - min;
}

export class SystemAudioHealthClassifier {
  static supportedEventKinds = Object.freeze([
    'capture-started',
    'capture-stopped',
    'chunk',
    'watchdog-tick',
    'same-device-route-detected',
  ]);

  constructor(options = {}) {
    this.watchdogMs = options.watchdogMs ?? DEFAULT_WATCHDOG_MS;
    this.zeroObservationMs = options.zeroObservationMs ?? DEFAULT_ZERO_OBSERVATION_MS;
    this.meaningfulPeakToPeak = options.meaningfulPeakToPeak ?? DEFAULT_MEANINGFUL_PEAK_TO_PEAK;
    this.interChunkGapLogMs = options.interChunkGapLogMs ?? DEFAULT_INTER_CHUNK_GAP_LOG_MS;
    this.overflowLogIntervalMs = options.overflowLogIntervalMs ?? DEFAULT_OVERFLOW_LOG_INTERVAL_MS;
    this.reset();
  }

  reset() {
    this.startedAtMs = null;
    this.stopped = false;
    this.chunkCount = 0;
    this.firstChunkAtMs = null;
    this.lastChunkAtMs = null;
    this.hasMeaningfulSignal = false;
    this.sameDeviceWarningEmitted = false;
    this.noChunkLogEmitted = false;
    this.zeroValuedLogEmitted = false;
    this.droppedSamples = 0;
    this.overflowEvents = 0;
    this.lastOverflowLogAtMs = null;
  }

  handle(event) {
    switch (event.kind) {
      case 'capture-started':
        this.reset();
        this.startedAtMs = event.nowMs;
        return { type: 'none' };
      case 'capture-stopped':
        this.stopped = true;
        return { type: 'none' };
      case 'same-device-route-detected':
        return this.handleSameDeviceRoute(event);
      case 'watchdog-tick':
        return this.handleWatchdogTick(event);
      case 'chunk':
        return this.handleChunk(event);
      default:
        return { type: 'none' };
    }
  }

  handleSameDeviceRoute(event) {
    if (this.sameDeviceWarningEmitted) return { type: 'none' };
    this.sameDeviceWarningEmitted = true;
    return {
      type: 'warn-user',
      reason: 'same-device-input-output',
      device: event.device,
      terminal: false,
      stuck: true,
    };
  }

  handleWatchdogTick(event) {
    if (this.stopped || this.chunkCount > 0 || this.noChunkLogEmitted) return { type: 'none' };
    const startedAtMs = this.startedAtMs ?? event.nowMs;
    if (event.nowMs - startedAtMs < this.watchdogMs) return { type: 'none' };

    this.noChunkLogEmitted = true;
    return {
      type: 'log',
      level: 'warn',
      reason: 'initial-silence-no-chunks',
      message: `SystemAudioCapture produced 0 chunks in ${Math.round(this.watchdogMs / 1000)}s — treating as initial silence unless another capture health signal fails.`,
    };
  }

  handleChunk(event) {
    if (this.stopped) return { type: 'none' };

    const previousChunkAtMs = this.lastChunkAtMs;
    this.chunkCount++;
    if (this.firstChunkAtMs == null) this.firstChunkAtMs = event.nowMs;
    this.lastChunkAtMs = event.nowMs;

    // Capture-ring overflow outranks every other explanation on this chunk: it
    // says the native side kept capturing but WE could not keep up, so a gap or
    // a quiet chunk is a symptom, not the cause. Pre-fix this had no signal at
    // all — the audio was dropped inside Rust and nothing above it ever knew.
    const overflowDecision = this.observeOverflow(event);
    if (overflowDecision) return overflowDecision;

    const peakToPeak = peakToPeakInt16LE(event.chunk);
    if (peakToPeak > this.meaningfulPeakToPeak) {
      this.hasMeaningfulSignal = true;
      return this.maybeInterChunkGapLog(previousChunkAtMs, event.nowMs);
    }

    const zeroObservationStartMs = this.firstChunkAtMs ?? event.nowMs;
    if (!this.hasMeaningfulSignal && !this.zeroValuedLogEmitted && event.nowMs - zeroObservationStartMs >= this.zeroObservationMs) {
      this.zeroValuedLogEmitted = true;
      return {
        type: 'log',
        level: 'warn',
        reason: 'sustained-zero-valued-silence',
        message: `SystemAudio chunks stayed zero-valued (peak-to-peak <= ${this.meaningfulPeakToPeak}) for ${Math.round(this.zeroObservationMs / 1000)}s — treating as silence unless another capture health signal fails.`,
      };
    }

    return this.maybeInterChunkGapLog(previousChunkAtMs, event.nowMs);
  }

  /**
   * Fold the native capture-ring counters (SystemAudioCapture.getOverflowStats)
   * into the health picture. Returns a decision when NEW audio has been dropped
   * since the last report and the log interval has elapsed, otherwise null.
   */
  observeOverflow(event) {
    const overflow = event.overflow;
    if (!overflow) return null;

    const droppedSamples = Number(overflow.droppedSamples ?? 0);
    const overflowEvents = Number(overflow.overflowEvents ?? 0);
    if (!Number.isFinite(droppedSamples) || droppedSamples <= this.droppedSamples) return null;

    const newlyDropped = droppedSamples - this.droppedSamples;
    const droppedMs = Number(overflow.droppedMs ?? 0);
    this.droppedSamples = droppedSamples;
    this.overflowEvents = Number.isFinite(overflowEvents) ? overflowEvents : this.overflowEvents;

    if (
      this.lastOverflowLogAtMs != null
      && event.nowMs - this.lastOverflowLogAtMs < this.overflowLogIntervalMs
    ) {
      return null;
    }
    this.lastOverflowLogAtMs = event.nowMs;

    return {
      type: 'log',
      level: 'warn',
      reason: 'capture-ring-overflow',
      droppedSamples: this.droppedSamples,
      overflowEvents: this.overflowEvents,
      newlyDropped,
      message: `SystemAudio capture ring overwrote ${newlyDropped} unread samples (${Math.round(droppedMs)}ms dropped in total across ${this.overflowEvents} episodes) — the capture stream is healthy but the main process is not draining it fast enough. Expect gaps in the interviewer transcript.`,
    };
  }

  maybeInterChunkGapLog(previousChunkAtMs, nowMs) {
    if (previousChunkAtMs == null) return { type: 'none' };
    const gapMs = nowMs - previousChunkAtMs;
    if (gapMs <= this.interChunkGapLogMs) return { type: 'none' };
    return {
      type: 'log',
      level: 'warn',
      reason: 'inter-chunk-gap',
      gapMs,
      message: `SystemAudio chunk gap ${gapMs}ms — likely transient route change. Resuming.`,
    };
  }
}

export { peakToPeakInt16LE };
