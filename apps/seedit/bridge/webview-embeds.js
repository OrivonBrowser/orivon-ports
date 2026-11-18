// Shows the click-to-open embeds of third-party sites (video, audio, posts) in a <webview>, where an
// installed app's own frames may not load them. A classic script with no window value: it watches the
// page for an <iframe> that names an embed site, keeps the frame in the page, hidden, and puts a
// <webview> of the same class and source beside it. No other element is touched.
//
// The sites are named in the app's manifest under web.embed; a site missing there shows blank. Outside
// Orivon a <webview> is an unknown element, and then a frame stays as it is.

(function () {
  'use strict'

  /** The origins an embed frame's own address can have, and the spam-blocker's challenge page. */
  const EMBED_ORIGINS = [
    'https://www.youtube.com', 'https://player.twitch.tv', 'https://odysee.com', 'https://www.bitchute.com',
    'https://streamable.com', 'https://open.spotify.com', 'https://w.soundcloud.com',
    // The page the spam-blocker of a board sends a poster to, which the app draws in the frame of its challenge window.
    'https://spamblocker.bitsocial.net'
  ]
  /** A frame with inline content, not an address, is an embed when its content loads one of these widgets, which then opens a frame of its own site. */
  const WIDGET_SCRIPTS = ['https://platform.twitter.com/widgets.js', 'https://embed.reddit.com/widgets.js', 'https://www.tiktok.com/embed.js', 'https://www.instagram.com/embed.js']

  /** A frame's inline content resolves a protocol-relative address against the page that holds it; a data address has no host to borrow a scheme from, so the scheme is written out. */
  const withSchemes = (content) => content.replace(/(\bsrc\s*=\s*["'])\/\//gi, '$1https://')

  /** Where the shown page loads from, or null when the frame is not an embed. */
  function embedAddress (frame) {
    const src = frame.getAttribute('src')
    if (src !== null && src !== '') {
      try {
        const url = new URL(src, document.baseURI)
        return EMBED_ORIGINS.includes(url.origin) ? url.href : null
      } catch (error) {
        return null
      }
    }
    const inline = frame.getAttribute('srcdoc')
    const content = inline === null ? null : withSchemes(inline)
    if (content !== null && WIDGET_SCRIPTS.some((script) => content.includes(script))) return `data:text/html;charset=utf-8,${encodeURIComponent(content)}`
    return null
  }

  /** Asked when the first embed frame appears, not at load: the shell defines <webview> for a page as it starts, and a frame comes long after. */
  let live
  function canShowPages () {
    if (live !== undefined) return live
    live = typeof document.createElement('webview').loadURL === 'function'
    if (live) {
      // The frame's width and height attributes are hints a class overrides, so the element's fallback has no weight of its own.
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(':where(webview[data-orivon-embed]) { width: 100%; height: 100% }')
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
    }
    return live
  }

  const shown = new Map()

  function show (frame) {
    const address = embedAddress(frame)
    if (address === null || !canShowPages()) return
    const known = shown.get(frame)
    if (known !== undefined) {
      if (known.address !== address) { known.address = address; known.view.setAttribute('src', address) }
      return
    }
    const view = document.createElement('webview')
    view.setAttribute('data-orivon-embed', '')
    view.setAttribute('src', address)
    if (frame.className !== '') view.className = frame.className
    if (frame.title !== '') view.setAttribute('title', frame.title)
    // A frame that sends its own origin as the referrer is one a site may check, and a shown page has no parent frame to send it from.
    if (frame.referrerPolicy === 'origin' && !address.startsWith('data:')) view.setAttribute('httpreferrer', `${location.origin}/`)
    // The window a frame's page asks for opens as a tab, for a secure address only, as the desktop sends it to the system browser.
    view.addEventListener('orivon-popup', (event) => {
      if (String(event.detail?.url).startsWith('https://')) window.open(event.detail.url, '_blank', 'noopener,noreferrer')
    })
    frame.style.display = 'none'
    frame.after(view)
    shown.set(frame, { view, address })
  }

  function scan (node) {
    if (node.nodeType !== 1) return
    if (node.tagName === 'IFRAME') show(node)
    else for (const frame of node.querySelectorAll('iframe')) show(frame)
  }

  /** A frame the page removes takes its element with it. */
  function sweep () {
    for (const [frame, { view }] of shown) {
      if (!frame.isConnected) { view.remove(); shown.delete(frame) }
    }
  }

  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') { if (record.target.tagName === 'IFRAME') show(record.target) }
      else for (const node of record.addedNodes) scan(node)
    }
    sweep()
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcdoc'] })
  scan(document.documentElement)
})()
