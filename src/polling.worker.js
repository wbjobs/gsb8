let timer = null
let interval = 1000
let running = false

function schedule() {
  if (!running) return
  timer = setTimeout(() => {
    self.postMessage({ type: 'poll', interval, time: Date.now() })
    schedule()
  }, interval)
}

self.onmessage = (event) => {
  const message = event.data || {}
  if (message.type === 'start') {
    interval = message.interval || interval
    if (running) return
    running = true
    schedule()
  }
  if (message.type === 'set-interval') {
    interval = message.interval || interval
    if (running) {
      clearTimeout(timer)
      schedule()
    }
  }
  if (message.type === 'stop') {
    running = false
    clearTimeout(timer)
  }
}
