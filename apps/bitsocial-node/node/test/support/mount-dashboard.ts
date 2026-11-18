// The node dashboard drawn into a stand-in for a document, with the timers a test moves: what a section's test mounts it with.
import { vi } from 'vitest'
import { mountNodeDashboard } from '../../../page/node-dashboard.js'
import { FakeDocument, FakeElement } from './fake-dom.js'

export const refusal = (status: number, message: string) => Object.assign(new Error(message), { status })

export async function settle () { for (let i = 0; i < 40; i++) await new Promise((resolve) => setTimeout(resolve, 0)) }

/** The page's timers are faked so that `refresh` can move the dashboard's interval; call it in `beforeEach`, and `vi.useRealTimers` after each. */
export const fakeTimers = () => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }) }

/** `handle` is what the page's `window.orivonBitsocialNode.ready` settles with. */
export interface MountOptions { handle: unknown, app?: { name?: string, term?: 'board' | 'community', features?: string[], addressSetting?: string }, now?: () => number, fetch?: typeof fetch }

export function mountDashboard (options: MountOptions) {
  const doc = new FakeDocument()
  const root = doc.createElement('div')
  const win: Record<string, unknown> = {}
  const dashboard = mountNodeDashboard({
    root: root as never, node: { ready: Promise.resolve(options.handle), error: null },
    app: { name: 'seedit', features: [], ...options.app } as never, document: doc as never, window: win, now: options.now ?? (() => 1_800_000_000_000), refreshMs: 1_000,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch })
  })
  const by = (selector: string) => root.querySelector(selector) as FakeElement
  const refresh = async () => { vi.advanceTimersByTime(1_000); await settle() }
  return { root, win, dashboard, by, refresh, text: (selector?: string) => (selector === undefined ? root : root.querySelector(selector))?.textContent ?? '' }
}

export async function ready (options: MountOptions) {
  const view = mountDashboard(options)
  await view.dashboard.started
  await settle()
  return view
}
