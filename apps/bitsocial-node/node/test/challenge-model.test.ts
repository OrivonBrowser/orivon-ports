// A board's challenges as the dashboard edits them: a form for each bundled challenge built from the options it declares (the required
// ones prefilled with their defaults), the entries written back in the shape pkc-js 0.0.132 parses (held against its own schema), the order
// and the excludes that follow it, the host a challenge reaches, and the lines that say what an apply changes.
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { changesOf, entriesOf, moveRow, newRow, optionFields, removeRow, rowOf } from '../../page/dashboard/challenge-model.js'
import { asksOf, hostLine, shortName } from '../../page/dashboard/challenge-words.js'
import { BUNDLED, describeChallenges, OWN, registerChallenges } from '../worker/challenges.js'
import { ETH_RPC_URLS } from '../worker/eth-providers.js'

const SCHEMA = new URL('../node_modules/@pkcprotocol/pkc-js/dist/node/community/schema.js', import.meta.url)
const schema = await import(pathToFileURL(SCHEMA.pathname).href) as { CommunityChallengeSettingSchema: { safeParse: (value: unknown) => { success: boolean, error?: { message: string } } } }
const parses = (entry: unknown) => schema.CommunityChallengeSettingSchema.safeParse(entry)

const registry: Record<string, unknown> = { 'text-math': () => ({ description: 'Ask a math question.', type: 'text/plain', optionInputs: [{ option: 'difficulty', label: 'Difficulty', default: 'easy' }] }) }
registerChallenges(registry)
const list = describeChallenges(registry, { filesDir: '/app/files' })
const infos = new Map<string, any>(list.challenges.map((one) => [one.name, one]))
const info = (short: string) => infos.get(`@bitsocial/${short}-challenge`)!
const ORIVON_ID_NAME = OWN[0]!.name
const BOARD = { board: 'board', boards: 'boards', Board: 'Board', Boards: 'Boards' }
const WORDS = '[{"src":"cloud","dst":"butt"}]'

describe('the form of each bundled challenge', () => {
  it.each(BUNDLED.map((one) => [one.name] as const))('%s has one field for each option it declares, in its order, with its own words', (name) => {
    const one = infos.get(name)!
    const fields = optionFields(newRow(one, 'n1'), one)
    expect(fields.map((field: any) => field.option)).toEqual(one.optionInputs.map((input: any) => input.option))
    for (const [index, input] of one.optionInputs.entries()) {
      expect(fields[index]).toMatchObject({ label: input.label, required: input.required === true, placeholder: input.placeholder ?? '' })
    }
  })

  it('fills the options marked required with their defaults, and leaves the others empty with the default shown beside them', () => {
    for (const one of infos.values()) {
      const fields = optionFields(newRow(one, 'n1'), one)
      for (const field of fields as any[]) {
        if (field.required) expect(field.value, `${one.name} ${field.option}`).toBe(field.suggested ?? field.default)
        else expect(field.value, `${one.name} ${field.option}`).toBe('')
      }
    }
    const evm = optionFields(newRow(info('evm-contract'), 'n1'), info('evm-contract')) as any[]
    expect(evm.find((field) => field.option === 'chainTicker').value).toBe('eth')
    expect(evm.find((field) => field.option === 'address').value).toBe('')
    const r9k = optionFields(newRow(info('r9k'), 'n1'), info('r9k')) as any[]
    expect(r9k.find((field) => field.option === 'minimumOriginalContentLength').value).toBe('16')
  })

  it('puts the one file r9k writes under the app\'s files, where the Worker says to, and not in a home folder', () => {
    const fields = optionFields(newRow(info('r9k'), 'n1'), info('r9k')) as any[]
    expect(fields.find((field) => field.option === 'statePath').value).toBe('/app/files/challenges/r9k-state.json')
  })

  it('draws a true-or-false option as a choice, a key as a hidden value, JSON as a box, and the rest as a line', () => {
    const kinds = (short: string) => Object.fromEntries((optionFields(newRow(info(short), 'n1'), info(short)) as any[]).map((field) => [field.option, field.kind]))
    expect(kinds('flags')['requireFlag']).toBe('boolean')
    expect(kinds('flags')['allowedFlags']).toBe('text')
    expect(kinds('ai-moderation')['apiKey']).toBe('secret')
    expect(kinds('ai-moderation')['promptBearerToken']).toBe('secret')
    expect(kinds('wordfilter')['wordfilter/v1/rules']).toBe('multiline')
    expect(kinds('captcha-canvas')['characters']).toBe('text')
  })

  it('offers to publish an option, ticked for the wordfilter contract\'s rules and never for a credential or a list of RPC URLs', () => {
    const wordfilter = optionFields(newRow(info('wordfilter'), 'n1'), info('wordfilter')) as any[]
    expect(wordfilter.find((field) => field.option === 'wordfilter/v1/rules')).toMatchObject({ publishable: true, publish: true })
    expect(wordfilter.find((field) => field.option === 'error')).toMatchObject({ publishable: true, publish: false })
    const ai = optionFields(newRow(info('ai-moderation'), 'n1'), info('ai-moderation')) as any[]
    expect(ai.filter((field) => !field.publishable).map((field) => field.option).sort()).toEqual(['apiKey', 'jevApiKey', 'promptBearerToken', 'triageApiKey'])
    const evm = optionFields(newRow(info('evm-contract'), 'n1'), info('evm-contract')) as any[]
    expect(evm.find((field) => field.option === 'rpcUrls').publishable).toBe(false)
  })
})

describe('the entry a new challenge is written as', () => {
  it('is the name, the options that have a value and the options to publish, which pkc-js accepts', () => {
    const row = newRow(info('wordfilter'), 'n1')
    row.options['wordfilter/v1/rules'] = WORDS
    const { entries, errors } = entriesOf([row], infos)
    expect(errors).toEqual({})
    expect(entries).toEqual([{ name: '@bitsocial/wordfilter-challenge', options: { 'wordfilter/v1/rules': WORDS }, publicOptions: ['wordfilter/v1/rules'] }])
    expect(parses(entries[0]).success).toBe(true)
  })

  it('leaves an option out when it is empty and not required, and writes no options at all for a challenge that sets none', () => {
    const { entries } = entriesOf([newRow(info('base64'), 'n1')], infos)
    expect(entries).toEqual([{ name: '@bitsocial/base64-challenge' }])
    expect(parses(entries[0]).success).toBe(true)
  })

  it('writes the board\'s own description and the hold for a moderator\'s approval when they are set', () => {
    const row = newRow(info('base64'), 'n1')
    row.description = 'No pasted images, please link them'
    row.pendingApproval = true
    expect(entriesOf([row], infos).entries[0]).toEqual({ name: '@bitsocial/base64-challenge', description: 'No pasted images, please link them', pendingApproval: true })
  })

  it('refuses a required option with no value, naming it, and a value that must be JSON and is not', () => {
    const evm = newRow(info('evm-contract'), 'n1')
    const wordfilter = newRow(info('wordfilter'), 'n2')
    wordfilter.options['wordfilter/v1/rules'] = '[{"src":'
    const { errors } = entriesOf([evm, wordfilter], infos)
    expect(Object.keys(errors['n1']!.options).sort()).toEqual(['abi', 'address', 'condition'])
    expect(errors['n1']!.options['address']).toMatch(/required/i)
    expect(errors['n2']!.options['wordfilter/v1/rules']).toMatch(/JSON/)
  })

  it('writes a full set of an evm-contract\'s options, which pkc-js accepts', () => {
    const row = newRow(info('evm-contract'), 'n1')
    Object.assign(row.options, { address: '0x0000000000000000000000000000000000000001', abi: '{"constant":true}', condition: '>1000', rpcUrls: 'https://rpc.example.org' })
    const { entries, errors } = entriesOf([row], infos)
    expect(errors).toEqual({})
    expect(parses(entries[0]).success).toBe(true)
    expect(entries[0]!.options).toMatchObject({ chainTicker: 'eth', condition: '>1000' })
    expect(entries[0]!.publicOptions).toBeUndefined()
  })
})

describe('the challenges a board has', () => {
  const board = [
    { name: '@bitsocial/wordfilter-challenge', options: { 'wordfilter/v1/rules': WORDS }, publicOptions: ['wordfilter/v1/rules'], exclude: [{ roles: ['moderator'] }] },
    { name: 'text-math', options: { difficulty: 'hard' }, exclude: [{ challenges: [0] }, { postScore: 5 }], description: 'A sum', pendingApproval: true },
    { name: '@bitsocial/mintpass-challenge', options: { anything: 'kept' } },
    { path: '/home/someone/my-challenge.js', options: { a: 'b' } },
    { name: '@bitsocial/base64-challenge', options: { maxLength: '100', notDeclared: 'x' }, exclude: [{ roles: ['owner'], futureField: 1 }] }
  ]
  const rows = () => board.map((entry, index) => rowOf(entry, `b${String(index)}`))

  it('comes back as it was when nobody changed it, the entries of challenges this node does not have and of a file path included', () => {
    const { entries, errors } = entriesOf(rows(), infos)
    expect(errors).toEqual({})
    expect(entries).toEqual(board)
  })

  it('keeps an option the challenge does not declare, so nothing is dropped without being asked', () => {
    const row = rows()[4]!
    expect((optionFields(row, info('base64')) as any[]).map((field) => field.option)).toEqual(['maxLength', 'error'])
    expect(entriesOf([row], infos).entries[0]!.options).toEqual({ maxLength: '100', notDeclared: 'x' })
  })

  it('writes a change to one option and leaves every other entry as it was', () => {
    const all = rows()
    all[4]!.options['maxLength'] = '200'
    const { entries } = entriesOf(all, infos)
    expect(entries.slice(0, 4)).toEqual(board.slice(0, 4))
    expect(entries[4]!.options).toEqual({ maxLength: '200', notDeclared: 'x' })
  })

  it('moves a challenge up and down, never past either end, and the excludes that name a challenge by its place follow it', () => {
    const all = rows()
    const up = moveRow(all, 'b1', -1)
    expect(up.map((row: any) => row.key)).toEqual(['b1', 'b0', 'b2', 'b3', 'b4'])
    expect(moveRow(up, 'b1', -1).map((row: any) => row.key)).toEqual(['b1', 'b0', 'b2', 'b3', 'b4'])
    expect(moveRow(all, 'b4', 1).map((row: any) => row.key)).toEqual(['b0', 'b1', 'b2', 'b3', 'b4'])
    const { entries } = entriesOf(up, infos)
    expect(entries.map((entry: any) => entry.name ?? entry.path)).toEqual(['text-math', '@bitsocial/wordfilter-challenge', '@bitsocial/mintpass-challenge', '/home/someone/my-challenge.js', '@bitsocial/base64-challenge'])
    expect(entries[0]!.exclude).toEqual([{ challenges: [1] }, { postScore: 5 }])
  })

  it('removes a challenge, shifts the places the excludes name, and drops a rule that only existed for the one removed', () => {
    const { entries, dropped } = entriesOf(removeRow(rows(), 'b0'), infos)
    expect(entries.map((entry: any) => entry.name ?? entry.path)).toEqual(['text-math', '@bitsocial/mintpass-challenge', '/home/someone/my-challenge.js', '@bitsocial/base64-challenge'])
    expect(entries[0]!.exclude).toEqual([{ postScore: 5 }])
    expect(dropped).toEqual([{ key: 'b1', count: 1 }])
  })

  it('adds a challenge at the end', () => {
    const all = [...rows(), newRow(info('voucher'), 'n7')]
    all[5]!.options['vouchers'] = 'A1,B2'
    const { entries } = entriesOf(all, infos)
    expect(entries).toHaveLength(6)
    expect(entries[5]).toEqual({ name: '@bitsocial/voucher-challenge', options: { vouchers: 'A1,B2' } })
  })

  it('writes an exclude the form made, and says which rule of which challenge is refused', () => {
    const all = rows()
    all[0]!.excludes.push({ raw: undefined, texts: { ...all[0]!.excludes[0]!.texts, roles: [], postCount: 'many' } })
    const { errors } = entriesOf(all, infos)
    expect(errors['b0']!.excludes[1]!['postCount']).toMatch(/whole number/i)
  })
})

describe('what a challenge says it asks, and the host it reaches', () => {
  it('shortens a package name and keeps any other', () => {
    expect(shortName('@bitsocial/wordfilter-challenge')).toBe('wordfilter')
    expect(shortName('text-math')).toBe('text-math')
    expect(shortName('@bitsocial/captcha-canvas-challenge')).toBe('captcha-canvas')
    expect(shortName('@orivon/id-challenge')).toBe('Orivon ID')
  })

  it('says what a poster is asked in the node\'s words, and falls back to the challenge\'s own description', () => {
    expect(asksOf(info('captcha-canvas'))).toMatch(/picture/i)
    expect(asksOf(info('wordfilter'))).toMatch(/nothing/i)
    expect(asksOf(infos.get('text-math'))).toBe('Ask a math question.')
    for (const one of BUNDLED) expect(asksOf(infos.get(one.name)).length, one.name).toBeGreaterThan(10)
  })

  it('names the host in one line, the one the options say and not the default when they set another', () => {
    const tail = ': an ordinary web server, which counts as a Level 1 (Web2) connection for the Web3 Score.'
    expect(hostLine(info('spam-blocker'), {})).toBe(`Connects to spamblocker.bitsocial.net${tail}`)
    expect(hostLine(info('spam-blocker'), { serverUrl: 'https://my.example.org/api/v1' })).toBe(`Connects to my.example.org${tail}`)
    expect(hostLine(info('flags'), {})).toBe(`Connects to flags.5chan.app${tail}`)
    expect(hostLine(info('ai-moderation'), {})).toBe(`Connects to api.openai.com and api.typesafe.ai${tail}`)
    expect(hostLine(info('evm-contract'), {})).toBe(`Connects to ethereum.reth.rs by default (name RPC URLs to choose others)${tail}`)
    expect(hostLine(info('evm-contract'), { rpcUrls: 'https://a.example.com/x, https://b.example.com' })).toBe(`Connects to a.example.com and b.example.com${tail}`)
  })

  describe('the evm-contract challenge, when its owner named no server', () => {
    const tail = ': an ordinary web server, which counts as a Level 1 (Web2) connection for the Web3 Score.'
    const evm = () => info('evm-contract')
    const LIGHT = { path: 'light-client', lightClient: 3, public: 0 }
    const LIGHT_LINE = 'Connects to your browser\'s light client for Ethereum by default (name RPC URLs to choose others): it checks each answer, and a public server is asked only for what it cannot answer.'
    const VIEM_LINE = `Connects to ethereum.reth.rs by default (name RPC URLs to choose others)${tail}`

    it('names the browser\'s light client, and no server, when the node reads Ethereum through it', () => {
      expect(hostLine(evm(), {}, LIGHT)).toBe(LIGHT_LINE)
      expect(hostLine(evm(), { chainTicker: 'eth' }, LIGHT)).toBe(LIGHT_LINE)
      expect(hostLine(evm(), { chainTicker: ' ETH ', rpcUrls: '  ' }, LIGHT)).toBe(LIGHT_LINE)
      expect(hostLine(evm(), { chainTicker: 'eth' }, LIGHT)).not.toMatch(/reth\.rs|merkle|Level 1/)
    })

    it('names the server its own library names when the browser has no light client for apps (v0.1.0), and when the node does not say', () => {
      expect(hostLine(evm(), {}, { path: 'public', why: 'unsupported' })).toBe(VIEM_LINE)
      expect(hostLine(evm(), {}, undefined)).toBe(VIEM_LINE)
      expect(hostLine(evm(), {}, null)).toBe(VIEM_LINE)
      expect(hostLine(evm(), {}, {})).toBe(VIEM_LINE)
      expect(hostLine(evm(), {}, { path: 'none' })).toBe(VIEM_LINE)
    })

    it('says public servers are used until the person answers the browser\'s question, and while the light client is off or not answering', () => {
      expect(hostLine(evm(), {}, { path: 'asking', lightClient: 0, public: 0 }))
        .toBe(`Connects to public Ethereum servers by default until you answer your browser's question about its light client, which then reads Ethereum instead (name RPC URLs to choose others)${tail}`)
      for (const why of ['no-handle', 'denied', 'closed', 'unavailable', 'timeout', 'not-asked', 'something-new']) {
        expect(hostLine(evm(), {}, { path: 'public', why, lightClient: 0, public: 2 }), why)
          .toBe(`Connects to public Ethereum servers by default, because your browser's light client is off, was not allowed for this app or did not answer (name RPC URLs to choose others)${tail}`)
      }
    })

    it('names the hosts its owner chose, whichever way the node reads Ethereum', () => {
      const options = { rpcUrls: 'https://a.example.com/x, https://b.example.com' }
      for (const reads of [LIGHT, { path: 'asking' }, { path: 'public', why: 'denied' }, { path: 'public', why: 'unsupported' }, undefined]) {
        expect(hostLine(evm(), options, reads)).toBe(`Connects to a.example.com and b.example.com${tail}`)
      }
    })

    describe('on a chain but Ethereum, where it reads the contract from that chain and an author\'s name on Ethereum', () => {
      const chain = `Connects to the server its chain library names for base by default (name RPC URLs to choose others)${tail}`
      const NAME = 'An author\'s .eth or .bso name is read'
      const base = (reads: any, options: Record<string, string> = {}) => hostLine(evm(), { chainTicker: 'base', ...options }, reads)

      it('reads the contract from the chain\'s server, never through the light client, which carries Ethereum only', () => {
        for (const reads of [LIGHT, { path: 'asking' }, { path: 'public', why: 'denied' }, { path: 'public', why: 'unsupported' }, undefined]) {
          expect(base(reads), JSON.stringify(reads)).toMatch(/^Connects to the server its chain library names for base by default \(name RPC URLs to choose others\): an ordinary web server/)
        }
        expect(hostLine(evm(), { chainTicker: ' Base' }, undefined)).toMatch(/^Connects to the server its chain library names for base by default/)
      })

      it('reads an author\'s name through the browser\'s light client while the node reads Ethereum through it', () => {
        expect(base(LIGHT)).toBe(`${chain} ${NAME} through your browser's light client, which checks each answer and asks a public server only for what it cannot answer.`)
      })

      it('reads an author\'s name from public servers until the person answers the browser\'s question, and while the light client is off or not answering', () => {
        expect(base({ path: 'asking' })).toBe(`${chain} ${NAME} from public Ethereum servers until you answer your browser's question about its light client, which then reads it instead (Level 1 too).`)
        for (const why of ['no-handle', 'denied', 'closed', 'unavailable', 'timeout', 'not-asked', 'something-new']) {
          expect(base({ path: 'public', why, lightClient: 0, public: 2 }), why)
            .toBe(`${chain} ${NAME} from public Ethereum servers, because your browser's light client is off, was not allowed for this app or did not answer (Level 1 too).`)
        }
      })

      it('reads an author\'s name from the server its own library names when the browser has no light client for apps (v0.1.0), and when the node does not say', () => {
        for (const reads of [{ path: 'public', why: 'unsupported' }, { path: 'none' }, {}, null, undefined]) {
          expect(base(reads), JSON.stringify(reads)).toBe(`${chain} ${NAME} from ethereum.reth.rs (Level 1 too).`)
        }
      })

      it('reads the contract from the servers its owner named for that chain, and an author\'s name as it does without them', () => {
        const named = { rpcUrls: 'https://base.example.org' }
        expect(base(LIGHT, named)).toBe(`Connects to base.example.org${tail} ${NAME} through your browser's light client, which checks each answer and asks a public server only for what it cannot answer.`)
        expect(base(undefined, named)).toBe(`Connects to base.example.org${tail} ${NAME} from ethereum.reth.rs (Level 1 too).`)
        expect(base({ path: 'asking' }, named)).toMatch(/^Connects to base\.example\.org: .* An author's \.eth or \.bso name is read from public Ethereum servers until you answer/)
      })

      it('says nothing of an author\'s name for a board on Ethereum: it reads the name from the servers it reads the contract from', () => {
        expect(hostLine(evm(), { chainTicker: 'eth', rpcUrls: 'https://own.example.org' }, LIGHT)).toBe(`Connects to own.example.org${tail}`)
        expect(hostLine(evm(), { chainTicker: 'eth' }, LIGHT)).toBe(LIGHT_LINE)
        expect(hostLine(evm(), {}, LIGHT)).not.toMatch(/author/)
      })
    })

    it('changes nothing for a challenge that has no server option of a chain', () => {
      expect(hostLine(info('spam-blocker'), {}, LIGHT)).toBe(`Connects to spamblocker.bitsocial.net${tail}`)
      expect(hostLine(info('wordfilter'), {}, LIGHT)).toBe('')
    })
  })

  describe('the Orivon ID challenge, which reads a name\'s record through the node\'s Ethereum providers', () => {
    const tail = ': an ordinary web server, which counts as a Level 1 (Web2) connection for the Web3 Score.'
    const id = () => infos.get(ORIVON_ID_NAME)!
    const providers = `Connects to ${ETH_RPC_URLS.map((url) => new URL(url).hostname).slice(0, -1).join(', ')} and ${new URL(ETH_RPC_URLS.at(-1)!).hostname}${tail}`

    it('names the browser\'s light client, and no provider, while the node reads Ethereum through it', () => {
      const line = hostLine(id(), {}, { path: 'light-client', lightClient: 1, public: 0 })
      expect(line).toBe('Connects to your browser\'s light client for Ethereum: it checks each answer, and a public server is asked only for what it cannot answer.')
      for (const host of ETH_RPC_URLS.map((url) => new URL(url).hostname)) expect(line).not.toContain(host)
    })

    it('names the providers as it did when the light client does not answer, is not asked yet or is not there', () => {
      for (const reads of [{ path: 'asking' }, { path: 'public', why: 'denied' }, { path: 'public', why: 'unsupported' }, { path: 'none' }, {}, null, undefined]) {
        expect(hostLine(id(), {}, reads), JSON.stringify(reads)).toBe(providers)
      }
    })

    it('does not carry the light client over to a challenge that is not read through the name resolvers', () => {
      expect(hostLine(info('spam-blocker'), {}, { path: 'light-client' })).toBe(`Connects to spamblocker.bitsocial.net${tail}`)
    })
  })

  it('says nothing for a challenge that reaches no host', () => {
    for (const short of ['wordfilter', 'base64', 'captcha-canvas', 'voucher', 'r9k']) expect(hostLine(info(short), {}), short).toBe('')
    expect(hostLine(infos.get('text-math'), {})).toBe('')
  })
})

describe('what an apply changes, in words', () => {
  const start = () => [
    rowOf({ name: '@bitsocial/wordfilter-challenge', options: { 'wordfilter/v1/rules': WORDS }, publicOptions: ['wordfilter/v1/rules'] }, 'b0'),
    rowOf({ name: '@bitsocial/base64-challenge', options: { maxLength: '100' } }, 'b1'),
    rowOf({ name: '@bitsocial/voucher-challenge', options: { vouchers: 'A' } }, 'b2')
  ]

  it('says nothing when nothing changed', () => {
    expect(changesOf(start(), start(), infos, BOARD)).toEqual([])
  })

  it('names an added, a removed, a moved and a changed challenge, with their places', () => {
    const after = start()
    after[1]!.options['maxLength'] = '200'
    const moved = moveRow(removeRow(after, 'b2'), 'b1', -1)
    moved.push(newRow(info('flags'), 'n1'))
    expect(changesOf(start(), moved, infos, BOARD)).toEqual([
      'Removed voucher (it was number 3).',
      'Moved base64 from number 2 to number 1.',
      'Changed base64: the options maxLength.',
      'Added flags as number 3.'
    ])
  })

  it('says what changed in a challenge without showing a value, and the people it now lets through', () => {
    const after = start()
    after[0]!.options['error'] = 'secret words'
    after[0]!.pendingApproval = true
    after[0]!.description = 'Words'
    after[0]!.excludes.push({ raw: undefined, texts: { ...rowOf({ name: 'x', exclude: [{ roles: ['moderator'] }] }, 'x').excludes[0]!.texts } } as never)
    const lines = changesOf(start(), after, infos, BOARD)
    expect(lines).toEqual(['Changed wordfilter: the options error, the description shown to posters, the approval it asks of a moderator, who it lets through.'])
    expect(lines.join(' ')).not.toContain('secret words')
  })

  it('counts a rule written with the fields of before 0.0.132 as a change, since it is written again with the ones that exist now', () => {
    const old = [rowOf({ name: '@bitsocial/base64-challenge', exclude: [{ role: ['moderator'] }] }, 'b0')]
    expect(changesOf(old, old, infos, BOARD)).toEqual(['Changed base64: the old role and address fields, now written as roles, publicKeys and names.'])
    const { entries } = entriesOf(old, infos)
    expect(entries[0]!.exclude).toEqual([{ roles: ['moderator'] }])
  })
})
