// 自适应性能降级的默认配置。所有阈值/策略都可在创建 PerformanceGovernor 时覆盖。
export const DEFAULT_CONFIG = {
  // 指标采样与决策周期（毫秒）。Worker 按此节奏读取最新采样。
  sampleInterval: 1000,

  // 启动保护：跳过前 N 个 tick，避免页面初始化期间的长任务造成误判。
  warmupTicks: 2,

  // 迟滞 / 防抖（单位：tick）
  hysteresis: {
    // 各信号首次达到某级别后，需连续保持的 tick 数才生效
    signalHoldTicks: 2,
    // 全局确认降级前，需要的总观察 tick 数（双保险）
    downgradeConfirmTicks: 3,
    // 恢复必须连续健康的 tick 数
    recoverTicks: 5,
    // 每次级别变化后的冷却 tick（冷却期内禁止再次变化，双向）
    changeCooldownTicks: 2,
  },

  // 各指标阈值。bands 按数组顺序匹配，"超过/低于" 方向由 comparator 决定。
  // 未命中任何 band 时信号级别为 0（健康）。
  thresholds: {
    // usedJSHeapSize / jsHeapSizeLimit
    memory: {
      enabled: 'auto', // auto：支持才启用；true：不支持时持续告警
      bands: [
        { level: 2, gte: 0.8 },
        { level: 1, gte: 0.65 },
      ],
      holdTicks: 2,
    },
    fps: {
      enabled: true,
      // FPS 低于 lte 即命中该级别
      bands: [
        { level: 2, lte: 30 },
        { level: 1, lte: 50 },
      ],
      holdTicks: 2,
      // 一个采样窗口内渲染帧数少于该值时认为结果不可信（如页面切到后台），
      // 丢弃本次 FPS 信号，避免误判。
      minFramesReliable: 20,
    },
    longTask: {
      enabled: true,
      // 一个采样窗口内长任务的总耗时（毫秒）
      durationBands: [
        { level: 2, gte: 600 },
        { level: 1, gte: 250 },
      ],
      // 或长任务条数
      countBands: [
        { level: 1, gte: 3 },
      ],
      holdTicks: 1,
    },
    // 主线程饥饿：requestIdleCallback 长时间拿不到空闲。
    // 默认只作为旁证（corroborate），不单独触发降级，避免与长任务双重计分。
    idle: {
      enabled: 'auto',
      mode: 'corroborate', // 'corroborate' | 'signal'
      bands: [
        { level: 2, lte: 0 }, // 剩余空闲 ms
      ],
      holdTicks: 2,
      starveMs: 200, // 超过该时长拿不到 idle 视为饥饿
    },
  },

  // 降级级别与动作。级别 0 为正常状态。
  levels: [
    {
      level: 0,
      animation: 'on',
      canvasScale: 1,
      pollingFactor: 1,
      cache: 'keep',
    },
    {
      level: 1,
      animation: 'reduced', // 关闭装饰性动画，保留必要反馈
      canvasScale: 0.75,
      pollingFactor: 2, // 轮询间隔 ×2
      cache: 'keep',
    },
    {
      level: 2,
      animation: 'off',
      canvasScale: 0.5,
      pollingFactor: 4,
      cache: 'trim', // 释放一半缓存
    },
    {
      level: 3,
      animation: 'off',
      canvasScale: 0.25,
      pollingFactor: 8,
      cache: 'purge', // 清空缓存
    },
  ],
};

export const MAX_LEVEL = DEFAULT_CONFIG.levels.length - 1;
