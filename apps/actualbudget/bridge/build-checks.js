// What the build refuses, as pure functions the build script throws on and the tests hand real
// violations: a clone that is not the release the bridge answers for, an install tree missing what
// the backend reads, a bundle that holds native code or lacks the backend, and a `require` whose
// argument no bundler followed.

/** Why the clone is not the release this bridge answers `Actual.ACTUAL_VERSION` for, or null. */
export function versionProblem (cloneVersion, bridgeVersion) {
  return cloneVersion === bridgeVersion
    ? null
    : `the clone's desktop-electron package is ${String(cloneVersion)}, but bridge/plan.js (ACTUAL_VERSION) and bridge/actualbudget.js answer for ${bridgeVersion}: move them with the pin`
}

/** What the backend reads with `fs` from beside its bundle: the database template and the migrations. */
export function installFileProblems (names) {
  const problems = []
  if (!names.includes('default-db.sqlite')) problems.push('default-db.sqlite is missing: loot-core\'s database template')
  if (!names.some((name) => /^migrations\/.+\.sql$/.test(name))) problems.push('migrations/ holds no .sql file')
  if (!names.some((name) => /^migrations\/.+\.js$/.test(name))) problems.push('migrations/ holds no .js file: the backend lists them by name even though their code is bundled')
  return problems
}

/** Inputs of the server bundle (paths relative to the clone, posix): the backend must be there, and no native module may be. */
export function metafileProblems (inputs, backendInput) {
  const problems = []
  if (!inputs.includes(backendInput)) problems.push(`the bundle is missing ${backendInput}: the backend was not bundled`)
  const native = inputs.find((path) => path.startsWith('node_modules/better-sqlite3/'))
  if (native !== undefined) problems.push(`the bundle holds ${native}: the native module must resolve to the shim's adapter`)
  if (!inputs.some((path) => path.endsWith('src/shim/sqlite/better-sqlite3.ts'))) problems.push('the bundle holds no better-sqlite3 adapter: `better-sqlite3` did not resolve to the shim')
  return problems
}

const DYNAMIC_REQUIRE = /(?<![\w$.])__require\(\s*([^"'`\s)][^)]*)\)/g

/**
 * Every `__require(<expression>)` in `code` that is not on the declared list. esbuild prints a
 * `require` whose argument is not a string it could follow as `__require(...)`; at run time the
 * forked child's own `require` answers it from the app's files, so each one must be a call
 * somebody read and declared. `declared` is `[{ pattern, why }]`.
 */
export function dynamicRequires (code, declared = []) {
  const problems = []
  const used = new Set()
  for (const match of code.matchAll(DYNAMIC_REQUIRE)) {
    const text = `__require(${match[1]})`
    const entry = declared.find((candidate) => candidate.pattern.test(text))
    if (entry === undefined) problems.push(`server.mjs: ${text} is left in the bundle for run time and is not on the declared list`)
    else used.add(entry)
  }
  for (const entry of declared) {
    if (!used.has(entry)) problems.push(`the declared require ${String(entry.pattern)} no longer appears in the bundle`)
  }
  return problems
}
