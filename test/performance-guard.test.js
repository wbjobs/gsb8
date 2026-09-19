import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ManagedCache } from '../src/managed-cache.js'
import { PerformanceGuard } from '../src/performance-guard.js'

function createHooks(options = {}) {
  let time = 0
  let frameCallback = null
  const observers = []
  const performance = {
    now: () => time,
    memory: options.memory === false ? undefined : {
      usedJSHeapSize: 10,
      jsHeapSizeLimit: 100
    }
  }
  class FakeObserver {
    constructor(callback) {
      this.callback = callback
    }
    observe() {
      observers.push(this)
    }
    disconnect() {}
    emit(entries) {
      this.callback({ getEntries: () => entries })
    }
  }
  const hooks = {
    time,
    performance,
    observers,
    levels: [],
    polling: [],
    cacheReleases: [],
    advance(ms) {
      time += ms
      hooks.time = time
    },
    frame(gap = 16) {
      const callback = frameCallback
      frameCallback = null
      hooks.advance(gap)
      callback(time)
    },
    emitLongTask(duration) {
      hooks.advance(duration)
      for (const observer of observers) {
        observer.emit([{ entryType: 'longtask', duration, startTime: time - duration }])
      }
      const callback = frameCallback
      frameCallback = null
      callback(time)
    },
    requestAnimationFrame(callback) {
      frameCallback = callback
      return 1
    },
    cancelAnimationFrame() {
      frameCallback = null
    },
    requestIdleCallback(callback) {
      queueMicrotask(() => callback({ timeRemaining: () => 1 }))
      return 1
    },
    cancelIdleCallback() {},
    createWorker: () => ({
      addEventListener() {},
      postMessage(message) {
        if (message.type === 'set-interval') hooks.polling.push(message.interval)
      },
      terminate() {}
    }),
    PerformanceObserver: FakeObserver,
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {}
    }
  }
  return hooks
}

function createGuard(hooks, options = {}) {
  return new PerformanceGuard({
    performance: hooks.performance,
    requestAnimationFrame: hooks.requestAnimationFrame,
    cancelAnimationFrame: hooks.cancelAnimationFrame,
    requestIdleCallback: hooks.requestIdleCallback,
    cancelIdleCallback: hooks.cancelIdleCallback,
    PerformanceObserver: hooks.PerformanceObserver,
    document: hooks.document,
    createWorker: hooks.createWorker,
    reaction: { warmupMs: 250, sampleIntervalMs: 1000, downgradeAfter: 2, recoverAfter: 3, recoveryCooldownMs: 1000, idleTimeoutMs: 100 },
    thresholds: {
      fps: { windowMs: 3000, minFrames: 5 },
      memory: { usedRatio: [0.7, 0.85, 0.98], recoverRatio: [0.55, 0.7, 0.9] },
      longTask: { windowMs: 5000, minEntryDuration: 45 }
    },
    onLevelChange: (event) => hooks.levels.push(event.level),
    onPollingIntervalChange: (interval) => hooks.polling.push(interval),
    onReleaseCache: (event) => hooks.cacheReleases.push(event),
    ...options
  })
}

describe('PerformanceGuard', () => {
  it('连续长任务后降级，恢复后自动回升', async () => {
    const hooks = createHooks()
    const guard = createGuard(hooks)
    await guard.start()

    hooks.frame(16)
    hooks.emitLongTask(220)
    hooks.emitLongTask(220)
    assert.equal(guard.getState().level, 0, '单个采样点不能立即降级')
    hooks.emitLongTask(220)
    for (let index = 0; index < 350; index += 1) hooks.frame(16)
    assert.ok(guard.getState().level >= 1)

    await Promise.resolve()
    hooks.frame(5200)
    for (let index = 0; index < 650; index += 1) hooks.frame(16)
    await Promise.resolve()
    assert.equal(guard.getState().level, 0)
    assert.deepEqual(hooks.levels, [0, 1, 2, 1, 0])
    assert.ok(hooks.polling.includes(1000))
    assert.equal(hooks.polling.at(-1), 1000)
  })

  it('不支持 performance.memory 时跳过内存指标，不影响长任务降级', async () => {
    const hooks = createHooks({ memory: false })
    const guard = createGuard(hooks)
    await guard.start()
    hooks.frame(16)
    hooks.emitLongTask(220)
    hooks.emitLongTask(220)
    hooks.emitLongTask(220)
    for (let index = 0; index < 350; index += 1) hooks.frame(16)

    assert.ok(guard.getState().level >= 1)
    assert.equal(guard.getState().metrics.memory.supported, false)
    assert.equal(guard.getState().capabilities.memory, false)
  })

  it('使用可配置策略并在降级时释放缓存', async () => {
    const hooks = createHooks()
    const cache = new ManagedCache({ name: 'test', maxEntries: 10 })
    for (let index = 0; index < 8; index += 1) cache.set(index, index)
    const guard = createGuard(hooks, {
      caches: [cache],
      policies: [
        { animationsEnabled: true, canvasScale: 1, pollingIntervalMs: 500, cacheRelease: 'none' },
        { animationsEnabled: true, canvasScale: 1, pollingIntervalMs: 500, cacheRelease: 'none' },
        { animationsEnabled: false, canvasScale: .7, pollingIntervalMs: 2500, cacheRelease: 'oldest' },
        { animationsEnabled: false, canvasScale: .4, pollingIntervalMs: 10000, cacheRelease: 'all' }
      ]
    })
    await guard.start()
    hooks.frame(16)
    hooks.emitLongTask(220)
    hooks.emitLongTask(220)
    hooks.emitLongTask(220)
    for (let index = 0; index < 350; index += 1) hooks.frame(16)

    await Promise.resolve()
    assert.ok(guard.getState().level >= 1)
    assert.ok(cache.size <= 4)
    assert.notEqual(hooks.polling.at(-1), 500)
    assert.equal(hooks.cacheReleases[0].strategy, 'oldest')
  })

  it('内存压力带滞回，不会在阈值附近频繁抖动', async () => {
    const hooks = createHooks()
    const guard = createGuard(hooks)
    await guard.start()

    hooks.performance.memory = { usedJSHeapSize: 80, jsHeapSizeLimit: 100 }
    for (let index = 0; index < 200; index += 1) hooks.frame(16)
    assert.equal(guard.getState().level, 1)

    hooks.performance.memory = { usedJSHeapSize: 50, jsHeapSizeLimit: 100 }
    for (let index = 0; index < 220; index += 1) hooks.frame(16)
    assert.equal(guard.getState().level, 0)

    hooks.performance.memory = { usedJSHeapSize: 65, jsHeapSizeLimit: 100 }
    for (let index = 0; index < 220; index += 1) hooks.frame(16)
    assert.equal(guard.getState().level, 0, '高于恢复线但低于降级线时应保持当前级别')
  })

  it('单个长任务不会造成误降级', async () => {
    const hooks = createHooks()
    const guard = createGuard(hooks)
    await guard.start()
    hooks.emitLongTask(220)
    for (let index = 0; index < 400; index += 1) hooks.frame(16)
    assert.deepEqual(hooks.levels, [0])
    assert.equal(guard.getState().level, 0)
  })

  it('原生 longtask 事件不会和帧间隔兜底重复计数', async () => {
    const hooks = createHooks()
    const guard = createGuard(hooks)
    await guard.start()
    hooks.emitLongTask(220)
    assert.equal(hooks.observers.length, 1)
    hooks.frame(900)
    assert.equal(guard.lastMetrics.longTask.count, 1)
  })

})
