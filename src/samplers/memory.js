// 内存采样器。performance.memory 仅 Chromium 提供，必须兼容差异：
// 1. Chromium: performance.memory（usedJSHeapSize / jsHeapSizeLimit）
// 2. 支持 measureUserAgentSpecificMemory 的浏览器（Cross-origin isolation 下）
// 3. performance.memoryInfo（部分版本字段名）
// 4. 都不支持：supported=false，策略层该信号不投票，不参与误判。
export function createMemorySampler() {
  let asyncSupported = false;
  try {
    asyncSupported = typeof performance.measureUserAgentSpecificMemory === 'function';
  } catch {
    asyncSupported = false;
  }

  const legacy = typeof performance.memory === 'object' && performance.memory !== null;
  const supported = legacy || asyncSupported;
  let lastBytes = null;

  function readLegacy() {
    const m = performance.memory;
    if (!m || !m.jsHeapSizeLimit) return null;
    return {
      used: m.usedJSHeapSize,
      total: m.totalJSHeapSize,
      limit: m.jsHeapSizeLimit,
    };
  }

  return {
    supported,
    source: legacy ? 'performance.memory' : asyncSupported ? 'measureUserAgentSpecificMemory' : 'unsupported',
    // 异步来源时建议在 tick 前 prefetch；同步来源可直接 sample。
    prefetch() {
      if (!asyncSupported) return Promise.resolve();
      return performance
        .measureUserAgentSpecificMemory()
        .then((report) => {
          const used = report.bytes;
          lastBytes = { used, total: used, limit: null };
        })
        .catch(() => {
          // 权限/隔离不满足时静默回退，视为本拍未知。
          lastBytes = null;
        });
    },
    sample() {
      if (legacy) {
        const r = readLegacy();
        if (!r) return { supported: false };
        return {
          supported: true,
          source: 'performance.memory',
          usedJSHeapSize: r.used,
          totalJSHeapSize: r.total,
          jsHeapSizeLimit: r.limit,
          // Chromium 的 limit 会随堆增长而变大，因此 ratio 同时给出
          // used/total（当前占用率）和 used/limit（硬顶使用率），
          // 默认用 used/total，更能反映真实压力。
          ratio: r.total ? r.used / r.total : 0,
          hardLimitRatio: r.limit ? r.used / r.limit : null,
        };
      }
      if (asyncSupported && lastBytes) {
        const used = lastBytes.used;
        return {
          supported: true,
          source: 'measureUserAgentSpecificMemory',
          usedJSHeapSize: used,
          totalJSHeapSize: used,
          jsHeapSizeLimit: null,
          ratio: null,
          hardLimitRatio: null,
          // 无 limit 时无法可靠地算比例；不投票，避免假信号。
        };
      }
      return { supported: false, source: 'unsupported' };
    },
    stop() {},
  };
}
