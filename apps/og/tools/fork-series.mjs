// Runs the registration's and the manager's real send code against a local anvil fork of mainnet, with a funded throwaway key behind a
// stand-in for the browser's handles (fork-handles.mjs), and after each run asks the resolver's own `resolveOg` what the name answers.
//
//   node apps/og/tools/fork-series.mjs [--json] [case-name-part ...]
//
// It needs `anvil` (Foundry) and a public node that can be forked (ORIVON_OG_FORK_RPC first, then two free ones). Nothing is ever
// sent to mainnet: every transaction goes to the fork. A case that cannot run says so and the exit status is 1.
// Registration cases (fork-cases-register.mjs): wrapped; unwrapped; wallet that signs one by one; name taken mid-series; wrapping off
// before and in the middle of a series; wrapping off on the way to the wrapper, then finished; tip unticked.
// Manage cases (fork-cases-manage.mjs): fix the controller (unwrapped, wrapped); transfer (unwrapped with the controller and primary
// name removed, wrapped, wrapped after a clean-up); clear records; set the primary name; wrap and unwrap with the site kept.

import { fileURLToPath } from 'node:url'
import { BIG, createWorld, startFork } from './fork-world.mjs'
import registerCases from './fork-cases-register.mjs'
import manageCases from './fork-cases-manage.mjs'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const wanted = args.filter((one) => !one.startsWith('--'))

const fork = await startFork()
const world = await createWorld(fork)
const CASES = [...registerCases(world), ...manageCases(world)]

const results = []
let failed = false
try {
  await world.plantTipResolver()
  for (const one of CASES.filter((entry) => wanted.length === 0 || wanted.some((part) => entry.name.includes(part)))) {
    const started = Date.now()
    // A public node that was asked too fast or too much fails a read of the fork's, which is not what a case tests: that case runs once more.
    for (let attempt = 1; ; attempt++) {
      try {
        const out = await one.run()
        results.push({ case: one.name, ok: true, seconds: Math.round((Date.now() - started) / 1000), ...out })
        break
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (attempt < 3 && /failed to get|timed out|rate limit|429/i.test(message)) continue
        failed = true
        const refused = /archive requests|fork error/i.test(message)
        results.push({ case: one.name, ok: false, error: refused ? `${message} (the node refused a read of the fork: run again with ORIVON_OG_FORK_RPC set to another node)` : message })
        break
      }
    }
  }
} catch (error) {
  failed = true
  results.push({ case: 'setup', ok: false, error: error instanceof Error ? error.message : String(error) })
} finally {
  fork.stop()
}
const out = { fork: `anvil, forked from ${fork.node.replace(/\/\/.*@/, '//')}`, file: fileURLToPath(import.meta.url).split('/').slice(-3).join('/'), results }
console.log(asJson ? JSON.stringify(out, (_, value) => BIG(value), 2) : results.map((one) => `${one.ok ? 'PASS' : 'FAIL'} ${one.case}\n${JSON.stringify(one, (_, value) => BIG(value), 2)}`).join('\n'))
process.exit(failed ? 1 : 0)
