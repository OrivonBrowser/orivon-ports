// The window.electronIPC members that carry a decision rather than a shape:
// sendRequest and cancelRequest, which send Restfox's requests through the page's
// own fetch (Orivon's routed fetch in an app tab: no CORS check, and the headers
// the user typed, Cookie and Origin included, go out as written), and the two
// settings that main applied to its own HTTP client that need an answer. The other 30 members are
// declared in ./members.json and generated -- see ../README.md.
//
// This file is spliced into the composed bridge, so it is not a module: it
// declares `appMembers`, which the installer calls with the kit.

const PROXY_MESSAGE = 'Settings > Proxy is set to Custom. This build sends requests from the browser it runs in and cannot send them through a proxy of its own, so it sent nothing. Set the proxy to System or Off to send requests.'
const CA_MESSAGE = 'This build cannot add certificate authorities: it checks certificates against the roots the browser trusts, so the file was not saved.'
const CERTIFICATE_MESSAGE = 'The server\'s certificate was not accepted. This build checks certificates against the roots the browser trusts and has no setting to skip the check, so Disable SSL Verification and CA Certificates in Settings do not apply.'
const HTTP_MESSAGE = 'Plain http:// requests are sent only to the localhost ports this app was given permission for (the site panel lists them). Use https:// for any other address.'

// Upstream's main process reports its page views to its own analytics host
// unless this key says no. A new profile starts with it off; Settings shows the
// box ticked and one click turns it back on.
const ANALYTICS_KEY = 'Restfox-DisablePageViewAnalyticsTracking'

try {
  if (window.localStorage.getItem(ANALYTICS_KEY) === null) window.localStorage.setItem(ANALYTICS_KEY, 'true')
} catch {
  // Storage can be blocked; the app then runs with upstream's own default.
}

/** An Error and what it was caused by, as the text Restfox shows under a failed request. */
function describeError (error) {
  const lines = []
  for (let current = error, depth = 0; current !== undefined && current !== null && depth < 4; current = current.cause, depth += 1) {
    lines.push(String(current))
  }
  return lines.join('\nCaused by: ')
}

/** Restfox prints the message of an error whose cause is 'display-error' in place of its generic "Request failed" list. */
function displayError (message) {
  return new Error(message, { cause: 'display-error' })
}

/** The shapes main's handleSendRequest rebuilds: a file or a form as plain data over IPC, here as the objects fetch takes. */
function bodyFrom (body, hint) {
  const file = (part) => new File([new Uint8Array(part.buffer)], part.name, { type: part.type })
  if (hint === 'File') return file(body)
  if (hint !== 'FormData') return body
  const form = new FormData()
  for (const [name, value] of body) form.append(name, typeof value === 'object' && value !== null ? file(value) : value)
  return form
}

function appMembers (kit) {
  void kit
  const controllers = new Map()
  const cancelledEarly = new Set()
  let customProxy = false

  async function sendRequest (data) {
    const { requestId, url, method, headers, bodyHint } = data
    const controller = new AbortController()
    controllers.set(requestId, controller)
    if (cancelledEarly.delete(requestId)) controller.abort()
    try {
      if (customProxy) throw displayError(PROXY_MESSAGE)
      const body = bodyFrom(data.body, bodyHint)
      const startTime = Date.now()
      const response = await fetch(url, { method, headers, body: method === 'GET' ? undefined : body, signal: controller.signal })
      const headEndTime = Date.now()
      const blob = await response.blob()
      const buffer = await blob.arrayBuffer()
      const endTime = Date.now()
      return {
        event: 'response',
        eventData: {
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers.entries()],
          mimeType: blob.type,
          buffer: new Uint8Array(buffer),
          timeTaken: endTime - startTime,
          headTimeTaken: headEndTime - startTime,
          bodyTimeTaken: endTime - headEndTime,
          // What the app handed to fetch, which goes out as written. The request line, Host and the headers the
          // browser adds itself are not in this list.
          requestHeadersSent: Object.entries(headers)
        }
      }
    } catch (error) {
      if (error?.cause === 'display-error') throw error
      const reason = describeError(error)
      if (/certificate|self.signed|unable to verify|CERT_|ERR_CERT|ERR_TLS|SSL routines/i.test(reason)) throw displayError(`${CERTIFICATE_MESSAGE}\n\n${reason}`)
      if (error?.name === 'TypeError' && /^http:/i.test(url)) throw displayError(`${HTTP_MESSAGE}\n\n${reason}`)
      return { event: 'responseError', eventData: reason }
    } finally {
      controllers.delete(requestId)
      cancelledEarly.delete(requestId)
    }
  }

  function cancelRequest (requestId) {
    const controller = controllers.get(requestId)
    if (controller === undefined) cancelledEarly.add(requestId)
    else controller.abort()
    return Promise.resolve()
  }

  return {
    sendRequest,
    cancelRequest,
    // Settings saves a file only when this answers without an error, so a refused one is never kept.
    setCACertificates (text) {
      return Promise.resolve({ error: typeof text === 'string' && text !== '' ? CA_MESSAGE : null })
    },
    setProxy (settings) {
      customProxy = settings !== null && settings !== undefined && settings.mode === 'custom'
      return Promise.resolve()
    }
  }
}
