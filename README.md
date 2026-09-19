# PerformanceGuard

零依赖的浏览器自适应性能监控器：监控 FPS、长任务和 `performance.memory`，压力持续出现时逐级降级，指标恢复并稳定后逐级回升。

## 能力

- 使用 `PerformanceObserver` 监听原生 `longtask`；不支持时使用帧间隔合成检测兜底。
- 使用 `requestAnimationFrame` 统计 FPS 和慢帧占比，避免单个历史长任务长期拉低均值。
- 使用 `requestIdleCallback` 延迟上报指标和释放缓存；不支持时同步兜底。
- 优先使用 Web Worker 提供业务轮询节拍；Worker 不可用时自动退回主线程定时器，降级时都会拉长轮询间隔。
- 自动关闭动画、降低 Canvas 渲染分辨率、关闭图像平滑、释放 `ManagedCache`。
- 支持 Chrome/Edge 的非标准 `performance.memory`；Firefox/Safari 不支持时自动跳过，不会误降级。
- 使用连续确认、降级/恢复双阈值、恢复冷却和逐级回升防止抖动。

## 快速开始

```js
import {
  PerformanceGuard,
  CanvasResolutionManager,
  ManagedCache
} from './src/index.js'

const canvasManager = new CanvasResolutionManager()
canvasManager.register(document.querySelector('#scene'), {
  width: 760,
  height: 300,
  onResize: (canvas) => render(canvas)
})

const cache = new ManagedCache({ name: 'api', maxEntries: 200 })

const guard = new PerformanceGuard({
  caches: [cache],
  onAnimationsChange(enabled) {
    document.body.classList.toggle('no-animations', !enabled)
  },
  onCanvasScale(scale) {
    canvasManager.setScale(scale)
  },
  onImageSmoothingChange(enabled) {
    canvasManager.setImageSmoothing(enabled)
  },
  onPoll(message) {
    fetchLatestData()
  },
  onLevelChange({ level, reason, policy }) {
    console.info(`performance level ${level}`, reason, policy)
  },
  onMetrics(metrics) {
    updateDashboard(metrics)
  }
})

await guard.start()
```

## 级别和默认策略

策略数组固定为 `[L0, L1, L2, L3]`：

| 级别 | 动画 | Canvas | 轮询 | 缓存 |
| --- | --- | --- | --- | --- |
| L0 正常 | 开启 | 100% | 1s | 保留 |
| L1 轻度 | 开启 | 85% | 3s | 保留 |
| L2 中度 | 关闭 | 60% | 8s | 释放最旧一半 |
| L3 重度 | 关闭 | 35% | 20s | 全部释放 |

自定义时四项都必须提供：

```js
new PerformanceGuard({
  policies: [
    { animationsEnabled: true, canvasScale: 1, pollingIntervalMs: 1000, cacheRelease: 'none' },
    { animationsEnabled: true, canvasScale: 0.8, pollingIntervalMs: 4000, cacheRelease: 'none' },
    { animationsEnabled: false, canvasScale: 0.5, pollingIntervalMs: 10000, cacheRelease: 'oldest' },
    { animationsEnabled: false, canvasScale: 0.25, pollingIntervalMs: 30000, cacheRelease: 'all' }
  ]
})
```

`cacheRelease` 支持 `'none'`、`'oldest'`、`'all'`。也可以提供 `releaseCache(strategy, level)` 接管业务自有缓存。

## 阈值配置

```js
new PerformanceGuard({
  thresholds: {
    fps: {
      degradeBelow: [50, 35, 20],
      recoverAbove: [58, 45, 30],
      slowFrameRatio: [0.15, 0.4, 0.7],
      windowMs: 5000,
      minFrames: 10,
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
  },
  reaction: {
    sampleIntervalMs: 1000,
    downgradeAfter: 2,
    recoverAfter: 4,
    recoveryCooldownMs: 8000,
    warmupMs: 5000,
    idleTimeoutMs: 1500
  }
})
```

降级阈值和恢复阈值必须形成滞回区间，例如 FPS 低于 50 才进入 L1，但高于 58 才考虑恢复。`downgradeAfter` 和 `recoverAfter` 分别要求连续采样确认；`recoveryCooldownMs` 阻止刚降级后立即回弹。

## 手动控制

```js
guard.setLevel(2)       // 手动锁定 L2
guard.releaseManualControl() // 恢复自动决策
guard.getState()        // 当前级别、策略、能力和最新指标
guard.stop()
guard.destroy()
```

## 演示与测试

```bash
npm test
npm start
```

然后打开 `http://localhost:5173`。页面可以模拟连续长任务和持续低 FPS；负载停止并经过恢复确认后，动画、Canvas 分辨率和轮询间隔会逐级恢复。
