import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'

// A plain file server. It reads files off disk and returns them; it holds no
// state, talks to nothing, and knows nothing about Orivon. Everything
// Orivon-specific was baked in by prepare.ts, so this stays the dumb half --
// and stays as dumb as the static hosts a prepared app also has to run on.

export const HOST = '127.0.0.1'

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
}

/**
 * Resolves a request path inside `root`, or `null` if it would escape. The
 * separator test is what makes it safe: `startsWith(root)` alone accepts
 * `/srv/app-secrets` for a root of `/srv/app`.
 */
export function resolveRequestPath (root: string, pathname: string, entry = 'index.html'): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname === '/' ? `/${entry}` : pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const resolved = normalize(join(root, decoded))
  if (resolved !== root && !resolved.startsWith(root + sep)) return null
  return resolved
}

/**
 * The authority a request is actually addressed to, or `null` if the request
 * line is malformed in a way that must never fall back to guessing.
 *
 * A PAC-driven proxy sends an ABSOLUTE-FORM request-target --
 * `GET http://freetube.eth/x HTTP/1.1` -- and RFC 9112 SS3.2.2 requires the
 * `Host` header be ignored in favour of the authority the target itself
 * names; trusting `Host` instead would accept `GET http://asgardex.eth/x` +
 * `Host: freetube.eth` at FreeTube's own port, exactly the cross-origin
 * splice this guard exists to refuse. Everything else (an ordinary
 * origin-form request, direct or through the loopback rule below) has no
 * authority of its own, so `Host` is all there is.
 *
 * Userinfo in an absolute-form target (`http://x@freetube.eth/`) is not a
 * legitimate shape a proxy ever sends and exists only to make one hostname
 * look like another to a careless parser -- refused outright rather than
 * silently taking either side of it.
 */
export function requestAuthority (target: string, hostHeader: string | undefined): string | undefined | null {
  if (/^https?:\/\//i.test(target)) {
    let url: URL
    try { url = new URL(target) } catch { return null }
    if (url.username !== '' || url.password !== '') return null
    return url.host
  }
  return hostHeader
}

/**
 * Whether `authority` (a Host header, or a request-target's own authority --
 * see `requestAuthority`) may be answered by this instance. `name` is the
 * app's own fake `.eth` name (recipe.ts's `eth` field) -- an app that
 * declares none gets no guard at all, unconditionally true, so today's
 * behaviour is exactly preserved for every port that has not opted in.
 *
 * Once a name IS declared: loopback always passes, any port spelling,
 * because a raw IP claims no origin to spoof; no authority at all is a plain
 * HTTP/1.0 request, which reaches this server the same way a raw loopback
 * hit would, so it passes too. The one case refused is a DIFFERENT declared
 * name reaching this port -- a PAC misconfiguration, or a rewrite, that would
 * otherwise let `asgardex.eth` serve FreeTube's bytes under ASGARDEX's own
 * origin. That crosses the one-origin-per-app grant boundary `check:pinned`
 * enforces at the recipe level (src/README.md's "one origin per app"), so it
 * is refused here rather than merely discouraged there.
 */
export function isAllowedHost (authority: string | undefined, name: string | undefined): boolean {
  if (name === undefined || authority === undefined) return true
  const host = authority.trim().toLowerCase().replace(/:\d+$/, '')
  return host === HOST || host === name
}

/**
 * The bytes on disk, and a type derived from the name. Nothing else: this
 * server is deliberately no more capable than the plain static hosts a port
 * has to survive -- an IPFS gateway, object storage -- so a response header
 * none of them can derive is one no port may come to depend on.
 */
async function sendFile (res: ServerResponse, filePath: string): Promise<void> {
  const body = await readFile(filePath)
  const type = MIME_TYPES[extname(filePath)] ?? 'application/octet-stream'
  res.writeHead(200, { 'content-type': type }).end(body)
}

export interface ServeOptions {
  readonly root: string
  readonly port: number
  readonly label: string
  readonly entry?: string
  /** The recipe's fake `.eth` name, if it has one -- see `isAllowedHost`. */
  readonly name?: string
}

export async function startServer (options: ServeOptions): Promise<Server> {
  const root = normalize(options.root).replace(/[/\\]$/, '')
  const entry = options.entry ?? 'index.html'

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const authority = requestAuthority(req.url ?? '/', req.headers.host)
    if (authority === null) { res.writeHead(400).end('bad request'); return }
    if (!isAllowedHost(authority, options.name)) {
      // The request reached the wrong app's port -- 421, not 404, because
      // nothing here is missing. The body names neither the authority it got
      // nor the app it hit: a reject is the only signal a misdirected
      // request gets, matching resolveRequestPath's own "bad path" below.
      res.writeHead(421).end('misdirected request')
      return
    }
    const filePath = resolveRequestPath(root, new URL(req.url ?? '/', `http://${HOST}`).pathname, entry)
    if (filePath === null) { res.writeHead(400).end('bad path'); return }
    try {
      if (!(await stat(filePath)).isFile()) throw new Error('not a file')
      await sendFile(res, filePath)
    } catch {
      // Ordinary single-page-app hosting: a path with no file extension is a
      // client-side route, not a missing asset. A request that names an
      // extension still 404s, so a genuinely missing script stays visible
      // instead of being answered with HTML.
      if (extname(filePath) === '') {
        try { await sendFile(res, join(root, entry)); return } catch { /* fall through */ }
      }
      res.writeHead(404).end('not found')
    }
  }

  const server = createServer((req, res) => { void handle(req, res) })

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'EADDRINUSE'
        ? new Error(`[${options.label}] port ${String(options.port)} is taken -- another app or an earlier run still holds it`)
        : new Error(`[${options.label}] failed to start: ${error.message}`))
    })
    server.listen(options.port, HOST, () => { resolve() })
  })

  // The bound port, not the requested one: port 0 means "any free port", and
  // a line that says 0 is useless to whoever has to open the thing.
  const bound = (server.address() as AddressInfo | null)?.port ?? options.port
  process.stdout.write(`[${options.label}] serving ${root} on http://${HOST}:${String(bound)}\n`)
  return server
}
