// 轮询频率控制：所有轮询任务统一注册，降级时按 factor 拉长间隔。
// factor 变化时自动平滑重排，不会产生并发请求。
export function createPollingRegistry() {
  let factor = 1;
  let seq = 0;
  const jobs = new Map();

  function schedule(job) {
    clearTimeout(job.timer);
    const delay = job.baseInterval * factor;
    job.nextDelay = Math.round(delay);
    job.timer = setTimeout(async () => {
      if (job.stopped) return;
      job.running = true;
      try {
        await job.task();
      } catch (err) {
        if (typeof job.onError === 'function') job.onError(err);
      }
      job.running = false;
      if (!job.stopped) schedule(job);
    }, delay);
  }

  return {
    // task 为异步/同步函数；返回注销句柄。
    register(task, baseInterval, { onError } = {}) {
      const id = ++seq;
      const job = { id, task, baseInterval, onError, timer: 0, stopped: false, running: false, nextDelay: baseInterval };
      jobs.set(id, job);
      schedule(job);
      return {
        id,
        unregister() {
          job.stopped = true;
          clearTimeout(job.timer);
          jobs.delete(id);
        },
        // 立即触发一次并重新计时
        refresh() {
          if (!job.stopped && !job.running) schedule(job);
        },
        get interval() {
          return job.nextDelay;
        },
      };
    },
    apply(nextFactor) {
      if (nextFactor === factor) return;
      factor = nextFactor;
      for (const job of jobs.values()) {
        if (!job.running) schedule(job);
      }
    },
    getFactor: () => factor,
    list() {
      return [...jobs.values()].map((j) => ({ id: j.id, interval: j.nextDelay, running: j.running }));
    },
    clear() {
      for (const job of jobs.values()) {
        job.stopped = true;
        clearTimeout(job.timer);
      }
      jobs.clear();
    },
  };
}
