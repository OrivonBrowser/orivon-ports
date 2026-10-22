// The daemon component as jco's JavaScript and core modules, made the way
// orivon-mvp's spawn requires (its src/shim/wasi-p2/run.ts, transpileCommand):
// asynchronous instantiation, JSPI, the host's own list of imports that
// suspend, and no Node compatibility. The lists and the check spawn applies
// are read from that checkout, so they can never disagree with the host
// that runs the program.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** ASYNC_IMPORTS, ASYNC_EXPORTS, isJcoOutput and unmarkedAsyncImports from orivon-mvp's WASI 0.2 host. */
async function hostRules (esbuild, mvpRoot) {
  const dir = join(mvpRoot, 'src', 'shim', 'wasi-p2')
  const result = await esbuild.build({
    stdin: {
      contents: "export { ASYNC_IMPORTS, ASYNC_EXPORTS } from './imports.ts'\nexport { isJcoOutput, unmarkedAsyncImports } from './run.ts'\n",
      resolveDir: dir,
      loader: 'ts'
    },
    bundle: true,
    format: 'esm',
    // The modules import Node builtins (path/posix) that Node itself answers when the result is imported.
    platform: 'node',
    packages: 'external',
    write: false,
    logLevel: 'silent'
  })
  const code = result.outputFiles[0].text
  return await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}

/**
 * Writes `<outDir>/<name>.p2/`: the glue `<name>.js` and its core modules.
 * Throws when the glue would not pass spawn's own check.
 */
export async function transpileComponent ({ component, name, outDir, toolsDir, mvpRoot }) {
  const require = createRequire(join(toolsDir, 'package.json'))
  const esbuild = require('esbuild')
  const rules = await hostRules(esbuild, mvpRoot)
  const bindgenPath = join(toolsDir, 'node_modules', '@bytecodealliance', 'jco-transpile', 'vendor', 'js-component-bindgen-component.js')
  const bindgen = await import(pathToFileURL(bindgenPath).href)
  await bindgen.$init
  const { files } = bindgen.generate(await readFile(component), {
    name,
    instantiation: { tag: 'async' },
    asyncMode: { tag: 'jspi', val: { imports: [...rules.ASYNC_IMPORTS], exports: [...rules.ASYNC_EXPORTS] } },
    noNodejsCompat: true,
    noTypescript: true,
    map: []
  })
  const dir = join(outDir, `${name}.p2`)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  let glue = ''
  for (const [file, bytes] of files) {
    await writeFile(join(dir, file), bytes)
    if (file === `${name}.js`) glue = new TextDecoder().decode(bytes)
  }
  if (!rules.isJcoOutput(glue)) throw new Error(`jco wrote no ${name}.js that orivon-mvp's spawn accepts`)
  const unmarked = rules.unmarkedAsyncImports(glue)
  if (unmarked.length > 0) throw new Error(`jco lowered ${unmarked.join(', ')} synchronously; orivon-mvp's host answers them asynchronously`)
  return dir
}
