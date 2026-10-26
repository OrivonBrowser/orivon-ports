// A one-line status over the renderer while the backend is not ready, so a first start that takes
// seconds does not look like a page that is stuck. It lives on the document element, outside the
// renderer's own root, and appears only after `delayMs` so a start that is quick shows nothing.

const ID = 'actualbudget-status'

/** The text for a progress report from backend-client.js, or null when nothing should show. */
export function statusText ({ phase, done, total }) {
  if (phase === 'install') return total > 0 ? `Setting up Actual on this device… (${String(done)} of ${String(total)} files)` : 'Setting up Actual on this device…'
  if (phase === 'starting') return 'Starting Actual…'
  return null
}

/** Returns the function to call with each progress report. `timers` is the clock, so a test can drive it. */
export function createStatusLine (doc, delayMs = 1500, timers = { set: (run, ms) => setTimeout(run, ms), clear: (id) => clearTimeout(id) }) {
  let text = null
  let timer = null
  let node = null

  const render = () => {
    if (node === null) {
      node = doc.createElement('div')
      node.id = ID
      node.setAttribute('role', 'status')
      node.style.cssText = 'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:2147483000;padding:8px 16px;border-radius:6px;background:#1f2937;color:#fff;font:14px sans-serif;pointer-events:none'
      doc.documentElement.append(node)
    }
    node.textContent = text
  }

  return (report) => {
    const next = statusText(report)
    if (next === null) {
      if (timer !== null) timers.clear(timer)
      timer = null
      text = null
      node?.remove()
      node = null
      return
    }
    text = next
    if (node !== null) render()
    else if (timer === null) timer = timers.set(() => { if (text !== null) render() }, delayMs)
  }
}
