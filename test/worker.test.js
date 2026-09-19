import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const shim = fileURLToPath(new URL('./worker-shim.mjs', import.meta.url));

const fastConfig = {
  warmupTicks: 1,
  hysteresis: { signalHoldTicks: 2, downgradeConfirmTicks: 2, recoverTicks: 3, changeCooldownTicks: 1 },
};

const stressed = {
  visible: true,
  fps: { value: 15, reliable: true },
  longTask: { count: 6, duration: 1200, maxDuration: 400 },
  memory: { supported: true, ratio: 0.4 },
  idle: { supported: true, remaining: 0, timeSinceIdle: 900 },
};
const healthy = {
  visible: true,
  fps: { value: 60, reliable: true },
  longTask: { count: 0, duration: 0, maxDuration: 0 },
  memory: { supported: true, ratio: 0.3 },
  idle: { supported: true, remaining: 8, timeSinceIdle: 5 },
};

function drive(worker, metrics, n) {
  return new Promise((resolve) => {
    let last;
    let received = 0;
    const onMsg = (msg) => {
      if (msg.type !== 'decision') return;
      last = msg;
      received += 1;
      if (received < n) {
        worker.postMessage({ type: 'metrics', metrics });
      } else {
        worker.off('message', onMsg);
        resolve(last);
      }
    };
    worker.on('message', onMsg);
    worker.postMessage({ type: 'metrics', metrics });
  });
}

test('Web Worker 内决策状态机：压力降级 → 健康回升，消息协议正确', async () => {
  const worker = new Worker(shim);
  const ready = new Promise((resolve) =>
    worker.once('message', (m) => (m.type === 'ready' ? resolve(m) : resolve(null))),
  );
  worker.postMessage({ type: 'init', config: fastConfig });
  const readyMsg = await ready;
  assert.equal(readyMsg.type, 'ready');

  const degraded = await drive(worker, stressed, 10);
  assert.ok(degraded.level >= 2, `应降至 L2+，实际 L${degraded.level}`);
  assert.equal(degraded.action.animation, 'off');
  assert.ok(degraded.action.pollingFactor >= 4);

  const recovered = await drive(worker, healthy, 24);
  assert.equal(recovered.level, 0);
  assert.equal(recovered.action.animation, 'on');
  assert.equal(recovered.action.canvasScale, 1);

  await worker.terminate();
});
