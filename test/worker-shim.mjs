// Node worker_threads 下的浏览器 Worker 全局垫片，用于端到端冒烟 governor-worker.js。
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (data) => {
  if (globalThis.__onmessage) globalThis.__onmessage({ data });
});

globalThis.self = {
  postMessage: (msg) => parentPort.postMessage(msg),
  set onmessage(fn) {
    globalThis.__onmessage = fn;
  },
};

await import('../src/governor-worker.js');
