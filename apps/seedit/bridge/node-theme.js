// Gives the node dashboard the theme seedit itself is wearing. seedit keeps the choice in localStorage `theme`, which this page shares because it is served in
// the app's own origin, and falls back to 'light' when nothing is stored (src/stores/use-theme-store.ts). Its App effect (src/app.tsx) then leaves that name as
// the only class of the body, and the app's stylesheet draws `.light` and `.dark`. The settings page offers those two, and seedit's own static shell ignores any
// other value, so the class the page was written with stays for one, and when storage cannot be read.
//
// Loaded in the head, before the stylesheet, as a plain script: the body does not exist yet, so the class goes on as the parser inserts the body, in the same
// task, and no frame is drawn without it. A change of theme in another tab shows on the next load of this page.

(function () {
  let theme
  try {
    const stored = localStorage.getItem('theme') || 'light'
    if (stored === 'light' || stored === 'dark') theme = stored
  } catch {}
  if (theme === undefined) return
  const apply = () => {
    if (document.body === null) return false
    document.body.className = theme
    return true
  }
  if (apply()) return
  const observer = new MutationObserver(() => { if (apply()) observer.disconnect() })
  observer.observe(document.documentElement, { childList: true })
})()
