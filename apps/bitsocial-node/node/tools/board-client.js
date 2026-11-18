// A pkc-js client playing the app, for the runs that check what the board manager does to a board: it creates and starts boards on
// the Worker's RPC, posts, and reads each result from the board's own published pages, never from the manager's log.
// `board-manager.js` (plain Node) and `shell/manager.js` (the Orivon shell) share it.

import PKC from '@pkcprotocol/pkc-js'
import { sleep, waitFor } from './scenario.js'

export const SORT = '@pkcprotocol/active-page-sort'
/** Between two posts of one board: a post's timestamp is in seconds, and a tie would leave the order to chance. */
const GAP_MS = 1_150

/** @param {unknown} error */
export const textOf = (error) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
/** The last six characters of a cid, enough to tell the threads of a run apart in a line. @param {string} cid */
export const shortOf = (cid) => cid.slice(-6)

/** The threads of the board's `active` sort, or of its first page when it has none, in the order the board publishes them. @param {any} community */
export const threadsOf = (community) => /** @type {Array<Record<string, any>>} */ (community.posts?.pages?.active?.comments ?? Object.values(community.posts?.pages ?? {})[0]?.comments ?? [])

/** @param {string} rpcUrl @param {(line: string) => void} log */
export async function boardClient (rpcUrl, log) {
  const pkc = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined })
  pkc.on('error', (/** @type {unknown} */ error) => { log(`client error: ${textOf(error)}`) })

  /**
   * A board created and started on the Worker's RPC, with no challenge so a post is accepted at once; `sort` gives it the active page sort.
   * @param {string} title @param {boolean} sort
   */
  async function createBoard (title, sort) {
    const community = await pkc.createCommunity({ title, description: `${title}, for the board manager` })
    community.on('error', (/** @type {unknown} */ error) => { log(`${title}: community error: ${textOf(error)}`) })
    for (let attempt = 1; ; attempt += 1) {
      try { await community.start(); break } catch (error) {
        if (!/not local|toJSONInternalRpcBeforeFirstUpdate/.test(textOf(error)) || attempt >= 5) throw error
        await sleep(2000)
      }
    }
    await waitFor(() => (community.updatedAt !== undefined && community.startedState === 'succeeded' ? true : undefined), 240_000, `${title} never published`)
    const pages = sort
      ? { posts: [{ name: SORT, options: { noBumpKeywords: 'sage', bumpLimit: '300' }, preloaded: true }], replies: [{ name: 'old', preloaded: true }, { name: 'new' }] }
      : undefined
    await community.edit({ settings: { ...community.settings, challenges: [], ...(pages === undefined ? {} : { pages }) } })
    await waitFor(() => (Array.isArray(community.settings?.challenges) && community.settings.challenges.length === 0 ? true : undefined), 60_000, `${title}: the settings edit did not show`)
    log(`${title}: board ${community.address} started${sort ? ' with the active page sort' : ' with no page sort'}`)
    return { community, address: /** @type {string} */ (community.address), title }
  }

  /** A client that follows a board's published record, as a reader of its pages does. @param {string} address */
  async function follow (address) {
    const community = await pkc.createCommunity({ address })
    community.on('error', (/** @type {unknown} */ error) => { log(`${address}: reader error: ${textOf(error)}`) })
    await community.update()
    await waitFor(() => (community.updatedAt === undefined ? undefined : true), 120_000, `${address}: no record to read`)
    return community
  }

  /** Publishes a comment and returns its cid once the board verified it. @param {string} address @param {Record<string, unknown>} fields */
  async function post (address, fields) {
    const signer = await pkc.createSigner()
    const comment = await pkc.createComment({ signer, communityAddress: address, author: { displayName: 'tester' }, ...fields })
    comment.on('error', (/** @type {unknown} */ error) => { log(`post error: ${textOf(error)}`) })
    /** @type {{ challengeSuccess: boolean, reason?: string } | null} */
    let verdict = null
    comment.on('challengeverification', (/** @type {{ challengeSuccess: boolean, reason?: string }} */ message) => { verdict = message })
    await comment.publish()
    await waitFor(() => verdict, 120_000, `no verification for ${JSON.stringify(fields['title'] ?? fields['content'])}`)
    const verified = /** @type {{ challengeSuccess: boolean, reason?: string }} */ (verdict)
    if (!verified.challengeSuccess) throw new Error(`the board refused the post: ${verified.reason ?? 'no reason'}`)
    await sleep(GAP_MS)
    return /** @type {string} */ (comment.cid)
  }

  /**
   * Publishes a comment as a stranger and says what the board answered, without throwing on a refusal. A challenge the board asks is
   * answered with `answers` (a list of strings, or a function of the challenges asked); with none the post waits for a verdict
   * that never comes, and the call says so.
   * @param {string} address @param {Record<string, unknown>} fields
   * @param {{ answers?: string[] | ((challenges: Array<Record<string, any>>) => string[] | Promise<string[]>), signer?: any, author?: Record<string, unknown>, ms?: number }} [options]
   *   `author` is merged over the display name; a `signer` is made when none is given
   * @returns {Promise<{ success: boolean, reason: string, cid: string | undefined, asked: Array<Array<{ type: string, challenge: string }>>, signer: any }>}
   */
  async function tryPost (address, fields, { answers, signer: given, author = {}, ms = 120_000 } = {}) {
    const signer = given ?? await pkc.createSigner()
    const comment = await pkc.createComment({ signer, communityAddress: address, author: { displayName: 'tester', ...author }, ...fields })
    comment.on('error', (/** @type {unknown} */ error) => { log(`tryPost error: ${textOf(error)}`) })
    /** @type {Array<Array<{ type: string, challenge: string }>>} */
    const asked = []
    /** @type {Record<string, any> | null} */
    let verdict = null
    comment.on('challenge', async (/** @type {{ challenges: Array<Record<string, any>> }} */ message) => {
      asked.push(message.challenges.map((one) => ({ type: String(one['type']), challenge: String(one['challenge']) })))
      if (answers === undefined) return
      try { await comment.publishChallengeAnswers({ challengeAnswers: typeof answers === 'function' ? await answers(message.challenges) : answers }) } catch (error) { log(`tryPost could not answer: ${textOf(error)}`) }
    })
    comment.on('challengeverification', (/** @type {Record<string, any>} */ message) => { verdict = message })
    await comment.publish()
    await waitFor(() => verdict, ms, `no verdict for ${JSON.stringify(fields['content'])} (challenges asked: ${asked.length})`)
    const message = /** @type {Record<string, any>} */ (verdict)
    const errors = message['challengeErrors'] === undefined ? [] : Object.values(message['challengeErrors']).map(String)
    return { success: message['challengeSuccess'] === true, reason: [message['reason'], ...errors].filter((one) => typeof one === 'string' && one !== '').join('; '), cid: comment.cid, asked, signer }
  }

  /** Polls a board's pages until `check` holds, and says what the pages held when it did not. @param {any} community @param {(threads: Array<Record<string, any>>) => boolean} check @param {number} ms @param {string} what */
  async function pagesShow (community, check, ms, what) {
    try { await waitFor(() => (check(threadsOf(community)) ? true : undefined), ms, what) } catch (error) {
      throw new Error(`${textOf(error)}; the pages held ${JSON.stringify(threadsOf(community).map((one) => ({ cid: shortOf(one['cid']), title: one['title'], archived: one['archived'] ?? false, replyCount: one['replyCount'], lastReplyTimestamp: one['lastReplyTimestamp'] })))}`)
    }
  }

  return {
    createBoard,
    follow,
    pagesShow,
    tryPost,
    createSigner: () => pkc.createSigner(),
    thread: (/** @type {string} */ address, /** @type {string} */ title) => post(address, { title, content: `${title} body` }),
    reply: (/** @type {string} */ address, /** @type {string} */ parentCid, /** @type {string} */ content) => post(address, { parentCid, postCid: parentCid, content }),
    destroy: () => pkc.destroy().catch(() => {})
  }
}
