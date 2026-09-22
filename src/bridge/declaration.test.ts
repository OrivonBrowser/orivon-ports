// Every case here is a declaration a person could plausibly write, and the
// point of each is the message: a member in the wrong bucket is otherwise a
// member that silently does the wrong thing inside somebody else's bundle.
import { describe, expect, it } from 'vitest'
import { parseDeclaration } from './declaration.ts'

const valid = {
  global: 'appApi',
  behaviours: { locale: 'getLocale' },
  listeners: { why: 'one window, nothing to sync with', members: ['onThing'] },
  hand: ['doTheThing']
}

function parse (overrides: Record<string, unknown>): unknown {
  return parseDeclaration({ ...valid, ...overrides }, 'members.json')
}

describe('the unclassified gate', () => {
  it('refuses the port while recon output has not been bucketed, and names what is left', () => {
    expect(() => parse({ unclassified: ['openInExternalPlayer', 'relaunch'] }))
      .toThrow(/2 member\(s\) have not been bucketed yet: openInExternalPlayer, relaunch/)
  })

  it('accepts an empty one, which is what a finished declaration has', () => {
    expect(() => parse({ unclassified: [] })).not.toThrow()
  })
})

describe('buckets', () => {
  it('refuses a member declared in two of them, naming both', () => {
    expect(() => parse({ noop: { why: 'no', members: ['onThing'] } }))
      .toThrow(/"onThing" is declared twice -- in listeners and in noop/)
  })

  it('refuses a member the app file would also supply', () => {
    expect(() => parse({ hand: ['onThing'] })).toThrow(/declared twice -- in listeners and in hand/)
  })

  it('refuses an unknown top-level field rather than ignoring it', () => {
    expect(() => parse({ inert: ['onThing'] })).toThrow(/is not a field here/)
  })

  it('refuses a group with no members instead of generating an empty object', () => {
    expect(() => parse({ noop: { why: 'no', members: [] } })).toThrow(/is empty -- delete the group/)
  })
})

describe('why', () => {
  it('is required on a constant, because the value alone does not say what it stands for', () => {
    expect(() => parse({ constants: { isWayland: { value: false } } }))
      .toThrow(/constants.isWayland.why: is required/)
  })

  it('is required on a refusal', () => {
    expect(() => parse({ refused: { relaunch: { reason: 'shell-owned' } } }))
      .toThrow(/refused.relaunch.why: is required/)
  })

  it('is required on a group', () => {
    expect(() => parse({ noop: { members: ['setThing'] } })).toThrow(/noop.why: is required/)
  })
})

describe('refusals', () => {
  it('refuses a reason outside the closed set', () => {
    expect(() => parse({ refused: { relaunch: { reason: 'later', why: 'x' } } }))
      .toThrow(/must be one of: excluded, shell-owned, not-built -- got "later"/)
  })

  it('takes the three real ones', () => {
    for (const reason of ['excluded', 'shell-owned', 'not-built']) {
      expect(() => parse({ refused: { relaunch: { reason, why: 'x' } } })).not.toThrow()
    }
  })
})

describe('behaviours', () => {
  it('refuses an id the kit does not have, and lists the ones it does', () => {
    expect(() => parse({ behaviours: { clipboard: 'readText' } }))
      .toThrow(/is not a behaviour this kit has -- known: fullscreen, pictureInPicture/)
  })

  it('refuses a bare name for a behaviour that installs more than one member', () => {
    expect(() => parse({ behaviours: { wakeLock: 'keepAwake' } }))
      .toThrow(/installs 2 members \(acquire, release\), so it needs an object/)
  })

  it('refuses a half-declared multi-member behaviour', () => {
    expect(() => parse({ behaviours: { wakeLock: { acquire: 'keepAwake' } } }))
      .toThrow(/behaviours.wakeLock.release: is required/)
  })

  it('refuses a role the behaviour does not have', () => {
    expect(() => parse({ behaviours: { wakeLock: { acquire: 'a', release: 'b', renew: 'c' } } }))
      .toThrow(/behaviours.wakeLock.renew: is not a field here/)
  })
})

describe('shape', () => {
  it('refuses a global that is not a name a page could carry', () => {
    expect(() => parse({ global: 'window.app' })).toThrow(/must be a name the preload exposed/)
  })

  it('refuses a member name that is not an identifier', () => {
    expect(() => parse({ hand: ['do the thing'] })).toThrow(/must be a member name the app actually calls/)
  })

  it('refuses a declaration that installs nothing at all', () => {
    expect(() => parseDeclaration({ global: 'appApi' }, 'members.json')).toThrow(/declares no members at all/)
  })
})

describe('the two forms', () => {
  const globals = { globals: { apiOne: { hand: ['doIt'] }, apiTwo: { hand: ['doIt'] } } }

  it('takes one bucket set per global, and the same member name on each', () => {
    expect(() => parseDeclaration(globals, 'members.json')).not.toThrow()
  })

  it('refuses both forms at once, rather than merging them', () => {
    expect(() => parseDeclaration({ ...globals, global: 'appApi' }, 'members.json'))
      .toThrow(/cannot sit beside "globals" -- use one form or the other/)
  })

  it('refuses a bucket left at the top level beside globals, naming where it belongs', () => {
    expect(() => parseDeclaration({ ...globals, noop: { why: 'x', members: ['a'] } }, 'members.json'))
      .toThrow(/belongs inside a global when "globals" is used -- move it under globals.<name>.noop/)
  })

  it('refuses an empty globals map', () => {
    expect(() => parseDeclaration({ globals: {} }, 'members.json')).toThrow(/is empty -- members.json would install nothing/)
  })

  it('scopes duplicate detection to one global, and still catches a real duplicate inside one', () => {
    expect(() => parseDeclaration({ globals: { apiOne: { noop: { why: 'x', members: ['get'] }, hand: ['get'] } } }, 'members.json'))
      .toThrow(/globals.apiOne: "get" is declared twice -- in noop and in hand/)
  })
})
