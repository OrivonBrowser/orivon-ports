// The anti-spam challenge packages, bundled into the Worker from the packages `node/package.json` installs (the list is
// `node/worker/challenges.js`). Nothing of them is changed: four imports are resolved to something the Worker has, and the
// one font the captcha is drawn in is read into the bundle.
//
// | Import | Becomes | Why |
// |---|---|---|
// | `skia-canvas` | `worker/workarounds/pure-canvas.js` | a native module, which captcha-canvas imports by that name; the replacement draws with pureimage, in JavaScript |
// | `@pkcprotocol/pkc-logger`, from a challenge package | `worker/challenge-logger.js` | its `debug` writes through `util.formatWithOptions`, which the shim lacks, and nothing it wrote would reach a bug report |
// | `@pkcprotocol/pkc-js`, from the Worker's own files | `dist/bundled/index.js`, the entry whose chunks the RPC server already holds | the package's `import` entry opens a compile cache through `node:module`, which the shim lacks, and the registry must be the one the RPC server reads (the board manager's own files take the same entry, `board-manager.mjs`) |
// | `i18n-iso-countries`, from a challenge package | its `index.js`, the entry its `browser` field names | the `main` entry registers every language file through a glob `require`, which esbuild names with the path it was built in; `countries.isValid`, the one call spam-blocker makes, reads no language file |
// | `worker/workarounds/canvas-font.js` | the same function over the bytes of the font file, with the font's licence text as a legal comment | the Worker has no `node_modules` to read it from, and the licence asks that its notice go with every copy |

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const recipe = dirname(dirname(fileURLToPath(import.meta.url)))
const nodeDir = join(recipe, 'node')
/** Whether a file is one of the challenge packages' own. @param {string} path */
const inChallengePackage = (path) => /\/@bitsocial\/[a-z0-9-]+-challenge\//.test(path.replaceAll('\\', '/'))
const FONT = 'dejavu-fonts-ttf/ttf/DejaVuSans.ttf'

/** The package's own path of the font file, found as the Worker's plain-Node run finds it. */
const fontPath = () => createRequire(join(nodeDir, 'package.json')).resolve(FONT)

/** An esbuild plugin for the imports of the challenge packages and of the Worker's registry. */
export function challengeSources () {
  return {
    name: 'bitsocial-challenge-sources',
    /** @param {import('esbuild').PluginBuild} build */
    setup (build) {
      build.onResolve({ filter: /^skia-canvas$/ }, () => ({ path: join(nodeDir, 'worker', 'workarounds', 'pure-canvas.js') }))
      build.onResolve({ filter: /^@pkcprotocol\/pkc-logger$/ }, (args) => (inChallengePackage(args.importer) ? { path: join(nodeDir, 'worker', 'challenge-logger.js') } : undefined))
      build.onResolve({ filter: /^i18n-iso-countries$/ }, (args) => (inChallengePackage(args.importer) ? { path: join(nodeDir, 'node_modules', 'i18n-iso-countries', 'index.js') } : undefined))
      build.onResolve({ filter: /^@pkcprotocol\/pkc-js$/ }, (args) => (args.importer.startsWith(join(nodeDir, 'worker') + sep) ? { path: join(nodeDir, 'node_modules', '@pkcprotocol', 'pkc-js', 'dist', 'bundled', 'index.js') } : undefined))
      build.onLoad({ filter: /[\\/]worker[\\/]workarounds[\\/]canvas-font\.js$/ }, async () => {
        const bytes = await readFile(fontPath())
        // The font's licence asks that its notice go with every copy, so it travels in the bundle as a legal comment.
        const licence = (await readFile(join(dirname(dirname(fontPath())), 'LICENSE'), 'utf8')).replaceAll('*/', '* /')
        return {
          contents: `/*!\n${licence}*/\nconst BASE64 = ${JSON.stringify(bytes.toString('base64'))}\nexport function fontBytes () { return Buffer.from(BASE64, 'base64') }\n`,
          loader: 'js'
        }
      })
    }
  }
}

/** Where `bundleChallenges` writes by default: under the app's `node_modules`, with the packages the bundle is made from. */
export const CHALLENGES_BUNDLE = join(nodeDir, 'node_modules', '.cache', 'challenges', 'challenges.mjs')

/**
 * The challenge list as one ES module for plain Node: the same sources and the same four rewrites as the Worker's bundle, with Node's
 * own modules left as they are. `bundle.test.ts` and the tools under `node/tools/` load it to run the packages the way the Worker runs them.
 * @param {{ outfile?: string }} [options]
 */
export async function bundleChallenges ({ outfile = CHALLENGES_BUNDLE } = {}) {
  const esbuild = createRequire(join(nodeDir, 'package.json'))('esbuild')
  await esbuild.build({
    entryPoints: [join(nodeDir, 'worker', 'challenges.js')], outfile, bundle: true, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
    banner: { js: "import { createRequire as __bundleRequire } from 'node:module'; const require = __bundleRequire(import.meta.url);" },
    plugins: [challengeSources()]
  })
  return outfile
}
