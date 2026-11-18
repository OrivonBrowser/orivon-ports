// How seeding follows a community with pkc-js: a plain copy of the record's fields, and an update loop that is started and stopped.
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { communityOpener, recordOf } from '../worker/seeding-pkc.js'

class FakeCommunity extends EventEmitter {
  updatedAt: number | undefined
  updateCid: string | undefined
  pubsubTopic = 'topic'
  posts = { pageCids: { hot: 'bafkhot' }, pages: { hot: { nextCid: 'bafknext', comments: [{ huge: 'x' }] } } }
  postUpdates = { 86400: 'bafkupd' }
  updates = 0
  stops = 0
  async update () { this.updates += 1 }
  async stop () { this.stops += 1 }
}

describe('recordOf', () => {
  it('is null until a record has come, then a plain copy of the fields a seeder reads and nothing of the comments', () => {
    const community = new FakeCommunity()
    expect(recordOf(community)).toBeNull()
    community.updatedAt = 12; community.updateCid = 'bafkrecord'
    expect(recordOf(community)).toEqual({ updatedAt: 12, updateCid: 'bafkrecord', pubsubTopic: 'topic', posts: { pageCids: { hot: 'bafkhot' }, pages: { hot: { nextCid: 'bafknext' } } }, postUpdates: { 86400: 'bafkupd' } })
  })
})

describe('communityOpener', () => {
  it('opens a community by address on the server\'s pkc-js, starts its update, and tells a listener of each new record until it is taken off', async () => {
    const community = new FakeCommunity()
    const asked: unknown[] = []
    const open = communityOpener({ pkc: () => ({ createCommunity: async (options: unknown) => { asked.push(options); return community } }) })
    const handle = await open('music.bso')
    expect(asked).toEqual([{ address: 'music.bso' }])
    expect(community.updates).toBe(1)
    let heard = 0
    const off = handle.onUpdate(() => { heard += 1 })
    community.emit('update')
    off()
    community.emit('update')
    expect(heard).toBe(1)
    await handle.stop()
    expect(community.stops).toBe(1)
  })

  it('says the node is still starting while pkc-js\'s server is not up, and says a community\'s error once, not at every retry', async () => {
    await expect(communityOpener({ pkc: () => null })('a.bso')).rejects.toThrow(/still starting/)
    const community = new FakeCommunity()
    const lines: string[] = []
    await communityOpener({ pkc: () => ({ createCommunity: async () => community }), warn: (line) => { lines.push(line) } })('a.bso')
    community.emit('error', new Error('no provider'))
    community.emit('error', new Error('no provider'))
    community.emit('error', new Error('timed out'))
    expect(lines).toEqual(['seeding: a.bso: no provider', 'seeding: a.bso: timed out'])
  })
})
