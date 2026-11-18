// The 5chan board manager, bundled into the Worker from the package `node/package.json` installs at its pinned commit. Its
// sources are TypeScript and it has no library entry, so esbuild reads `src/board-manager.ts` and the pure modules beside it
// (`worker/board-manager-entry.js` names the four it exports). Nothing of it is changed: four of its imports are resolved
// to something the Worker has, and one line reads the package's version from a file the bundle has no place for.
//
// | Import | Becomes | Why |
// |---|---|---|
// | `@pkcprotocol/pkc-js` | `dist/bundled/index.js`, the entry whose chunks the RPC server already holds | the package's `import` entry opens a compile cache through `node:module` and loads the same chunks a second time |
// | `@pkcprotocol/pkc-logger` | `worker/board-manager-logger.js` | its `debug` writes through `util.formatWithOptions`, which the shim lacks, and nothing it wrote would reach a bug report |
// | `@pkcprotocol/proper-lock-file` | `worker/workarounds/process-lock.js` | the library keeps a lock fresh with `fs.utimes`, which the shim lacks |
// | `env-paths` | an empty folder set | it names the user's log folder for the CLI, which is not bundled |

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { replaceText } from './text-patch.mjs'

const recipe = dirname(dirname(fileURLToPath(import.meta.url)))
const nodeDir = join(recipe, 'node')
export const BOARD_MANAGER_PACKAGE = '@bitsocial/5chan-board-manager'
const PACKAGE_DIR = join(nodeDir, 'node_modules', ...BOARD_MANAGER_PACKAGE.split('/'))
const IN_PACKAGE = `${sep}${join('@bitsocial', '5chan-board-manager')}${sep}`

/** The installed package's `version`, which `pkc-rpc.ts` reads from `../package.json` through `createRequire`. */
export async function boardManagerVersion () {
  const text = await readFile(join(PACKAGE_DIR, 'package.json'), 'utf8').catch(() => {
    throw new Error(`${BOARD_MANAGER_PACKAGE} is not installed in ${nodeDir}: run \`npm run bitsocial-node:install\``)
  })
  return String(JSON.parse(text).version)
}

const readVersion = "const require = createRequire(import.meta.url)\nconst { version } = require('../package.json') as { version: string }"

/**
 * An esbuild plugin for the imports of the board manager's own files.
 * @param {{ version: string, pkcJs?: 'bundle' | 'external' }} options `pkcJs`: `external` leaves pkc-js to be loaded from
 *   its install (a bundle run by plain Node, which has the whole package beside it), `bundle` takes it into the output
 */
export function boardManagerSource ({ version, pkcJs = 'bundle' }) {
  return {
    name: 'bitsocial-board-manager-source',
    /** @param {import('esbuild').PluginBuild} build */
    setup (build) {
      const mine = (/** @type {string} */ importer) => importer.includes(IN_PACKAGE)
      build.onResolve({ filter: /^@pkcprotocol\/pkc-js$/ }, (args) => {
        if (!mine(args.importer)) return undefined
        return { path: join(nodeDir, 'node_modules', '@pkcprotocol', 'pkc-js', 'dist', 'bundled', 'index.js'), external: pkcJs === 'external' }
      })
      build.onResolve({ filter: /^@pkcprotocol\/pkc-logger$/ }, (args) => (mine(args.importer) ? { path: join(nodeDir, 'worker', 'board-manager-logger.js') } : undefined))
      build.onResolve({ filter: /^@pkcprotocol\/proper-lock-file$/ }, (args) => (mine(args.importer) ? { path: join(nodeDir, 'worker', 'workarounds', 'process-lock.js') } : undefined))
      build.onResolve({ filter: /^env-paths$/ }, (args) => (mine(args.importer) ? { path: 'env-paths', namespace: 'bitsocial-board-manager-stub' } : undefined))
      build.onLoad({ filter: /.*/, namespace: 'bitsocial-board-manager-stub' }, () => ({
        contents: "const none = ''; export default () => ({ data: none, config: none, cache: none, log: none, temp: none })",
        loader: 'js'
      }))
      build.onLoad({ filter: /[\\/]5chan-board-manager[\\/]src[\\/]pkc-rpc\.ts$/ }, async (args) => {
        const text = await readFile(args.path, 'utf8')
        const changed = replaceText(readVersion, `const version = ${JSON.stringify(version)}`)(text, args.path)
        return { contents: changed, loader: 'ts', resolveDir: dirname(args.path) }
      })
    }
  }
}

/** Where `bundleBoardManager` writes by default: under the app's `node_modules`, so pkc-js is found from it as from the Worker's own files. */
export const NODE_BUNDLE = join(nodeDir, 'node_modules', '.cache', 'board-manager', 'board-manager.mjs')

/**
 * The board manager as one ES module for plain Node, the way the tools under `node/tools/` run the Worker: pkc-js is left to be loaded
 * from its install, so the manager's client and the Worker's RPC server share its modules.
 * @param {{ outfile?: string }} [options]
 */
export async function bundleBoardManager ({ outfile = NODE_BUNDLE } = {}) {
  const esbuild = createRequire(join(nodeDir, 'package.json'))('esbuild')
  await esbuild.build({
    entryPoints: [join(nodeDir, 'worker', 'board-manager-entry.js')], outfile, bundle: true, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
    plugins: [boardManagerSource({ version: await boardManagerVersion(), pkcJs: 'external' })]
  })
  return outfile
}
