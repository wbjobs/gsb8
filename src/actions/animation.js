// 动画控制：通过根节点 data 属性 + 样式规则批量关闭 CSS 动画/过渡，
// 业务侧 rAF 动画应查询 isAnimationEnabled() 自行暂停。
export function createAnimationController(root = document.documentElement) {
  const listeners = new Set();
  let state = 'on';

  function emit(next) {
    if (next === state) return;
    const prev = state;
    state = next;
    root.setAttribute('data-perf-level', next);
    root.setAttribute('data-animation', next);
    for (const fn of listeners) fn(next, prev);
  }

  return {
    init() {
      root.setAttribute('data-perf-level', state);
      root.setAttribute('data-animation', state);
    },
    apply(mode) {
      // on | reduced | off
      emit(mode);
    },
    getState: () => state,
    isEnabled: () => state === 'on',
    isReduced: () => state !== 'on',
    isOff: () => state === 'off',
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
