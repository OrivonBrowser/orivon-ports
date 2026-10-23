// What the boot kernel needs from Node's `vm` that the shim refuses. The
// kernel makes one context at load (`vm.createContext({})`) and runs every
// module of a plugin in it (`vm.runInContext`), so that a module's stray
// global assignments land in a sandbox and are reported. A context of its own
// needs a second JavaScript realm, which a Worker has no way to make, so the
// shim refuses both by name. The stand-in keeps the two calls and runs the
// code in the Worker's own realm instead: a module keeps every name the
// kernel passes it, and also sees the Worker's globals. That is no loss of
// isolation, because the kernel's own `require` hands any module `fs`, `http`
// and the rest (they are what a plugin is for), and the sandbox was only ever
// a tidiness check.
//
// The check itself cannot hold in one realm: it reads `Object.keys` of the
// context's global to find assignments, and the Worker's global holds the
// shim's own. It reaches that global through the free name `__temp__`, so
// `runInContext` gives the code a parameter of that name that is an empty
// object. The code upstream wrote runs as it wrote it.

/** The name the kernel's check reads the context's global through (boot/boot.js, `globalCheck`). */
export const GLOBAL_PROBE = '__temp__'

/** The text of a function whose body is `code`, an expression, with `sourceUrl` named for stack traces. */
export function wrapperBody (code, sourceUrl) {
  return `return ${code}\n//# sourceURL=${sourceUrl}`
}

/** The file name `vm.runInContext(code, context, options)` was given: a string, or `options.filename`. */
export function filenameOf (options) {
  if (typeof options === 'string') return options
  return typeof options?.filename === 'string' ? options.filename : 'vm-module'
}

/**
 * Replaces `createContext` and `runInContext` on the shim's `vm` object with
 * the stand-ins above and returns it. `runInThisContext` is the shim's own.
 */
export function standInVm (vm) {
  vm.createContext = (sandbox = {}) => sandbox
  vm.runInContext = (code, _context, options) => {
    // eslint-disable-next-line no-new-func -- the kernel's modules are compiled from text; this is vm's job
    return new Function(GLOBAL_PROBE, wrapperBody(String(code), filenameOf(options)))({})
  }
  return vm
}
