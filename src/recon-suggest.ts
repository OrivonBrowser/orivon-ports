import { effectsOf, handlersIn, constantReturn, stateOnly } from './ipc-main.ts'
import type { Effects, Handler } from './ipc-main.ts'
import { preloadMembers } from './ipc-preload.ts'
import type { IpcKind, PreloadMember } from './ipc-preload.ts'
import { SendIndex } from './ipc-sends.ts'
import { sameChannel, Universe } from './ipc-source.ts'
import type { Channel } from './ipc-source.ts'
import { apiList, decide } from './suggest-rules.ts'
import type { Decision, MemberFacts, Suggestion, UseFacts } from './suggest-rules.ts'

// Recon's suggestions: for each member a preload exposes, the IPC channel it uses, the
// `ipcMain` handler behind it, and the Electron and Node APIs that handler calls, joined
// to a suggested bucket by the rules in `suggest-rules.ts`. Evidence for the person who
// classifies, never a classification: `--emit` still writes every name as unclassified.

export interface UseEvidence {
  readonly kind: IpcKind
  /** The channel's value when the constants could be read, else its source text. */
  readonly channel: string
  readonly resolved: boolean
  /** The `ipcMain` handler, as `file:line`; undefined when no handler for the channel was found. */
  readonly handler?: string
}

export interface MemberSuggestion {
  readonly global: string
  readonly member: string
  /** Where the preload defines it, as `file:line`. */
  readonly at: string
  readonly ipc: readonly UseEvidence[]
  /** The Electron and Node APIs seen in the preload member and its handlers, with the function they were found in when it was not the handler. */
  readonly apis: readonly string[]
  readonly suggestion?: Suggestion
  readonly because: string
  readonly notes: readonly string[]
}

export interface SuggestionReport {
  readonly members: readonly MemberSuggestion[]
  readonly suggested: number
  /** What this scan could not read, which would otherwise look like "no suggestion". */
  readonly limits: readonly string[]
}

const MAX_APIS = 8

function commonDirectory (a: string, b: string): string {
  const left = a.split('/')
  const right = b.split('/')
  const shared: string[] = []
  for (let i = 0; i < Math.min(left.length, right.length) && left[i] === right[i]; i++) shared.push(left[i] as string)
  return shared.join('/')
}

const under = (files: readonly string[], root: string): string[] => files.filter((file) => file === root || file.startsWith(`${root}/`))

function describeApis (effects: readonly Effects[]): string[] {
  const seen = new Map<string, string | undefined>()
  for (const set of effects) {
    for (const api of apiList(set)) {
      if (!seen.has(api)) seen.set(api, set.via.get(api))
    }
  }
  // A bare name (`fs`, `session`) says less than the member beside it (`fs.readFile`).
  const names = [...seen.keys()].filter((api) => ![...seen.keys()].some((other) => other.startsWith(`${api}.`)))
  return names.sort().map((api) => `${api}${seen.get(api) === undefined ? '' : ` (in ${seen.get(api) as string})`}`)
}

/** The suggestions for every member the clone's preload exposes. */
export async function suggest (clone: string, roots: Readonly<Record<string, string | undefined>>, called?: Readonly<Record<string, readonly string[]>>): Promise<SuggestionReport> {
  const preloadRoot = roots['preload']
  const mainRoot = roots['main']
  if (preloadRoot === undefined || mainRoot === undefined) {
    return { members: [], suggested: 0, limits: ['no preload or no main root was found, so there is no seam to read'] }
  }
  const universe = await Universe.load(clone, commonDirectory(preloadRoot, mainRoot))
  return suggestFrom(universe, preloadRoot, mainRoot, called)
}

/** `called` limits each global to the members the renderer calls, which are the ones a declaration lists. */
export function suggestFrom (universe: Universe, preloadRoot: string, mainRoot: string, called?: Readonly<Record<string, readonly string[]>>): SuggestionReport {
  const preloadFiles = under(universe.files, preloadRoot)
  const mainFiles = under(universe.files, mainRoot)
  const functions = universe.functionsIn(mainFiles)
  const handlers = handlersIn(universe, mainFiles, functions)
  const sends = new SendIndex(universe, mainFiles)
  const members = preloadMembers(universe, preloadFiles).filter((member) => {
    const names = called?.[member.global]
    return names === undefined || names.length === 0 || names.includes(member.member)
  })

  const handlerFor = (channel: Channel): { handler?: Handler; why?: string } => {
    const matching = handlers.filter((handler) => sameChannel(handler.channel, channel))
    const app = matching.filter((handler) => handler.scope === 'app')
    const pool = app.length > 0 ? app : matching
    if (pool.length === 0) return { why: 'no `ipcMain` handler for this channel was found' }
    return pool.length === 1 ? { handler: pool[0] as Handler } : { why: `${String(pool.length)} handlers answer this channel, so none is taken for it` }
  }
  const effectCache = new Map<Handler, Effects | undefined>()
  const effectsFor = (handler: Handler): Effects | undefined => {
    if (!effectCache.has(handler)) effectCache.set(handler, handler.fn === undefined ? undefined : effectsOf(handler.fn, functions))
    return effectCache.get(handler)
  }

  // First every member that is not a listener: a listener is inert when what main sends it for is a member that is refused.
  const refusedChannels: Channel[] = []
  const factsOf = (member: PreloadMember, withSends: boolean): { facts: MemberFacts; evidence: UseEvidence[]; effects: Effects[] } => {
    const preload = effectsOf({ source: member.source, node: member.node }, functions, 0)
    const effects = [preload]
    const evidence: UseEvidence[] = []
    const uses: UseFacts[] = member.uses.map((use) => {
      const { handler, why } = handlerFor(use.channel)
      const found = handler === undefined ? undefined : effectsFor(handler)
      evidence.push({
        kind: use.kind,
        channel: use.channel.name ?? use.channel.text,
        resolved: use.channel.name !== undefined,
        ...handler === undefined ? {} : { handler: `${handler.source.path}:${String(handler.line)}` }
      })
      if (found !== undefined) effects.push(found)
      const base = { kind: use.kind, channel: use.channel }
      const unread = why ?? (use.channel.name === undefined ? 'the channel is built at run time, so the handler matched by its text is not read'
        : handler?.fn === undefined ? 'the handler\'s callback is defined where this scan does not follow' : undefined)
      if (use.kind === 'on' || use.kind === 'once') {
        return use.channel.name !== undefined && withSends
          ? { ...base, sends: sends.verdict(use.channel, (channel) => refusedChannels.some((refused) => sameChannel(refused, channel))) }
          : base
      }
      if (unread !== undefined || handler?.fn === undefined || found === undefined) return { ...base, unread: unread ?? 'the handler was not read' }
      return { ...base, handler: { effects: found, ...optional('constant', constantReturn(handler.fn.node)), ...optional('storesOnly', stateOnly(handler.fn)) } }
    })
    return { facts: { uses, preload }, evidence, effects }
  }

  const firstPass = new Map<PreloadMember, Decision>()
  for (const member of members) {
    if (member.uses.some((use) => use.kind === 'on' || use.kind === 'once')) continue
    const { facts } = factsOf(member, false)
    const decision = decide(facts)
    firstPass.set(member, decision)
    if (decision.suggestion?.bucket === 'refused') refusedChannels.push(...member.uses.map((use) => use.channel))
  }

  const out: MemberSuggestion[] = members.map((member) => {
    const { facts, evidence, effects } = factsOf(member, true)
    const decision = firstPass.get(member) ?? decide(facts)
    return {
      global: member.global,
      member: member.member,
      at: `${member.source.path}:${String(member.line)}`,
      ipc: evidence,
      apis: describeApis(effects).slice(0, MAX_APIS),
      ...decision.suggestion === undefined ? {} : { suggestion: decision.suggestion },
      because: decision.because,
      notes: decision.notes
    }
  })
  return {
    members: out,
    suggested: out.filter((entry) => entry.suggestion !== undefined).length,
    limits: [
      'a handler callback or helper defined in another module, a channel built at run time and a preload object built by a factory call are not followed',
      'a member counted here is one the preload object spells out; spreads and computed keys are skipped'
    ]
  }
}

function optional<K extends string, V> (name: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : { [name]: value } as Record<K, V>
}

function label (suggestion: Suggestion): string {
  switch (suggestion.bucket) {
    case 'behaviours': return `behaviours.${suggestion.behaviour as string}${suggestion.role === undefined ? '' : `.${suggestion.role}`}`
    case 'refused': return `refused (${suggestion.refusal as string}${suggestion.detail === undefined ? '' : `: ${suggestion.detail}`})`
    case 'constants':
    case 'asyncConstants': return `${suggestion.bucket} = ${JSON.stringify(suggestion.value)}`
    default: return suggestion.bucket
  }
}

/** The "Suggested buckets" section of a recon report. */
export function formatSuggestions (report: SuggestionReport): string {
  const out = ['', '## Suggested buckets', '']
  if (report.members.length === 0) {
    out.push(`No member could be traced to a handler: ${report.limits.join('; ')}.`)
    return out.join('\n')
  }
  out.push(
    `${String(report.suggested)} of ${String(report.members.length)} members have a suggestion. Each is read from the Electron and Node APIs the member's`,
    '`ipcMain` handler calls, which mean the same in every app, and it is evidence for step 2, not an answer: `--emit` still writes every',
    'name as unclassified and the build refuses until a person has moved each one. Where the evidence is thin or mixed the answer is "none".', '')
  let current: string | undefined
  for (const entry of report.members) {
    if (entry.global !== current) {
      current = entry.global
      out.push(`### \`${entry.global}\` (${String(report.members.filter((other) => other.global === entry.global).length)} members)`, '')
    }
    out.push(`- \`${entry.member}\` -> ${entry.suggestion === undefined ? 'none' : `**${label(entry.suggestion)}**`}`)
    for (const use of entry.ipc) out.push(`  - ${use.kind} \`${use.channel}\`${use.resolved ? '' : ' (not resolved)'}${use.handler === undefined ? ', no handler found' : ` -> ${use.handler}`}`)
    if (entry.apis.length > 0) out.push(`  - APIs: ${entry.apis.join(', ')}`)
    out.push(`  - ${entry.suggestion === undefined ? 'why none' : 'why'}: ${entry.because}`)
    for (const note of entry.notes) out.push(`  - note: ${note}`)
  }
  out.push('', `Limits: ${report.limits.join('; ')}.`)
  return out.join('\n')
}
