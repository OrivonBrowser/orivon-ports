import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'

// A plain file server. It reads files off disk and returns them; it holds no
// state, talks to nothing, and knows nothing about Orivon. Everything
// Orivon-specific was baked in by prepare.ts, so this stays the dumb half.

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
 * A `.br` file on disk is pre-compressed -- some builds emit locale JSON that
 * way and fetch it by that name. Content-Encoding is the standard way a static
 * server hands a browser a pre-compressed asset; Chromium decodes it the same
 * for http as for https.
 */
async function sendFile (res: ServerResponse, filePath: string): Promise<void> {
  const body = await readFile(filePath)
  const compressed = filePath.endsWith('.br')
  const type = MIME_TYPES[extname(compressed ? filePath.slice(0, -3) : filePath)] ?? 'application/octet-stream'
  const headers: Record<string, string> = { 'content-type': type }
  if (compressed) headers['content-encoding'] = 'br'
  res.writeHead(200, headers).end(body)
}

export interface ServeOptions {
  readonly root: string
  readonly port: number
  readonly label: string
  readonly entry?: string
}

export async function startServer (options: ServeOptions): Promise<Server> {
  const root = normalize(options.root).replace(/[/\\]$/, '')
  const entry = options.entry ?? 'index.html'

  const handle = async (url: string, res: ServerResponse): Promise<void> => {
    const filePath = resolveRequestPath(root, new URL(url, `http://${HOST}`).pathname, entry)
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

  const server = createServer((req, res) => { void handle(req.url ?? '/', res) })

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'EADDRINUSE'
        ? new Error(`[${options.label}] port ${String(options.port)} is taken -- another app or an earlier run still holds it`)
        : new Error(`[${options.label}] failed to start: ${error.message}`))
    })
    server.listen(options.port, HOST, () => { resolve() })
  })

  process.stdout.write(`[${options.label}] serving ${root} on http://${HOST}:${String(options.port)}\n`)
  return server
}
