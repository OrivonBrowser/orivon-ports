// Stands in for application-config-path, which throws on every platform but
// darwin, linux and win32, and Orivon's os.platform() is none of them. The
// app's own files are the only filesystem it has, and $HOME names their root,
// so the answer is the one the package's Linux branch gives.

import { join } from 'node:path'

export default function applicationConfigPath (name) {
  if (typeof name !== 'string') throw new TypeError('`name` must be string')
  return join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME, '.config'), name)
}
