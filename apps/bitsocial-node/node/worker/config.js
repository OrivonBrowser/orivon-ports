// What the page forked the Worker with: one JSON value in the environment variable `BITSOCIAL_NODE`. The key stays
// in the environment of this process and the page that forked it, and never in an argument a process list shows.

/** The variable the page puts the configuration in. */
export const CONFIG_VARIABLE = 'BITSOCIAL_NODE'

const KEY_SHAPE = /^[A-Za-z0-9_-]{16,128}$/
const LOOPBACK_ROUTER = /^http:\/\/127\.0\.0\.1:\d{1,5}$/
const LOOPBACK_PEER = /^\/ip4\/127\.0\.0\.1\/tcp\/\d{1,5}\/p2p\/[A-Za-z0-9]{10,100}$/
const PORT_NAMES = ['rpc', 'gateway', 'kubo', 'nodeApi', 'p2p']
export const DEBUG_SHAPE = /^[A-Za-z0-9_*:,.-]{1,400}$/
const RELAY_SHAPE = /^\/(ip4|ip6|dns4|dns6)\/([A-Za-z0-9.:-]{1,253})\/tcp\/(\d{1,5})\/p2p\/[A-Za-z0-9]{10,100}$/
const DNS_NAME = /^[A-Za-z0-9.-]+$/
const IPV4_SHAPE = /^(?:(?:0|[1-9]\d{0,2})\.){3}(?:0|[1-9]\d{0,2})$/
const SHAPE_MESSAGE = 'relay must be /ip4|ip6|dns4|dns6/<host>/tcp/<port>/p2p/<relay peer id>'

/** The four numbers of an IPv4 address, or null when the node's multiaddr parser would not read it. @param {string} text */
function ipv4Octets (text) {
  const octets = IPV4_SHAPE.test(text) ? text.split('.').map(Number) : null
  return octets !== null && octets.every((octet) => octet <= 255) ? octets : null
}

/** The eight 16-bit groups of an IPv6 address written in hex (no dotted tail), or null when it is not one. @param {string} text */
function ipv6Groups (text) {
  const halves = text.split('::')
  if (halves.length > 2 || !/^[0-9A-Fa-f:]+$/.test(text)) return null
  const read = (/** @type {string} */ part) => (part === '' ? [] : part.split(':'))
  const head = read(halves[0] ?? '')
  const tail = read(halves[1] ?? '')
  const groups = [...head, ...tail]
  if (groups.some((group) => !/^[0-9A-Fa-f]{1,4}$/.test(group)) || (halves.length === 1 ? groups.length !== 8 : groups.length > 7)) return null
  const numbers = (/** @type {string[]} */ list) => list.map((group) => parseInt(group, 16))
  return [...numbers(head), ...Array(8 - groups.length).fill(0), ...numbers(tail)]
}

/**
 * What the node's `ipv4_is_public` refuses (`crates/orivon-ipfs-serve/src/addr.rs`): loopback, private, link-local, unspecified, the
 * `0.0.0.0/8` block, broadcast, multicast, the documentation blocks and the shared (carrier-grade NAT) block.
 * @param {number[]} octets
 */
function ipv4IsPublic ([a, b, c, d]) {
  return !(a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) ||
    (a === 255 && b === 255 && c === 255 && d === 255) || (a >= 224 && a <= 239) ||
    (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || (a === 100 && b >= 64 && b <= 127))
}

/** What the node's `ipv6_is_public` refuses: an IPv4-mapped address is judged as the IPv4 one, then loopback, unspecified, multicast, unique-local and link-local. @param {number[]} groups */
function ipv6IsPublic (groups) {
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) return ipv4IsPublic([groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255])
  const first = groups[0]
  const zeros = groups.slice(0, 7).every((group) => group === 0)
  return !(zeros && groups[7] <= 1) && (first & 0xff00) !== 0xff00 && (first & 0xfe00) !== 0xfc00 && (first & 0xffc0) !== 0xfe80
}

/** The node's `dns_name_is_local`: `localhost` and every name under it, in any case, with or without the final dot. The node does not refuse `.local`, which is the local network's own name space; it is refused here as well. @param {string} name */
function nameIsLocal (name) {
  const lower = name.replace(/\.$/, '').toLowerCase()
  return lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local')
}

/** @param {unknown} value @param {string} name */
function port (value, name) {
  if (!Number.isInteger(value) || /** @type {number} */ (value) < 1024 || /** @type {number} */ (value) > 65535) throw new Error(`${name} must be a port from 1024 to 65535`)
  return /** @type {number} */ (value)
}

/**
 * @typedef {object} WorkerConfig
 * @property {string} authKey the path a client opens the RPC at: `ws://localhost:<rpc>/<authKey>`
 * @property {string} files the app's files directory; the data, the node's database and the facade's state live under it
 * @property {{ rpc: number, gateway: number, kubo: number, nodeApi: number, p2p: number }} ports
 *   `rpc` pkc-js's WebSocket, `gateway` the media gateway, `kubo` the origin pkc-js believes kubo answers at (answered
 *   in this process, never listened on), `nodeApi` the IPFS node's HTTP API, `p2p` the node's IPFS port
 * @property {string[]} origins page origins the gateway answers a request from, beside requests that carry none
 * @property {string} trace the node's trace filter
 * @property {string} [relay] a circuit relay the person names, `/ip4|ip6|dns4|dns6/<host>/tcp/<port>/p2p/<relay peer id>`: the node holds a
 *   place on it and announces the circuit address it gives. There is no default, as Orivon's own node names none
 * @property {string} [debug] pkc-js's own log namespaces to write as well (a `debug` pattern, `pkc-js:local-community:*`), beside the few
 *   that say how its RPC server started; they go to the Worker's warnings, which reach a bug report
 * @property {{ bootstrap: string[], routers?: string[] }} [isolated] no internet: the node dials loopback addresses and its DHT starts from
 *   `bootstrap` (`/ip4/127.0.0.1/tcp/<port>/p2p/<peer id>`), and pkc-js has no HTTP routers and no name resolvers. `routers`, loopback
 *   `http://127.0.0.1:<port>` origins, are the only HTTP routers the node asks for providers (a kubo's own routing API, say). For
 *   a test or a local network, never for a person's node
 */

/**
 * The address of a relay a person names, or a thrown reason it cannot be one: its shape, and that it is on the internet, by the rule
 * the node component starts with (`parse_dial_addr`), so the field refuses what the node would refuse, at the field and not as a
 * node that stays "Restarting". An `isolated` run, with no internet, may name one on loopback.
 * @param {unknown} relay @param {boolean} [isolated]
 */
export function checkRelay (relay, isolated = false) {
  const shape = typeof relay === 'string' ? RELAY_SHAPE.exec(relay) : null
  if (shape === null || Number(shape[3]) > 65535) throw new Error(SHAPE_MESSAGE)
  const kind = shape[1]
  const host = /** @type {string} */ (shape[2])
  let public_
  if (kind === 'ip4') {
    const octets = ipv4Octets(host)
    if (octets === null) throw new Error(SHAPE_MESSAGE)
    public_ = ipv4IsPublic(octets)
  } else if (kind === 'ip6') {
    const groups = ipv6Groups(host)
    if (groups === null) throw new Error(SHAPE_MESSAGE)
    public_ = ipv6IsPublic(groups)
  } else {
    if (!DNS_NAME.test(host)) throw new Error(SHAPE_MESSAGE)
    public_ = !nameIsLocal(host)
  }
  if (!isolated && !public_) throw new Error('relay must be on the internet: the node refuses a relay on this computer or the local network')
  return /** @type {string} */ (relay)
}

/** @param {Record<string, string | undefined>} env @returns {WorkerConfig} */
export function readConfig (env) {
  const text = env[CONFIG_VARIABLE]
  if (text === undefined || text === '') throw new Error(`${CONFIG_VARIABLE} is not set: the page starts this Worker with its configuration`)
  /** @type {Record<string, any>} */
  let given
  try { given = JSON.parse(text) } catch { throw new Error(`${CONFIG_VARIABLE} is not JSON`) }
  if (typeof given.authKey !== 'string' || !KEY_SHAPE.test(given.authKey)) throw new Error('authKey must be 16 to 128 letters, digits, "-" or "_"')
  if (typeof given.files !== 'string' || !given.files.startsWith('/')) throw new Error('files must be an absolute directory')
  const ports = Object.fromEntries(PORT_NAMES.map((name) => [name, port(given.ports?.[name], `ports.${name}`)]))
  if (new Set(Object.values(ports)).size !== PORT_NAMES.length) throw new Error('ports must all differ')
  const origins = given.origins ?? []
  if (!Array.isArray(origins) || origins.some((origin) => typeof origin !== 'string')) throw new Error('origins must be a list of strings')
  const trace = given.trace ?? 'warn'
  if (typeof trace !== 'string' || !/^[A-Za-z0-9_=,:.-]{1,400}$/.test(trace)) throw new Error('trace is not a trace filter')
  const debug = given.debug ?? undefined
  if (debug !== undefined && (typeof debug !== 'string' || !DEBUG_SHAPE.test(debug))) throw new Error('debug is not a list of log namespaces')
  const relay = given.relay ?? undefined
  const isolated = given.isolated ?? undefined
  if (relay !== undefined) checkRelay(relay, isolated !== undefined)
  if (isolated !== undefined && (!Array.isArray(isolated?.bootstrap) || isolated.bootstrap.length === 0 || isolated.bootstrap.some((/** @type {unknown} */ peer) => typeof peer !== 'string' || !LOOPBACK_PEER.test(peer)))) {
    throw new Error('isolated.bootstrap must list loopback peers: /ip4/127.0.0.1/tcp/<port>/p2p/<peer id>')
  }
  const routers = isolated?.routers ?? []
  if (isolated !== undefined && (!Array.isArray(routers) || routers.some((/** @type {unknown} */ router) => typeof router !== 'string' || !LOOPBACK_ROUTER.test(router)))) {
    throw new Error('isolated.routers must list loopback routers: http://127.0.0.1:<port>')
  }
  return { authKey: given.authKey, files: given.files.replace(/\/+$/, ''), ports: /** @type {WorkerConfig['ports']} */ (ports), origins, trace, ...(debug === undefined ? {} : { debug }), ...(relay === undefined ? {} : { relay }), ...(isolated === undefined ? {} : { isolated: { bootstrap: [...isolated.bootstrap], ...(routers.length === 0 ? {} : { routers: [...routers] }) } }) }
}

/** Where each thing the Worker keeps lives, under the app's files. @param {string} files */
export function layout (files) {
  return { data: `${files}/pkc`, nodeDb: `${files}/node/blocks.db`, keySecret: `${files}/node/keys.secret`, facadeState: `${files}/facade/state.json`, boardManager: `${files}/board-manager`, seeding: `${files}/seeding`, relay: `${files}/relay.json` }
}
