import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolicy, evaluateSignals, normalizeConfig } from '../src/policy.js';

// 快速配置：sampleInterval 对纯逻辑无影响，只调迟滞参数。
const fastConfig = {
  warmupTicks: 1,
  hysteresis: {
    signalHoldTicks: 2,
    downgradeConfirmTicks: 2,
    recoverTicks: 3,
    changeCooldownTicks: 1,
  },
  thresholds: {
    longTask: {
      enabled: true,
      durationBands: [
        { level: 2, gte: 600 },
        { level: 1, gte: 250 },
      ],
      countBands: [{ level: 1, gte: 3 }],
      holdTicks: 1,
    },
  },
};

const healthy = {
  fps: { value: 60, reliable: true },
  longTask: { count: 0, duration: 0, maxDuration: 0 },
  memory: { supported: true, ratio: 0.3 },
  idle: { supported: true, remaining: 8, timeSinceIdle: 10 },
};

const stressed = {
  fps: { value: 18, reliable: true },
  longTask: { count: 5, duration: 1200, maxDuration: 400 },
  memory: { supported: true, ratio: 0.5 },
  idle: { supported: true, remaining: 0, timeSinceIdle: 900 },
};

function runTicks(policy, metrics, n) {
  const results = [];
  for (let i = 0; i < n; i += 1) results.push(policy.evaluate(metrics));
  return results;
}

test('配置可覆盖：normalizeConfig 深度合并自定义阈值与级别动作', () => {
  const cfg = normalizeConfig({
    thresholds: { fps: { bands: [{ level: 2, lte: 20 }] } },
    levels: [{ level: 0, animation: 'on', canvasScale: 1, pollingFactor: 1, cache: 'keep' }],
  });
  assert.equal(cfg.thresholds.fps.bands.length, 1);
  // 未覆盖的字段保留默认
  assert.equal(cfg.thresholds.memory.bands.length, 2);
  assert.equal(cfg.levels.length, 1);
});

test('模拟持续长任务后自动逐级降级，长任务 L2 叠加 idle 旁证最终达到 L3', () => {
  const policy = createPolicy(fastConfig);
  const r1 = policy.evaluate(stressed); // 第 1 拍：warmup
  assert.equal(r1.level, 0);
  assert.equal(r1.reason, 'warmup');

  const r2 = policy.evaluate(stressed); // 观察第 1 拍
  assert.equal(r2.level, 0);
  assert.ok(['pressure-pending'].includes(r2.reason));

  // 确认后降级（逐级，每拍最多一级 + 冷却）
  const trail = runTicks(policy, stressed, 8).map((r) => r.level);
  assert.ok(trail.includes(2), `轨迹 ${trail.join(',')} 应包含 L2`);
  // stressed 同时满足 idle 饥饿旁证，目标峰值被推高一级到 L3
  assert.equal(Math.max(...trail), 3);
  // 不能出现越级跳变
  for (let i = 1; i < trail.length; i += 1) {
    assert.ok(Math.abs(trail[i] - trail[i - 1]) <= 1, '禁止跨级跳变');
  }
});

test('恢复后逐级自动回升到 L0', () => {
  const policy = createPolicy(fastConfig);
  runTicks(policy, stressed, 10);
  assert.equal(policy.level, 3);

  const recovery = runTicks(policy, healthy, 24);
  assert.equal(recovery.at(-1).level, 0);
  // 回升必须逐级
  const levels = recovery.map((r) => r.level);
  for (let i = 1; i < levels.length; i += 1) {
    assert.ok(levels[i - 1] - levels[i] <= 1, '回升不能跨级');
  }
});

test('防抖：单拍偶发长任务不会造成误降级', () => {
  const policy = createPolicy(fastConfig);
  policy.evaluate(healthy); // warmup
  policy.evaluate(healthy); // 健康基线

  // 只出现一拍压力，随即恢复
  const blip = policy.evaluate(stressed);
  assert.equal(blip.level, 0, '单拍压力不应降级');
  for (let i = 0; i < 8; i += 1) {
    const r = policy.evaluate(healthy);
    assert.equal(r.level, 0);
  }
});

test('防抖：阈值边界来回抖动不会频繁切换级别', () => {
  const policy = createPolicy(fastConfig);
  policy.evaluate(healthy);
  const wobbleLow = { ...healthy, fps: { value: 51, reliable: true } };
  const wobbleBad = { ...healthy, fps: { value: 49, reliable: true } };
  let downgrades = 0;
  for (let i = 0; i < 12; i += 1) {
    const m = i % 2 === 0 ? wobbleBad : wobbleLow;
    const r = policy.evaluate(m);
    if (r.changed && r.level > 0) downgrades += 1;
  }
  assert.equal(downgrades, 0, '阈值附近每拍来回横跳时不应降级');
  assert.equal(policy.level, 0);
});

test('恢复确认期内再次恶化不会错误回升', () => {
  const policy = createPolicy(fastConfig);
  runTicks(policy, stressed, 10);
  assert.equal(policy.level, 3);

  policy.evaluate(healthy);
  policy.evaluate(healthy);
  const backDown = policy.evaluate(stressed);
  assert.equal(policy.level, 3, '恢复尚未确认，级别应保持');
});

test('不支持 performance.memory 的浏览器：内存信号不投票，不影响其他信号', () => {
  const metrics = {
    ...healthy,
    memory: { supported: false, source: 'unsupported' },
  };
  const cfg = normalizeConfig(fastConfig);
  const signals = evaluateSignals(metrics, cfg);
  assert.equal(signals.memory, null);
  assert.equal(signals.fps, 0);
  // 健康样本的长任务级别为 0
  const sig2 = evaluateSignals({ ...metrics, longTask: { count: 0, duration: 0 } }, cfg);
  assert.equal(sig2.longTask, 0);

  // 即便内存"假性爆表"也无从产生 —— 用不支持的样本跑策略，永不因内存降级
  const policy = createPolicy(fastConfig);
  const noMem = { ...stressed, memory: { supported: false } };
  // stressed 里 fps/longTask 仍会导致降级，这是预期；这里改为仅内存高
  const onlyMemoryBroken = {
    ...healthy,
    memory: { supported: false },
  };
  policy.evaluate(onlyMemoryBroken);
  for (let i = 0; i < 10; i += 1) assert.equal(policy.evaluate(onlyMemoryBroken).level, 0);
});

test('FPS 样本不可信（后台/帧数不足）时不投票，避免切标签页误判', () => {
  const cfg = normalizeConfig(fastConfig);
  const signals = evaluateSignals(
    { ...healthy, fps: { value: 0, reliable: false, frames: 0 } },
    cfg,
  );
  assert.equal(signals.fps, null);
});

test('idle 饥饿默认仅作旁证：单独出现不降级，与其他压力叠加时推高', () => {
  const policy = createPolicy(fastConfig);
  const onlyStarve = { ...healthy, idle: { supported: true, remaining: 0, timeSinceIdle: 900 } };
  runTicks(policy, onlyStarve, 10);
  assert.equal(policy.level, 0, '仅 idle 旁证不应单独触发降级');
});

test('温和压力只降到 L1，且动作集与级别对应', () => {
  const policy = createPolicy(fastConfig);
  const mild = {
    fps: { value: 40, reliable: true },
    longTask: { count: 4, duration: 300, maxDuration: 120 },
    memory: { supported: true, ratio: 0.3 },
    idle: { supported: true, remaining: 6, timeSinceIdle: 10 },
  };
  runTicks(policy, mild, 10);
  assert.equal(policy.level, 1);
  assert.equal(policy.evaluate(mild).action.animation, 'reduced');
  assert.equal(policy.evaluate(mild).action.pollingFactor, 2);
});
