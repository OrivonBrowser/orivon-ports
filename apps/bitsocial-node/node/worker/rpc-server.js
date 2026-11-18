// pkc-js's RPC server on a loopback WebSocket port, behind the key guard (rpc-guard.js). The HTTP server is ours, handed
// to pkc-js, so the guard is in place before pkc-js's server adds its listeners and the port is open only when this
// resolves: a client that connects earlier is refused with a 1006.

import { guardServer } from './rpc-guard.js'

/**
 * @param {{
 *   PKCRpc: { PKCWsServer: (options: Record<string, unknown>) => Promise<any> },
 *   http: Pick<typeof import('node:http'), 'createServer'>,
 *   port: number, authKey: string, pkcOptions: Record<string, unknown>,
 *   onError?: (error: unknown) => void
 * }} options
 */
export async function startRpcServer ({ PKCRpc, http, port, authKey, pkcOptions, onError = () => {} }) {
  const server = guardServer(http.createServer(), authKey)
  const pkc = await PKCRpc.PKCWsServer({ server, pkcOptions, authKey })
  pkc.on('error', onError)
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(undefined) })
    })
  } catch (error) {
    await pkc.destroy().catch(() => {})
    throw error
  }
  server.on('error', onError)

  /** The running community at `address`, or null when it is not running or does not answer in a moment. @param {string} address @returns {Promise<any>} */
  async function started (address) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer
    try {
      const community = await Promise.race([
        pkc.getStartedCommunity(address),
        new Promise((resolve) => { timer = setTimeout(() => { resolve(null) }, 2000) })
      ])
      return community ?? null
    } catch { return null } finally { clearTimeout(timer) }
  }

  return {
    /** The communities this node hosts, as pkc-js lists them: `{ name?, publicKey, address, started }`. Empty for a server that lists none. */
    hosted: () => /** @type {Array<{ address: string, started?: boolean }>} */ (pkc.pkc?.communities ?? []),
    /**
     * Whether a community this server runs has `features.noArchive` set (its threads past the board manager's limit are deleted at once, not
     * archived): null when it is not running or does not answer in a moment, which a page shows as not known.
     * @param {string} address @returns {Promise<boolean | null>}
     */
    async noArchive (address) {
      const community = await started(address)
      return community === null ? null : community.features?.noArchive === true
    },
    /**
     * A hosted board's settings as the server holds them: the running community's, or the stored one's when it does not run (the way the
     * server's own edit reaches a board that is stopped).
     * @param {string} address @returns {Promise<Record<string, unknown>>}
     */
    async settings (address) {
      const community = (await started(address)) ?? (await pkc.pkc.createCommunity({ address }))
      return structuredClone(community.settings ?? {})
    },
    /**
     * Writes a hosted board's `settings` whole through the server's own edit (`editCommunity`), to the board that entry of `hosted()` names, and
     * answers the settings it saved.
     * @param {string} address @param {Record<string, unknown>} settings @returns {Promise<Record<string, unknown> | undefined>}
     */
    async editSettings (address, settings) {
      const entry = /** @type {any} */ (pkc.pkc?.communities ?? []).find((/** @type {{ address: string }} */ one) => one.address === address)
      const name = typeof entry?.name === 'string' ? entry.name : address.includes('.') ? address : undefined
      const publicKey = typeof entry?.publicKey === 'string' ? entry.publicKey : name === undefined ? address : undefined
      const saved = await pkc.editCommunity([{ ...(name === undefined ? {} : { name }), ...(publicKey === undefined ? {} : { publicKey }), editOptions: { settings } }])
      return saved?.settings
    },
    /** The server's own pkc-js instance, which the listing calls read a hosted board's record and key from. */
    pkc: () => pkc.pkc ?? null,
    /** Stops the communities, closes every client and the port. */
    async close () {
      await pkc.destroy()
      await new Promise((resolve) => { server.close(() => { resolve(undefined) }); server.closeAllConnections() })
    }
  }
}
