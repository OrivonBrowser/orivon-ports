// The go/no-go scenario, whoever hosts: a community is created and started on a host through pkc-js's RPC, a separate
// reader (pkc-js as a plain client over a real kubo) resolves and reads it, publishes a post, answers the community's
// challenge over pubsub, and sees the post in the community's next update. Every step is timed.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import PKC from '@pkcprotocol/pkc-js'

export const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Polls until `check` answers something other than undefined/false, or says what never happened.
 * @template T @param {() => T | Promise<T>} check @param {number} ms @param {string} what
 */
export async function waitFor (check, ms, what) {
  const end = Date.now() + ms
  for (;;) {
    const found = await check()
    if (found !== undefined && found !== false && found !== null) return /** @type {Exclude<T, undefined | false | null>} */ (found)
    if (Date.now() > end) throw new Error(`gave up after ${Math.round(ms / 1000)} s: ${what}`)
    await sleep(250)
  }
}

/** @param {unknown} error */
const textOf = (error) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error))

/**
 * Creates and starts a community on the host behind `rpcUrl`.
 * @param {{ rpcUrl: string, log: (line: string) => void, startMs?: number }} options
 */
export async function startHostedCommunity ({ rpcUrl, log, startMs = 120_000 }) {
  const pkc = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined })
  pkc.on('error', (/** @type {unknown} */ error) => { log(`host client error: ${textOf(error)}`) })
  const community = await pkc.createCommunity({ title: 'go-no-go board', description: 'Hosted through the kubo facade and Orivon\'s IPFS node' })
  community.on('error', (/** @type {unknown} */ error) => { log(`host community error: ${textOf(error)}`) })
  community.on('startedstatechange', (/** @type {string} */ state) => { log(`host community started state: ${state}`) })
  const began = Date.now()
  // The host reads its list of local communities through the shell's call limiter, which the node's own database traffic can
  // use up for a moment: a refused read leaves the community unlisted, and pkc-js answers "not local" or fails on a community
  // it took for a remote one. Asking again finds it.
  for (let attempt = 1; ; attempt += 1) {
    try { await community.start(); break } catch (error) {
      if (!/not local|toJSONInternalRpcBeforeFirstUpdate/.test(textOf(error)) || attempt >= 5) throw error
      log(`host community start failed as an unlisted community (try ${attempt} of 5): ${textOf(error)}; asking again`)
      await sleep(2000)
    }
  }
  await waitFor(() => community.updatedAt !== undefined && community.startedState === 'succeeded' ? true : undefined, startMs, `the host community never published (state ${String(community.startedState)})`)
  const challenge = community.settings?.challenges?.[0]
  const answer = challenge?.options?.answer
  if (typeof answer !== 'string') throw new Error(`the host community has no default question challenge: ${JSON.stringify(community.settings?.challenges)}`)
  log(`host community ${community.address} started in ${Date.now() - began} ms, challenge answer known`)
  return {
    address: /** @type {string} */ (community.address),
    answer,
    startedMs: Date.now() - began,
    /** The comment cids the host's own database holds, read back through the RPC. */
    async stop () { await community.stop().catch(() => {}); await pkc.destroy().catch(() => {}) }
  }
}

/**
 * The reader: pkc-js over `api`, a kubo's `/api/v0` URL. Resolves and reads the community, posts, answers the challenge,
 * and waits for the post in a later update. Returns the times in ms.
 * @param {{ api: string, address: string, answer: string, log: (line: string) => void, resolveMs?: number, postMs?: number, visibleMs?: number, httpRouters?: string[] }} options
 *   `httpRouters`: the reader's pkc-js options, which a real client has (and which the kubo it talks to is set up for)
 */
export async function readAndPost ({ api, address, answer, log, resolveMs = 150_000, postMs = 120_000, visibleMs = 150_000, httpRouters = [] }) {
  const dataPath = await mkdtemp(join(tmpdir(), 'bitsocial-reader-'))
  const pkc = await PKC({ kuboRpcClientsOptions: [{ url: api }], pubsubKuboRpcClientsOptions: [{ url: api }], httpRoutersOptions: httpRouters, ipfsGatewayUrls: [], dataPath, resolveAuthorNames: false })
  pkc.on('error', (/** @type {unknown} */ error) => { log(`reader error: ${textOf(error)}`) })
  const times = /** @type {Record<string, number>} */ ({})
  try {
    const started = Date.now()
    const abort = new AbortController()
    const timer = setTimeout(() => { abort.abort() }, resolveMs)
    let community
    try { community = await pkc.getCommunity({ address, abortSignal: abort.signal }) } finally { clearTimeout(timer) }
    times['firstResolveMs'] = Date.now() - started
    if (community.updatedAt === undefined) throw new Error('the reader resolved the community but has no update')
    log(`reader resolved ${address} in ${times['firstResolveMs']} ms (updatedAt ${community.updatedAt}, title ${JSON.stringify(community.title)})`)

    community.on('error', (/** @type {unknown} */ error) => { log(`reader community error: ${textOf(error)}`) })
    await community.update()
    const signer = await pkc.createSigner()
    const comment = await pkc.createComment({ signer, communityAddress: address, title: 'hello from a Bitsocial client', content: `posted ${new Date().toISOString()}`, author: { displayName: 'reader' } })
    comment.on('error', (/** @type {unknown} */ error) => { log(`reader comment error: ${textOf(error)}`) })
    /** @type {Array<Record<string, unknown>>} */
    const challenges = []
    let asked = 0
    /** @type {{ challengeSuccess: boolean, reason?: string } | null} */
    let verification = null
    comment.on('challenge', async (/** @type {{ challenges: unknown[] }} */ message) => {
      asked += 1
      challenges.push({ challenges: message.challenges })
      log(`reader got the challenge: ${JSON.stringify(message.challenges).slice(0, 200)}`)
      try { await comment.publishChallengeAnswers({ challengeAnswers: [answer] }) } catch (error) { log(`reader could not answer the challenge: ${textOf(error)}`) }
    })
    comment.on('challengeverification', (/** @type {{ challengeSuccess: boolean, reason?: string }} */ message) => { verification = message; log(`reader got the verification: ${JSON.stringify(message).slice(0, 200)}`) })
    const published = Date.now()
    await comment.publish()
    await waitFor(() => verification, postMs, `no challenge verification for the post (challenges asked: ${asked})`)
    times['postToVerificationMs'] = Date.now() - published
    const verified = /** @type {{ challengeSuccess: boolean, reason?: string }} */ (verification)
    if (!verified.challengeSuccess) throw new Error(`the community refused the post: ${verified.reason ?? 'no reason'}`)
    if (typeof comment.cid !== 'string') throw new Error('the verified post has no cid')
    log(`reader's post ${comment.cid} verified in ${times['postToVerificationMs']} ms`)

    const posted = comment.cid
    await waitFor(() => community.lastPostCid === posted || community.posts?.pages?.hot?.comments?.some((/** @type {{ cid?: string }} */ one) => one.cid === posted) ? true : undefined, visibleMs, `the post ${posted} is not in the community's update the reader reads (lastPostCid ${String(community.lastPostCid)})`)
    times['postToVisibleMs'] = Date.now() - published
    log(`reader sees the post in the community's update ${times['postToVisibleMs']} ms after publishing`)
    await community.stop().catch(() => {})
    return { ok: true, asked, postCid: posted, times }
  } finally {
    await pkc.destroy().catch(() => {})
    await rm(dataPath, { recursive: true, force: true })
  }
}
