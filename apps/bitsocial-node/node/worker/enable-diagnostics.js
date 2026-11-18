// Imported ahead of pkc-js (main.js), because pkc-js's logger reads `DEBUG` once, when it loads: the start-up namespaces and the
// page's `debug` become the variable's value. `diagnostics.js` says what they are and where the lines go.

import { debugNamespaces } from './diagnostics.js'

process.env['DEBUG'] = debugNamespaces(process.env['BITSOCIAL_NODE'], process.env['DEBUG'])
