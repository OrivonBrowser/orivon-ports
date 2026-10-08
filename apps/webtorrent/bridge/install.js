// Copies the files of upstream's static/ that the app reaches by path (the
// default torrents, their posters and the sounds) into APP_ROOT/static in the
// app's own files, once per build: install.json names them and carries their
// stamp.

import { mkdir, readFile, writeFile } from 'node:fs/promises'

export async function installStatic () {
  const install = await (await fetch('install.json')).json()
  const stampPath = `${install.root}/install-stamp`
  const current = await readFile(stampPath, 'utf8').catch(() => '')
  if (current === install.stamp) return
  for (const name of install.files) {
    const target = `${install.root}/static/${name}`
    await mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true })
    await writeFile(target, new Uint8Array(await (await fetch(`static/${name}`)).arrayBuffer()))
  }
  await writeFile(stampPath, install.stamp)
}
