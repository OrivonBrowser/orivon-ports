// The RPC server's door. pkc-js admits a client with no key whenever the connection's two ends have the same address,
// and in Orivon every connection a page makes to a port of its own app arrives from 127.0.0.1: so a page, and any
// other program on the loopback, would be let in. This refuses an upgrade whose path is not `/<authKey>` before the
// server pkc-js built on it sees the request, and answers every plain HTTP request but a download pkc-js serves.

/** The one plain HTTP route pkc-js serves: an exported community, named by an unguessable id. */
const EXPORT_PATH = /^\/exports\/[0-9a-fA-F-]{36}$/

/**
 * Whether `given` is `wanted`, comparing every character whatever the first difference.
 * @param {string} given @param {string} wanted
 */
export function sameKey (given, wanted) {
  let difference = given.length ^ wanted.length
  for (let at = 0; at < wanted.length; at++) difference |= (given.charCodeAt(at) || 0) ^ wanted.charCodeAt(at)
  return difference === 0
}

/**
 * Makes `server` pass an `upgrade` event on only when its path is `/<authKey>`, and `request` events on only for an
 * export download. Call it before handing the server to pkc-js, whose server registers its own listeners on it.
 * @param {import('node:http').Server} server @param {string} authKey
 */
export function guardServer (server, authKey) {
  const emit = server.emit.bind(server)
  /** @type {(event: string | symbol, ...args: any[]) => boolean} */
  server.emit = (event, ...args) => {
    if (event === 'upgrade') {
      const [request, socket] = /** @type {[import('node:http').IncomingMessage, import('node:net').Socket]} */ (args)
      if (!sameKey(request.url ?? '', `/${authKey}`)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => { socket.destroy() })
        return true
      }
    } else if (event === 'request') {
      const [request, response] = /** @type {[import('node:http').IncomingMessage, import('node:http').ServerResponse]} */ (args)
      if (!EXPORT_PATH.test((request.url ?? '').split('?')[0] ?? '')) {
        response.writeHead(404, { 'Content-Length': '0' }).end()
        return true
      }
    }
    return emit(event, ...args)
  }
  return server
}
