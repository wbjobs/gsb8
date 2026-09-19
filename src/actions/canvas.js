// Canvas 分辨率控制：按降级级别缩放 devicePixelRatio，降低每帧填充像素量。
// 尺寸由业务的 onResize 回调负责（backing store 与 CSS 尺寸分离）。
export function createCanvasRegistry() {
  const entries = new Set();
  let scale = 1;
  const listeners = new Set();

  function applyTo(entry, value) {
    const ratio = Math.min(window.devicePixelRatio || 1, 2) * value;
    entry.scale = value;
    entry.effectiveRatio = ratio;
    if (typeof entry.onResize === 'function') {
      entry.onResize({
        scale: value,
        effectiveRatio: ratio,
        cssWidth: entry.canvas.clientWidth,
        cssHeight: entry.canvas.clientHeight,
      });
    }
  }

  return {
    register(canvas, onResize) {
      const entry = { canvas, onResize, scale: 1, effectiveRatio: Math.min(window.devicePixelRatio || 1, 2) };
      entries.add(entry);
      applyTo(entry, scale);
      return () => entries.delete(entry);
    },
    apply(nextScale) {
      if (nextScale === scale) return;
      scale = nextScale;
      for (const entry of entries) applyTo(entry, scale);
      for (const fn of listeners) fn(scale);
    },
    getScale: () => scale,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get size() {
      return entries.size;
    },
  };
}
