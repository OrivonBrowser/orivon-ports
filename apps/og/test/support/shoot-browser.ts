// The page side of tools/shoot.mjs: installs a simulated Linagee chain as the page's `orivon`, in the state the scene names, before the
// page's own scripts run. Bundled by the tool; never served.

import { fakeOrivon } from './fake-orivon.ts'
import { ACCOUNT, linageeWorld, RIVAL, TIP_ADDRESS, type State } from './linagee-world.ts'

interface Seed { from: string, to: string, data: string }
interface Scene { state?: Partial<State>, plan?: boolean, tip?: string | null, seed?: Seed[], before?: { index: number, change: Partial<State> }[] }
const scene = ((globalThis as unknown as { __SCENE?: Scene }).__SCENE ?? {})
const state = (scene.state ?? {}) as Record<string, any>
// JSON has no bigint: the wrapper's token ids come in as numbers.
if (state['nameToId'] !== undefined) state['nameToId'] = Object.fromEntries(Object.entries(state['nameToId'] as Record<string, number>).map(([key, id]) => [key, BigInt(id)]))
// The options object stays reachable (`__options`) so a scene can move the address `orivonstack.eth` resolves to after the page showed it.
const options = { tip: scene.tip === undefined ? TIP_ADDRESS : scene.tip, plan: scene.plan !== false }
const setup = linageeWorld(state, options)
// A seed is a transaction mined before the page starts, so a name has the history of one that was registered, wrapped or written to.
for (const one of scene.seed ?? []) {
  const nonce = setup.world.state.nonces[one.from.toLowerCase()] ?? 0
  setup.mine(new TextEncoder().encode(JSON.stringify({ ...one, value: '0x0', gas: 500_000, nonce })))
}
// `index` counts the transactions mined after the seeds.
const first = setup.world.log.length
for (const { index, change } of scene.before ?? []) setup.world.before.set(first + index, (state) => { Object.assign(state, change) })
Object.assign(globalThis, { orivon: setup.orivon, __world: setup, __options: options, __account: ACCOUNT, __rival: RIVAL, __fake: fakeOrivon })
