// The gateway socket's answers say `Connection: keep-alive`. The shell's fetch asks for `Connection: close`, the shim's
// HTTP server then closes the connection as soon as it has written the response, and the close can reach the page before
// the end of the body: the page's fetch fails with "the connection closed before the response body completed", always
// for a body of a few hundred kilobytes and at random for a small one. With keep-alive the server leaves the connection
// to the page, which closes it when it has read the whole body. Delete this module when the shim delivers a response
// before it closes.

/** @param {{ handle: (request: Request) => Promise<Response> }} facade */
export function keepAlive (facade) {
  return {
    /** @param {Request} request */
    async handle (request) {
      const response = await facade.handle(request)
      const headers = new Headers(response.headers)
      headers.set('Connection', 'keep-alive')
      return new Response(response.body, { status: response.status, headers })
    }
  }
}
