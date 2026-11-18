// Uploads a file to an image host by driving the host's own upload page in a <webview> the person
// never sees, the way a desktop build drives it in a hidden window. A classic script that sets one
// window value, `orivonWebviewUpload`: `upload(provider, file)` resolves `{ url, provider }`,
// `stripMetadata(file)` returns the file without its camera and location metadata.
//
// The page is shown through web.embed, so the app's manifest names each upload page's origin. Nothing
// else in this file is specific to one app; the recipe table below is the data.

(function () {
  'use strict'

  const POLL_INTERVAL_MS = 500
  const PAGE_LOAD_TIMEOUT_MS = 30_000
  const SETTLE_MS = 1500
  const AFTER_FILE_MS = 500
  const SUBMIT_WAIT_MS = 10_000
  const SUBMIT_POLL_MS = 250
  const CHUNK_BYTES = 1024 * 1024
  const VIEW_STYLE = 'position:fixed;left:0;top:0;width:800px;height:600px;border:0;opacity:0;pointer-events:none;z-index:-1'
  const DIRECT_MEDIA_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.webm', '.mp4', '.mov', '.avi', '.mkv', '.gifv', '.swf']
  const MAX_STRIPPED_BYTES = 64 * 1024 * 1024

  const BLOCKED = ['#challenge', '.captcha', '[data-captcha]', '.g-recaptcha', '#recaptcha', '.login-form', '.signin', '.login']

  /** Selectors are candidates, tried in order. A blocked indicator is a captcha or a login wall: the upload fails at once when one is on the page. */
  const RECIPES = {
    imgur: {
      uploadUrl: 'https://imgur.com/upload',
      fileInput: ['input[type="file"]', 'input[type=file]', '[data-file-input]'],
      submit: ['button[type="submit"]', '[data-action="upload"]', '.upload-btn', '[type="submit"]'],
      result: {
        selectors: ['a[href*="i.imgur.com"]', 'input[value*="i.imgur.com"]', '[class*="copy-link"] input', '[data-link]'],
        attribute: 'href',
        // Read only when no candidate above answers: the page uploads as soon as a file is chosen, moves to the post's address and shows the picture in an
        // <img>, and its copy-link field holds the post's address, not the file's.
        added: { path: '^/(?:a|gallery)/', selectors: ['img[src*="i.imgur.com"]'], attribute: 'src' }
      },
      blocked: BLOCKED,
      timeoutMs: 45_000
    },
    imgbb: {
      uploadUrl: 'https://imgbb.com/',
      fileInput: ['input[type="file"]', '#anywhere-upload-input', 'input[data-action="anywhere-upload-input"]'],
      submit: ['button[data-action="upload"]', 'button.btn.green', 'button[type="submit"]', '[data-action="upload"]'],
      result: {
        selectors: ['input[name="html-embed-medium"]', 'textarea[name="html-embed-medium"]', '#uploaded-embed-code-1', 'input[value*="i.ibb.co"]', 'textarea', 'img[src*="i.ibb.co"]'],
        attribute: 'value'
      },
      prepare: "(function(){var select=document.querySelector('#upload-expiration,select[name=\"upload-expiration\"]');if(select){select.value='';select.dispatchEvent(new Event('change',{bubbles:true}));}return true;})()",
      blocked: BLOCKED,
      timeoutMs: 60_000
    }
  }

  // The functions below run inside the shown page: each is sent as source, so none may use anything outside itself.

  function guestFirstMatch (selectors) {
    for (const selector of selectors) {
      try { if (document.querySelector(selector) !== null) return selector } catch (error) {}
    }
    return null
  }

  function guestReceive (key, chunk) {
    if (!Array.isArray(window[key])) window[key] = []
    window[key].push(chunk)
    return true
  }

  /** Puts the received bytes on the file input as a File and fires the events a chosen file fires. */
  function guestAttach (key, selector, name, type) {
    const parts = (window[key] || []).map((chunk) => {
      const text = atob(chunk)
      const bytes = new Uint8Array(text.length)
      for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index)
      return bytes
    })
    delete window[key]
    const input = document.querySelector(selector)
    if (input === null) return false
    const transfer = new DataTransfer()
    transfer.items.add(new File(parts, name, { type }))
    input.files = transfer.files
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }

  /** Clicks the first element, of the first candidate that has one, that is laid out and enabled: 'clicked', 'hidden' when elements match and none can be clicked yet, 'missing' when none match. */
  function guestClick (selectors) {
    let matched = false
    for (const selector of selectors) {
      let elements
      try { elements = document.querySelectorAll(selector) } catch (error) { continue }
      for (const element of elements) {
        matched = true
        if (element.getClientRects().length === 0 || element.disabled === true) continue
        element.click()
        return 'clicked'
      }
    }
    return matched ? 'hidden' : 'missing'
  }

  /** What the page holds for each candidate, for the log of a click that could not be made: how many match, and whether each is laid out and enabled. */
  function guestDescribe (selectors) {
    return selectors.map((selector) => {
      let elements = []
      try { elements = [...document.querySelectorAll(selector)] } catch (error) {}
      return { selector, matches: elements.length, shown: elements.slice(0, 4).map((element) => ({ tag: element.tagName, laidOut: element.getClientRects().length > 0, disabled: element.disabled === true, text: String(element.textContent || '').trim().slice(0, 40) })) }
    })
  }

  /** The first candidate whose value holds a link to media: a bare link, or the first media link in a block of text such as an embed code. */
  function guestExtract (selectors, attribute, path) {
    if (path !== undefined && !new RegExp(path).test(location.pathname)) return null
    const normalize = (value) => {
      const url = String(value || '').trim()
      return url.startsWith('//') ? `https:${url}` : url
    }
    const isMedia = (url) => /\.(?:jpe?g|png|gif|webp|bmp|avif|mp4|webm|mov|avi|mkv|gifv)(?:[?#].*)?$/i.test(url)
    const pick = (value) => {
      const text = String(value || '')
      for (const candidate of text.match(/https?:\/\/[^\s"'<>[\]]+/g) || []) {
        if (isMedia(normalize(candidate))) return normalize(candidate)
      }
      const whole = normalize(text)
      return whole.startsWith('http') ? whole : ''
    }
    for (const selector of selectors) {
      try {
        const element = document.querySelector(selector)
        if (element === null) continue
        const raw = attribute === 'text' ? element.textContent : attribute === 'value' ? (element.value || element.getAttribute('value')) : (element.getAttribute(attribute) || element[attribute])
        const url = pick(String(raw || '').trim())
        if (url !== '') return url
      } catch (error) {}
    }
    return null
  }

  function isDirectMediaUrl (url) {
    const bare = String(url).split('?')[0].split('#')[0].toLowerCase()
    return DIRECT_MEDIA_EXTENSIONS.some((extension) => bare.endsWith(extension))
  }

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  function base64Of (bytes) {
    let text = ''
    for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(at, at + 0x8000))
    return btoa(text)
  }

  function openHiddenView () {
    const view = document.createElement('webview')
    view.setAttribute('src', 'about:blank')
    view.setAttribute('style', VIEW_STYLE)
    view.setAttribute('aria-hidden', 'true')
    view.setAttribute('tabindex', '-1')
    return view
  }

  /**
   * The element is attached on about:blank first and then sent to the page: a refused origin then rejects the load instead of
   * ending the element. An element the shell never attaches (no grant) fires nothing, so the whole step has one clock.
   */
  async function showPage (view, uploadUrl) {
    let timer
    const timeout = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Page load timed out after ${String(PAGE_LOAD_TIMEOUT_MS)}ms for ${uploadUrl}`)), PAGE_LOAD_TIMEOUT_MS) })
    const loaded = (async () => {
      const attached = new Promise((resolve) => view.addEventListener('did-finish-load', resolve, { once: true }))
      document.body.appendChild(view)
      await attached
      if (typeof view.setAudioMuted === 'function') view.setAudioMuted(true)
      try { await view.loadURL(uploadUrl) } catch (error) { throw new Error(`Page load failed: ${String(error?.message ?? error)}`) }
    })()
    loaded.catch(() => {})
    try {
      await Promise.race([loaded, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  let lastKey = 0

  async function sendFile (run, file, selector) {
    const key = `__orivonUpload${String(++lastKey)}`
    const bytes = new Uint8Array(await file.arrayBuffer())
    for (let at = 0; at < bytes.length; at += CHUNK_BYTES) await run(guestReceive, key, base64Of(bytes.subarray(at, at + CHUNK_BYTES)))
    return await run(guestAttach, key, selector, file.name, file.type)
  }

  async function firstMatch (run, selectors) {
    return await run(guestFirstMatch, selectors)
  }

  /**
   * A page that is still drawing its button (imgbb's queue opens a moment after the file is set, longer on a busy machine) has the button in the
   * document but not laid out: the click is tried again until the button can take it or SUBMIT_WAIT_MS has passed. 'missing' at the end means the
   * page replaced the button itself, which is a page that went on to upload, so the result is waited for.
   */
  async function clickSubmit (run, selectors) {
    const deadline = Date.now() + SUBMIT_WAIT_MS
    for (;;) {
      const outcome = await run(guestClick, selectors)
      if (outcome === 'clicked' || Date.now() >= deadline) return outcome
      await delay(SUBMIT_POLL_MS)
    }
  }

  /** The desktop's message for a button that cannot be clicked, carrying what the page held for the log. */
  async function unclickable (run, selectors) {
    const error = new Error('Cannot click node: box model unavailable (element may be hidden or zero-size)')
    error.detail = await run(guestDescribe, selectors).catch(() => null)
    return error
  }

  async function runRecipe (provider, recipe, file) {
    const view = openHiddenView()
    // The page is another site's: a script error, or the page replacing itself, is an answer of "nothing yet" and the poll goes on.
    const run = (fn, ...args) => view.executeJavaScript(`(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(',')})`, fn === guestClick)
    try {
      await showPage(view, recipe.uploadUrl)
      await delay(SETTLE_MS)

      const blockedBefore = await firstMatch(run, recipe.blocked)
      if (blockedBefore !== null) throw new Error(`Provider blocked: captcha, login, or challenge detected (${provider}), selector: ${blockedBefore}`)

      const input = await firstMatch(run, recipe.fileInput)
      if (input === null) throw new Error(`No file input found for ${provider}. Tried: ${recipe.fileInput.join(', ')}`)
      await sendFile(run, file, input)
      await delay(AFTER_FILE_MS)

      if (recipe.prepare !== undefined) await view.executeJavaScript(recipe.prepare)

      const submit = await firstMatch(run, recipe.submit)
      // A page may start the upload as soon as the file is chosen and show no button until it is done (imgur's does). The desktop gives up here; this goes on
      // to wait for the result, and gives the desktop's message when none comes.
      if (submit !== null) {
        const clicked = await clickSubmit(run, recipe.submit)
        if (clicked === 'hidden') throw await unclickable(run, recipe.submit)
      }

      const start = Date.now()
      while (Date.now() - start < recipe.timeoutMs) {
        const blockedNow = await firstMatch(run, recipe.blocked).catch(() => null)
        if (blockedNow !== null) throw new Error(`Provider blocked during upload: captcha or challenge (${provider}), selector: ${blockedNow}`)
        const answer = recipe.result
        let url = await run(guestExtract, answer.selectors, answer.attribute).catch(() => null)
        if (url === null && answer.added !== undefined) url = await run(guestExtract, answer.added.selectors, answer.added.attribute, answer.added.path).catch(() => null)
        if (typeof url === 'string' && isDirectMediaUrl(url)) return { url, provider }
        await delay(POLL_INTERVAL_MS)
      }
      if (submit === null) throw new Error(`No submit button found for ${provider}. Tried: ${recipe.submit.join(', ')}`)
      throw new Error(`Upload timeout or no direct URL extracted for ${provider} (elapsed: ${String(Date.now() - start)}ms, timeout: ${String(recipe.timeoutMs)}ms)`)
    } finally {
      view.remove()
    }
  }

  async function upload (provider, file) {
    const recipe = Object.prototype.hasOwnProperty.call(RECIPES, provider) ? RECIPES[provider] : undefined
    if (recipe === undefined) throw new Error(`No automation recipe for provider: ${String(provider)}`)
    try {
      return await runRecipe(provider, recipe, file)
    } catch (error) {
      console.warn(`[orivon] upload to ${provider} failed: ${String(error?.message ?? error)}${error?.detail === undefined ? '' : ` ${JSON.stringify(error.detail)}`}`)
      throw error
    }
  }

  // Metadata: removed from JPEG, PNG and WebP before an upload leaves, by their container formats. The file's own pixels are never
  // re-encoded, and any file it cannot read to the end goes up unchanged, so stripping never blocks an upload.

  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const PNG_RENDERING_CHUNKS = ['tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs', 'acTL', 'fcTL', 'fdAT']
  const JPEG_METADATA_SEGMENTS = [0xe1, 0xed, 0xfe]
  const WEBP_METADATA_FLAGS = 0x0c

  const be32 = (bytes, at) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0
  const le32 = (bytes, at) => (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
  const tag = (bytes, at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3])

  function joined (parts) {
    const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
    let at = 0
    for (const part of parts) { out.set(part, at); at += part.length }
    return out
  }

  /** The Orientation of an Exif block's first directory, 1 when there is none. A photo's rotation lives there, not in its pixels. */
  function exifOrientation (bytes, tiff, end) {
    if (tiff + 8 > end) return 1
    const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49
    if (!little && !(bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d)) return 1
    const u16 = (at) => (little ? bytes[at] | (bytes[at + 1] << 8) : (bytes[at] << 8) | bytes[at + 1])
    const u32 = (at) => (little ? le32(bytes, at) : be32(bytes, at))
    const first = tiff + u32(tiff + 4)
    if (u16(tiff + 2) !== 42 || first + 2 > end) return 1
    for (let entry = first + 2, left = u16(first); left > 0 && entry + 12 <= end; left--, entry += 12) {
      if (u16(entry) !== 0x0112) continue
      const value = u16(entry + 8)
      return u16(entry + 2) === 3 && u32(entry + 4) === 1 && value >= 1 && value <= 8 ? value : 1
    }
    return 1
  }

  function orientationSegment (orientation) {
    return Uint8Array.from([0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00,
      0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
  }

  function stripJpeg (bytes) {
    const kept = [bytes.subarray(0, 2)]
    let dropped = 0
    let orientation = 1
    for (let at = 2; ;) {
      if (at + 1 >= bytes.length || bytes[at] !== 0xff) return null
      let marker = at + 1
      while (bytes[marker] === 0xff) marker++
      const kind = bytes[marker]
      if (kind === 0xda) { kept.push(bytes.subarray(at)); break }
      if (marker + 2 >= bytes.length || kind === 0x00 || kind === 0x01 || (kind >= 0xd0 && kind <= 0xd9)) return null
      const end = marker + 1 + ((bytes[marker + 1] << 8) | bytes[marker + 2])
      if (end < marker + 3 || end > bytes.length) return null
      if (JPEG_METADATA_SEGMENTS.includes(kind)) {
        dropped += end - at
        if (kind === 0xe1 && tag(bytes, marker + 3) === 'Exif' && orientation === 1) orientation = exifOrientation(bytes, marker + 9, end)
      } else {
        kept.push(bytes.subarray(at, end))
      }
      at = end
    }
    if (dropped === 0) return null
    if (orientation > 1) kept.splice(1, 0, orientationSegment(orientation))
    return joined(kept)
  }

  function stripPng (bytes) {
    const kept = [bytes.subarray(0, 8)]
    let dropped = 0
    for (let at = 8; ;) {
      if (at + 8 > bytes.length) return null
      const end = at + 12 + be32(bytes, at)
      if (end > bytes.length) return null
      const type = tag(bytes, at + 4)
      if (type === 'IEND') { kept.push(bytes.subarray(at)); break }
      if ((bytes[at + 4] & 0x20) === 0 || PNG_RENDERING_CHUNKS.includes(type)) kept.push(bytes.subarray(at, end))
      else dropped += end - at
      at = end
    }
    return dropped === 0 ? null : joined(kept)
  }

  function stripWebp (bytes) {
    const riffEnd = 8 + le32(bytes, 4)
    if (riffEnd < 12 || riffEnd > bytes.length) return null
    const kept = [bytes.subarray(0, 12)]
    let size = 12
    let dropped = 0
    let flagsAt = -1
    let flagged = false
    for (let at = 12; at < riffEnd;) {
      if (at + 8 > riffEnd) return null
      const length = le32(bytes, at + 4)
      const end = at + 8 + length + (length & 1)
      if (end > riffEnd) return null
      const type = tag(bytes, at)
      if (type === 'EXIF' || type === 'XMP ') {
        dropped += end - at
      } else {
        if (type === 'VP8X') {
          if (length < 10) return null
          flagsAt = size + 8
          flagged = (bytes[at + 8] & WEBP_METADATA_FLAGS) !== 0
        }
        kept.push(bytes.subarray(at, end))
        size += end - at
      }
      at = end
    }
    if (dropped === 0 && !flagged) return null
    if (riffEnd < bytes.length) kept.push(bytes.subarray(riffEnd))
    const out = joined(kept)
    for (let shift = 0; shift < 4; shift++) out[4 + shift] = ((size - 8) >>> (8 * shift)) & 0xff
    if (flagsAt >= 0) out[flagsAt] &= ~WEBP_METADATA_FLAGS
    return out
  }

  /** The format is read from the file's first bytes, never from its name or type. Null means nothing to remove, or a file this cannot read: keep the original. */
  function strippedBytes (bytes) {
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return stripJpeg(bytes)
    if (bytes.length >= 8 && PNG_SIGNATURE.every((byte, at) => bytes[at] === byte)) return stripPng(bytes)
    if (bytes.length >= 16 && tag(bytes, 0) === 'RIFF' && tag(bytes, 8) === 'WEBP') return stripWebp(bytes)
    return null
  }

  async function stripMetadata (file) {
    if (file.size > MAX_STRIPPED_BYTES) return file
    try {
      const out = strippedBytes(new Uint8Array(await file.arrayBuffer()))
      return out === null ? file : new File([out], file.name, { type: file.type, lastModified: file.lastModified })
    } catch (error) {
      return file
    }
  }

  window.orivonWebviewUpload = Object.freeze({ upload, stripMetadata, providers: Object.freeze(Object.keys(RECIPES)) })
})()
