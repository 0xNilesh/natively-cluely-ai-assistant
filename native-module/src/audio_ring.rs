// Drop-oldest lock-free SPSC ring buffer for real-time audio capture.
//
// WHY THIS EXISTS
// ---------------
// Every capture backend (CoreAudio process tap, ScreenCaptureKit, WASAPI
// loopback, CPAL microphone) hands us samples from a real-time thread that must
// never block, allocate or take a lock. The DSP thread that drains them shares
// the Electron process with the intelligence pipeline — answer prefetch, the
// mobilebert intent classifier, Temporal RAG, a streaming LLM call — and can be
// starved for hundreds of milliseconds at a time.
//
// The previous implementation used `ringbuf`'s bounded SPSC queue, whose
// `push_slice` is DROP-NEWEST: once the queue is full the producer silently
// discards the audio it has just captured, and the ring stays pinned full of the
// OLDEST samples. Two consequences, both bad:
//
//   1. Freshness inverts. After a 2.7s stall the DSP thread resumes on audio
//      that is 2.7s old and never catches up, so the interviewer channel
//      transcribes the past for the rest of the meeting.
//   2. It is completely silent. `let _pushed = producer.push_slice(..)` — the
//      drop count went nowhere, which is what made the field failure (system
//      audio freezing the instant Auto Answer generated its first answer) take
//      hours to diagnose.
//
// This ring fixes both. The producer is WAIT-FREE: it does not inspect the
// consumer's position at all, it always writes, overwriting the oldest samples,
// and publishes one release store. The consumer notices it was lapped, resyncs
// to the newest `capacity` samples, and counts exactly how many it lost. The
// DSP thread reads that count via `AudioConsumer::overflow()` and surfaces it
// (Rust log + napi `getOverflowStats()` + the JS systemAudioHealth classifier)
// instead of letting it vanish.
//
// REAL-TIME AND SOUNDNESS PROPERTIES
// ----------------------------------
//   * No `unsafe`. Slots are `AtomicU32` holding `f32::to_bits`, so a
//     producer/consumer race on a slot yields a defined (if meaningless) value
//     rather than a data race — and the consumer detects and discards any
//     region that was overwritten while it was being copied.
//   * The producer path performs no allocation, no locking, no syscalls and no
//     branching on consumer state: one relaxed load, one relaxed store, one
//     release fence, N relaxed stores, one release store. It never reads the
//     consumer's position, so it cannot be made to wait by a slow consumer.
//   * No panics. The slot array is a power of two and every index is masked, so
//     each access is provably in bounds; all index arithmetic is wrapping.
//
// ACCOUNTING
// ----------
// The CONSUMER owns both counters. It is the only side that can measure loss
// exactly (it knows precisely which samples it had to skip), and keeping the
// producer free of any read of the consumer's position is what makes the
// capture callback structurally unable to observe — let alone wait on —
// downstream work. The invariant the unit tests pin is:
//
//     samples_received + dropped_samples == samples_pushed

use std::sync::atomic::{fence, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

/// Smallest ring we will build. Two slots keeps the power-of-two masking valid.
const MIN_CAPACITY: usize = 2;

/// Ceiling on ring capacity (2^26 f32 samples = 256 MiB). Purely a guard so a
/// nonsense caller-supplied capacity cannot overflow `next_power_of_two()` or
/// exhaust memory; real call sites ask for 32K–128K samples.
const MAX_CAPACITY: usize = 1 << 26;

/// Immutable view of the overflow counters, taken at one instant.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OverflowSnapshot {
    /// Cumulative samples the consumer lost because the producer lapped it.
    pub dropped_samples: u64,
    /// Cumulative number of *drains* that observed loss. One event can cover
    /// many samples, so this is the "how often were we starved" signal while
    /// `dropped_samples` is the "how much audio did we lose" signal.
    pub overflow_events: u64,
}

impl OverflowSnapshot {
    /// Milliseconds of audio lost, given the ring's sample rate.
    pub fn dropped_ms(&self, sample_rate: u32) -> f64 {
        samples_to_ms(self.dropped_samples, sample_rate)
    }
}

/// Sample count expressed as milliseconds of audio. Returns 0 for an unknown
/// (zero) rate rather than dividing by it.
pub fn samples_to_ms(samples: u64, sample_rate: u32) -> f64 {
    if sample_rate == 0 {
        return 0.0;
    }
    (samples as f64) * 1000.0 / (sample_rate as f64)
}

struct Ring {
    /// `capacity` slots, each an `f32` stored as its bit pattern. Atomic so a
    /// producer/consumer overlap is a defined race-free read of a garbage value
    /// rather than UB; the consumer discards any such region.
    slots: Box<[AtomicU32]>,
    /// `capacity - 1`. Every index is `pos & mask`, hence always in bounds.
    mask: usize,
    capacity: usize,
    /// Monotonic count of samples the producer has PUBLISHED — everything below
    /// this index is fully written and safe to read. Producer-only writer.
    write: AtomicUsize,
    /// Monotonic upper bound on how far the producer has physically written
    /// into `slots`, published BEFORE the writes rather than after.
    ///
    /// `write` alone is not enough to police the consumer's copy. The producer
    /// stores a whole callback's worth of samples and only then publishes
    /// `write`, so between those two points it has already clobbered slots the
    /// consumer may be reading while `write` still reads low. Trimming against
    /// `write` therefore under-counts the damage and can hand a torn,
    /// out-of-order sample to STT (caught by
    /// `producer_never_blocks_on_a_slower_consumer`). `claimed` is raised first
    /// and is never below the physical frontier, so trimming against it is
    /// conservative by construction. Producer-only writer.
    claimed: AtomicUsize,
    /// Monotonic count of samples ever consumed (including skipped ones).
    /// Consumer-only writer.
    read: AtomicUsize,
    /// Cumulative samples the consumer lost because the producer lapped it.
    dropped_samples: AtomicU64,
    /// Cumulative drains that observed loss.
    overflow_events: AtomicU64,
}

impl Ring {
    /// Record one episode of loss. Consumer-side only — it is the side that can
    /// measure exactly which samples went missing.
    #[inline]
    fn record_loss(&self, samples: usize) {
        if samples == 0 {
            return;
        }
        self.dropped_samples
            .fetch_add(samples as u64, Ordering::Relaxed);
        self.overflow_events.fetch_add(1, Ordering::Relaxed);
    }

    fn snapshot(&self) -> OverflowSnapshot {
        OverflowSnapshot {
            dropped_samples: self.dropped_samples.load(Ordering::Relaxed),
            overflow_events: self.overflow_events.load(Ordering::Relaxed),
        }
    }
}

/// Build a drop-oldest SPSC ring holding at least `capacity` f32 samples.
///
/// The capacity is rounded up to a power of two (masking instead of modulo on
/// the real-time path) and clamped to a sane range.
pub fn audio_ring(capacity: usize) -> (AudioProducer, AudioConsumer) {
    let capacity = capacity
        .clamp(MIN_CAPACITY, MAX_CAPACITY)
        .next_power_of_two();

    let mut slots = Vec::with_capacity(capacity);
    slots.resize_with(capacity, || AtomicU32::new(0));

    let ring = Arc::new(Ring {
        slots: slots.into_boxed_slice(),
        mask: capacity - 1,
        capacity,
        write: AtomicUsize::new(0),
        claimed: AtomicUsize::new(0),
        read: AtomicUsize::new(0),
        dropped_samples: AtomicU64::new(0),
        overflow_events: AtomicU64::new(0),
    });

    (
        AudioProducer { ring: ring.clone() },
        AudioConsumer { ring },
    )
}

// ============================================================================
// PRODUCER — runs on the OS audio callback thread. Wait-free.
// ============================================================================

/// Write half of the ring. Lives in the capture callback.
pub struct AudioProducer {
    ring: Arc<Ring>,
}

impl AudioProducer {
    /// Write every sample in `src`, overwriting the oldest data if the consumer
    /// has fallen behind. Always returns `src.len()` — this call cannot fail
    /// and cannot wait.
    #[inline]
    pub fn push_slice(&mut self, src: &[f32]) -> usize {
        self.push_iter(src.iter().copied())
    }

    /// Same contract as [`AudioProducer::push_slice`], for callbacks that must
    /// convert (i16/i32 → f32) or downmix interleaved channels on the way in.
    /// Taking an `ExactSizeIterator` lets them do that without a scratch buffer
    /// or a per-sample round trip through the atomics.
    #[inline]
    pub fn push_iter<I>(&mut self, iter: I) -> usize
    where
        I: IntoIterator<Item = f32>,
        I::IntoIter: ExactSizeIterator,
    {
        let iter = iter.into_iter();
        let n = iter.len();
        if n == 0 {
            return 0;
        }

        let ring = &*self.ring;

        // A burst larger than the whole ring can only leave its newest
        // `capacity` samples behind; skip the rest instead of writing over
        // ourselves. The published index still advances by the full `n` so the
        // consumer's loss accounting stays exact.
        let skip = n.saturating_sub(ring.capacity);

        // Relaxed: the producer is the only writer of `write` and `claimed`.
        let w = ring.write.load(Ordering::Relaxed);
        let end = w.wrapping_add(n);

        // Announce how far we are about to reach BEFORE touching a single slot,
        // so a consumer copying concurrently can tell which of the samples it
        // just read were inside our reach. The release fence is what makes the
        // announcement stick: it forbids the slot stores below from becoming
        // visible ahead of it. Two stores and one fence per callback — the
        // producer still never reads the consumer's position and still cannot
        // be made to wait.
        ring.claimed.store(end, Ordering::Relaxed);
        fence(Ordering::Release);

        let mut pos = w.wrapping_add(skip);
        for sample in iter.skip(skip) {
            ring.slots[pos & ring.mask].store(sample.to_bits(), Ordering::Relaxed);
            pos = pos.wrapping_add(1);
        }

        // Release: publishes the slot stores above to the consumer's Acquire
        // load. This is the only point at which the new audio becomes readable.
        ring.write.store(end, Ordering::Release);
        n
    }

    /// Total slots in the ring (rounded up to a power of two).
    pub fn capacity(&self) -> usize {
        self.ring.capacity
    }
}

impl std::fmt::Debug for AudioProducer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AudioProducer")
            .field("capacity", &self.ring.capacity)
            .finish()
    }
}

// ============================================================================
// CONSUMER — runs on the DSP thread. Detects and accounts for loss.
// ============================================================================

/// Read half of the ring. Lives on the DSP thread.
pub struct AudioConsumer {
    ring: Arc<Ring>,
}

impl AudioConsumer {
    /// Append every sample currently readable to `dst` and return how many were
    /// appended.
    ///
    /// If the producer lapped us while we were away, the stale samples are
    /// skipped (drop-oldest) and counted, so what lands in `dst` is always the
    /// most recent audio rather than a backlog the pipeline can never work off.
    pub fn drain_into(&mut self, dst: &mut Vec<f32>) -> usize {
        let ring = &*self.ring;
        let cap = ring.capacity;

        // Acquire: pairs with the producer's release store, making its slot
        // writes visible to the loads below.
        let w = ring.write.load(Ordering::Acquire);
        // Relaxed: the consumer is the only writer of `read`.
        let mut r = ring.read.load(Ordering::Relaxed);

        let mut avail = w.wrapping_sub(r);
        if avail == 0 {
            return 0;
        }

        let mut lost = 0usize;
        if avail > cap {
            // Lapped. Everything older than `w - cap` has been overwritten.
            lost = avail - cap;
            r = w.wrapping_sub(cap);
            avail = cap;
        }

        let base = dst.len();
        dst.reserve(avail);
        for i in 0..avail {
            let idx = r.wrapping_add(i) & ring.mask;
            dst.push(f32::from_bits(ring.slots[idx].load(Ordering::Relaxed)));
        }

        // The producer may have wrapped around and overwritten the front of the
        // region while we were copying it. `claimed` is the conservative bound
        // on how far it has physically reached (see the field docs — `write`
        // lags it by up to a whole callback, which is exactly how torn samples
        // used to slip through). Anything older than `claimed - cap` is
        // unreliable now; discard it rather than feeding it to STT.
        //
        // The acquire fence keeps this load from being hoisted above the copy
        // above, so the bound really does cover the window we just read.
        fence(Ordering::Acquire);
        let claimed = ring.claimed.load(Ordering::Relaxed);
        let clobbered = claimed.wrapping_sub(r).saturating_sub(cap).min(avail);

        // Release: tells the producer (via `len()`/diagnostics) how far we got.
        ring.read.store(r.wrapping_add(avail), Ordering::Release);

        if clobbered > 0 {
            let kept = avail - clobbered;
            let tail = base + clobbered;
            dst.copy_within(tail..tail + kept, base);
            dst.truncate(base + kept);
            lost += clobbered;
        }

        ring.record_loss(lost);
        avail - clobbered
    }

    /// Pop a single sample. Convenience for tests and non-hot callers;
    /// production code should use [`AudioConsumer::drain_into`], which moves a
    /// whole callback's worth per call.
    ///
    /// Applies the same `claimed` safety rule as `drain_into`: a sample the
    /// producer was inside the reach of is counted as lost and skipped rather
    /// than returned. The loop always advances `read`, so it terminates.
    pub fn try_pop(&mut self) -> Option<f32> {
        let ring = &*self.ring;
        let cap = ring.capacity;

        loop {
            let w = ring.write.load(Ordering::Acquire);
            let mut r = ring.read.load(Ordering::Relaxed);

            let avail = w.wrapping_sub(r);
            if avail == 0 {
                return None;
            }

            let mut lost = 0usize;
            if avail > cap {
                lost = avail - cap;
                r = w.wrapping_sub(cap);
            }

            let sample = f32::from_bits(ring.slots[r & ring.mask].load(Ordering::Relaxed));

            fence(Ordering::Acquire);
            let claimed = ring.claimed.load(Ordering::Relaxed);
            ring.read.store(r.wrapping_add(1), Ordering::Release);

            if claimed.wrapping_sub(r) > cap {
                // The producer reached this slot while we were reading it.
                ring.record_loss(lost + 1);
                continue;
            }
            ring.record_loss(lost);
            return Some(sample);
        }
    }

    /// Samples currently readable, saturated at the ring capacity.
    pub fn len(&self) -> usize {
        let ring = &*self.ring;
        let w = ring.write.load(Ordering::Acquire);
        let r = ring.read.load(Ordering::Relaxed);
        w.wrapping_sub(r).min(ring.capacity)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Total slots in the ring (rounded up to a power of two).
    pub fn capacity(&self) -> usize {
        self.ring.capacity
    }

    /// Current overflow counters.
    pub fn overflow(&self) -> OverflowSnapshot {
        self.ring.snapshot()
    }
}

impl std::fmt::Debug for AudioConsumer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AudioConsumer")
            .field("capacity", &self.ring.capacity)
            .field("len", &self.len())
            .field("overflow", &self.overflow())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::thread;
    use std::time::Duration;

    fn ramp(start: usize, count: usize) -> Vec<f32> {
        (start..start + count).map(|i| i as f32).collect()
    }

    fn drain(consumer: &mut AudioConsumer) -> Vec<f32> {
        let mut out = Vec::new();
        consumer.drain_into(&mut out);
        out
    }

    #[test]
    fn capacity_rounds_up_to_power_of_two() {
        let (p, c) = audio_ring(1000);
        assert_eq!(p.capacity(), 1024);
        assert_eq!(c.capacity(), 1024);

        // Already a power of two — left alone.
        let (_, c) = audio_ring(4096);
        assert_eq!(c.capacity(), 4096);

        // Degenerate requests are clamped, never panic.
        let (_, c) = audio_ring(0);
        assert_eq!(c.capacity(), MIN_CAPACITY);
        let (_, c) = audio_ring(1);
        assert_eq!(c.capacity(), MIN_CAPACITY);
    }

    #[test]
    fn samples_convert_to_milliseconds() {
        assert_eq!(samples_to_ms(48_000, 48_000), 1000.0);
        assert_eq!(samples_to_ms(0, 48_000), 0.0);
        // An unknown rate must not divide by zero.
        assert_eq!(samples_to_ms(48_000, 0), 0.0);
        assert_eq!(
            OverflowSnapshot {
                dropped_samples: 24_000,
                overflow_events: 3,
            }
            .dropped_ms(48_000),
            500.0
        );
    }

    #[test]
    fn empty_push_and_drain_are_noops() {
        let (mut p, mut c) = audio_ring(64);
        assert_eq!(p.push_slice(&[]), 0);
        assert!(c.is_empty());
        assert_eq!(c.len(), 0);
        assert!(c.try_pop().is_none());

        let mut sink = vec![7.0f32];
        assert_eq!(c.drain_into(&mut sink), 0);
        assert_eq!(sink, vec![7.0], "drain must not disturb existing contents");
        assert_eq!(c.overflow(), OverflowSnapshot::default());
    }

    #[test]
    fn push_then_drain_round_trips_in_order() {
        let (mut p, mut c) = audio_ring(64);
        let src = ramp(0, 10);
        assert_eq!(p.push_slice(&src), 10);
        assert_eq!(c.len(), 10);

        assert_eq!(drain(&mut c), src);
        assert!(c.is_empty());
        assert_eq!(c.overflow().dropped_samples, 0);
    }

    #[test]
    fn drain_appends_rather_than_replacing() {
        let (mut p, mut c) = audio_ring(64);
        let mut sink = vec![-1.0f32, -2.0];
        p.push_slice(&ramp(0, 3));
        assert_eq!(c.drain_into(&mut sink), 3);
        assert_eq!(sink, vec![-1.0, -2.0, 0.0, 1.0, 2.0]);
    }

    #[test]
    fn wraparound_preserves_order_across_many_laps() {
        // capacity 8, 500 samples pushed 3 at a time and drained each round:
        // the write index laps the slot array ~60 times.
        let (mut p, mut c) = audio_ring(8);
        let mut received = Vec::new();
        let mut next = 0usize;
        while next < 500 {
            let batch = ramp(next, 3);
            p.push_slice(&batch);
            next += 3;
            received.extend(drain(&mut c));
        }
        assert_eq!(received, ramp(0, next));
        assert_eq!(
            c.overflow().dropped_samples,
            0,
            "a consumer that keeps up must never lose a sample"
        );
    }

    #[test]
    fn overflow_drops_oldest_and_keeps_newest() {
        let (mut p, mut c) = audio_ring(8);
        // 20 samples into an 8-slot ring with no drain in between.
        for i in 0..5 {
            p.push_slice(&ramp(i * 4, 4));
        }
        let got = drain(&mut c);
        assert_eq!(
            got,
            ramp(12, 8),
            "drop-oldest must surface the newest capacity() samples, not the first ones"
        );
        let stats = c.overflow();
        assert_eq!(stats.dropped_samples, 12);
        assert_eq!(stats.overflow_events, 1, "one drain observed the loss");
    }

    #[test]
    fn overflow_accounting_is_exact() {
        let (mut p, mut c) = audio_ring(16);
        let total = 1000usize;
        let mut pushed = 0usize;
        let mut received = 0usize;
        // Drain only every 7th push so the producer laps the consumer
        // repeatedly at an offset that does not divide the capacity.
        for round in 0..(total / 5) {
            p.push_slice(&ramp(pushed, 5));
            pushed += 5;
            if round % 7 == 0 {
                received += drain(&mut c).len();
            }
        }
        received += drain(&mut c).len();

        let stats = c.overflow();
        assert_eq!(
            received as u64 + stats.dropped_samples,
            pushed as u64,
            "every produced sample is either delivered or counted as dropped"
        );
        assert!(stats.overflow_events > 0);
    }

    #[test]
    fn single_push_larger_than_capacity_keeps_the_tail() {
        let (mut p, mut c) = audio_ring(16);
        assert_eq!(p.push_slice(&ramp(0, 48)), 48);

        let got = drain(&mut c);
        assert_eq!(got, ramp(32, 16), "only the newest 16 samples can survive");
        let stats = c.overflow();
        assert_eq!(stats.dropped_samples, 32);
        assert_eq!(stats.overflow_events, 1);
    }

    #[test]
    fn push_iter_matches_push_slice_including_downmix() {
        let (mut p, mut c) = audio_ring(64);
        // Stereo interleaved, downmixed on the way in — the shape core_audio.rs
        // and microphone.rs use for multi-channel devices.
        let interleaved = [1.0f32, 3.0, 5.0, 7.0, 9.0, 11.0];
        p.push_iter(
            interleaved
                .chunks_exact(2)
                .map(|f| (f[0] + f[1]) / 2.0),
        );
        assert_eq!(drain(&mut c), vec![2.0, 6.0, 10.0]);
        assert_eq!(c.overflow().dropped_samples, 0);
    }

    #[test]
    fn try_pop_resynchronises_after_being_lapped() {
        let (mut p, mut c) = audio_ring(4);
        p.push_slice(&ramp(0, 10));
        // Oldest survivor is sample 6 (10 pushed, 4 slots).
        assert_eq!(c.try_pop(), Some(6.0));
        assert_eq!(c.try_pop(), Some(7.0));
        assert_eq!(c.try_pop(), Some(8.0));
        assert_eq!(c.try_pop(), Some(9.0));
        assert_eq!(c.try_pop(), None);
        assert_eq!(c.overflow().dropped_samples, 6);
    }

    #[test]
    fn consumer_that_keeps_up_never_loses_audio() {
        // 48kHz, 10ms callbacks, ring sized like the real system-audio path.
        let (mut p, mut c) = audio_ring(1024);
        let mut received = Vec::new();
        for block in 0..200 {
            p.push_slice(&ramp(block * 480, 480));
            received.extend(drain(&mut c));
        }
        assert_eq!(received.len(), 200 * 480);
        assert_eq!(received, ramp(0, 200 * 480));
        assert_eq!(c.overflow(), OverflowSnapshot::default());
    }

    #[test]
    fn slow_consumer_stays_current_instead_of_falling_behind() {
        // The regression this whole module exists for: the consumer stalls for
        // several ring-fulls (Auto Answer running inference), then resumes.
        // Post-fix it must come back on the NEWEST audio, not on a backlog.
        let (mut p, mut c) = audio_ring(1024);

        // 30 callbacks (~14400 samples) land while the DSP thread is blocked.
        for block in 0..30 {
            p.push_slice(&ramp(block * 480, 480));
        }
        let resumed = drain(&mut c);
        assert_eq!(resumed.len(), 1024);
        assert_eq!(
            resumed,
            ramp(30 * 480 - 1024, 1024),
            "after a stall the consumer must resume on the most recent audio"
        );

        // And once it is keeping up again, delivery is lossless from there on.
        let before = c.overflow().dropped_samples;
        let mut received = Vec::new();
        for block in 30..60 {
            p.push_slice(&ramp(block * 480, 480));
            received.extend(drain(&mut c));
        }
        assert_eq!(received, ramp(30 * 480, 30 * 480));
        assert_eq!(
            c.overflow().dropped_samples,
            before,
            "no further loss once the consumer keeps up"
        );
    }

    /// Real threads, real contention. The producer must complete a fixed
    /// workload however slowly the consumer drains, every sample the consumer
    /// is handed must be a real sample in order, and nothing may be lost
    /// without being counted.
    ///
    /// The ordering assertion is the load-bearing one: it is what caught the
    /// producer clobbering slots the consumer was mid-copy on. `write` is
    /// published only after a whole callback has been stored, so trimming the
    /// copy against `write` let torn samples through and delivered audio went
    /// backwards. The `claimed` index exists to close exactly this window, and
    /// the geometries below are chosen to hold it wide open: block sizes at and
    /// beyond the ring capacity, and a consumer that barely yields.
    #[test]
    fn producer_never_blocks_on_a_slower_consumer() {
        // (capacity, block, blocks, consumer sleep in microseconds)
        let geometries = [
            (1024usize, 256usize, 4_000usize, 200u64),
            // Block close to a whole ring: every push covers most of the slot
            // array, so the pre-publish window is at its widest.
            (512, 480, 4_000, 20),
            // Block LARGER than the ring: exercises the `skip` path under
            // contention too.
            (256, 1_024, 2_000, 0),
        ];

        for (cap, block, blocks, sleep_us) in geometries {
            let label = format!("cap={} block={} blocks={}", cap, block, blocks);
            let (mut producer, mut consumer) = audio_ring(cap);
            let done = Arc::new(AtomicBool::new(false));
            let done_writer = done.clone();
            // Pre-built so the producer loop itself does nothing but push — the
            // property under test is that a slow consumer cannot stall it.
            let source = ramp(0, blocks * block);

            let writer = thread::spawn(move || {
                for b in 0..blocks {
                    producer.push_slice(&source[b * block..(b + 1) * block]);
                }
                done_writer.store(true, Ordering::Release);
                blocks * block
            });

            let mut received: Vec<f32> = Vec::new();
            let mut buf: Vec<f32> = Vec::new();
            loop {
                // Sampled BEFORE the drain: if the writer had already finished,
                // the release/acquire pair guarantees this drain sees its final
                // write index, so one more sweep is unnecessary.
                let finished = done.load(Ordering::Acquire);
                buf.clear();
                consumer.drain_into(&mut buf);
                received.extend_from_slice(&buf);
                if finished {
                    break;
                }
                if sleep_us == 0 {
                    thread::yield_now();
                } else {
                    thread::sleep(Duration::from_micros(sleep_us));
                }
            }

            let pushed = writer.join().expect("producer thread must not panic");

            // Strictly increasing: every delivered sample is a real sample, in
            // order, with nothing torn or duplicated.
            for (i, pair) in received.windows(2).enumerate() {
                assert!(
                    pair[1] > pair[0],
                    "{}: delivered audio must stay ordered, saw {} then {} at index {}",
                    label,
                    pair[0],
                    pair[1],
                    i
                );
            }
            for &sample in &received {
                assert!(
                    sample.is_finite() && sample >= 0.0 && sample < pushed as f32,
                    "{}: sample {} is outside the produced range",
                    label,
                    sample
                );
            }

            let stats = consumer.overflow();
            assert_eq!(
                received.len() as u64 + stats.dropped_samples,
                pushed as u64,
                "{}: every produced sample must be either delivered or accounted as dropped",
                label
            );
        }
    }
}
