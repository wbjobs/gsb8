// 长任务采样器：PerformanceObserver 监听 longtask（>50ms）。
// 不支持 longtask 的环境（旧 Safari）降级为 "不投票"，绝不用不可靠来源冒充。
export function createLongTaskSampler() {
  let tasks = [];
  let observer = null;
  let supported = false;

  try {
    if (typeof PerformanceObserver !== 'undefined' && typeof PerformanceObserver.supportedEntryTypes !== 'undefined') {
      supported = PerformanceObserver.supportedEntryTypes.includes('longtask');
    }
    if (supported) {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          tasks.push({ start: entry.startTime, duration: entry.duration });
        }
      });
      observer.observe({ entryTypes: ['longtask'], buffered: true });
    }
  } catch {
    supported = false;
    observer = null;
  }

  return {
    supported,
    sample() {
      const now = performance.now();
      const current = tasks;
      tasks = [];
      return {
        count: current.length,
        duration: Math.round(current.reduce((sum, t) => sum + t.duration, 0)),
        maxDuration: current.length ? Math.round(Math.max(...current.map((t) => t.duration))) : 0,
        entries: current,
        now,
      };
    },
    stop() {
      if (observer) observer.disconnect();
      observer = null;
      tasks = [];
    },
  };
}
