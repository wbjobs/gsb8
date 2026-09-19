// Web Worker：在独立线程运行降级决策状态机，避免决策代码本身占用主线程。
// 主线程每拍把采样到的 metrics 发过来，Worker 返回级别与应执行的动作。
import { createPolicy } from './policy.js';

let policy = null;

self.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type === 'init') {
    policy = createPolicy(msg.config || {});
    self.postMessage({ type: 'ready', tickInterval: policy.config.sampleInterval });
    return;
  }
  if (msg.type === 'metrics' && policy) {
    const result = policy.evaluate(msg.metrics || {});
    self.postMessage({
      type: 'decision',
      level: result.level,
      changed: result.changed,
      reason: result.reason,
      tickIndex: result.tickIndex,
      action: result.action,
      rawSignals: result.rawSignals,
      observedSignals: result.observedSignals,
      targetPeak: result.targetPeak,
      idleCorroborated: result.idleCorroborated,
    });
  }
};
