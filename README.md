# Performance Governor — 自适应性能监控与自动降级

监控页面的 **FPS / 长任务（longtask）/ JS 堆内存 / 主线程空闲**，超过阈值时自动
执行降级策略（关闭动画、降低 Canvas 分辨率、拉长轮询间隔、释放缓存），压力消失后
逐级自动回升。决策状态机运行在 **Web Worker** 中，采样基于
**PerformanceObserver + requestAnimationFrame + requestIdleCallback + performance.memory**。

## 快速开始

ES Module + Module Worker 需要通过 http 访问（不能 `file://`）：

```bash
npm start          # http://localhost:8080/
npm test           # Node 内置测试运行器
```

## 使用

```js
import { PerformanceGovernor, createManagedCache } from './src/index.js';

const governor = new PerformanceGovernor({
  // 所有阈值与动作均可覆盖（见 src/default-config.js）
  sampleInterval: 1000,
  hysteresis: { signalHoldTicks: 2, downgradeConfirmTicks: 3, recoverTicks: 5 },
  thresholds: {
    fps:    { bands: [{ level: 2, lte: 30 }, { level: 1, lte: 50 }] },
    memory: { bands: [{ level: 2, gte: 0.8 }, { level: 1, gte: 0.65 }] },
    longTask: {
      durationBands: [{ level: 2, gte: 600 }, { level: 1, gte: 250 }],
      countBands:    [{ level: 1, gte: 3 }],
    },
  },
});

// 1) Canvas：降级时自动收到新的有效 DPR，在回调里重建 backing store
governor.canvas.register(canvas, ({ effectiveRatio, cssWidth, cssHeight }) => {
  canvas.width  = cssWidth  * effectiveRatio;
  canvas.height = cssHeight * effectiveRatio;
  ctx.setTransform(effectiveRatio, 0, 0, effectiveRatio, 0, 0);
});

// 2) 轮询：统一注册，降级时自动按 pollingFactor 拉长间隔
const poller = governor.polling.register(fetchData, 2000);

// 3) 缓存：LRU 托管缓存，L2 自动 trim 一半，L3 自动 purge
const cache = createManagedCache('biz', { maxEntries: 500 });
governor.caches.register(cache);

// 4) 动画：CSS 动画由 [data-animation] 样式自动关闭；rAF 动画查询状态自行冻结
if (!governor.animation.isOff()) renderFrame();

governor.on('levelchange', ({ level, action }) => console.log('级别 ->', level, action));
governor.on('metrics',  (m) => console.log(m));
governor.start();
```

CSS 动画只需依赖根节点属性（demo 的 `style.css` 内置了规则）：

```css
:root[data-animation="off"] *,
:root[data-animation="off"] *::before,
:root[data-animation="off"] *::after {
  animation: none !important;
  transition: none !important;
}
:root[data-animation="reduced"] .decorative { animation-duration: 6s !important; }
```

## 架构

```
主线程                                                        Worker 线程
┌─────────────────────────────┐               ┌──────────────────────────┐
│ FPS 采样 (rAF)              │               │                          │
│ 长任务采样 (PerformanceObs) │── metrics ──▶ │ 降级策略状态机 policy.js  │
│ 内存采样 (memory/UA measure)│   每 1 秒      │  · 信号保持（防抖）       │
│ 空闲采样 (rIC + timeout)    │               │  · 降级确认 / 冷却        │
└─────────────────────────────┘               │  · 恢复确认（逐级）       │
                                              └───────────┬──────────────┘
┌─────────────────────────────┐                           │ decision
│ 动作执行器                   │ ◀─────────────────────────┘
│  animation / canvas /       │
│  polling / cache            │
└─────────────────────────────┘
```

Worker 创建失败、环境不支持或超时时，自动回退到主线程内运行**同一套**
`createPolicy` 逻辑（事件 `backend` 可感知）。

### 降级级别（默认动作可配置）

| 级别 | 动画 | Canvas DPR | 轮询间隔 | 缓存 |
|---|---|---|---|---|
| L0 | on | 1.0× | ×1 | keep |
| L1 | reduced（弱化装饰动画） | 0.75× | ×2 | keep |
| L2 | off | 0.5× | ×4 | trim 50%（LRU 最旧） |
| L3 | off | 0.25× | ×8 | purge 全清 |

## 误判与抖动防护

1. **信号保持**：每个指标连续 N 拍保持同一级别才采纳，单次 GC / 偶发卡顿无效。
2. **降级确认 + 冷却**：压力持续 `downgradeConfirmTicks` 拍才动；变化后进入冷却期。
3. **逐级升降**：每拍最多变化一级，杜绝 L0↔L3 横跳。
4. **恢复确认**：所有信号连续健康 `recoverTicks` 拍才回升一级，期间反复立即打断。
5. **样本可信度**：后台标签页 / 帧数不足时 FPS 标记 `reliable=false` 不投票；
   切标签页回来不会误判。
6. **idle 仅作旁证**：`requestIdleCallback` 饥饿默认不单独触发降级，只在已有
   FPS/长任务压力时把目标级别推高一级。
7. **启动保护**：前 `warmupTicks` 拍只采样不决策，跳过页面初始化噪声。

## `performance.memory` 兼容性

| 环境 | 行为 |
|---|---|
| Chromium | `performance.memory`，使用 used/total 比率，同时上报 used/limit |
| 支持 `performance.measureUserAgentSpecificMemory()` | 异步预取；无 limit 时不产生比率信号 |
| Firefox / 旧 Safari（均不支持） | `memory.supported=false`，该信号**不投票**，其他信号照常工作 |
| 不支持 `longtask` 的浏览器 | 长任务信号不投票（不使用不可靠的 polyfill 冒充） |
| 不支持 `requestIdleCallback` | setTimeout 兜底，且标记 `degraded` 不参与决策 |

能力矩阵通过 `governor.capabilities` 暴露。

## 事件与 API

- `governor.on('metrics', m => …)`：每拍原始指标
- `governor.on('decision', d => …)`：每拍决策详情（各信号原始/确认级别、原因）
- `governor.on('levelchange', ({ level, action }) => …)`：仅级别真正变化时
- `governor.on('cacherelease', e => …)`：缓存被 trim/purge
- `governor.on('backend', b => …)`：Worker / 主线程回退
- `governor.updateConfig(override)`：运行期热更新阈值与策略
- `governor.getStatus()`：当前级别、能力、指标与动作快照
- `governor.setLevelManual(level)`：手动逃生舱

## 文件结构

```
src/
  default-config.js      阈值/迟滞/级别动作默认配置
  policy.js              纯决策状态机（可单测，Worker 与主线程共用）
  governor.js            总控：采样 → Worker → 动作
  governor-worker.js     Web Worker 包装
  samplers/              fps / long-task / memory / idle
  actions/               animation / canvas / polling / cache
demo/                    可交互演示页（长任务/内存负载模拟 + 实时面板）
test/                    policy 与 actions 的 node:test 测试
```
