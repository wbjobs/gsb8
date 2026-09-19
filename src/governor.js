// PerformanceGovernor：自适应性能降级总控。
//
// 数据流：采样器(rAF/PerformanceObserver/rIC/performance.memory)
//   --每拍 metrics--> Web Worker(决策状态机) --decision--> 动作执行器
//                                              （动画/Canvas/轮询/缓存）
// Worker 不可用时自动回退到主线程内运行同一套 createPolicy 逻辑。
import { normalizeConfig, createPolicy } from './policy.js';
import { createFpsSampler } from './samplers/fps.js';
import { createLongTaskSampler } from './samplers/long-task.js';
import { createMemorySampler } from './samplers/memory.js';
import { createIdleSampler } from './samplers/idle.js';
import { createAnimationController } from './actions/animation.js';
import { createCanvasRegistry } from './actions/canvas.js';
import { createPollingRegistry } from './actions/polling.js';
import { createCacheRegistry } from './actions/cache.js';

function createEventEmitter() {
  const map = new Map();
  return {
    on(type, fn) {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
      return () => map.get(type)?.delete(fn);
    },
    emit(type, payload) {
      for (const fn of map.get(type) ?? []) {
        try {
          fn(payload);
        } catch (err) {
          console.error(`[governor] listener for "${type}" failed`, err);
        }
      }
    },
  };
}

export class PerformanceGovernor {
  constructor(config = {}, options = {}) {
    this.config = normalizeConfig(config);
    this.emitter = createEventEmitter();

    // 动作执行器可由外部注入（测试用），否则创建默认实例。
    this.animation = options.animation || createAnimationController();
    this.canvas = options.canvas || createCanvasRegistry();
    this.polling = options.polling || createPollingRegistry();
    this.caches = options.caches || createCacheRegistry();

    this.fps = createFpsSampler();
    this.longTasks = createLongTaskSampler();
    this.memory = createMemorySampler();
    this.idle = createIdleSampler(this.config.thresholds.idle.starveMs);

    this.capabilities = {
      memory: this.memory.supported,
      memorySource: this.memory.source,
      longTask: this.longTasks.supported,
      requestIdleCallback: typeof requestIdleCallback === 'function',
      worker: false,
    };

    this.level = 0;
    this.lastMetrics = null;
    this.lastDecision = null;
    this.running = false;
    this.tickTimer = 0;
    this.worker = null;
    this.fallbackPolicy = null;
    this._cacheReleaseOff = this.caches.onRelease((detail) => {
      this.emitter.emit('cacherelease', detail);
    });
  }

  start() {
    if (this.running) return this;
    this.running = true;
    this.animation.init();
    this.fps.start();
    this.idle.start();
    this._startDecisionBackend();
    this._scheduleTick(this.config.sampleInterval);
    return this;
  }

  stop() {
    this.running = false;
    clearTimeout(this.tickTimer);
    this.fps.stop();
    this.longTasks.stop();
    this.idle.stop();
    this.memory.stop();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    return this;
  }

  // ---- 对外事件：levelchange / metrics / decision / cacherelease ----
  on(type, fn) {
    return this.emitter.on(type, fn);
  }

  getStatus() {
    return {
      level: this.level,
      running: this.running,
      capabilities: { ...this.capabilities },
      metrics: this.lastMetrics,
      decision: this.lastDecision,
      actions: {
        animation: this.animation.getState(),
        canvasScale: this.canvas.getScale(),
        pollingFactor: this.polling.getFactor(),
        cacheMode: this.caches.getMode(),
      },
    };
  }

  // 手动施加级别（测试/逃生舱），与自动决策结果走同一动作通道。
  setLevelManual(level, reason = 'manual') {
    this._applyDecision({
      level,
      changed: level !== this.level,
      reason,
      action: this.config.levels[level],
    });
  }

  // 运行期更新配置（阈值/策略热更新）：重建决策状态机，级别从 0 重新学习。
  updateConfig(override) {
    this.config = normalizeConfig(override);
    this.idle.setStarveMs(this.config.thresholds.idle.starveMs);
    if (this.worker) {
      this.worker.postMessage({ type: 'init', config: this.config });
    } else if (this.fallbackPolicy) {
      this.fallbackPolicy = createPolicy(this.config);
    }
    this.emitter.emit('config', this.config);
  }

  // ---------- 内部实现 ----------

  _startDecisionBackend() {
    const useWorker = typeof Worker !== 'undefined';
    if (!useWorker) {
      this._enableFallback('unsupported');
      return;
    }
    try {
      // 以 module worker 加载，同源静态服务器或打包器均可解析。
      this.worker = new Worker(new URL('./governor-worker.js', import.meta.url), { type: 'module' });
      const fallbackTimer = setTimeout(() => {
        // Worker 迟迟未 ready（某些受限环境静默失败）—— 回退主线程。
        if (this.running && !this.capabilities.worker) this._enableFallback('timeout');
      }, 1500);

      this.worker.onmessage = (event) => {
        const msg = event.data || {};
        if (msg.type === 'ready') {
          clearTimeout(fallbackTimer);
          this.capabilities.worker = true;
          this.emitter.emit('backend', { type: 'worker' });
        } else if (msg.type === 'decision') {
          this._applyDecision(msg);
        }
      };
      this.worker.onerror = () => {
        clearTimeout(fallbackTimer);
        if (!this.capabilities.worker) this._enableFallback('error');
      };
      this.worker.postMessage({ type: 'init', config: this.config });
    } catch {
      this._enableFallback('construct-failed');
    }
  }

  _enableFallback(reason) {
    // 已在回退模式时忽略迟到的 worker 事件（如 terminate 后的 error）。
    if (!this.worker && this.fallbackPolicy) return;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.capabilities.worker = false;
    this.fallbackPolicy = createPolicy(this.config);
    this.emitter.emit('backend', { type: 'main-thread', reason });
  }

  _scheduleTick(delay) {
    clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => {
      this._tick().finally(() => {
        if (this.running) this._scheduleTick(this.config.sampleInterval);
      });
    }, delay);
  }

  async _tick() {
    // 异步内存 API：先取（结果在下一拍打点使用）；同步 API 立即返回。
    await this.memory.prefetch();

    const metrics = {
      ts: Date.now(),
      visible: document.visibilityState === 'visible',
      fps: this.fps.sample(this.config.sampleInterval, this.config.thresholds.fps.minFramesReliable),
      longTask: this.longTasks.sample(),
      memory: this.memory.sample(),
      idle: this.idle.sample(),
    };
    this.lastMetrics = metrics;
    this.emitter.emit('metrics', metrics);

    if (this.worker) {
      this.worker.postMessage({ type: 'metrics', metrics });
    } else if (this.fallbackPolicy) {
      this._applyDecision(this.fallbackPolicy.evaluate(metrics));
    }
  }

  _applyDecision(decision) {
    this.lastDecision = {
      level: decision.level,
      changed: decision.changed,
      reason: decision.reason,
      tickIndex: decision.tickIndex,
      rawSignals: decision.rawSignals,
      observedSignals: decision.observedSignals,
      targetPeak: decision.targetPeak,
      idleCorroborated: decision.idleCorroborated,
    };
    this.emitter.emit('decision', this.lastDecision);

    if (!decision.changed || decision.action == null) return;
    this.level = decision.level;
    this.animation.apply(decision.action.animation);
    this.canvas.apply(decision.action.canvasScale);
    this.polling.apply(decision.action.pollingFactor);
    this.caches.apply(decision.action.cache);
    this.emitter.emit('levelchange', {
      level: decision.level,
      reason: decision.reason,
      action: decision.action,
    });
  }
}

export function createGovernor(config, options) {
  return new PerformanceGovernor(config, options);
}
