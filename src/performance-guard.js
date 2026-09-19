import { DEFAULT_POLICIES, DEFAULT_REACTION, DEFAULT_THRESHOLDS } from './defaults.js'

export class PerformanceGuard {
  constructor(options = {}) {
    this.thresholds = mergeOptions(DEFAULT_THRESHOLDS, options.thresholds || {})
    this.policies = normalizePolicies(options.policies || DEFAULT_POLICIES)
    this.reaction = { ...DEFAULT_REACTION, ...(options.reaction || {}) }

    this.callbacks = {
      onLevelChange: options.onLevelChange,
      onAnimationsChange: options.onAnimationsChange,
      onCanvasScale: options.onCanvasScale,
      onImageSmoothingChange: options.onImageSmoothingChange,
      onPollingIntervalChange: options.onPollingIntervalChange,
      onPoll: options.onPoll,
      onReleaseCache: options.onReleaseCache,
      onMetrics: options.onMetrics
    }

    this.caches = options.caches ? new Map(options.caches.map((cache) => [cache.name || 'cache', cache])) : null
    this.customCacheRelease = typeof options.releaseCache === 'function' ? options.releaseCache : null
    this.workerFactory = options.createWorker
    this.workerUrl = options.workerUrl || new URL('./polling.worker.js', import.meta.url)

    this.performance = options.performance || globalThis.performance
    this.document = options.document || globalThis.document
    this.requestFrame = options.requestAnimationFrame || globalThis.requestAnimationFrame?.bind(globalThis)
    this.cancelFrame = options.cancelAnimationFrame || globalThis.cancelAnimationFrame?.bind(globalThis)
    this.requestIdle = options.requestIdleCallback || globalThis.requestIdleCallback?.bind(globalThis)
    this.cancelIdle = options.cancelIdleCallback || globalThis.cancelIdleCallback?.bind(globalThis)
    this.Observer = options.PerformanceObserver || globalThis.PerformanceObserver

    this.level = options.initialLevel || 0
    this.targetLevel = this.level
    this.forceLevel = null
    this.running = false
    this.destroyed = false
    this.startedAt = 0
    this.lastLevelChangeAt = 0
    this.lastSampleAt = 0
    this.frameHandle = null
    this.worker = null
    this.pollingFallback = null
    this.pollingInterval = 1000
    this.idleMetricHandle = null
    this.idleCacheHandle = null
    this.visibilityHandler = null

    this.frames = []
    this.longTasks = []
    this.longTaskObserver = null
    this.downgradeStreaks = [0, 0, 0, 0]
    this.recoveryStreak = 0
    this.previousCandidate = 0
    this.lastMetrics = null
    this.capabilities = {
      memory: false,
      longTask: false,
      nativeLongTask: false,
      worker: false,
      idleCallback: Boolean(this.requestIdle)
    }

    this.handleFrame = this.handleFrame.bind(this)
    this.handleWorkerMessage = this.handleWorkerMessage.bind(this)

    if (this.policies.length !== 4) throw new Error('policies must contain normal and three degradation levels')
    if (this.reaction.downgradeAfter < 1) throw new Error('reaction.downgradeAfter must be >= 1')
    if (this.reaction.recoverAfter < 1) throw new Error('reaction.recoverAfter must be >= 1')
  }

  async start() {
    if (this.destroyed) throw new Error('PerformanceGuard has been destroyed')
    if (this.running) return
    this.running = true
    this.startedAt = this.now()
    this.lastSampleAt = this.startedAt
    this.connectWorker()
    this.connectLongTaskObserver()
    this.connectVisibility()
    this.applyLevel(this.level, 'initial')
    if (this.requestFrame) this.frameHandle = this.requestFrame(this.handleFrame)
  }

  stop() {
    this.running = false
    if (this.frameHandle && this.cancelFrame) this.cancelFrame(this.frameHandle)
    this.frameHandle = null
    if (this.longTaskObserver) {
      this.longTaskObserver.disconnect()
      this.capabilities.nativeLongTask = false
    }
    if (this.worker) this.worker.postMessage({ type: 'stop' })
    if (this.pollingFallback) clearTimeout(this.pollingFallback)
    this.pollingFallback = null
    this.cancelScheduledIdle('idleMetricHandle')
    this.cancelScheduledIdle('idleCacheHandle')
  }

  destroy() {
    this.stop()
    if (this.worker) this.worker.terminate()
    if (this.document && this.visibilityHandler) {
      this.document.removeEventListener('visibilitychange', this.visibilityHandler)
    }
    this.destroyed = true
  }

  setLevel(level, reason = 'manual') {
    const next = clampLevel(level)
    this.forceLevel = next
    this.targetLevel = next
    this.applyLevel(next, reason)
  }

  releaseManualControl() {
    this.forceLevel = null
  }

  getState() {
    return {
      level: this.level,
      targetLevel: this.targetLevel,
      forced: this.forceLevel !== null,
      running: this.running,
      destroyed: this.destroyed,
      policy: this.policies[this.level],
      capabilities: { ...this.capabilities },
      metrics: this.lastMetrics ? { ...this.lastMetrics } : null
    }
  }

  now() {
    return this.performance && typeof this.performance.now === 'function'
      ? this.performance.now()
      : Date.now()
  }

  handleFrame(timestamp) {
    if (!this.running) return
    const now = typeof timestamp === 'number' ? timestamp : this.now()
    if (this.lastFrameAt) {
      const gap = now - this.lastFrameAt
      if (!this.capabilities.nativeLongTask && gap > this.thresholds.longTask.minEntryDuration) {
        this.recordLongTaskEntry(gap, 'synthetic')
      }
      this.frames.push({ at: now, duration: Math.min(gap, 1000) })
    }
    this.lastFrameAt = now
    if (now - this.lastSampleAt >= this.reaction.sampleIntervalMs) this.sample(now)
    if (this.running && this.requestFrame) this.frameHandle = this.requestFrame(this.handleFrame)
  }

  recordLongTaskEntry(duration, source = 'longtask') {
    this.longTasks.push({
      duration,
      source,
      startTime: this.now() - duration
    })
  }

  connectLongTaskObserver() {
    if (!this.Observer || !this.performance) return
    try {
      const observer = new this.Observer((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType !== 'longtask' || entry.duration < this.thresholds.longTask.minEntryDuration) continue
          this.longTasks.push({
            duration: entry.duration,
            source: 'longtask',
            startTime: entry.startTime
          })
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
      this.longTaskObserver = observer
      this.capabilities.longTask = true
      this.capabilities.nativeLongTask = true
    } catch {
      this.capabilities.longTask = false
    }
  }

  connectVisibility() {
    if (!this.document || typeof this.document.addEventListener !== 'function') return
    this.visibilityHandler = () => {
      if (this.document.visibilityState === 'hidden') this.resetSignals()
      else {
        this.lastFrameAt = 0
        this.lastSampleAt = this.now()
      }
    }
    this.document.addEventListener('visibilitychange', this.visibilityHandler)
  }

  resetSignals() {
    this.frames = []
    this.longTasks = []
    this.downgradeStreaks = [0, 0, 0, 0]
    this.recoveryStreak = 0
    this.previousCandidate = this.level
  }

  sample(now = this.now()) {
    this.lastSampleAt = now
    prune(this.frames, now - this.thresholds.fps.windowMs, (frame) => frame.at)
    prune(this.longTasks, now - this.thresholds.longTask.windowMs, (entry) => entry.startTime)

    const fps = this.readFps(now)
    const memory = this.readMemory()
    const longTask = this.readLongTask()
    const warmup = now - this.startedAt < this.reaction.warmupMs

    const candidate = Math.max(
      fps.rawLevel || 0,
      memory.rawLevel || 0,
      longTask.rawLevel || 0
    )
    const reasons = [
      ...(fps.rawLevel ? [`fps:${fps.value.toFixed(1)}`] : []),
      ...(memory.rawLevel ? [`memory:${(memory.ratio * 100).toFixed(1)}%`] : []),
      ...(longTask.rawLevel ? [`longtask:${longTask.count}x${Math.round(longTask.maxDuration)}ms`] : [])
    ]

    const metrics = {
      at: now,
      fps,
      memory,
      longTask,
      candidate,
      reasons,
      warmup
    }
    this.lastMetrics = metrics
    if (!warmup) this.reconcile(candidate, reasons, metrics, now)
    this.scheduleIdle(() => this.safeCallback(this.callbacks.onMetrics, metrics), 'idleMetricHandle')
  }

  readFps(now) {
    const windowStart = now - this.thresholds.fps.windowMs
    const recent = this.frames.filter((frame) => frame.at >= windowStart)
    const elapsed = recent.length > 1 ? (recent[recent.length - 1].at - recent[0].at) / 1000 : 0
    const value = elapsed > 0 && recent.length >= this.thresholds.fps.minFrames
      ? (recent.length - 1) / elapsed
      : null
    const slowFrames = value === null
      ? 0
      : recent.slice(1).filter((frame) => frame.duration > this.thresholds.fps.frameIntervalMs).length
    const slowRatio = recent.length > 1 ? slowFrames / (recent.length - 1) : 0
    const slowLevel = value === null
      ? null
      : thresholdLevel(slowRatio, this.thresholds.fps.slowFrameRatio, (ratio, threshold) => ratio >= threshold)
    return {
      value,
      slowRatio,
      supported: value !== null,
      rawLevel: value === null ? null : Math.max(
        thresholdLevel(value, this.thresholds.fps.degradeBelow, (v, t) => v < t),
        slowLevel
      )
    }
  }

  readMemory() {
    const memory = this.performance && this.performance.memory
    if (!memory) {
      return { supported: false, value: null, ratio: null, rawLevel: null }
    }
    const limit = Number(memory.jsHeapSizeLimit || 0)
    const used = Number(memory.usedJSHeapSize || 0)
    const ratio = limit > 0 && used >= 0 ? used / limit : null
    const absolute = used > 0 ? used : null
    const rawLevel = Math.max(
      ratio === null ? 0 : thresholdLevel(ratio, this.thresholds.memory.usedRatio, (v, t) => v >= t),
      absolute === null ? 0 : thresholdLevel(absolute, this.thresholds.memory.usedJSHeapSize, (v, t) => v >= t)
    )
    const supported = ratio !== null || absolute !== null
    this.capabilities.memory = supported
    return {
      supported,
      value: absolute,
      limit: limit || null,
      ratio,
      rawLevel: supported ? rawLevel : null
    }
  }

  readLongTask() {
    const entries = this.longTasks
    const maxDuration = entries.reduce((max, entry) => Math.max(max, entry.duration), 0)
    const counts = this.thresholds.longTask.duration.map((duration, index) => ({
      level: index + 1,
      count: entries.filter((entry) => entry.duration >= duration).length
    }))
    const trigger = counts
      .filter((item) => item.count >= this.thresholds.longTask.count[item.level - 1])
      .map((item) => item.level)
      .pop() || 0
    return {
      supported: true,
      count: entries.length,
      maxDuration,
      counts,
      rawLevel: entries.length ? trigger : null
    }
  }

  reconcile(candidate, reasons, metrics, now) {
    if (this.forceLevel !== null) {
      this.targetLevel = this.forceLevel
      if (this.level !== this.forceLevel) this.applyLevel(this.forceLevel, 'manual')
      return
    }

    if (candidate > this.level) {
      this.recoveryStreak = 0
      const target = this.level + 1
      this.downgradeStreaks[target] += 1
      if (this.downgradeStreaks[target] >= this.reaction.downgradeAfter) {
        this.applyLevel(target, `pressure:${reasons.join(',') || 'unknown'}`)
      }
    } else {
      this.downgradeStreaks = this.downgradeStreaks.map((streak, index) => index <= this.level ? 0 : streak)
      const stillNeeded = this.level > 0 && this.metricRequiresLevel(metrics, this.level)
      if (stillNeeded) this.recoveryStreak = 0
      else {
        this.recoveryStreak += 1
        const cooled = this.level === 2 || now - this.lastLevelChangeAt >= this.reaction.recoveryCooldownMs
        if (this.recoveryStreak >= this.reaction.recoverAfter && cooled) {
          this.applyLevel(this.level - 1, 'recovery')
        }
      }
    }
    this.targetLevel = candidate
  }

  metricRequiresLevel(metrics, level) {
    const fpsNeeded = metrics.fps.supported
      && metrics.fps.value < this.thresholds.fps.recoverAbove[level - 1]
    const memoryNeeded = metrics.memory.supported
      && this.memoryExceeds(metrics.memory, this.thresholds.memory.recoverRatio[level - 1])
    const longTaskNeeded = metrics.longTask.maxDuration > this.thresholds.longTask.recoverDuration[level - 1]
      || metrics.longTask.count > this.thresholds.longTask.recoverCount[level - 1]
    return fpsNeeded || memoryNeeded || longTaskNeeded
  }

  memoryExceeds(memory, ratioThreshold) {
    if (memory.ratio !== null && ratioThreshold !== null && memory.ratio >= ratioThreshold) return true
    const absoluteLevel = thresholdLevel(
      memory.value || 0,
      this.thresholds.memory.recoverJSHeapSize,
      (value, threshold) => value >= threshold
    )
    return absoluteLevel > 0
  }

  applyLevel(nextLevel, reason) {
    const level = clampLevel(nextLevel)
    const policy = this.policies[level]
    const previousLevel = this.level
    this.level = level
    this.targetLevel = level
    this.lastLevelChangeAt = this.now()
    this.downgradeStreaks = [0, 0, 0, 0]
    this.recoveryStreak = 0
    this.previousCandidate = level

    if (previousLevel !== level || reason === 'initial') {
      this.safeCallback(this.callbacks.onAnimationsChange, policy.animationsEnabled, policy, level)
      this.safeCallback(this.callbacks.onCanvasScale, policy.canvasScale, policy, level)
      this.safeCallback(this.callbacks.onImageSmoothingChange, policy.imageSmoothingEnabled, policy, level)
      this.safeCallback(this.callbacks.onPollingIntervalChange, policy.pollingIntervalMs, policy, level)
      this.pollingInterval = policy.pollingIntervalMs
      if (this.worker) {
        this.worker.postMessage({ type: 'set-interval', interval: policy.pollingIntervalMs })
      } else if (this.running) {
        this.scheduleFallbackPoll()
      }
      if (policy.cacheRelease !== 'none' && previousLevel <= level) {
        this.scheduleIdle(() => this.releaseCache(policy.cacheRelease, level), 'idleCacheHandle')
      }
      this.safeCallback(this.callbacks.onLevelChange, {
        level,
        previousLevel,
        reason,
        policy,
        capabilities: { ...this.capabilities }
      })
    }
  }

  releaseCache(strategy, level) {
    if (this.customCacheRelease) {
      this.safeCallback(this.customCacheRelease, strategy, level)
      this.safeCallback(this.callbacks.onReleaseCache, { strategy, level, keys: [] })
      return
    }
    if (!this.caches) return
    const released = []
    for (const cache of this.caches.values()) {
      const keys = cache.release(strategy)
      released.push({ name: cache.name, keys })
    }
    this.safeCallback(this.callbacks.onReleaseCache, { strategy, level, caches: released })
  }

  connectWorker() {
    if (!globalThis.Worker) return
    try {
      if (this.workerFactory) {
        this.worker = this.workerFactory()
      } else if (this.workerUrl) {
        try {
          this.worker = new globalThis.Worker(this.workerUrl, { type: 'module' })
        } catch {
          const blob = new globalThis.Blob([FALLBACK_WORKER_SOURCE], { type: 'application/javascript' })
          this.worker = new globalThis.Worker(URL.createObjectURL(blob))
        }
      }
      if (!this.worker) return
      this.worker.addEventListener('message', this.handleWorkerMessage)
      this.worker.postMessage({
        type: 'start',
        interval: this.policies[this.level].pollingIntervalMs
      })
      this.capabilities.worker = true
    } catch {
      this.capabilities.worker = false
      this.worker = null
    }
    if (!this.worker && globalThis.setTimeout) this.scheduleFallbackPoll()
  }

  scheduleFallbackPoll() {
    if (this.pollingFallback) clearTimeout(this.pollingFallback)
    this.pollingFallback = null
    this.pollingFallback = setTimeout(() => {
      this.pollingFallback = null
      if (this.running) {
        this.safeCallback(this.callbacks.onPoll, { type: 'poll', interval: this.pollingInterval, time: Date.now() })
        this.scheduleFallbackPoll()
      }
    }, this.pollingInterval)
    if (typeof this.pollingFallback.unref === 'function') this.pollingFallback.unref()
  }

  handleWorkerMessage(event) {
    const message = event.data || {}
    if (message.type !== 'poll') return
    this.safeCallback(this.callbacks.onPoll, message)
  }

  scheduleIdle(task, handleName) {
    this.cancelScheduledIdle(handleName)
    if (!this.requestIdle) {
      task()
      return
    }
    this[handleName] = this.requestIdle(() => {
      this[handleName] = null
      task()
    }, { timeout: this.reaction.idleTimeoutMs })
  }

  cancelScheduledIdle(handleName) {
    if (this[handleName] && this.cancelIdle) this.cancelIdle(this[handleName])
    this[handleName] = null
  }

  safeCallback(callback, ...args) {
    if (typeof callback !== 'function') return
    try {
      return callback(...args)
    } catch (error) {
      console.error('[PerformanceGuard] callback failed:', error)
    }
  }
}

function prune(list, cutoff, getTime) {
  while (list.length && getTime(list[0]) < cutoff) list.shift()
}

function thresholdLevel(value, thresholds, test) {
  let level = 0
  thresholds.forEach((threshold, index) => {
    if (threshold !== null && threshold !== undefined && test(value, threshold)) level = index + 1
  })
  return level
}

function clampLevel(level) {
  return Math.max(0, Math.min(3, Math.trunc(level)))
}

const FALLBACK_WORKER_SOURCE = `
let timer = null
let interval = 1000
let running = false
function schedule() {
  if (!running) return
  timer = setTimeout(() => {
    self.postMessage({ type: 'poll', interval, time: Date.now() })
    schedule()
  }, interval)
}
self.onmessage = (event) => {
  const message = event.data || {}
  if (message.type === 'start') {
    interval = message.interval || interval
    if (running) return
    running = true
    schedule()
  }
  if (message.type === 'set-interval') {
    interval = message.interval || interval
    if (running) {
      clearTimeout(timer)
      schedule()
    }
  }
  if (message.type === 'stop') {
    running = false
    clearTimeout(timer)
  }
}
`

function mergeOptions(base, override) {
  const output = {}
  for (const [key, value] of Object.entries(base)) {
    const hasValue = Object.prototype.hasOwnProperty.call(override, key) && override[key] !== undefined
    const next = override[key]
    if (Array.isArray(value) || Array.isArray(next)) output[key] = hasValue ? next : value
    else if (isPlainObject(value)) output[key] = mergeOptions(value, isPlainObject(next) ? next : {})
    else output[key] = hasValue ? next : value
  }
  for (const [key, value] of Object.entries(override)) {
    if (!(key in output)) output[key] = value
  }
  return output
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizePolicies(policies) {
  if (!Array.isArray(policies) || policies.some((policy) => !isPlainObject(policy))) {
    throw new Error('policies must be an array of policy objects')
  }
  return policies.map((policy) => {
    const normalized = {
      animationsEnabled: true,
      canvasScale: 1,
      pollingIntervalMs: 1000,
      imageSmoothingEnabled: true,
      cacheRelease: 'none',
      ...policy
    }
    if (typeof normalized.animationsEnabled !== 'boolean' || typeof normalized.imageSmoothingEnabled !== 'boolean') {
      throw new Error('animationsEnabled and imageSmoothingEnabled must be booleans')
    }
    if (!Number.isFinite(normalized.canvasScale) || normalized.canvasScale <= 0 || normalized.canvasScale > 1) {
      throw new Error('canvasScale must be greater than 0 and no greater than 1')
    }
    if (!Number.isFinite(normalized.pollingIntervalMs) || normalized.pollingIntervalMs <= 0) {
      throw new Error('pollingIntervalMs must be greater than 0')
    }
    if (!['none', 'oldest', 'all'].includes(normalized.cacheRelease)) {
      throw new Error('cacheRelease must be none, oldest, or all')
    }
    return normalized
  })
}
