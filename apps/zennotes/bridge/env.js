// Runs before every other module of the bundle: upstream's settings module reads its directory from
// the environment when it is first asked, and the answer must be a place the app owns.

import { CONFIG_DIR } from './build-plan.js'

process.env.ZENNOTES_CONFIG_DIR = CONFIG_DIR
