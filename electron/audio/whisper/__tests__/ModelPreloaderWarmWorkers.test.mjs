// Behavioral regression test for the "interviewer channel never transcribes"
// bug.
//
// Bug: ModelPreloader held exactly ONE warm worker (warmWorker + warmModelId,
// loadingWorker + pendingModelId + loading). With per-channel transcription
// enabled there are TWO consumers — the mic LocalWhisperSTT and the
// interviewer one — so the mic always asked first, took the only warm worker,
// and the interviewer was left to cold-start. Cold-started workers log
// "Loading" and then sit at 0% CPU without ever reporting `ready`, so the
// interviewer channel produced zero segments and everything downstream of it
// (Auto Answer) stayed silent.
//
// Fix: warm workers are keyed by model id (warmWorkers / loadingWorkers maps),
// so every selected model can be warmed and handed to its own caller. The map
// is capped at MAX_WARM_WORKERS (3 = global + mic + system) so the extra
// workers cannot accumulate without bound.
//
// This test drives the REAL preload() path with `worker_threads` stubbed out,
// which is what lets it assert on spawn counts and handoff routing rather than
// just on the shape of the source.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import os from 'os';
import Module from 'module';
import { EventEmitter } from 'events';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Deterministic ONNX gates. Without these the preloader's memory floor could
// silently skip every preload on a loaded machine (it refuses below 2GB
// available) and the concurrency cap of 2 would queue the third acquisition.
process.env.NATIVELY_ONNX_AVAILABLE_MEM_GB = '64';
process.env.NATIVELY_ONNX_MAX_CONCURRENT_SESSIONS = '16';

// modelPreloader (and modelManager, which it late-requires for the worker init
// message) pull in `electron` for userData / the models dir. Point both at a
// fresh temp dir so the recent-failures JSON and the load sentinels are
// isolated from the real app.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'preloader-warm-'));

// Stand-in for a whisper worker thread. The preloader only ever calls
// postMessage/terminate on it and listens for 'message' / 'error' / 'exit',
// so an EventEmitter covers the whole contract.
class FakeWorker extends EventEmitter {
  static instances = [];

  constructor(workerPath) {
    super();
    this.workerPath = workerPath;
    this.posted = [];
    this.terminated = false;
    FakeWorker.instances.push(this);
  }

  postMessage(msg) {
    this.posted.push(msg);
  }

  terminate() {
    this.terminated = true;
    return Promise.resolve(0);
  }

  /** The modelId this worker was asked to load (from its `init` message). */
  get initModelId() {
    return this.posted.find(m => m?.type === 'init')?.modelId ?? null;
  }
}

const origLoad = Module._load;
Module._load = function patched(request, _p, _m) {
  if (request === 'electron') {
    return {
      app: {
        getPath: (k) => (k === 'userData' ? userData : os.tmpdir()),
        isReady: () => true,
      },
    };
  }
  if (request === 'worker_threads') {
    return { Worker: FakeWorker, isMainThread: true, parentPort: null, workerData: null, threadId: 0 };
  }
  return origLoad.apply(this, arguments);
};

// resolveWhisperWorkerPath() probes for the compiled whisperWorker.js next to
// the bundle, and preload() bails out (recording a failure) if it isn't there.
// A `npm test` run has built it for real; a standalone run of just this file
// may not have. Report it as present either way — the Worker constructor is
// stubbed, so nothing ever reads the file.
const realExistsSync = fs.existsSync;
fs.existsSync = (p) =>
  (typeof p === 'string' && p.endsWith('whisperWorker.js')) ? true : realExistsSync(p);

const distRoot = path.resolve(__dirname, '../../../../dist-electron/electron/audio/whisper');
const { modelPreloader } = await import(
  pathToFileURL(path.join(distRoot, 'modelPreloader.js')).href
);

// Real catalog ids — buildWorkerInitMessage() looks each one up for the
// download-size hint. None of them is a Nemotron build, so every call goes
// down the warm-worker path rather than the sharedWorkerRegistry one.
const MIC_MODEL = 'onnx-community/moonshine-tiny-ONNX';
const SYSTEM_MODEL = 'onnx-community/moonshine-base-ONNX';
const GLOBAL_MODEL = 'Xenova/whisper-tiny.en';
const FOURTH_MODEL = 'Xenova/whisper-base.en';
// The one id that takes the sharedWorkerRegistry path instead.
const NEMOTRON_MODEL = 'onnx-community/nemotron-3.5-asr-streaming-0.6b-onnx-int4';

// TS `private` is erased at runtime, so the singleton's maps are reachable
// here. Resetting them is what keeps these tests independent of each other.
function resetPreloader() {
  modelPreloader.warmWorkers = new Map();
  modelPreloader.loadingWorkers = new Map();
  modelPreloader.recentFailures = new Map();
  modelPreloader.nemotronWarmRelease = null;
  modelPreloader.nemotronWarmModelId = null;
  modelPreloader.nemotronWarmPendingId = null;
  modelPreloader.nemotronWarmLoading = false;
  FakeWorker.instances.length = 0;
}

/** Let the end-of-batch reconcile microtask scheduled by preload() run. */
function drainBatch() {
  return new Promise(resolve => setImmediate(resolve));
}

/** Spawn a worker for `modelId` and drive it all the way to warm. */
function preloadUntilWarm(modelId) {
  modelPreloader.preload(modelId);
  const w = FakeWorker.instances.find(i => i.initModelId === modelId);
  assert.ok(w, `preload(${modelId}) should have spawned a worker`);
  w.emit('message', { type: 'ready' });
  return w;
}

beforeEach(resetPreloader);

describe('warm workers are kept per model id', () => {
  test('both channels get their own warm worker, each handed to the right caller', () => {
    // The exact production configuration that was broken: per-channel
    // transcription with a different Moonshine build on each channel.
    const micWorker = preloadUntilWarm(MIC_MODEL);
    const systemWorker = preloadUntilWarm(SYSTEM_MODEL);

    assert.notStrictEqual(micWorker, systemWorker, 'each model must get its own worker');
    assert.equal(
      FakeWorker.instances.length,
      2,
      'two distinct models must spawn two workers, not one that replaces the other',
    );
    assert.equal(micWorker.terminated, false, 'warming the system model must not tear down the mic worker');

    assert.equal(modelPreloader.isWarm(MIC_MODEL), true);
    assert.equal(modelPreloader.isWarm(SYSTEM_MODEL), true);

    // The mic channel asks first — the bug was that this consumed the only
    // warm worker and left the interviewer with nothing.
    assert.strictEqual(
      modelPreloader.takeWarmWorker(MIC_MODEL),
      micWorker,
      'the mic model must be handed the worker warmed for the mic model',
    );
    assert.strictEqual(
      modelPreloader.takeWarmWorker(SYSTEM_MODEL),
      systemWorker,
      'the interviewer model must still have its own warm worker after the mic took its one',
    );

    // Both slots are now empty: a warm worker is handed off exactly once.
    assert.equal(modelPreloader.isWarm(MIC_MODEL), false);
    assert.equal(modelPreloader.isWarm(SYSTEM_MODEL), false);
    assert.equal(modelPreloader.takeWarmWorker(MIC_MODEL), null);
  });

  test('takeWarmWorker returns null for a model that was never warmed', () => {
    const micWorker = preloadUntilWarm(MIC_MODEL);

    assert.equal(
      modelPreloader.takeWarmWorker(GLOBAL_MODEL),
      null,
      'an unwarmed model must return null so LocalWhisperSTT falls back to a cold start',
    );
    assert.equal(modelPreloader.isWarm(GLOBAL_MODEL), false);
    // ...and the miss must not disturb the model that IS warm.
    assert.strictEqual(modelPreloader.takeWarmWorker(MIC_MODEL), micWorker);
  });

  test('a model still loading is not handed off as warm', () => {
    modelPreloader.preload(MIC_MODEL);
    assert.equal(modelPreloader.isWarm(MIC_MODEL), false, 'not warm until the worker reports ready');
    assert.equal(modelPreloader.takeWarmWorker(MIC_MODEL), null);
  });
});

describe('repeated preload of the same model is a no-op', () => {
  test('preloading twice while the first load is in flight spawns one worker', () => {
    modelPreloader.preload(MIC_MODEL);
    modelPreloader.preload(MIC_MODEL);
    modelPreloader.preload(MIC_MODEL);

    assert.equal(
      FakeWorker.instances.length,
      1,
      'the in-flight guard must be per model id, so repeats do not stack up workers',
    );
    assert.equal(FakeWorker.instances[0].terminated, false, 'the in-flight worker must not be cancelled by a repeat');
  });

  test('preloading a model that is already warm spawns nothing and keeps the same worker', () => {
    const micWorker = preloadUntilWarm(MIC_MODEL);

    modelPreloader.preload(MIC_MODEL);
    modelPreloader.preload(MIC_MODEL);

    assert.equal(FakeWorker.instances.length, 1, 'an already-warm model must not spawn a second worker');
    assert.equal(micWorker.terminated, false, 'the warm worker must survive a repeat preload');
    assert.strictEqual(modelPreloader.takeWarmWorker(MIC_MODEL), micWorker);
  });

  test('the warm map is bounded — a fourth model evicts the least recently warmed', () => {
    const first = preloadUntilWarm(MIC_MODEL);
    preloadUntilWarm(SYSTEM_MODEL);
    preloadUntilWarm(GLOBAL_MODEL);
    assert.equal(modelPreloader.warmWorkers.size, 3, 'three selectable models fit under the cap');

    preloadUntilWarm(FOURTH_MODEL);

    assert.equal(modelPreloader.warmWorkers.size, 3, 'the warm map must not grow past MAX_WARM_WORKERS');
    assert.equal(first.terminated, true, 'the evicted worker must actually be terminated, not just dropped');
    assert.equal(modelPreloader.isWarm(MIC_MODEL), false);
    for (const stillWarm of [SYSTEM_MODEL, GLOBAL_MODEL, FOURTH_MODEL]) {
      assert.equal(modelPreloader.isWarm(stillWarm), true, `${stillWarm} must still be warm`);
    }
  });

  test('a warm worker that dies on its own is dropped from the map', () => {
    const micWorker = preloadUntilWarm(MIC_MODEL);
    micWorker.emit('exit', 1);

    assert.equal(
      modelPreloader.isWarm(MIC_MODEL),
      false,
      'a dead worker must not be handed to LocalWhisperSTT as if it were warm',
    );
    assert.equal(modelPreloader.takeWarmWorker(MIC_MODEL), null);
  });
});

describe('recent-failure cooldown still gates preload', () => {
  test('a modelId inside the cooldown window spawns no worker', () => {
    modelPreloader.recentFailures.set(MIC_MODEL, Date.now() + 60_000);

    modelPreloader.preload(MIC_MODEL);

    assert.equal(FakeWorker.instances.length, 0, 'a model in cooldown must not be re-warmed');
    assert.equal(modelPreloader.isWarm(MIC_MODEL), false);

    // The cooldown is per model id — the other channel is unaffected.
    modelPreloader.preload(SYSTEM_MODEL);
    assert.equal(FakeWorker.instances.length, 1, 'a cooldown on one model must not block the other channel');
    assert.equal(FakeWorker.instances[0].initModelId, SYSTEM_MODEL);
  });

  test('an expired cooldown entry lets the model warm again', () => {
    modelPreloader.recentFailures.set(MIC_MODEL, Date.now() - 1);

    const micWorker = preloadUntilWarm(MIC_MODEL);
    assert.strictEqual(modelPreloader.takeWarmWorker(MIC_MODEL), micWorker);
  });

  test('a worker init error records the cooldown, which then blocks the next preload', () => {
    modelPreloader.preload(MIC_MODEL);
    const micWorker = FakeWorker.instances[0];
    micWorker.emit('message', { type: 'error', message: 'ORT session load failed' });

    assert.equal(micWorker.terminated, true, 'a failed init must terminate its worker');
    assert.equal(modelPreloader.isWarm(MIC_MODEL), false);
    const expiry = modelPreloader.recentFailures.get(MIC_MODEL);
    assert.ok(expiry && expiry > Date.now(), 'the init failure must record a live cooldown');

    modelPreloader.preload(MIC_MODEL);
    assert.equal(FakeWorker.instances.length, 1, 'the recorded cooldown must block the retry');
  });

  test('clearRecentFailure lifts the cooldown (the reset-to-default recovery path)', () => {
    modelPreloader.recentFailures.set(MIC_MODEL, Date.now() + 60_000);
    modelPreloader.preload(MIC_MODEL);
    assert.equal(FakeWorker.instances.length, 0);

    modelPreloader.clearRecentFailure(MIC_MODEL);
    modelPreloader.preload(MIC_MODEL);
    assert.equal(FakeWorker.instances.length, 1, 'clearing the cooldown must let the model warm again');
  });
});

describe('the Nemotron warm hold tracks the whole selection, not one call', () => {
  // Seed the hold the way a completed acquireSharedNemotronWorker() would.
  // preloadNemotronViaRegistry() then short-circuits on "already warm for this
  // id", so nothing here reaches the real registry.
  function seedNemotronHold() {
    const state = { released: 0 };
    modelPreloader.nemotronWarmRelease = () => { state.released++; };
    modelPreloader.nemotronWarmModelId = NEMOTRON_MODEL;
    modelPreloader.nemotronWarmPendingId = NEMOTRON_MODEL;
    return state;
  }

  test('a mixed selection (mic on Nemotron, system on Moonshine) keeps the hold', async () => {
    const hold = seedNemotronHold();

    // One app-launch batch, both channels.
    modelPreloader.preload(NEMOTRON_MODEL);
    modelPreloader.preload(SYSTEM_MODEL);
    await drainBatch();

    assert.equal(
      hold.released,
      0,
      'the non-Nemotron channel must not tear down the ONNX sessions the Nemotron channel is about to join',
    );
    assert.equal(modelPreloader.nemotronWarmModelId, NEMOTRON_MODEL, 'the hold must survive the batch');
    assert.equal(modelPreloader.isWarm(SYSTEM_MODEL), false, 'the other channel is still loading');
    assert.equal(FakeWorker.instances.length, 1, 'only the non-Nemotron model spawns a worker of its own');
  });

  test('a selection that no longer includes Nemotron releases the hold', async () => {
    const hold = seedNemotronHold();

    modelPreloader.preload(SYSTEM_MODEL);
    await drainBatch();

    assert.equal(hold.released, 1, 'nothing wants Nemotron any more — the registry must be let go');
    assert.equal(modelPreloader.nemotronWarmModelId, null);
    assert.equal(modelPreloader.nemotronWarmPendingId, null);
  });
});

describe('terminate tears every worker down without poisoning cooldowns', () => {
  test('warm and in-flight workers are all terminated and no failure is recorded', () => {
    const warm = preloadUntilWarm(MIC_MODEL);
    modelPreloader.preload(SYSTEM_MODEL); // still loading
    const loading = FakeWorker.instances.find(i => i.initModelId === SYSTEM_MODEL);

    modelPreloader.terminate();

    assert.equal(warm.terminated, true, 'warm workers must be terminated');
    assert.equal(loading.terminated, true, 'in-flight loads must be terminated');
    assert.equal(modelPreloader.warmWorkers.size, 0);
    assert.equal(modelPreloader.loadingWorkers.size, 0);
    // An intentional teardown exits non-zero; the listeners are removed first
    // precisely so that is not mistaken for "this model failed to load".
    assert.equal(
      modelPreloader.recentFailures.size,
      0,
      'tearing down healthy workers must not write a failure cooldown',
    );
  });
});
