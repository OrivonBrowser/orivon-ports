// TorSocks' page: the store (src/core/) under the interface (src/ui/). The
// build bundles this file with Orivon's Node shim into app.js.

import { createStore } from './core/store.js'
import { mountUi } from './ui/mount.js'

const store = createStore()
mountUi(document.getElementById('app'), store)
store.start()
