import { CanvasResolutionManager, ManagedCache, PerformanceGuard } from '../src/index.js'

const canvas = document.querySelector('#scene')
const refs = {
  level: document.querySelector('#level'),
  fps: document.querySelector('#fps'),
  memory: document.querySelector('#memory'),
  polling: document.querySelector('#polling'),
  animations: document.querySelector('#animations'),
  scale: document.querySelector('#scale'),
  cache: document.querySelector('#cache'),
  longtask: document.querySelector('#longtask'),
  memorySupport: document.querySelector('#memorySupport'),
  observerSupport: document.querySelector('#observerSupport'),
  workerSupport: document.querySelector('#workerSupport'),
  idleSupport: document.querySelector('#idleSupport')
}

const cache = new ManagedCache({ name: 'demo-cache', maxEntries: 120 })
for (let index = 0; index < 100; index += 1) cache.set(`item-${index}`, new Array(128).fill(index))

const canvasManager = new CanvasResolutionManager()
let animationsEnabled = true
let loadMode = 'idle'
let phase = 0

canvasManager.register(canvas, {
  width: 760,
  height: 300,
  onResize: draw
})

const guard = new PerformanceGuard({
  caches: [cache],
  thresholds: {
    fps: {
      degradeBelow: [50, 35, 20],
      recoverAbove: [58, 45, 30],
      windowMs: 3000
    },
    longTask: {
      duration: [50, 100, 200],
      count: [3, 2, 1],
      recoverDuration: [35, 80, 160],
      recoverCount: [1, 1, 0],
      windowMs: 8000
    }
  },
  onAnimationsChange(enabled) {
    animationsEnabled = enabled
    refs.animations.textContent = enabled ? '开启' : '关闭'
    document.body.classList.toggle('no-animations', !enabled)
  },
  onCanvasScale(scale) {
    canvasManager.setScale(scale)
    refs.scale.textContent = `${Math.round(scale * 100)}%`
  },
  onImageSmoothingChange(enabled) {
    canvasManager.setImageSmoothing(enabled)
  },
  onPoll(message) {
    refs.polling.textContent = `${message.interval}ms · 已轮询`
  },
  onReleaseCache(result) {
    refs.cache.textContent = `${cache.size} 项（${result.strategy}）`
  },
  onLevelChange({ level, reason, capabilities }) {
    refs.level.textContent = `L${level} ${['正常', '轻度', '中度', '重度'][level]} · ${reason}`
    refs.level.className = `badge level-${level}`
    refs.memorySupport.textContent = capabilities.memory ? '支持' : '不支持，已跳过'
    refs.observerSupport.textContent = capabilities.longTask ? 'longtask 原生事件' : '帧间隔合成检测'
    refs.workerSupport.textContent = capabilities.worker ? '支持' : '不支持'
    refs.idleSupport.textContent = capabilities.idleCallback ? '支持' : 'setTimeout 兜底'
  },
  onMetrics(metrics) {
    refs.fps.textContent = metrics.fps.value === null ? '采样中' : `${metrics.fps.value.toFixed(1)}`
    refs.memory.textContent = metrics.memory.supported && metrics.memory.ratio !== null
      ? `${(metrics.memory.ratio * 100).toFixed(1)}%`
      : '不支持'
    refs.longtask.textContent = `${metrics.longTask.count} 次 / 最长 ${Math.round(metrics.longTask.maxDuration)}ms`
  }
})

function draw() {
  const context = canvas.getContext('2d')
  const width = canvas.width
  const height = canvas.height
  context.clearRect(0, 0, width, height)
  for (let index = 0; index < 32; index += 1) {
    const x = width * (0.5 + 0.42 * Math.cos(phase + index * 0.45))
    const y = height * (0.5 + 0.35 * Math.sin(phase * 1.4 + index * 0.6))
    const radius = Math.max(2, width / 85) * (1 + Math.sin(phase + index) * 0.3)
    context.fillStyle = `hsl(${(index * 29 + phase * 30) % 360}, 80%, 65%)`
    context.beginPath()
    context.arc(x, y, radius, 0, Math.PI * 2)
    context.fill()
  }
}

function render() {
  if (loadMode === 'low-fps') {
    const end = performance.now() + 90
    while (performance.now() < end) {}
  }
  if (animationsEnabled) {
    phase += 0.025
    draw()
  }
  requestAnimationFrame(render)
}

function blockMainThread(ms) {
  const end = performance.now() + ms
  while (performance.now() < end) {}
}

document.querySelector('#longTask').addEventListener('click', () => {
  loadMode = 'long-task'
  for (let index = 0; index < 4; index += 1) {
    setTimeout(() => blockMainThread(230), index * 450)
  }
})

document.querySelector('#lowFps').addEventListener('click', () => {
  loadMode = 'low-fps'
})

document.querySelector('#stopLoad').addEventListener('click', () => {
  loadMode = 'idle'
})

refs.cache.textContent = `${cache.size} 项（保留）`
guard.start()
requestAnimationFrame(render)
