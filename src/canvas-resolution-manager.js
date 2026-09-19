export class CanvasResolutionManager {
  constructor({ getDevicePixelRatio } = {}) {
    this.canvases = new Map()
    this.getDevicePixelRatio = getDevicePixelRatio || (() => {
      if (typeof window === 'undefined') return 1
      return window.devicePixelRatio || 1
    })
  }

  register(canvas, options = {}) {
    if (!canvas || !canvas.style) throw new TypeError('A canvas element is required')
    const contextType = options.contextType || '2d'
    const cssWidth = options.width || canvas.clientWidth || Number(canvas.getAttribute('width')) || 300
    const cssHeight = options.height || canvas.clientHeight || Number(canvas.getAttribute('height')) || 150
    canvas.style.width = `${cssWidth}px`
    canvas.style.height = `${cssHeight}px`
    this.canvases.set(canvas, {
      width: cssWidth,
      height: cssHeight,
      contextType,
      onResize: options.onResize
    })
    return canvas
  }

  unregister(canvas) {
    return this.canvases.delete(canvas)
  }

  setScale(scale) {
    const safeScale = Math.min(1, Math.max(0.1, scale))
    const dpr = this.getDevicePixelRatio()
    for (const [canvas, item] of this.canvases) {
      const targetWidth = Math.max(1, Math.round(item.width * safeScale * dpr))
      const targetHeight = Math.max(1, Math.round(item.height * safeScale * dpr))
      if (canvas.width === targetWidth && canvas.height === targetHeight) continue
      canvas.width = targetWidth
      canvas.height = targetHeight
      if (typeof item.onResize === 'function') item.onResize(canvas, safeScale)
    }
  }

  setImageSmoothing(enabled) {
    for (const [canvas, item] of this.canvases) {
      if (item.contextType !== '2d') continue
      const context = canvas.getContext('2d')
      if (context) context.imageSmoothingEnabled = enabled
    }
  }

  destroy() {
    this.canvases.clear()
  }
}
