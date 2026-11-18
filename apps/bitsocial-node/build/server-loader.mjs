// `node/server.mjs` of a packed build (build/pack.mjs): the Worker's first file, which reads the node's code from
// `server.bundle.js.deflate` beside it, unpacks it and runs it as the bundle's own top level would have run. The bundle was
// built to read its address from `globalThis.__bitsocialServerUrl` where it would read `import.meta.url`, so the files it
// looks for (`sqlite3.wasm`) are found beside this file as they would be beside the bundle.
//
// It runs the text with `new Function`, not as a `blob:` module: the page's content security policy admits `'unsafe-eval'`
// in `script-src` and no `blob:` there, and the bundle is the app's own hash-checked file. The text is strict, as a module
// is, and its `await` at the top is the async function's.

const address = import.meta.url
const answer = await fetch(new URL('server.bundle.js.deflate', address))
if (!answer.ok || answer.body === null) throw new Error(`the node's code (server.bundle.js.deflate) is not served: ${String(answer.status)}`)
const source = await new Response(answer.body.pipeThrough(new DecompressionStream('deflate-raw'))).text()
globalThis.__bitsocialServerUrl = address
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
await new AsyncFunction(`"use strict";\n${source}\n//# sourceURL=${new URL('server.bundle.js', address).href}`)()
