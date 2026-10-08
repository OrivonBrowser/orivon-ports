// Copies the files of upstream's static/ that the app reads with fs (the
// default torrents and their posters) into APP_ROOT/static in the app's own
// files, once per build: install.json names them and carries their stamp.

import { mkdir, readFile, writeFile } from 'node:fs/promises'

export async function installStatic () {
  const install = await (await fetch('install.json')).json()
  const stampPath = `${install.root}/install-stamp`
  const current = await readFile(stampPath, 'utf8').catch(() => '')
  if (current === install.stamp) return
  await mkdir(`${install.root}/static`, { recursive: true })
  for (const name of install.files) {
    const bytes = new Uint8Array(await (await fetch(`static/${name}`)).arrayBuffer())
    await writeFile(`${install.root}/static/${name}`, bytes)
  }
  await writeFile(stampPath, install.stamp)
}
