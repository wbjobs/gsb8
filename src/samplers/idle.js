// 空闲采样器：通过 requestIdleCallback 感知主线程饥饿。
// 连续 starveMs 拿不到空闲回调，说明主线程被长任务占满。
export function createIdleSampler(starveMs) {
  const ric = typeof requestIdleCallback === 'function'
    ? requestIdleCallback.bind(window)
    : null;
  const cic = typeof cancelIdleCallback === 'function'
    ? cancelIdleCallback.bind(window)
    : null;

  let running = false;
  let lastIdleAt = performance.now();
  let lastRemaining = Infinity;
  let scheduled = false;
  let fallbackTimer = 0;
  let handle = 0;

  function schedule() {
    if (!running || scheduled) return;
    scheduled = true;
    if (ric) {
      // 超时兜底：即便一直没有真正空闲，starveMs 后也会以 didTimeout=true 触发。
      handle = ric(onIdle, { timeout: starveMs });
    } else {
      fallbackTimer = setTimeout(() => onIdle({ didTimeout: true, timeRemaining: () => 0 }), 200);
    }
  }

  function onIdle(deadline) {
    scheduled = false;
    lastIdleAt = performance.now();
    lastRemaining = typeof deadline.timeRemaining === 'function' ? deadline.timeRemaining() : 0;
    if (running) schedule();
  }

  return {
    supported: true, // 带 setTimeout 兜底，恒可用；信号本身可在配置中关闭
    start() {
      if (running) return;
      running = true;
      lastIdleAt = performance.now();
      schedule();
    },
    sample() {
      const now = performance.now();
      const timeSinceIdle = now - lastIdleAt;
      // 兜底实现（无 rIC）不具备真实空闲语义，标记 degraded 供策略忽略。
      return {
        supported: Boolean(ric),
        degraded: !ric,
        timeSinceIdle: Math.round(timeSinceIdle),
        remaining: Math.round(lastRemaining),
        starving: timeSinceIdle >= starveMs,
      };
    },
    setStarveMs(ms) {
      starveMs = ms;
    },
    stop() {
      running = false;
      if (cic && handle) cic(handle);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      handle = 0;
      fallbackTimer = 0;
    },
  };
}
