// What orivon.json grants for the Bitsocial node, read as orivon-mvp's broker reads it: `*` never
// reaches loopback, so each port the page dials on this machine is named on both loopback hosts, and
// the ports the node listens on are named in tcp.listen. The ports are the ones the bridge sets in
// window.defaultPkcOptions and window.defaultMediaIpfsGatewayUrl, and the ones node-start.js starts the
// node with, read from their own source so a port changed in one file and not the others fails here.
// What the node needs beyond ports is read from apps/bitsocial-node/orivon.json. seedit's ports are its
// own, so it runs beside 5chan: no port here is a port 5chan's manifest holds.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface Manifest {
  crossOriginIsolated: boolean
  consentGranularity: string
  capabilities: {
    net: { tcp: { connect: string[], listen: { local: string[], network: string[] } }, https: { connect: string[] }, concurrentSockets: number }
    fs: { quotaBytes: number }
    web: { embed: { origins: string[] } }
  }
}

const read = (path: string): Manifest => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as Manifest
const manifest = read('../orivon.json')
const fiveChan = read('../../5chan/orivon.json')
const nodeManifest = read('../../bitsocial-node/orivon.json')
const nodeStart = readFileSync(new URL('./node-start.js', import.meta.url), 'utf8')
const bridge = readFileSync(new URL('./seedit.js', import.meta.url), 'utf8')
const uploadScript = readFileSync(new URL('./webview-upload.js', import.meta.url), 'utf8')
const embedsScript = readFileSync(new URL('./webview-embeds.js', import.meta.url), 'utf8')
const turnstileScript = readFileSync(new URL('./webview-turnstile.js', import.meta.url), 'utf8')
const { tcp, https } = manifest.capabilities.net

const portOf = (pattern: RegExp): string => {
  const port = pattern.exec(bridge)?.[1]
  if (port === undefined) throw new Error(`the bridge no longer matches ${String(pattern)}`)
  return port
}

const RPC = portOf(/const RPC_PORT = (\d+)/)
const GATEWAY = portOf(/const GATEWAY_URL = 'http:\/\/localhost:(\d+)'/)
const KUBO_API = startedPorts()['kubo'] as string
const NODE_API = '50129'
const TURNSTILE = portOf(/const TURNSTILE_PORT = (\d+)/)
const LOOPBACK = ['127.0.0.1', 'localhost']
const isLoopbackPattern = (pattern: string) => LOOPBACK.some((host) => pattern.startsWith(`${host}:`))

/** The ports node-start.js hands the node, by the names node-client.js knows them by. */
function startedPorts (): Record<string, string> {
  const block = /const PORTS = \{([^}]*)\}/.exec(nodeStart)?.[1]
  if (block === undefined) throw new Error('node-start.js no longer matches const PORTS')
  return Object.fromEntries([...block.matchAll(/(\w+): (\d+)/g)].map((match) => [match[1] as string, match[2] as string]))
}

/** The origins the helper scripts show, read from their own source: the pages an upload recipe opens, the frame Cloudflare's widget opens, the frames an embed names, and the sites the inline widgets open frames of. */
function shownOrigins (): string[] {
  const uploadPages = [...uploadScript.matchAll(/uploadUrl: '([^']+)'/g)].map((match) => new URL(match[1] as string).origin)
  const embedBlock = /const EMBED_ORIGINS = \[([^\]]*)\]/.exec(embedsScript)?.[1]
  const widgetBlock = /const WIDGET_SCRIPTS = \[([^\]]*)\]/.exec(embedsScript)?.[1]
  if (embedBlock === undefined || widgetBlock === undefined) throw new Error('webview-embeds.js no longer matches EMBED_ORIGINS and WIDGET_SCRIPTS')
  const turnstileBlock = /const WIDGET_ORIGINS = \[([^\]]*)\]/.exec(turnstileScript)?.[1]
  if (turnstileBlock === undefined) throw new Error('webview-turnstile.js no longer matches WIDGET_ORIGINS')
  const quoted = (block: string) => [...block.matchAll(/'([^']+)'/g)].map((match) => match[1] as string)
  return [...uploadPages, ...quoted(turnstileBlock), ...quoted(embedBlock), ...quoted(widgetBlock).map((script) => new URL(script).origin)]
}

describe('the Bitsocial node grants', () => {
  it('tcp.connect reaches any public host, and names the RPC, gateway and node API ports on both loopback hosts', () => {
    expect(tcp.connect).toContain('*:*')
    for (const host of LOOPBACK) {
      for (const port of [RPC, GATEWAY, NODE_API]) expect(tcp.connect, `${host}:${port}`).toContain(`${host}:${port}`)
    }
  })

  it('tcp.connect names nothing else but the name servers the node dials, which apps/bitsocial-node/orivon.json names too', () => {
    const rest = tcp.connect.filter((pattern) => pattern !== '*:*' && !isLoopbackPattern(pattern))
    expect(rest).toEqual(['1.1.1.1:53', '1.0.0.1:53'])
    expect(nodeManifest.capabilities.net.tcp.connect.filter((pattern) => pattern !== '*:*' && !isLoopbackPattern(pattern))).toEqual(rest)
    expect(tcp.connect).toHaveLength(1 + LOOPBACK.length * 3 + rest.length)
  })

  it('names the kubo API port nowhere: the page\'s calls to it are answered by the node\'s own socket, never sent to whatever listens there', () => {
    for (const pattern of [...tcp.connect, ...tcp.listen.local, ...tcp.listen.network]) expect(pattern, pattern).not.toContain(KUBO_API)
  })

  it('tcp.listen.local is the loopback ports of the RPC, the gateway and the node, and the Turnstile page', () => {
    expect(tcp.listen.local).toEqual([RPC, GATEWAY, NODE_API, TURNSTILE])
  })

  it('tcp.listen.network is the node\'s ten-port peer range, the only port opened to the network', () => {
    expect(tcp.listen.network).toEqual(['4011-4020'])
  })

  it('starts the node on the ports it is granted: the bridge\'s RPC, gateway and kubo ports, the node API, and a peer port in the range', () => {
    const { p2p, ...rest } = startedPorts()
    expect(rest).toEqual({ rpc: RPC, gateway: GATEWAY, kubo: KUBO_API, nodeApi: NODE_API })
    expect(Number(p2p)).toBeGreaterThanOrEqual(4011)
    expect(Number(p2p)).toBeLessThanOrEqual(4020)
  })

  it('has every grant the node app\'s own manifest has beyond its ports, and room for its sockets and files', () => {
    expect(https.connect).toEqual(nodeManifest.capabilities.net.https.connect)
    expect(manifest.capabilities.net.concurrentSockets).toBeGreaterThanOrEqual(nodeManifest.capabilities.net.concurrentSockets)
    expect(manifest.capabilities.fs.quotaBytes).toBeGreaterThanOrEqual(nodeManifest.capabilities.fs.quotaBytes)
    expect(manifest.crossOriginIsolated).toBe(nodeManifest.crossOriginIsolated)
  })

  it('https.connect reaches any host: a post links to any site and the routed fetch carries those requests', () => {
    expect(https.connect).toEqual(['*:*'])
  })

  it('embeds the Turnstile page on its exact loopback origin, and exactly the sites the helper scripts show: the upload pages, the frame of Cloudflare\'s widget and the embed sites', () => {
    const origins = manifest.capabilities.web.embed.origins
    expect(origins).not.toContain('*')
    expect(origins.filter((origin) => origin.startsWith('http://'))).toEqual([`http://localhost:${TURNSTILE}`])
    expect([...origins].sort()).toEqual([`http://localhost:${TURNSTILE}`, ...new Set(shownOrigins())].sort())
    expect(origins).toEqual(expect.arrayContaining(['https://imgur.com', 'https://imgbb.com', 'https://challenges.cloudflare.com', 'https://www.youtube.com', 'https://platform.twitter.com', 'https://embed.reddit.com']))
  })

  it('serves the Turnstile page on the port it grants to listen on and to embed, and reaches Forge through https.connect', () => {
    expect(turnstileScript).toContain(`const PAGE_PATH = '/forge-turnstile'`)
    expect(tcp.listen.local).toContain(TURNSTILE)
    expect(manifest.capabilities.web.embed.origins).toContain(`http://localhost:${TURNSTILE}`)
    for (const host of ['img-api.bitsocialforge.com', 'forgeimg.net']) expect(https.connect.some((pattern) => pattern === '*:*' || pattern.startsWith(`${host}:`))).toBe(true)
  })

  it('names no site that seedit\'s embed component never opens: Vimeo has no embed in seedit', () => {
    expect(manifest.capabilities.web.embed.origins).not.toContain('https://player.vimeo.com')
  })

  it('asks for 10 GiB of files, the default StorageMax of the node\'s datastore, and is all-or-nothing', () => {
    expect(manifest.capabilities.fs.quotaBytes).toBe(10 * 1024 ** 3)
    expect(manifest.consentGranularity).toBe('all-or-nothing')
  })

  it('is cross-origin isolated, and its socket ceiling stays under the platform\'s', () => {
    expect(manifest.crossOriginIsolated).toBe(true)
    expect(manifest.capabilities.net.concurrentSockets).toBeLessThanOrEqual(512)
  })

  it('holds no loopback port, no connect pattern and no peer port that 5chan\'s manifest holds, so both run at once', () => {
    expect(tcp.listen.local.filter((port) => fiveChan.capabilities.net.tcp.listen.local.includes(port))).toEqual([])
    expect(tcp.listen.network.filter((range) => fiveChan.capabilities.net.tcp.listen.network.includes(range))).toEqual([])
    const connected = (patterns: string[]) => patterns.filter((pattern) => pattern !== '*:*' && !pattern.includes(':53'))
    expect(connected(tcp.connect).filter((pattern) => connected(fiveChan.capabilities.net.tcp.connect).includes(pattern))).toEqual([])
  })

  it('draws the link to the node\'s web UI at the kubo API port, which the bridge catches and sends to the dashboard', () => {
    expect(bridge).toContain(`const NODE_WEBUI_HREF = 'http://localhost:${KUBO_API}/webui/'`)
  })
})
