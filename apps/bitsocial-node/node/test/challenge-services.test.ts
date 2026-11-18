// The stand-in for the services the anti-spam challenges call (tools/challenge-services.js): what it serves for the spam-blocker, on which port, and what it records.
import { afterEach, describe, expect, it } from 'vitest'
import * as cborg from 'cborg'
import { startChallengeServices } from '../tools/challenge-services.js'

type Services = Awaited<ReturnType<typeof startChallengeServices>>
const open: Services[] = []
afterEach(async () => { for (const one of open.splice(0)) await one.close() })
const start = async (options: { port?: number } = {}): Promise<Services> => { const one = await startChallengeServices({ balances: {}, ...options }); open.push(one); return one }

describe('the spam-blocker stand-in', () => {
  it('listens on the port it is asked for, and on a free one when it is asked for none', async () => {
    const free = await start()
    expect(new URL(free.url).port).not.toBe('0')
    const probe = await start()
    const taken = Number(new URL(probe.url).port)
    await probe.close()
    open.splice(open.indexOf(probe), 1)
    const named = await start({ port: taken })
    expect(named.url).toBe(`http://127.0.0.1:${String(taken)}`)
  })

  it('serves the page of a challenge session where the challenge package sends the poster, and records the visit', async () => {
    const services = await start()
    const answer = await fetch(`${services.url}/spam/api/v1/iframe/session-1/lazy?theme=light`)
    expect(answer.status).toBe(200)
    expect(answer.headers.get('content-type')).toMatch(/^text\/html/)
    const page = await answer.text()
    expect(page).toContain('<title>Spam blocker stand-in</title>')
    expect(page).toContain('session-1')
    expect(services.requests).toContainEqual({ service: 'spam', kind: 'iframe', session: 'session-1' })
  })

  it('still answers a verify call by what the test says: not solved, then solved', async () => {
    const services = await start()
    const verify = async (): Promise<{ success: boolean }> => await (await fetch(`${services.url}/spam/api/v1/challenge/verify`, { method: 'POST', body: Buffer.from(cborg.encode({ sessionId: 's', signature: { publicKey: new Uint8Array(32) } })) })).json() as { success: boolean }
    services.state.solved = false
    expect((await verify()).success).toBe(false)
    services.state.solved = true
    expect((await verify()).success).toBe(true)
  })
})
