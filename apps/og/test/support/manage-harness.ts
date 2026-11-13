// A page's flows over a simulated Linagee: the registration, the manage flow and the resolver's own answer for a name, all on one chain,
// so a test of a change can say what the resolver says after it.

import { callQueue, orivonChain } from '../../site/sdk/chain-orivon.js'
import { CENSUS_FORMAT, type Census } from '../../site/resolver/og-census.js'
import { inspectOg, resolveOg } from '../../site/resolver/og-names.js'
import { IMPLEMENTATION, UPGRADES } from '../../site/resolver/og-pins.js'
import { createSession } from '../../site/resolver/og-tail.js'
import { createManage } from '../../site/manage-flow.js'
import { createRegistration } from '../../site/register-flow.js'
import { orivonSender } from '../../site/register-send.js'
import { ACCOUNT, BASE_BLOCK, linageeWorld, TIP_ADDRESS, type WorldOptions } from './linagee-world.ts'

export const census = (): Census => ({ format: CENSUS_FORMAT, block: BASE_BLOCK - 100, blockHash: `0x${'00'.repeat(32)}`, implementation: IMPLEMENTATION, upgrades: [...UPGRADES], names: {} })
const calm = { sleep: async () => {} }

export function harness (initial: Record<string, unknown> = {}, options: WorldOptions = {}) {
  const setup = linageeWorld(initial as never, { tip: TIP_ADDRESS, plan: true, ...options })
  const chain = orivonChain(setup.orivon as never, { queue: callQueue({ burst: 1e6, perSecond: 1e6 }) })
  const sender = orivonSender({ orivon: setup.orivon as never, chain, relay: { send: async () => { throw new Error('the relay was not asked for') } } })
  const states: Record<string, any>[] = []
  const onState = (state: Record<string, any>) => states.push(state)
  const manage = createManage({ chain, sender, onState, clock: calm, wait: { intervalMs: 0, timeoutMs: 1000 } })
  const registration = createRegistration({ chain, sender, onState, clock: calm, wait: { intervalMs: 0, timeoutMs: 1000 } })
  return {
    setup, chain, states, manage, registration,
    /** Runs one change as the account. */
    run: (request: Record<string, unknown>) => manage.start({ account: ACCOUNT, private: false, ...request } as never),
    /** The resolver's answer for `<label>.og`, and the reasons behind it. */
    answer: async (label: string) => (await resolveOg(chain, `${label}.og`, { session: createSession(), census: census() })).records,
    inspect: async (label: string) => await inspectOg(chain, label, { session: createSession(), census: census() }, { latest: true }),
    labels: () => setup.world.log.map((one) => one.label)
  }
}
export type Harness = ReturnType<typeof harness>
