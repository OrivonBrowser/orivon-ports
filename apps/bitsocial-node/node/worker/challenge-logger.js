// The logger the challenge packages get in place of `@pkcprotocol/pkc-logger` (build/challenges.mjs): its `debug` writes through
// `util.formatWithOptions`, which the shim lacks, and nothing it wrote would reach a bug report. Each line goes to the Worker
// (`routeChallengeLog` in diagnostics.js), which writes it as a warning.

import { loggerTo } from './board-manager-logger.js'

export default loggerTo('__bitsocialChallengeLog')
