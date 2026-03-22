const { Worker, isMainThread, parentPort } = require('worker_threads');
const path = require('path');

if (isMainThread) {
  const worker = new Worker(__filename);
  worker.on('message', m => console.log('Main got:', m));
  worker.on('error', e => console.error('Worker error:', e));
  worker.on('exit', code => console.log('Worker exited:', code));
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
    parentPort.postMessage('Loaded natively-audio successfully in worker!');
    process.exit(0);
  } catch (e) {
    parentPort.postMessage('Failed to load: ' + e.message);
  }
}
