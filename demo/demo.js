import { PerformanceGovernor } from '../src/index.js';
import { createManagedCache } from '../src/index.js';

// 演示使用更快的迟滞参数，使升降级在数秒内可观察；
// 生产环境请使用默认配置（更保守、更抗抖）。
const DEMO_CONFIG = {
  sampleInterval: 1000,
  warmupTicks: 1,
  hysteresis: {
    signalHoldTicks: 2,
    downgradeConfirmTicks: 2,
    recoverTicks: 4,
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
    idle: { enabled: 'auto', mode: 'corroborate', bands: [{ level: 2, lte: 0 }], holdTicks: 2, starveMs: 200 },
  },
};

const $ = (id) => document.getElementById(id);

const governor = new PerformanceGovernor(DEMO_CONFIG);
const cache = createManagedCache('demo-cache', { maxEntries: 1000 });
governor.caches.register(cache);

// 预填 400 条缓存，便于观察 trim/purge。
for (let i = 0; i < 400; i += 1) cache.set(`key-${i}`, { i, pad: 'x'.repeat(64) });

// ---------- Canvas 粒子场景（注册后由 governor 自动调整 backing store 分辨率） ----------
const canvas = $('particleCanvas');
const ctx = canvas.getContext('2d');
const PARTICLES = Array.from({ length: 280 }, () => ({
  x: Math.random() * 640,
  y: Math.random() * 300,
  vx: (Math.random() - 0.5) * 1.6,
  vy: (Math.random() - 0.5) * 1.6,
  r: 1 + Math.random() * 2.4,
}));

const unregisterCanvas = governor.canvas.register(canvas, ({ effectiveRatio, cssWidth, cssHeight }) => {
  canvas.width = Math.max(1, Math.round(cssWidth * effectiveRatio));
  canvas.height = Math.max(1, Math.round(cssHeight * effectiveRatio));
  ctx.setTransform(effectiveRatio, 0, 0, effectiveRatio, 0, 0);
  draw(true);
});

function draw(force = false) {
  const mode = governor.animation.getState();
  if (mode === 'off' && !force) return; // 动画关闭时冻结画面，主线程零渲染开销
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  // reduced 模式只画一半粒子，off 模式不进入循环（见 frameLoop）。
  const count = mode === 'reduced' ? PARTICLES.length / 2 : PARTICLES.length;
  for (let i = 0; i < count; i += 1) {
    const p = PARTICLES[i];
    p.x += p.vx;
    p.y += p.vy;
    if (p.x < 0 || p.x > w) p.vx *= -1;
    if (p.y < 0 || p.y > h) p.vy *= -1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = '#4f8cff';
    ctx.fill();
  }
}

function frameLoop() {
  draw();
  requestAnimationFrame(frameLoop);
}
frameLoop();

// ---------- 一个模拟的轮询任务（降级时间隔自动拉长） ----------
let pollCount = 0;
const pollHandle = governor.polling.register(
  async () => {
    pollCount += 1;
  },
  500,
);

// ---------- 负载模拟 ----------
let loadTimers = [];
function blockMainThread(ms) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // 忙等：制造真实 longtask 条目
    Math.sqrt(Math.random() * 1e9);
  }
}

function runLongTaskBurst(blockMs, times, gapMs) {
  stopLoads(false);
  for (let i = 0; i < times; i += 1) {
    const t = setTimeout(() => blockMainThread(blockMs), i * gapMs);
    loadTimers.push(t);
  }
  log(`<b>开始模拟长任务</b>：${blockMs}ms × ${times}`);
}

$('btnLongTask').addEventListener('click', () => runLongTaskBurst(400, 8, 650));
$('btnHugeLongTask').addEventListener('click', () => {
  stopLoads(false);
  const t = setTimeout(() => blockMainThread(4000), 0);
  loadTimers.push(t);
  log('<b>持续阻塞 4 秒</b>');
});

// 内存压力：仅 Chromium 有 performance.memory，不支持时给出明确提示。
let retainedChunks = [];
$('btnAllocate').addEventListener('click', () => {
  if (!governor.capabilities.memory) {
    log('当前浏览器不支持 performance.memory，无法模拟内存信号（该信号自动不投票）');
    return;
  }
  const alloc = setTimeout(function grow() {
    retainedChunks.push('x'.repeat(2 * 1024 * 1024)); // 2MB 字符串块
    const m = performance.memory;
    const ratio = m.usedJSHeapSize / m.totalJSHeapSize;
    if (ratio < 0.9 && retainedChunks.length < 200) {
      loadTimers.push(setTimeout(grow, 80));
    } else {
      log(`<b>内存压力就绪</b>：占用率 ${(ratio * 100).toFixed(0)}%，持有 ${retainedChunks.length * 2}MB`);
    }
  }, 0);
  loadTimers.push(alloc);
});

$('btnGcHints').addEventListener('click', () => {
  retainedChunks = [];
  log('已释放引用，等待浏览器 GC 后内存信号恢复');
});

function stopLoads(writeLog = true) {
  loadTimers.forEach(clearTimeout);
  loadTimers = [];
  retainedChunks = [];
  if (writeLog) log('已停止全部模拟负载');
}
$('btnRecover').addEventListener('click', () => stopLoads());

// ---------- 面板绑定 ----------
function log(html, cls = '') {
  const li = document.createElement('li');
  li.className = cls;
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  li.innerHTML = `[${time}] ${html}`;
  const box = $('eventLog');
  box.prepend(li);
  while (box.children.length > 60) box.lastChild.remove();
}

function renderSignal(elId, value) {
  const el = $(elId);
  const span = el.querySelector('.sig-state');
  if (value == null) {
    span.className = 'sig-state lv-n';
    span.textContent = '未知/不投票';
  } else {
    span.className = `sig-state lv${value}`;
    span.textContent = value === 0 ? `L${value} 健康` : `L${value}`;
  }
}

governor.on('metrics', (m) => {
  $('mFps').textContent = m.fps.reliable ? `${m.fps.value}` : '不可信';
  $('mFpsExtra').textContent = `${m.fps.frames} 帧 / 掉帧率 ${(m.fps.droppedRatio * 100).toFixed(0)}%`;

  if (m.memory.supported && m.memory.ratio != null) {
    const pct = (m.memory.ratio * 100).toFixed(1);
    $('mMem').textContent = `${pct}%`;
    $('mMemExtra').textContent =
      `${(m.memory.usedJSHeapSize / 1048576).toFixed(1)} / ${(m.memory.totalJSHeapSize / 1048576).toFixed(1)} MB · ${m.memory.source}`;
  } else {
    $('mMem').textContent = 'N/A';
    $('mMemExtra').textContent = m.memory.supported ? '异步来源无 limit' : '浏览器不支持';
  }

  $('mLT').textContent = `${m.longTask.duration}ms`;
  $('mLTExtra').textContent = `${m.longTask.count} 个长任务 · 最大 ${m.longTask.maxDuration}ms`;

  $('mIdle').textContent = `${m.idle.timeSinceIdle}ms`;
  $('mIdleExtra').textContent = m.idle.supported
    ? (m.idle.starving ? '主线程饥饿（旁证）' : `剩余空闲 ${m.idle.remaining}ms`)
    : 'rIC 不支持';

  $('cacheSize').textContent = cache.size;
  $('aPoll').textContent = `${pollHandle.interval}ms ×${governor.polling.getFactor()}（第 ${pollCount} 次）`;
});

governor.on('decision', (d) => {
  if (d.observedSignals) {
    renderSignal('sigMemory', d.observedSignals.memory);
    renderSignal('sigFps', d.observedSignals.fps);
    renderSignal('sigLT', d.observedSignals.longTask);
    renderSignal('sigIdle', d.idleCorroborated ? 2 : null);
  }
  $('reasonText').textContent =
    `tick #${d.tickIndex} · 决策：${d.reason}${d.targetPeak != null ? ` · 峰值需求 L${d.targetPeak}` : ''}`;
});

governor.on('levelchange', ({ level, reason, action }) => {
  document.querySelectorAll('.pill').forEach((p) => {
    p.classList.toggle(`active-l${level}`, Number(p.dataset.level) === level);
  });
  const up = level > 0 && reason === 'downgrade';
  log(
    `<b>${up ? '降级' : '回升'}到 L${level}</b> · 动画 ${action.animation} / Canvas ${action.canvasScale}× / 轮询 ×${action.pollingFactor} / 缓存 ${action.cache}`,
    up ? 'down' : 'up',
  );
  $('aAnim').textContent = action.animation;
  $('aCanvas').textContent = `${action.canvasScale.toFixed(2)}×`;
  $('aDpr').textContent =
    `${(Math.min(window.devicePixelRatio || 1, 2) * action.canvasScale).toFixed(2)}`;
  $('aCache').textContent = action.cache;
});

governor.on('cacherelease', ({ mode, released }) => {
  const desc = released.map((r) => `${r.cache}:${r.count}`).join(', ');
  log(`缓存释放（${mode}）：${desc}`);
});

governor.on('backend', (b) => {
  $('backendBadge').textContent =
    b.type === 'worker' ? '决策后端：Web Worker（子线程）' : `决策后端：主线程回退（${b.reason}）`;
});
renderCaps();


// 能力清单（Worker 就绪后会刷新）
function renderCaps() {
  const caps = governor.capabilities;
  const capRows = [
    ['Web Worker', caps.worker],
    ['performance.memory（Chromium）', caps.memory && caps.memorySource === 'performance.memory'],
    ['measureUserAgentSpecificMemory', caps.memorySource === 'measureUserAgentSpecificMemory'],
    ['PerformanceObserver(longtask)', caps.longTask],
    ['requestIdleCallback', caps.requestIdleCallback],
  ];
  $('capsList').innerHTML = capRows
    .map(([name, ok]) => `<li><span class="${ok ? 'yes' : 'no'}">${ok ? '支持' : '不支持/降级'}</span> · ${name}</li>`)
    .join('');
}
renderCaps();

// ---------- 配置热更新 ----------
$('btnApplyConfig').addEventListener('click', () => {
  const fps1 = Number($('cfgFps1').value);
  const fps2 = Number($('cfgFps2').value);
  const mem1 = Number($('cfgMem1').value);
  const mem2 = Number($('cfgMem2').value);
  const lt1 = Number($('cfgLt1').value);
  const lt2 = Number($('cfgLt2').value);
  governor.updateConfig({
    ...DEMO_CONFIG,
    hysteresis: { ...DEMO_CONFIG.hysteresis, recoverTicks: Number($('cfgRecover').value) },
    thresholds: {
      ...DEMO_CONFIG.thresholds,
      fps: { enabled: true, bands: [{ level: 2, lte: fps2 }, { level: 1, lte: fps1 }], holdTicks: 2, minFramesReliable: 20 },
      memory: {
        enabled: 'auto',
        bands: [{ level: 2, gte: mem2 }, { level: 1, gte: mem1 }],
        holdTicks: 2,
      },
      longTask: {
        enabled: true,
        durationBands: [{ level: 2, gte: lt2 }, { level: 1, gte: lt1 }],
        countBands: [{ level: 1, gte: 3 }],
        holdTicks: 1,
      },
    },
  });
  log('<b>配置已热更新</b>，决策状态机已重置');
});

$('btnResetConfig').addEventListener('click', () => {
  governor.updateConfig(DEMO_CONFIG);
  ['cfgFps1', 'cfgFps2', 'cfgMem1', 'cfgMem2', 'cfgLt1', 'cfgLt2', 'cfgRecover'].forEach((id) => {
    const defaults = { cfgFps1: 50, cfgFps2: 30, cfgMem1: 0.65, cfgMem2: 0.8, cfgLt1: 250, cfgLt2: 600, cfgRecover: 4 };
    $(id).value = defaults[id];
  });
  log('已恢复演示配置');
});

governor.start();
log('监控已启动（采样 1s/拍，启动保护 1 拍）');

// 页面切后台时指标自动标记不可信，切回来不会被误判（见 fps.js / policy.js）。
window.addEventListener('beforeunload', () => {
  unregisterCanvas();
  pollHandle.unregister();
  governor.stop();
});
