// Before upstream starts: the Downloads folder its preferences name, which a
// computer always has and the app's own files do not until something makes
// it, and, once per build, the files of upstream's static/ that the app
// reaches by path (the default torrents, their posters and the sounds),
// copied into APP_ROOT/static. install.json names them and carries their
// stamp.

import { mkdir, readFile, writeFile } from 'node:fs/promises'

/** The default download folder: in the app's own files, which are the only files it has. */
export const DOWNLOADS = '/orivon/app/Downloads'

export async function installStatic () {
  await mkdir(DOWNLOADS, { recursive: true })
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
