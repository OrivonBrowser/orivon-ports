import type { Effects } from './ipc-main.ts'
import type { IpcKind } from './ipc-preload.ts'
import type { SendVerdict } from './ipc-sends.ts'
import type { Channel } from './ipc-source.ts'

// What an API means, the same in every app, and how those meanings add up to a
// suggested bucket for one preload member. A suggestion names its evidence and
// decides nothing: `parseDeclaration` still refuses a port until a person has moved
// each member. When the evidence is thin, mixed or unread, the answer is "none".

export type Bucket = 'behaviours' | 'listeners' | 'noop' | 'constants' | 'asyncConstants' | 'refused'

export interface Suggestion {
  readonly bucket: Bucket
  /** A `behaviours` suggestion: the catalog id, and the role when the behaviour has several. */
  readonly behaviour?: string
  readonly role?: string
  /** A `refused` suggestion: the declaration's reason and detail. */
  readonly refusal?: 'excluded' | 'shell-owned'
  readonly detail?: string
  /** A `constants` or `asyncConstants` suggestion: the literal the handler answers. */
  readonly value?: unknown
}

export interface Decision {
  readonly suggestion?: Suggestion
  /** Why this suggestion, or why none. One line. */
  readonly because: string
  /** Evidence that suggests no bucket but bears on the choice, such as a path that escapes into app code. */
  readonly notes: readonly string[]
}

export interface UseFacts {
  readonly kind: IpcKind
  readonly channel: Channel
  /** The handler behind the channel, when one was found and its body could be read. */
  readonly handler?: {
    readonly effects: Effects
    readonly constant?: { readonly value: unknown }
    readonly storesOnly?: readonly string[]
  }
  /** For a listener: what makes main send the channel. */
  readonly sends?: SendVerdict
  /** Why the handler was not read, when it was not. */
  readonly unread?: string
}

export interface MemberFacts {
  readonly uses: readonly UseFacts[]
  /** What the preload member itself calls (`webFrame`...), apart from IPC. */
  readonly preload: Effects
}

interface ApiRule {
  /** Matched against an Electron member (`powerSaveBlocker.start`), a construction (`new BrowserWindow`) or a Node member (`child_process.spawn`). */
  readonly api: RegExp
  readonly suggestion: Suggestion
  readonly because: string
  /** The rule holds only when every API the handler reaches matches it (or `also`, or is a benign Node module): a handler that also does something else is not this meaning. */
  readonly alone?: boolean
  readonly also?: RegExp
  /** The rule stands down when any of these is also reached: the same call means something else beside them. */
  readonly unless?: RegExp
}

/** The rules read in a main-process handler and in the helpers it calls. */
export const MAIN_RULES: readonly ApiRule[] = [
  { api: /^powerSaveBlocker\.start$/, suggestion: { bucket: 'behaviours', behaviour: 'wakeLock', role: 'acquire' }, because: '`powerSaveBlocker.start` keeps the machine awake: the `wakeLock` behaviour, acquire' },
  { api: /^powerSaveBlocker\.stop$/, suggestion: { bucket: 'behaviours', behaviour: 'wakeLock', role: 'release' }, because: '`powerSaveBlocker.stop` lets the machine sleep again: the `wakeLock` behaviour, release' },
  { api: /^app\.(?:getLocale|getSystemLocale|getPreferredSystemLanguages)$/, suggestion: { bucket: 'behaviours', behaviour: 'locale' }, because: 'the handler answers the system locale: the `locale` behaviour', alone: true },
  { api: /^session\.[\w.]*setProxy$/, suggestion: { bucket: 'refused', refusal: 'shell-owned', detail: 'proxy configuration is browser-level' }, because: '`setProxy` changes the proxy of a whole session, which is the browser\'s, not one app\'s' },
  { api: /^child_process(?:\.|$)/, suggestion: { bucket: 'refused', refusal: 'excluded', detail: 'launching another program' }, because: 'the handler starts a program with `child_process`, which Orivon excludes', unless: /^app\.(?:relaunch|quit|exit)$/ },
  { api: /^new (?:BrowserWindow|BaseWindow|BrowserView|WebContentsView)$/, suggestion: { bucket: 'refused', refusal: 'shell-owned', detail: 'windows and tabs are the browser\'s' }, because: 'the handler creates a window, and windows and tabs are the browser\'s' },
  { api: /^app\.(?:relaunch|quit|exit)$/, suggestion: { bucket: 'refused', refusal: 'shell-owned', detail: 'the browser owns the app\'s lifetime' }, because: 'the handler restarts or quits the app, whose lifetime the browser owns', alone: true, also: /^child_process(?:\.|$)/ }
]

/** The rules read in the preload member itself. */
export const PRELOAD_RULES: readonly ApiRule[] = [
  { api: /^webFrame\.(?:setZoomFactor|setZoomLevel)$/, suggestion: { bucket: 'behaviours', behaviour: 'zoom' }, because: '`webFrame.setZoomFactor` zooms the page: the `zoom` behaviour' }
]

// A script a preload member runs in the page names what it does. Matched by what the script says it
// is, and only for these two: anything else a script does is the app's own.
const SCRIPT_RULES: readonly { readonly script: RegExp; readonly suggestion: Suggestion; readonly because: string }[] = [
  { script: /picture-?in-?picture|togglePiP\b|requestPictureInPicture/i, suggestion: { bucket: 'behaviours', behaviour: 'pictureInPicture' }, because: 'the script asked of `webFrame.executeJavaScript` toggles picture-in-picture: the `pictureInPicture` behaviour' },
  { script: /full-?screen/i, suggestion: { bucket: 'behaviours', behaviour: 'fullscreen' }, because: 'the script asked of `webFrame.executeJavaScript` toggles fullscreen: the `fullscreen` behaviour' }
]

/** APIs that return host paths, or act on them: the value escapes into app code unless the bridge keeps it opaque. */
const ESCAPE_NOTES: readonly { readonly api: RegExp; readonly note: string }[] = [
  { api: /^dialog\.(?:showOpenDialog|showOpenDialogSync|showSaveDialog|showSaveDialogSync)$/, note: 'opens a file dialog: a host path can reach app code, so apply the escape test before choosing a bucket' },
  { api: /^shell\.(?:openPath|showItemInFolder)$/, note: 'acts on a host path the app names: apply the escape test' },
  { api: /^shell\.openExternal$/, note: 'opens a URL outside the page' }
]

// Node modules a handler can use without reaching outside the page's own world.
const BENIGN_NODE = /^(?:path|os|url|util|process|buffer|events|string_decoder|querystring)(?:\.|$)/

const key = (suggestion: Suggestion): string => JSON.stringify([suggestion.bucket, suggestion.behaviour, suggestion.role, suggestion.refusal])

interface Hit { readonly suggestion: Suggestion; readonly because: string }

function apiList (effects: Effects): string[] {
  return [...effects.electron, ...effects.constructs, ...effects.node, ...effects.spawns.map((spawn) => `child_process.${spawn}`)]
}

function rulesHit (effects: Effects, rules: readonly ApiRule[]): Hit[] {
  const hits: Hit[] = []
  const all = apiList(effects)
  for (const rule of rules) {
    const matched = all.filter((api) => rule.api.test(api))
    if (matched.length === 0) continue
    if (rule.unless !== undefined && all.some((api) => (rule.unless as RegExp).test(api))) continue
    if (rule.alone === true && all.some((api) => !rule.api.test(api) && !BENIGN_NODE.test(api) && rule.also?.test(api) !== true)) continue
    const via = effects.via.get(matched[0] as string)
    hits.push({ suggestion: rule.suggestion, because: `${rule.because}${via === undefined ? '' : ` (in \`${via}\`)`}` })
  }
  return hits
}

function scriptHits (effects: Effects): Hit[] {
  const hits: Hit[] = []
  for (const script of effects.electronArgs.get('webFrame.executeJavaScript') ?? []) {
    if (script === null) continue
    const rule = SCRIPT_RULES.find((candidate) => candidate.script.test(script))
    if (rule !== undefined) hits.push({ suggestion: rule.suggestion, because: rule.because })
  }
  return hits
}

function notesOf (effects: Effects): string[] {
  const out: string[] = []
  for (const api of [...effects.electron]) {
    const hit = ESCAPE_NOTES.find((candidate) => candidate.api.test(api))
    if (hit !== undefined) out.push(`\`${api}\` ${hit.note}`)
  }
  return out
}

function listenerHit (use: UseFacts): { hit?: Hit; why: string } {
  const sends = use.sends
  if (sends === undefined) return { why: `the channel \`${use.channel.text}\` is not a literal or a constant this scan can read, so what main sends on it is unknown` }
  if (sends.unresolved > 0) return { why: `${String(sends.unresolved)} send(s) in main name a channel this scan could not read, and any of them might be \`${use.channel.name ?? use.channel.text}\`` }
  if (sends.sites.length === 0) {
    return { hit: { suggestion: { bucket: 'listeners' }, because: `main never sends \`${use.channel.name ?? use.channel.text}\`, so the callback the app hands over is never called` }, why: '' }
  }
  const live = sends.sites.flatMap((site) => site.contexts.filter((context) => !context.inert).map((context) => `${site.where}: ${context.why}`))
  if (live.length > 0) return { why: `main sends it from ${live[0] as string}${live.length > 1 ? ` (and ${String(live.length - 1)} more)` : ''}` }
  const whys = [...new Set(sends.sites.flatMap((site) => site.contexts.map((context) => context.why)))]
  return { hit: { suggestion: { bucket: 'listeners' }, because: `every send in main is one a single-window browser never makes: ${whys.join('; and ')}` }, why: '' }
}

/** The suggestion for one member: what every piece of evidence agrees on, or none. */
export function decide (facts: MemberFacts): Decision {
  const notes = [...notesOf(facts.preload), ...facts.uses.flatMap((use) => use.handler === undefined ? [] : notesOf(use.handler.effects))]
  const pieces: { label: string; hits: Hit[]; why?: string }[] = []

  const own = [...rulesHit(facts.preload, PRELOAD_RULES), ...scriptHits(facts.preload)]
  if (own.length > 0) pieces.push({ label: 'the preload member', hits: own })

  for (const use of facts.uses) {
    const label = `\`${use.channel.name ?? use.channel.text}\``
    if (use.kind === 'on' || use.kind === 'once') {
      const result = listenerHit(use)
      pieces.push({ label, hits: result.hit === undefined ? [] : [result.hit], why: result.why })
      continue
    }
    const handler = use.handler
    if (handler === undefined) { pieces.push({ label, hits: [], why: use.unread ?? 'the handler behind it was not read' }); continue }
    const hits = rulesHit(handler.effects, MAIN_RULES)
    if (hits.length === 0 && handler.constant !== undefined && (use.kind === 'invoke' || use.kind === 'sendSync') && use.channel.name !== undefined) {
      const bucket = use.kind === 'invoke' ? 'asyncConstants' : 'constants'
      hits.push({ suggestion: { bucket, value: handler.constant.value }, because: `the handler only returns ${JSON.stringify(handler.constant.value)}` })
    }
    if (hits.length === 0 && handler.storesOnly !== undefined && use.kind === 'send' && use.channel.name !== undefined) {
      hits.push({ suggestion: { bucket: 'noop' }, because: `the handler only stores its argument in ${handler.storesOnly.map((name) => `\`${name}\``).join(', ')}, which nothing else in the file reads` })
    }
    pieces.push({ label, hits, why: hits.length === 0 ? 'the handler calls no API the rules know' : '' })
  }

  const unexplained = pieces.find((piece) => piece.hits.length === 0)
  if (pieces.length === 0) return { because: 'the member makes no `ipcRenderer` call this scan could read, and calls no API the rules know', notes }
  if (unexplained !== undefined) return { because: `${unexplained.label}: ${unexplained.why ?? 'nothing suggests a bucket'}`, notes }

  const all = pieces.flatMap((piece) => piece.hits)
  const first = all[0] as Hit
  if (all.some((hit) => key(hit.suggestion) !== key(first.suggestion))) {
    return { because: `the evidence disagrees: ${[...new Set(all.map((hit) => hit.because))].join('; but ')}`, notes }
  }
  // A literal answer stays attached to the one suggestion that carries it.
  const suggestion = all.find((hit) => hit.suggestion.value !== undefined)?.suggestion ?? first.suggestion
  return { suggestion, because: [...new Set(all.map((hit) => hit.because))].join('; and '), notes }
}

export { apiList }
