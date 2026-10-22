// The DecentraWiki build, run in the TiddlyWiki clone by `orivon-port build`.
// It writes two trees with TiddlyWiki's own command line:
//
// - `decentrawiki-dist/`, the editor (editor.decentrawiki.eth): the page in
//   ../page, the editing frame (frame.html) and the shared TiddlyWiki core;
// - `decentrawiki-home/`, decentrawiki.eth: the DecentraWiki guide, a wiki
//   published exactly as the editor publishes every wiki.
//
// Both load the same core file, byte for byte; the build refuses otherwise.

import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const recipe = dirname(dirname(fileURLToPath(import.meta.url)))
const source = process.cwd()
const editorOut = join(source, 'decentrawiki-dist')
const homeOut = join(source, 'decentrawiki-home')

const { version } = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
const core = `tiddlywikicore-${version}.js`
const env = { ...process.env, TIDDLYWIKI_PLUGIN_PATH: join(recipe, 'wiki', 'plugins') }

/** Renders an edition as an HTML page beside the core file it loads. */
function renderEdition (edition, out, page) {
  execFileSync(process.execPath, [
    join(source, 'tiddlywiki.js'), join(recipe, 'wiki', edition),
    '--output', out,
    '--render', '$:/core/save/offline-external-js', page, 'text/plain',
    '--render', '$:/core/templates/tiddlywiki5.js', core, 'text/plain'
  ], { cwd: source, env, stdio: ['ignore', 'inherit', 'inherit'] })
}

await rm(editorOut, { recursive: true, force: true })
await rm(homeOut, { recursive: true, force: true })
await mkdir(editorOut, { recursive: true })

renderEdition('frame', editorOut, 'frame.html')
renderEdition('home', homeOut, 'index.html')

const [editorCore, homeCore] = await Promise.all([readFile(join(editorOut, core)), readFile(join(homeOut, core))])
if (!editorCore.equals(homeCore)) throw new Error(`${core} differs between the editor and decentrawiki.eth: a published wiki would load another core than the one it was edited with`)

await cp(join(recipe, 'page'), editorOut, { recursive: true })
await writeFile(join(editorOut, 'build.json'), JSON.stringify({ tiddlywiki: version, core }, null, 2) + '\n')
