export class ManagedCache {
  static instances = 0

  constructor(options = {}) {
    this.name = options.name || `cache-${ManagedCache.instances}`
    ManagedCache.instances += 1
    this.maxEntries = Number.isInteger(options.maxEntries) ? options.maxEntries : 200
    this.maxAgeMs = options.maxAgeMs ?? 5 * 60 * 1000
    this.entries = new Map()
    this.lastAccess = new Map()
  }

  get size() {
    return this.entries.size
  }

  set(key, value, size = 1) {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      this.evictOldest(1)
    }
    this.entries.set(key, { value, size })
    this.lastAccess.set(key, Date.now())
  }

  get(key) {
    if (!this.entries.has(key)) return undefined
    this.lastAccess.set(key, Date.now())
    return this.entries.get(key).value
  }

  has(key) {
    return this.entries.has(key)
  }

  delete(key) {
    const existed = this.entries.delete(key)
    this.lastAccess.delete(key)
    return existed
  }

  evictOldest(count = 1) {
    const keys = [...this.lastAccess.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, count)
      .map(([key]) => key)
    for (const key of keys) this.delete(key)
    return keys
  }

  release(strategy = 'all') {
    if (strategy === false || strategy === 'none') return []
    if (strategy === 'oldest') return this.evictOldest(Math.max(1, Math.ceil(this.entries.size / 2)))
    const keys = [...this.entries.keys()]
    this.entries.clear()
    this.lastAccess.clear()
    return keys
  }

  clear() {
    const count = this.entries.size
    this.entries.clear()
    this.lastAccess.clear()
    return count
  }
}
