// FPS 采样器：rAF 统计一个采样窗口内的平均帧率与掉帧情况。
// 页面切到后台时 rAF 会暂停，此时帧数为 0、结果不可信 —— 标记 reliable=false，
// 决策层会丢弃该信号，避免"切标签页回来被误判降级"。
export function createFpsSampler() {
  let frames = 0;
  let longFrames = 0;
  let rafId = 0;
  let lastTs = 0;
  let running = false;

  function tick(ts) {
    if (!running) return;
    if (lastTs) {
      const delta = ts - lastTs;
      if (delta > 0) {
        frames += 1;
        // 单帧超过 ~33ms（约等于 30fps 以下）记为重帧
        if (delta > 33) longFrames += 1;
      }
    }
    lastTs = ts;
    rafId = requestAnimationFrame(tick);
  }

  return {
    start() {
      if (running) return;
      running = true;
      rafId = requestAnimationFrame(tick);
    },
    sample(intervalMs, minFramesReliable) {
      const expected = intervalMs / (1000 / 60);
      const result = {
        value: frames > 0 ? Math.round((frames * 1000) / intervalMs) : 0,
        frames,
        longFrames,
        droppedRatio: expected > 0 ? Math.max(0, 1 - frames / expected) : 0,
        reliable: frames >= minFramesReliable && document.visibilityState === 'visible',
      };
      frames = 0;
      longFrames = 0;
      return result;
    },
    stop() {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      lastTs = 0;
    },
  };
}
