import { describe, expect, it } from 'vitest'
import { ZERO_ADDRESS } from '../site/sdk/abi.js'
import { keyOf } from '../site/resolver/og-name.js'
import { WRAPPER } from '../site/resolver/og-pins.js'
import { checkAdded, readHints, readWrappedTokens } from '../site/names-reads.js'
import { ACCOUNT, RIVAL } from './support/linagee-world.ts'
import { harness } from './support/manage-harness.ts'

const key = (label: string) => keyOf(label)
/** A wrapper holding tokens: id to label, and who holds each. */
function holding (tokens: Record<string, [string, string]>) {
  const idToName: Record<string, string> = {}
  const tokenOwner: Record<string, string> = {}
  const nameToId: Record<string, bigint> = {}
  const owner: Record<string, string> = {}
  for (const [id, [label, holder]] of Object.entries(tokens)) {
    idToName[id] = key(label)
    tokenOwner[id] = holder
    nameToId[key(label)] = BigInt(id)
    owner[key(label)] = WRAPPER
  }
  return { idToName, tokenOwner, nameToId, owner }
}

describe('readWrappedTokens', () => {
  it('lists the tokens an account holds with the name of each, and none of another account\'s', async () => {
    const made = harness(holding({ 5: ['harbor', ACCOUNT], 6: ['lantern', RIVAL], 9: ['日本語', ACCOUNT] }))
    const read = await readWrappedTokens(made.chain, ACCOUNT)
    expect(read).toMatchObject({ total: 2, unreadable: 0, left: 0 })
    expect(read.tokens).toEqual([{ label: 'harbor', tokenId: '5' }, { label: '日本語', tokenId: '9' }])
  })

  it('answers nothing for an account that holds none', async () => {
    const read = await readWrappedTokens(harness(holding({ 5: ['harbor', RIVAL] })).chain, ACCOUNT)
    expect(read).toMatchObject({ total: 0, tokens: [], unreadable: 0, left: 0 })
  })

  it('reads at most the limit, and says how many it left out', async () => {
    const tokens = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [String(index + 1), [`name${index}`, ACCOUNT] as [string, string]]))
    const read = await readWrappedTokens(harness(holding(tokens)).chain, ACCOUNT, { limit: 3 })
    expect(read.tokens.map((token) => token.label)).toEqual(['name0', 'name1', 'name2'])
    expect(read).toMatchObject({ total: 5, left: 2 })
  })

  it('counts a token whose name is not text as one it cannot show, and keeps the rest', async () => {
    const world = holding({ 5: ['harbor', ACCOUNT], 6: ['x', ACCOUNT] })
    world.idToName['6'] = `0x${'ff'.repeat(32)}`
    const read = await readWrappedTokens(harness(world).chain, ACCOUNT)
    expect(read.tokens).toEqual([{ label: 'harbor', tokenId: '5' }])
    expect(read.unreadable).toBe(1)
  })
})

describe('readHints', () => {
  it('names the primary name and the registry\'s name for the account, each once and only as text', async () => {
    const made = harness({ primary: { [ACCOUNT.toLowerCase()]: key('harbor') }, registryName: { [ACCOUNT.toLowerCase()]: key('lantern') } })
    expect(await readHints(made.chain, ACCOUNT)).toEqual(['harbor', 'lantern'])
    const same = harness({ primary: { [ACCOUNT.toLowerCase()]: key('harbor') }, registryName: { [ACCOUNT.toLowerCase()]: key('harbor') } })
    expect(await readHints(same.chain, ACCOUNT)).toEqual(['harbor'])
    expect(await readHints(harness().chain, ACCOUNT)).toEqual([])
  })
})

describe('checkAdded', () => {
  it('finds a name held unwrapped, one the wrapper waits to finish, one already listed, a free one and another account\'s', async () => {
    const made = harness({
      owner: { [key('mine')]: ACCOUNT, [key('stuck')]: WRAPPER, [key('theirs')]: RIVAL, ...holding({ 5: ['token', ACCOUNT] }).owner },
      waitForWrap: { [key('stuck')]: ACCOUNT }, ...(({ idToName, tokenOwner, nameToId }) => ({ idToName, tokenOwner, nameToId }))(holding({ 5: ['token', ACCOUNT] }))
    })
    expect((await checkAdded(made.chain, 'mine', ACCOUNT)).kind).toBe('added')
    expect((await checkAdded(made.chain, 'stuck', ACCOUNT)).kind).toBe('finish')
    expect((await checkAdded(made.chain, 'token', ACCOUNT)).kind).toBe('listed')
    expect((await checkAdded(made.chain, 'nobody', ACCOUNT)).kind).toBe('free')
    expect((await checkAdded(made.chain, 'theirs', ACCOUNT)).kind).toBe('theirs')
  })

  it('reads the account\'s primary name with the facts, so the list can say it', async () => {
    const made = harness({ owner: { [key('mine')]: ACCOUNT }, primary: { [ACCOUNT.toLowerCase()]: key('mine') }, resolveAddress: { [key('mine')]: ACCOUNT } })
    const found = await checkAdded(made.chain, 'mine', ACCOUNT)
    expect(found.facts.primary).toBe(key('mine'))
    expect(found.facts.resolvesTo).toBe(ACCOUNT)
    expect(found.facts.controller).toBe(ZERO_ADDRESS)
  })
})
