const { Worker, isMainThread, parentPort } = require('worker_threads');
const path = require('path');

if (isMainThread) {
  const worker = new Worker(__filename);
  worker.on('message', m => console.log('Main got:', m));
  worker.on('error', e => console.error('Worker error:', e));
  worker.on('exit', code => {
    console.log('Worker exited:', code);
    // Propagate non-zero exit codes to the parent process so CI scripts
    // can detect failures — previously this was silently lost.
    if (code !== 0) process.exit(code);
  });
} else {
  try {
    // Worker has no Electron context, so load the .node binary directly by path
    const { platform, arch } = process;
    const map = {
      win32:  { x64: 'index.win32-x64-msvc.node' },
      darwin: { x64: 'index.darwin-x64.node', arm64: 'index.darwin-arm64.node' },
      linux:  { x64: 'index.linux-x64-gnu.node', arm64: 'index.linux-arm64-gnu.node' },
    };
    const binary = map[platform]?.[arch] ?? `index.${platform}-${arch}.node`;
    const NativeModule = require(path.join(__dirname, 'native-module', binary));
    // Verify the module actually exports the expected surface
    if (typeof NativeModule.SystemAudioCapture !== 'function') {
      throw new Error('SystemAudioCapture export missing from native binding');
    }
    parentPort.postMessage('Loaded natively-audio successfully in worker!');
    process.exit(0);
  } catch (e) {
    // Report failure to the parent AND exit non-zero so the test is detectable as failed.
    parentPort.postMessage('Failed to load: ' + e.message);
    process.exit(1);
  }
}
