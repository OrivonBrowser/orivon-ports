// Runs inside a plugin's page, a srcdoc frame of the app. The bridge rewrote the frame's
// document (superproductivity.js, preparePluginFrameHtml) so that each inline script is
// held in an inert <script type="text/plain" data-orivon-inline> with one of these after it
// (<script src=".../plugin-frame.js" data-orivon-run="classic|module">): the served policy
// admits this file ('self') and string evaluation ('unsafe-eval'), and no inline script.
//
// Each run evaluates the text of the element before it, where it stood:
// - a classic script by indirect eval, which keeps `var` and function declarations global (what
//   an inline handler needs) and runs at the parser's position (what DOMContentLoaded listeners
//   need). A top-level let, const or class stays private to its own script.
// - a module script as an async function in strict mode, deferred like a module: its top-level
//   declarations stay its own, `await` works, `import` and `export` do not.
//
// The first run also adopts inline event handlers (`onclick="..."`), which the same policy
// refuses: it takes each such attribute off its element before an event can fire and
// calls the code itself, with the scope chain a handler has (element, form, document).
(function () {
  const runner = document.currentScript
  const data = runner === null ? null : runner.previousElementSibling
  if (runner === null || data === null || !data.hasAttribute('data-orivon-inline')) return

  const MARK = Symbol.for('orivon.plugin-frame')
  if (window[MARK] !== true) {
    window[MARK] = true
    adoptHandlers()
  }

  if (runner.getAttribute('data-orivon-run') === 'module') runModule(data.textContent)
  else runClassic(data.textContent, data)

  function withCurrentScript (script, run) {
    Object.defineProperty(document, 'currentScript', { configurable: true, get: () => script })
    try {
      return run()
    } finally {
      delete document.currentScript
    }
  }

  function runClassic (code, element) {
    withCurrentScript(element, () => (0, eval)(code))
  }

  function runModule (code) {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const body = new AsyncFunction('"use strict";\n' + code)
    withCurrentScript(null, () => body.call(undefined)).catch((error) => { window.reportError(error) })
  }

  function adoptHandlers () {
    // The events a <body> or <frameset> attribute sets on the window, not on the element.
    const windowEvents = new Set([
      'afterprint', 'beforeprint', 'beforeunload', 'blur', 'error', 'focus', 'hashchange', 'languagechange', 'load',
      'message', 'messageerror', 'offline', 'online', 'pagehide', 'pageshow', 'popstate', 'rejectionhandled', 'resize',
      'storage', 'unhandledrejection', 'unload'
    ])
    const attributes = new Set()
    for (const owner of [window, document.createElement('div')]) {
      for (const key in owner) if (key.startsWith('on')) attributes.add(key)
    }
    const names = [...attributes]
    const selector = names.map((name) => '[' + name + ']').join(',')

    const adopt = (element) => {
      for (const name of names) {
        const code = element.getAttribute(name)
        if (code === null) continue
        element.removeAttribute(name)
        const type = name.slice(2)
        const onWindow = windowEvents.has(type) && (element.localName === 'body' || element.localName === 'frameset')
        let compiled
        ;(onWindow ? window : element).addEventListener(type, function (event) {
          // The scope an inline handler's code sees: the element, then its form, then the document.
          compiled ??= new Function('event', 'with (document) { with (this.form || {}) { with (this) {\n' + code + '\n} } }')
          const result = compiled.call(element, event)
          if (result === false && event.cancelable) event.preventDefault()
        })
      }
    }
    const adoptTree = (node) => {
      if (node.nodeType === 1 && node.matches(selector)) adopt(node)
      if (node.nodeType === 1 || node.nodeType === 9 || node.nodeType === 11) node.querySelectorAll(selector).forEach(adopt)
    }

    adoptTree(document)
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') adopt(record.target)
        else record.addedNodes.forEach(adoptTree)
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: names })
  }
})()
