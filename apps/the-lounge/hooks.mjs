// What upstream's server injects into the built index.html at serve time
// (server/plugins/html-config.ts), done statically: the placeholders the
// build leaves in the document get their answers, and the engine script is
// added. Idempotent, because prepare may run twice.

const BODYCLASS = '<!--thelounge-bodyclass-->'
const TRANSPORTS = '<!--thelounge-transports-->'
const THEMECOLOR = /<!--thelounge-themecolor-->/g
const HEAD_CLOSE = '</head>'

// In public mode the server replaces the body class with "public": no
// authentication, and the client knows it. The port has no user store, so
// public mode is the only mode it can honestly run.
const BODYCLASS_ANSWER = 'public'

// Upstream's default transports are polling plus websocket; polling is an
// HTTP endpoint a static file server cannot answer, so the client gets the
// websocket transport only. The engine's socket.io shim speaks exactly that.
// Quotes are attribute-escaped the way upstream's escapeAttr does it.
const TRANSPORTS_ANSWER = '[&quot;websocket&quot;]'

// The theme colour comes from public/thelounge.webmanifest's theme_color,
// which is how upstream reads it (server/config.ts reads the webmanifest for
// the default; the value below is that field's content).
const THEMECOLOR_ANSWER = '#415364'

// The client's theme setting rewrites this link's href (client/js/settings.ts
// looks it up by id and expects an HTMLLinkElement with an href); without it
// every theme change throws inside the settings store.
const THEME_LINK = '<link id="theme" rel="stylesheet" href="themes/default.css" data-server-theme="default">'

// Upstream injects an empty user stylesheet hook next to the theme link.
const USER_CSS = '<style id="user-specified-css"></style>'

// The engine replaces window.WebSocket before the client's bundle runs, so it
// must be a classic script in <head> — the entry bundle is a module, and
// module scripts always execute after synchronous classic scripts.
const ENGINE = '<script src="orivon/lounge-engine.js"></script>'

export function transformHtml (html) {
  if (!html.includes(BODYCLASS) || !html.includes(TRANSPORTS)) {
    throw new Error('the-lounge hooks.mjs: this does not look like The Lounge\'s index.html')
  }

  let out = html
    .replace(BODYCLASS, BODYCLASS_ANSWER)
    .replace(TRANSPORTS, TRANSPORTS_ANSWER)
    .replace(THEMECOLOR, THEMECOLOR_ANSWER)

  if (!out.includes(THEME_LINK)) {
    out = out.replace(HEAD_CLOSE, `\t${THEME_LINK}\n\t${USER_CSS}\n</head>`)
  }

  if (!out.includes('orivon/lounge-engine.js')) {
    out = out.replace(HEAD_CLOSE, `\t${ENGINE}\n</head>`)
  }

  return out
}
