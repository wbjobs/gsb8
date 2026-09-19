// 托管的内存缓存：支持按比例释放（trim）与全量释放（purge）。
// LRU 淘汰保证释放的是最久未访问的条目。
export function createManagedCache(name = 'default', { maxEntries = 500 } = {}) {
  const map = new Map();
  const stats = { hits: 0, misses: 0, evictions: 0, releases: 0 };

  function touch(key, value) {
    // Map 的迭代顺序即插入顺序；删除后重插即"最近使用"。
    map.delete(key);
    map.set(key, value);
  }

  return {
    name,
    get(key) {
      if (!map.has(key)) {
        stats.misses += 1;
        return undefined;
      }
      stats.hits += 1;
      const value = map.get(key);
      touch(key, value);
      return value;
    },
    set(key, value) {
      if (map.has(key)) touch(key, value);
      else map.set(key, value);
      if (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        map.delete(oldest);
        stats.evictions += 1;
      }
    },
    has: (key) => map.has(key),
    // 释放最久未使用的 ratio 比例条目（0~1）
    trim(ratio = 0.5) {
      const removeCount = Math.floor(map.size * ratio);
      const removed = [];
      for (let i = 0; i < removeCount; i += 1) {
        const key = map.keys().next().value;
        removed.push({ key, value: map.get(key) });
        map.delete(key);
      }
      stats.releases += removed.length;
      return removed;
    },
    purge() {
      const removed = map.size;
      map.clear();
      stats.releases += removed;
      return removed;
    },
    get size() {
      return map.size;
    },
    stats: () => ({ ...stats, size: map.size }),
  };
}

// 缓存集合：一条 trim/purge 指令作用于所有注册缓存。
export function createCacheRegistry() {
  const caches = new Set();
  const listeners = new Set();
  let mode = 'keep';

  return {
    register(cache) {
      caches.add(cache);
      return () => caches.delete(cache);
    },
    apply(nextMode) {
      if (nextMode === mode) return;
      const prevMode = mode;
      mode = nextMode;
      const released = [];
      for (const cache of caches) {
        if (nextMode === 'trim') {
          const removed = cache.trim(0.5);
          released.push({ cache: cache.name, mode: 'trim', count: removed.length });
        } else if (nextMode === 'purge') {
          const count = cache.purge();
          released.push({ cache: cache.name, mode: 'purge', count });
        }
      }
      if (released.some((r) => r.count > 0)) {
        for (const fn of listeners) fn({ mode: nextMode, prevMode, released });
      }
    },
    getMode: () => mode,
    onRelease(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
