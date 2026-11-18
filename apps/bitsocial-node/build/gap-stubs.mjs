// Workaround, deletable one builtin at a time as the shim gains each: pkc-js's dependency tree imports Node builtins the
// shim has no module for, though the code paths a node runs never use them (`mortice` imports `cluster`, undici
// `stream/web`). Each is replaced by a module that loads and, where its members are called, answers what a process
// that is not a cluster member would; `dns/promises` also gets a `Resolver` that throws when it is made.

/** What each stubbed builtin becomes. */
const STUBS = {
  'dns/promises': "import dns from 'node:dns'; export const lookup = dns.promises.lookup; export class Resolver { constructor () { throw new Error('node:dns/promises has no Resolver in the Orivon shim') } }; export default { lookup, Resolver }",
  v8: 'export default { getHeapStatistics: () => ({ heap_size_limit: 2147483648, total_heap_size: 0, used_heap_size: 0 }) }',
  cluster: 'const c = { isPrimary: true, isMaster: true, isWorker: false, on () { return c }, once () { return c }, off () { return c }, emit () { return false } }; export default c',
  'stream/web': [
    'ReadableStream', 'WritableStream', 'TransformStream', 'ByteLengthQueuingStrategy', 'CountQueuingStrategy', 'TextEncoderStream', 'TextDecoderStream',
    'CompressionStream', 'DecompressionStream', 'ReadableStreamDefaultReader', 'ReadableStreamBYOBReader', 'ReadableStreamBYOBRequest',
    'ReadableByteStreamController', 'ReadableStreamDefaultController', 'TransformStreamDefaultController', 'WritableStreamDefaultWriter', 'WritableStreamDefaultController'
  ].map((name) => `export const ${name} = globalThis.${name}`).join('\n') + '\nexport default { ReadableStream, WritableStream, TransformStream }'
}

export const stubbedBuiltins = Object.keys(STUBS)

export const builtinStubs = {
  name: 'bitsocial-builtin-stubs',
  /** @param {import('esbuild').PluginBuild} build */
  setup (build) {
    for (const name of stubbedBuiltins) {
      build.onResolve({ filter: new RegExp(`^(node:)?${name.replace('/', '\\/')}$`) }, () => ({ path: name, namespace: 'bitsocial-stub' }))
    }
    build.onLoad({ filter: /.*/, namespace: 'bitsocial-stub' }, (args) => ({ contents: STUBS[/** @type {keyof typeof STUBS} */ (args.path)], loader: 'js' }))
  }
}
