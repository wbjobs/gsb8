export const DEFAULT_THRESHOLDS = Object.freeze({
  fps: {
    degradeBelow: [50, 35, 20],
    recoverAbove: [58, 45, 30],
    windowMs: 5000,
    minFrames: 10,
    slowFrameRatio: [0.15, 0.4, 0.7],
    frameIntervalMs: 32
  },
  memory: {
    usedRatio: [0.75, 0.88, 0.95],
    recoverRatio: [0.62, 0.76, 0.86],
    usedJSHeapSize: [],
    recoverJSHeapSize: []
  },
  longTask: {
    duration: [50, 100, 200],
    count: [3, 2, 2],
    recoverDuration: [35, 80, 160],
    recoverCount: [1, 1, 0],
    windowMs: 10000,
    minEntryDuration: 45
  }
})

export const DEFAULT_POLICIES = Object.freeze([
  {
    name: 'normal',
    animationsEnabled: true,
    canvasScale: 1,
    pollingIntervalMs: 1000,
    imageSmoothingEnabled: true,
    cacheRelease: 'none'
  },
  {
    name: 'mild',
    animationsEnabled: true,
    canvasScale: 0.85,
    pollingIntervalMs: 3000,
    imageSmoothingEnabled: true,
    cacheRelease: 'none'
  },
  {
    name: 'moderate',
    animationsEnabled: false,
    canvasScale: 0.6,
    pollingIntervalMs: 8000,
    imageSmoothingEnabled: false,
    cacheRelease: 'oldest'
  },
  {
    name: 'severe',
    animationsEnabled: false,
    canvasScale: 0.35,
    pollingIntervalMs: 20000,
    imageSmoothingEnabled: false,
    cacheRelease: 'all'
  }
])

export const DEFAULT_REACTION = Object.freeze({
  sampleIntervalMs: 1000,
  downgradeAfter: 2,
  recoverAfter: 4,
  recoveryCooldownMs: 8000,
  warmupMs: 5000,
  idleTimeoutMs: 1500
})
