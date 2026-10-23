// The server bundle's entry: what `tiddlywiki <wikifolder> ...` runs
// (tiddlywiki.js), minus the file's own relative require. Upstream's boot
// kernel is not bundled. It reads its core, plugins and editions from the
// disk beside it and loads its own modules from them, so it is required from
// the install tree the launcher wrote into the app's files, where
// `module.filename` is a real path and the kernel finds `../core` and
// `../plugins` as it does in an npm install. The path arrives in the
// environment; the arguments are the launcher's.

import { createRequire } from 'module'
import vm from 'vm'
import { standInVm } from './vm-stand-in.js'

const root = process.env.WIKIFOLDER_INSTALL
if (typeof root !== 'string' || root === '') {
  throw new Error('WIKIFOLDER_INSTALL names the directory the install tree was written to; the launcher sets it')
}

standInVm(vm)
const kernel = createRequire(`${root}/`)('./boot/boot.js')
const $tw = kernel.TiddlyWiki()
$tw.boot.argv = process.argv.slice(2)
$tw.boot.boot()
