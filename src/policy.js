// 降级决策状态机。纯逻辑、无 DOM/Worker 依赖，可在 Worker、主线程回退和测试中复用。
//
// 设计要点：
// 1. 每个信号（memory/fps/longTask/idle）独立保持，必须连续 N 个 tick 维持同一
//    级别才被采纳 —— 单次 GC、偶发卡顿不会立刻触发降级。
// 2. 全局级别变化带冷却 + 降级确认 + 恢复确认，且每拍只升降一级（step-wise），
//    从机制上消除边界抖动（flapping）。
// 3. 页面不可见、样本不足、不支持的指标会产出 null（未知），未知信号不参与投票。
// 4. idle 饥饿默认仅作旁证：已有其他信号报警时，允许其把目标级别推高一级。

import { DEFAULT_CONFIG, MAX_LEVEL } from './default-config.js';

export function deepMerge(base, override) {
  if (!override) return structuredCloneSafe(base);
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const key of Object.keys(override)) {
    const bv = base ? base[key] : undefined;
    const ov = override[key];
    if (ov && typeof ov === 'object' && !Array.isArray(ov) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[key] = deepMerge(bv, ov);
    } else {
      out[key] = ov;
    }
  }
  return out;
}

function structuredCloneSafe(v) {
  return JSON.parse(JSON.stringify(v));
}

export function normalizeConfig(override) {
  return deepMerge(DEFAULT_CONFIG, override || {});
}

function matchGteLte(value, bands) {
  if (value == null || Number.isNaN(value)) return null;
  let hit = null;
  for (const band of bands) {
    const ok = band.gte != null ? value >= band.gte : value <= band.lte;
    if (ok && (hit == null || band.level > hit)) hit = band.level;
  }
  return hit;
}

// 把一组原始指标换算为各信号的原始级别（null = 未知/不投票）。
export function evaluateSignals(metrics, config) {
  const t = config.thresholds;
  const signals = {};

  if (metrics.memory && metrics.memory.supported !== false && t.memory.enabled !== false) {
    const memLevel = matchGteLte(metrics.memory.ratio, t.memory.bands);
    // 支持采样但拿不到可用比率（如异步 API 无 limit）=> null（未知，不投票）；
    // 有比率且未命中阈值 => 0（已知健康）。
    signals.memory = metrics.memory.ratio == null ? null : memLevel ?? 0;
  } else {
    signals.memory = null;
  }

  if (metrics.fps && metrics.fps.reliable !== false && t.fps.enabled !== false) {
    signals.fps = matchGteLte(metrics.fps.value, t.fps.bands) ?? 0;
  } else {
    signals.fps = null;
  }

  if (metrics.longTask && t.longTask.enabled !== false) {
    const byDuration = matchGteLte(metrics.longTask.duration, t.longTask.durationBands);
    const byCount = matchGteLte(metrics.longTask.count, t.longTask.countBands);
    const longTaskLevel = [byDuration, byCount].reduce(
      (a, b) => (b == null ? a : Math.max(a ?? 0, b)),
      null,
    );
    // 采样器有数据输出但未命中任何阈值，属于"已知健康"=0（而非未知 null）。
    signals.longTask = longTaskLevel == null ? 0 : longTaskLevel;
  } else {
    signals.longTask = null;
  }

  if (
    metrics.idle &&
    metrics.idle.supported !== false &&
    t.idle.enabled !== false &&
    t.idle.mode === 'signal'
  ) {
    signals.idle = matchGteLte(metrics.idle.remaining, t.idle.bands);
  } else {
    signals.idle = null;
  }

  return signals;
}

// idle 饥饿是否作为旁证成立。
export function idleStarving(metrics, config) {
  const t = config.thresholds;
  if (!metrics.idle || metrics.idle.supported === false || t.idle.enabled === false) return false;
  return metrics.idle.timeSinceIdle >= t.idle.starveMs;
}

function initSignalState() {
  return { candidate: null, ticks: 0 };
}

export function createPolicy(overrideConfig) {
  const config = normalizeConfig(overrideConfig);
  const hy = config.hysteresis;

  const signalKeys = ['memory', 'fps', 'longTask', 'idle'];
  const raw = Object.fromEntries(signalKeys.map((k) => [k, initSignalState()]));

  let level = 0;
  let tickIndex = 0;
  let downgradeObserved = 0; // 连续出现压力的 tick 数
  let healthyStreak = 0; // 连续完全健康的 tick 数
  let cooldown = 0; // 距上次级别变化剩余冷却 tick

  function settleSignal(key, observed, holdTicks) {
    const s = raw[key];
    if (observed === s.candidate) {
      s.ticks += 1;
    } else {
      s.candidate = observed;
      s.ticks = 1;
    }
    // 保持足够久才采纳；未知(null)立即采纳，防止被过期信号拖住。
    if (observed == null) return null;
    return s.ticks >= holdTicks ? observed : null;
  }

  function evaluate(metrics) {
    tickIndex += 1;
    const previousLevel = level;

    // 启动保护期：只预热各信号，不做决策。
    if (tickIndex <= config.warmupTicks) {
      return buildResult(previousLevel, 'warmup');
    }

    if (cooldown > 0) cooldown -= 1;

    const observed = evaluateSignals(metrics, config);
    const settled = {
      memory: settleSignal('memory', observed.memory, config.thresholds.memory.holdTicks ?? hy.signalHoldTicks),
      fps: settleSignal('fps', observed.fps, config.thresholds.fps.holdTicks ?? hy.signalHoldTicks),
      longTask: settleSignal('longTask', observed.longTask, config.thresholds.longTask.holdTicks ?? hy.signalHoldTicks),
      idle: settleSignal('idle', observed.idle, config.thresholds.idle.holdTicks ?? hy.signalHoldTicks),
    };

    const votes = Object.values(settled).filter((v) => v != null);
    const pressure = votes.length ? Math.max(...votes) : 0;
    const corroborated = idleStarving(metrics, config);
    // 旁证只在已有其他信号报警时"推高一级"，零压力时绝不单独引发降级。
    const targetPeak = pressure > 0 && corroborated ? Math.min(MAX_LEVEL, pressure + 1) : pressure;

    let reason = 'steady';

    if (targetPeak > level) {
      downgradeObserved += 1;
      healthyStreak = 0;
      if (downgradeObserved >= hy.downgradeConfirmTicks && cooldown === 0) {
        // 逐级升降，避免从 0 直接跳到 3 后又反弹。
        level = Math.min(level + 1, targetPeak);
        cooldown = hy.changeCooldownTicks;
        downgradeObserved = 0;
        reason = 'downgrade';
      } else {
        reason = 'pressure-pending';
      }
    } else {
      downgradeObserved = 0;
      if (level > 0) {
        // 必须所有信号都回到健康（或未知），且持续 recoverTicks。
        const anyUnhealthy = votes.some((v) => v > 0) || corroborated;
        if (anyUnhealthy) {
          healthyStreak = 0;
          reason = 'held';
        } else {
          healthyStreak += 1;
          if (healthyStreak >= hy.recoverTicks && cooldown === 0) {
            level -= 1;
            cooldown = hy.changeCooldownTicks;
            healthyStreak = 0; // 若仍有余量，继续逐拍恢复
            reason = 'recover';
          } else {
            reason = 'recover-pending';
          }
        }
      } else {
        healthyStreak = 0;
      }
    }

    return buildResult(previousLevel, reason, { observed, settled, targetPeak, corroborated });
  }

  function buildResult(previousLevel, reason, debug) {
    return {
      level,
      changed: level !== previousLevel,
      reason,
      tickIndex,
      action: config.levels[level],
      rawSignals: debug ? debug.settled : undefined,
      observedSignals: debug ? debug.observed : undefined,
      targetPeak: debug ? debug.targetPeak : undefined,
      idleCorroborated: debug ? debug.corroborated : undefined,
    };
  }

  return {
    evaluate,
    get level() {
      return level;
    },
    get tickIndex() {
      return tickIndex;
    },
    config,
  };
}
