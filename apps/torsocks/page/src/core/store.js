// The state the interface reads and the actions it calls (../model.js). What
// the person published lives in the registry file; what the daemon says about
// it arrives as events; a service's state is the two merged.

import { initialState } from '../model.js'
import { createDaemonLink } from './daemon.js'
import { applyEvent, emptyRuntime } from './events.js'
import { controlKey, readRegistry, removePublication, writePublication, writeRegistry } from './files.js'
import { newId, planArticle, planFor } from './publication.js'

/** One service as the interface sees it. */
export function mergeService (entry, runtime) {
  const live = runtime.services[entry.id] ?? {}
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    created: entry.created,
    enabled: entry.enabled,
    onion: live.onion ?? entry.onion ?? null,
    state: entry.enabled ? (live.state ?? 'starting') : 'off',
    problem: entry.enabled ? (live.problem ?? null) : null,
    hits: live.hits ?? 0,
    bytes: entry.bytes,
    files: entry.files,
    check: live.check ?? null
  }
}

/** Why the page could not start, in words: a refused call means the permissions were not given (yet). */
export function startError (error) {
  if (error?.code === 'denied' || error?.code === 'revoked') {
    return 'TorSocks runs Tor with the permissions Orivon asks for when it opens: a port on this computer for the proxy, the network for Tor, and space for what you publish. Reload the page to be asked again.'
  }
  const message = error instanceof Error ? error.message : String(error ?? '')
  return message === '' ? 'TorSocks could not start.' : message
}

export function createStore () {
  let state = initialState()
  let runtime = emptyRuntime()
  let registry = []
  let daemon = null
  const listeners = new Set()

  const publishState = () => {
    state = { ...state, services: [...registry].sort((a, b) => (a.created < b.created ? 1 : -1)).map((entry) => mergeService(entry, runtime)) }
    for (const listener of listeners) listener(state)
  }
  const set = (change) => { state = { ...state, ...change }; publishState() }

  const enabledIds = () => registry.filter((entry) => entry.enabled).map((entry) => entry.id)

  const saveRegistry = async (next) => {
    registry = next
    publishState()
    await writeRegistry(registry)
  }

  /** The daemon keeps running across reloads: bring what it serves in line with the registry. */
  const reconcile = (running) => {
    const wanted = new Set(enabledIds())
    for (const id of wanted) if (!running.includes(id)) daemon.send({ op: 'publish', id })
    for (const id of running) if (!wanted.has(id)) daemon.send({ op: 'stop', id })
  }

  const onEvent = (event) => {
    if (event.t === 'welcome') {
      reconcile(Array.isArray(event.running) ? event.running : [])
      return
    }
    ;({ state, runtime } = applyEvent({ state, runtime }, event))
    // A service's address is kept with it, so it is known before the daemon next starts.
    if (event.t === 'service' && typeof event.onion === 'string') {
      const entry = registry.find((e) => e.id === event.id)
      if (entry !== undefined && entry.onion !== event.onion) {
        saveRegistry(registry.map((e) => (e.id === event.id ? { ...e, onion: event.onion } : e))).catch(() => {})
        return
      }
    }
    publishState()
  }

  const publishPlan = async (plan) => {
    if (state.busy !== null) throw new Error('Another publication is still being written.')
    const id = newId()
    set({ busy: { label: `Writing ${plan.files === 1 ? 'the file' : `${String(plan.files)} files`}`, done: 0, total: plan.bytes } })
    try {
      await writePublication(id, plan, (done) => set({ busy: { ...state.busy, done } }))
      const entry = { id, kind: plan.kind, title: plan.title, created: new Date().toISOString(), enabled: true, onion: null, bytes: plan.bytes, files: plan.files }
      await saveRegistry([...registry, entry])
      daemon?.send({ op: 'publish', id })
      return id
    } finally {
      set({ busy: null })
    }
  }

  const actions = {
    publishArticle: (input) => publishPlan(planArticle(input)),
    publishFiles: (input) => publishPlan(planFor(input)),
    async setEnabled (id, enabled) {
      await saveRegistry(registry.map((entry) => (entry.id === id ? { ...entry, enabled } : entry)))
      daemon?.send({ op: enabled ? 'publish' : 'stop', id })
    },
    async remove (id) {
      daemon?.send({ op: 'forget', id })
      await saveRegistry(registry.filter((entry) => entry.id !== id))
      await removePublication(id)
    },
    check (id) {
      const live = runtime.services[id] ?? {}
      runtime = { ...runtime, services: { ...runtime.services, [id]: { ...live, check: { pending: true, ok: false, text: 'Reaching it through Tor…', ms: 0 } } } }
      publishState()
      if (daemon?.send({ op: 'check', id }) !== true) onEvent({ t: 'check', id, ok: false, msg: 'The Tor daemon is not running.' })
    },
    async restart () {
      runtime = emptyRuntime()
      set({ bootstrap: initialState().bootstrap, socks: initialState().socks, traffic: initialState().traffic })
      await daemon?.restart(enabledIds())
    },
    visitUrl (id) {
      const service = state.services.find((s) => s.id === id)
      return service?.onion ? `http://${service.onion}/` : ''
    }
  }

  return {
    getState: () => state,
    subscribe (listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    actions,
    /** Reads the registry and joins or starts the daemon. */
    async start () {
      if (window.orivon?.net?.connect === undefined || window.orivon?.fs === undefined) {
        set({ phase: 'outside-orivon' })
        return
      }
      try {
        registry = await readRegistry()
        publishState()
        const key = await controlKey()
        daemon = createDaemonLink({ key, onEvent, onPhase: (phase, error) => set({ phase, error }) })
        await daemon.start(enabledIds())
      } catch (error) {
        set({ phase: 'failed', error: startError(error) })
      }
    }
  }
}
