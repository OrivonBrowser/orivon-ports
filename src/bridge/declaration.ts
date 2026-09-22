// `apps/<id>/bridge/members.json`: the one file a person writes to say what a
// preload exposed and why each member is answered the way it is. Everything
// here is checked, and every rejection names the member -- a wrong bucket is
// otherwise a member that silently does the wrong thing at a call site deep
// in somebody else's bundle.

import { CATALOG, SINGLE_ROLE } from './catalog.ts'

export class DeclarationError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'DeclarationError'
  }
}

/** Why a member will never work. Closed, because a porting developer branches on it and a reader believes it. */
export type RefusalReason = 'excluded' | 'shell-owned' | 'not-built'

export const REFUSAL_REASONS: readonly RefusalReason[] = ['excluded', 'shell-owned', 'not-built']

export interface NamedGroup {
  readonly why: string
  readonly members: readonly string[]
}

export interface ValueMember {
  readonly value: unknown
  readonly why: string
}

export interface RefusedMember {
  readonly reason: RefusalReason
  readonly detail?: string
  readonly why: string
}

/** One global's members. A preload that exposed several publishes one of these per name. */
export interface Buckets {
  /** Behaviour id -> role -> the app's own name for that member. */
  readonly behaviours: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly listeners?: NamedGroup
  readonly noop?: NamedGroup
  readonly constants: Readonly<Record<string, ValueMember>>
  readonly asyncConstants: Readonly<Record<string, ValueMember>>
  readonly refused: Readonly<Record<string, RefusedMember>>
  /** The members the app's own bridge file supplies for this global. The installer requires exactly these, no more and no fewer. */
  readonly hand: readonly string[]
}

export interface Declaration {
  /** Global name -> its members, in declaration order. The `global` form produces exactly one entry. */
  readonly globals: Readonly<Record<string, Buckets>>
  /** Whether the one-global form was used. It decides what `appMembers` returns: a flat member map, or one keyed by global. */
  readonly single: boolean
}

const BUCKET_KEYS = ['behaviours', 'listeners', 'noop', 'constants', 'asyncConstants', 'refused', 'hand']
const TOP_LEVEL_KEYS = ['global', 'globals', ...BUCKET_KEYS, 'unclassified']
const GROUP_KEYS = ['why', 'members']
const VALUE_KEYS = ['value', 'why']
const REFUSED_KEYS = ['reason', 'detail', 'why']

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function fail (where: string, why: string): never {
  throw new DeclarationError(`${where}: ${why}`)
}

function object (value: unknown, where: string, allowed?: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(where, 'must be an object')
  const record = value as Record<string, unknown>
  if (allowed !== undefined) {
    for (const key of Object.keys(record)) {
      if (!allowed.includes(key)) fail(`${where}.${key}`, `is not a field here -- expected one of: ${allowed.join(', ')}`)
    }
  }
  return record
}

function why (record: Record<string, unknown>, where: string): string {
  const value = record['why']
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${where}.why`, 'is required -- a generated member still has to say why it is answered this way, because the comments are the deliverable')
  }
  return value
}

function memberName (value: unknown, where: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    fail(where, `must be a member name the app actually calls, not ${JSON.stringify(value)}`)
  }
  return value
}

function names (value: unknown, where: string): string[] {
  if (!Array.isArray(value)) fail(where, 'must be an array of member names')
  return value.map((entry, index) => memberName(entry, `${where}[${String(index)}]`))
}

function group (value: unknown, where: string): NamedGroup {
  const record = object(value, where, GROUP_KEYS)
  const members = names(record['members'], `${where}.members`)
  if (members.length === 0) fail(`${where}.members`, 'is empty -- delete the group instead of declaring an empty one')
  return { why: why(record, where), members }
}

function valueMembers (value: unknown, where: string): Record<string, ValueMember> {
  const record = object(value, where)
  const built: Record<string, ValueMember> = {}
  for (const [name, entry] of Object.entries(record)) {
    memberName(name, `${where}.${name}`)
    const fields = object(entry, `${where}.${name}`, VALUE_KEYS)
    if (!('value' in fields)) fail(`${where}.${name}.value`, 'is required -- a constant with no value is a member that returns undefined by accident')
    built[name] = { value: fields['value'], why: why(fields, `${where}.${name}`) }
  }
  return built
}

function refusedMembers (value: unknown, where: string): Record<string, RefusedMember> {
  const record = object(value, where)
  const built: Record<string, RefusedMember> = {}
  for (const [name, entry] of Object.entries(record)) {
    memberName(name, `${where}.${name}`)
    const fields = object(entry, `${where}.${name}`, REFUSED_KEYS)
    const reason = fields['reason']
    if (typeof reason !== 'string' || !REFUSAL_REASONS.includes(reason as RefusalReason)) {
      fail(`${where}.${name}.reason`, `must be one of: ${REFUSAL_REASONS.join(', ')} -- got ${JSON.stringify(reason)}`)
    }
    const detail = fields['detail']
    if (detail !== undefined && (typeof detail !== 'string' || detail.trim() === '')) {
      fail(`${where}.${name}.detail`, 'must be a non-empty string when present')
    }
    built[name] = {
      reason: reason as RefusalReason,
      ...(detail === undefined ? {} : { detail: detail as string }),
      why: why(fields, `${where}.${name}`)
    }
  }
  return built
}

/**
 * A behaviour is declared by its catalog id, and named by the app. One role
 * takes a bare string; more than one takes a role -> name object, with every
 * role present -- a half-declared wakeLock is a page that acquires one and
 * never releases it.
 */
function behaviours (value: unknown, where: string): Record<string, Record<string, string>> {
  const record = object(value, where)
  const built: Record<string, Record<string, string>> = {}
  for (const [id, entry] of Object.entries(record)) {
    const spec = CATALOG[id]
    if (spec === undefined) {
      fail(`${where}.${id}`, `is not a behaviour this kit has -- known: ${Object.keys(CATALOG).join(', ')}. A behaviour is added to src/bridge/ when a real port needs it`)
    }
    if (typeof entry === 'string') {
      if (spec.roles.length !== 1) {
        fail(`${where}.${id}`, `installs ${String(spec.roles.length)} members (${spec.roles.join(', ')}), so it needs an object naming each one, not a single name`)
      }
      built[id] = { [SINGLE_ROLE]: memberName(entry, `${where}.${id}`) }
      continue
    }
    const roles = object(entry, `${where}.${id}`, spec.roles)
    const filled: Record<string, string> = {}
    for (const role of spec.roles) {
      if (roles[role] === undefined) fail(`${where}.${id}.${role}`, `is required -- ${id} installs one member per role (${spec.roles.join(', ')})`)
      filled[role] = memberName(roles[role], `${where}.${id}.${role}`)
    }
    built[id] = filled
  }
  return built
}

/**
 * Every member one global installs, with the bucket it came from. Two buckets
 * answering one member is two different behaviours, and which one wins would
 * be whichever the installer happened to merge last -- so it is refused here
 * instead. Names are scoped to their own global: two globals may both have a
 * `get`, and often do.
 */
export function memberSources (buckets: Buckets, where: string): Map<string, string> {
  const sources = new Map<string, string>()
  const claim = (name: string, bucket: string): void => {
    const already = sources.get(name)
    if (already !== undefined) {
      throw new DeclarationError(`${where}: "${name}" is declared twice -- in ${already} and in ${bucket}. One member, one answer`)
    }
    sources.set(name, bucket)
  }

  for (const [id, roles] of Object.entries(buckets.behaviours)) {
    for (const [role, name] of Object.entries(roles)) claim(name, `behaviours.${id}.${role}`)
  }
  for (const name of buckets.listeners?.members ?? []) claim(name, 'listeners')
  for (const name of buckets.noop?.members ?? []) claim(name, 'noop')
  for (const name of Object.keys(buckets.constants)) claim(name, 'constants')
  for (const name of Object.keys(buckets.asyncConstants)) claim(name, 'asyncConstants')
  for (const name of Object.keys(buckets.refused)) claim(name, 'refused')
  for (const name of buckets.hand) claim(name, 'hand')
  return sources
}

/** Every member across every global, for a count or a roster. */
export function allMembers (declaration: Declaration): number {
  let total = 0
  for (const buckets of Object.values(declaration.globals)) total += memberSources(buckets, '').size
  return total
}

function parseBuckets (record: Record<string, unknown>, at: string): Buckets {
  return {
    behaviours: record['behaviours'] === undefined ? {} : behaviours(record['behaviours'], `${at}behaviours`),
    ...(record['listeners'] === undefined ? {} : { listeners: group(record['listeners'], `${at}listeners`) }),
    ...(record['noop'] === undefined ? {} : { noop: group(record['noop'], `${at}noop`) }),
    constants: record['constants'] === undefined ? {} : valueMembers(record['constants'], `${at}constants`),
    asyncConstants: record['asyncConstants'] === undefined ? {} : valueMembers(record['asyncConstants'], `${at}asyncConstants`),
    refused: record['refused'] === undefined ? {} : refusedMembers(record['refused'], `${at}refused`),
    hand: record['hand'] === undefined ? [] : names(record['hand'], `${at}hand`)
  }
}

function globalName (value: unknown, where: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    fail(where, `must be a name the preload exposed, e.g. "ftElectron" -- got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Two forms, and never both. A preload that exposed one name uses `global`
 * with the buckets beside it; one that exposed several -- ASGARDEX exposes
 * fourteen -- uses `globals`, one bucket set per name. Mixing them would make
 * "which members belong to which object" depend on where a key happened to
 * sit.
 */
function parseGlobals (record: Record<string, unknown>, at: string, sourcePath: string): { globals: Record<string, Buckets>, single: boolean } {
  const many = record['globals']
  if (many === undefined) {
    return { globals: { [globalName(record['global'], `${at}global`)]: parseBuckets(record, at) }, single: true }
  }

  if (record['global'] !== undefined) fail(`${at}global`, 'cannot sit beside "globals" -- use one form or the other')
  for (const key of BUCKET_KEYS) {
    if (record[key] !== undefined) fail(`${at}${key}`, `belongs inside a global when "globals" is used -- move it under globals.<name>.${key}`)
  }

  const record2 = object(many, `${at}globals`)
  const globals: Record<string, Buckets> = {}
  for (const [name, buckets] of Object.entries(record2)) {
    globalName(name, `${at}globals.${name}`)
    const inner = object(buckets, `${at}globals.${name}`, [...BUCKET_KEYS, 'unclassified'])
    checkUnclassified(inner, `${at}globals.${name}.`)
    globals[name] = parseBuckets(inner, `${at}globals.${name}.`)
  }
  if (Object.keys(globals).length === 0) fail(`${at}globals`, `is empty -- ${sourcePath} would install nothing`)
  return { globals, single: false }
}

/**
 * `orivon-port recon --emit` writes every member it found here, and this is
 * what refuses the port until a person has moved each one into a bucket. It
 * sits at the top level in the one-global form and inside each global in the
 * other, so a fourteen-global app can be bucketed a few globals at a time.
 */
function checkUnclassified (record: Record<string, unknown>, where: string): void {
  if (record['unclassified'] === undefined) return
  const left = names(record['unclassified'], `${where}unclassified`)
  if (left.length === 0) return
  fail(`${where}unclassified`, `${String(left.length)} member(s) have not been bucketed yet: ${left.join(', ')}. Each one is a decision only a person can make -- docs/porting-guide.md step 2`)
}

export function parseDeclaration (value: unknown, sourcePath: string): Declaration {
  const at = `${sourcePath} `
  const record = object(value, sourcePath, TOP_LEVEL_KEYS)
  checkUnclassified(record, at)

  const declaration: Declaration = parseGlobals(record, at, sourcePath)

  let total = 0
  for (const [name, buckets] of Object.entries(declaration.globals)) {
    total += memberSources(buckets, `${at}${declaration.single ? '' : `globals.${name}`}`).size
  }
  if (total === 0) {
    fail(sourcePath, 'declares no members at all -- `orivon-port recon <clone> --emit <app>` writes the list, and docs/porting-guide.md step 2 is how each one gets a bucket')
  }
  return declaration
}
