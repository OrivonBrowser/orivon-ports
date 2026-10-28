// A fake store for previewing the interface without Orivon (see preview.html).
// `?phase=failed`, `?phase=outside-orivon` or `?phase=starting` shows those layouts.
import { initialState } from '../model.js'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

function fakeOnion (seed) {
  let n = seed * 2654435761 % 4294967296
  let out = ''
  for (let i = 0; i < 56; i++) {
    n = (n * 1664525 + 1013904223) % 4294967296
    out += ALPHABET[(n >>> 24) % 32]
  }
  return `${out}.onion`
}

const DAY = 86_400_000

export function mockStore () {
  const phaseFromUrl = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('phase') : null
  const state = initialState()
  const listeners = new Set()
  const timers = []
  let nextId = 10
  let nextOnion = 20

  const emit = () => {
    const snapshot = { ...state }
    for (const fn of listeners) fn(snapshot)
  }
  const log = (level, target, msg) => {
    state.logs = [...state.logs, { time: Date.now(), level, target, msg }].slice(-400)
  }
  const later = (ms, fn) => timers.push(setTimeout(() => { fn(); emit() }, ms))
  const find = (id) => state.services.find((service) => service.id === id)

  state.arti = '0.47.0'
  // The four cards show what a person meets: settled, still publishing and not yet answering,
  // reachable although Arti still says degraded, and switched off.
  const DESCRIPTOR = 'publishing its descriptor: Timeout exceeded; Timeout exceeded'
  const answered = { pending: false, ok: true, text: 'Reached through Tor: HTTP/1.1 200 OK', ms: 1840, at: Date.now(), auto: true }
  const unanswered = { pending: false, ok: false, text: 'no answer within two minutes', ms: 120_000, at: Date.now(), auto: true }
  state.services = [
    { id: 'a1', kind: 'article', title: 'Notes on keeping a diary offline', created: new Date(Date.now() - 6 * DAY).toISOString(), enabled: true, onion: fakeOnion(1), state: 'running', problem: null, hits: 142, bytes: 18_400, files: 2, check: null, reached: false },
    { id: 'p2', kind: 'picture', title: 'Harbour at dawn', created: new Date(Date.now() - 2 * DAY).toISOString(), enabled: true, onion: fakeOnion(2), state: 'publishing', problem: null, hits: 0, bytes: 3_482_113, files: 2, check: unanswered, reached: false },
    { id: 'd4', kind: 'article', title: 'Field notes, spring', created: new Date(Date.now() - 1 * DAY).toISOString(), enabled: true, onion: fakeOnion(4), state: 'degraded', problem: DESCRIPTOR, hits: 3, bytes: 9_120, files: 2, check: answered, reached: true },
    { id: 'w3', kind: 'website', title: 'Field manual', created: new Date(Date.now() - 20 * DAY).toISOString(), enabled: false, onion: fakeOnion(3), state: 'off', problem: null, hits: 1_204, bytes: 52_428_800, files: 87, check: null, reached: false }
  ]

  function boot () {
    const phase = ['failed', 'outside-orivon', 'starting', 'checking'].includes(phaseFromUrl) ? phaseFromUrl : null
    if (phase) {
      state.phase = phase
      if (phase === 'failed') state.error = 'The Arti process exited with code 101: could not open /home/you/.local/share/torsocks/state (permission denied).'
      if (phase === 'checking' || phase === 'starting') state.bootstrap = { frac: 0.12, ready: false, msg: 'Fetching directory information', blocked: null }
      for (let i = 0; i < 8; i++) log(i % 5 === 3 ? 'WARN' : 'INFO', 'tor_dirmgr', 'Loading preview line ' + i)
      return
    }
    log('INFO', 'arti', 'Looking for a running daemon')
    state.phase = 'checking'
    later(900, () => {
      state.phase = 'starting'
      state.socks = { state: 'waiting', host: '127.0.0.1', port: 0, msg: '' }
      log('INFO', 'arti', 'Starting Arti ' + state.arti)
    })
    later(1800, () => {
      state.phase = 'running'
      state.socks = { state: 'listening', host: '127.0.0.1', port: 9150, msg: '' }
      log('INFO', 'arti_client', 'SOCKS proxy listening on 127.0.0.1:9150')
    })
    const advance = setInterval(() => {
      if (state.phase !== 'running') return
      const b = state.bootstrap
      if (b.ready) return
      b.frac = Math.min(1, b.frac + 0.05 + Math.random() * 0.08)
      b.msg = b.frac < 0.3 ? 'Fetching directory information' : b.frac < 0.7 ? 'Loading relay descriptors' : 'Building a circuit'
      if (b.frac >= 1) {
        b.ready = true
        b.msg = 'Done'
        log('INFO', 'tor_dirmgr', 'Directory is complete enough to use')
      } else {
        log('DEBUG', 'tor_dirmgr', `Bootstrap at ${Math.round(b.frac * 100)}%`)
      }
      emit()
    }, 700)
    timers.push(advance)
    const chatter = setInterval(() => {
      if (state.phase !== 'running') return
      const level = Math.random() < 0.12 ? 'WARN' : 'INFO'
      log(level, 'tor_hsservice', level === 'WARN' ? 'Intro point timed out, picking another' : 'Descriptor uploaded to an HSDir')
      state.traffic = { open: Math.floor(Math.random() * 4), total: state.traffic.total + (Math.random() < 0.5 ? 1 : 0) }
      emit()
    }, 2500)
    timers.push(chatter)
    state.logs = [{ time: Date.now() - 4000, level: 'ERROR', target: 'tor_guardmgr', msg: 'Could not reach guard 198.51.100.7:9001: connection refused' }, ...state.logs]
  }

  function addService (kind, title, files, bytes) {
    const id = `n${nextId++}`
    const service = { id, kind, title, created: new Date().toISOString(), enabled: true, onion: null, state: 'starting', problem: null, hits: 0, bytes, files, check: null, reached: false }
    state.services = [service, ...state.services]
    later(1500, () => { service.onion = fakeOnion(nextOnion++); service.state = 'publishing'; log('INFO', 'tor_hsservice', `Publishing ${title}`) })
    // Like the real page: a first test about a minute after the address (compressed here), a failure, a pass while Arti still says publishing, then Arti settles.
    later(7000, () => { service.check = { pending: false, ok: false, text: 'no answer within two minutes', ms: 120_000, at: Date.now(), auto: true } })
    later(13_000, () => {
      service.check = { pending: false, ok: true, text: 'Reached through Tor: HTTP/1.1 200 OK', ms: 1840, at: Date.now(), auto: true }
      service.reached = true
      log('INFO', 'torsocks', `${title} answered a test through Tor`)
    })
    later(25_000, () => { service.state = 'running'; service.reached = false; log('INFO', 'tor_hsservice', `${title} is reachable`) })
    return id
  }

  async function progress (label, total) {
    for (let done = 0; done <= total; done++) {
      state.busy = { label, done, total }
      emit()
      await new Promise((resolve) => setTimeout(resolve, 260))
    }
    state.busy = null
  }

  const actions = {
    async publishArticle ({ title, body }) {
      await progress('Writing the page', 4)
      if (/fail/i.test(title)) { emit(); throw new Error('The preview refuses titles that contain "fail".') }
      const id = addService('article', title, 2, body.length)
      emit()
      return id
    },
    async publishFiles ({ kind, title, files }) {
      await progress('Copying files', Math.min(files.length, 12))
      if (kind === 'website' && !files.some((file) => file.webkitRelativePath.split('/').length === 2 && file.name === 'index.html')) {
        emit()
        throw new Error('This folder has no index.html at its top.')
      }
      const id = addService(kind, title, files.length, files.reduce((sum, file) => sum + file.size, 0))
      emit()
      return id
    },
    async setEnabled (id, enabled) {
      const service = find(id)
      await new Promise((resolve) => setTimeout(resolve, 300))
      service.enabled = enabled
      service.state = enabled ? 'starting' : 'off'
      service.reached = false
      service.problem = enabled ? null : 'Switched off.'
      if (enabled) later(1800, () => { service.state = 'running' })
      emit()
    },
    async remove (id) {
      await new Promise((resolve) => setTimeout(resolve, 300))
      state.services = state.services.filter((service) => service.id !== id)
      emit()
    },
    check (id) {
      const service = find(id)
      service.check = { pending: true, ok: false, text: '', ms: 0, at: Date.now(), auto: false }
      emit()
      later(1600, () => {
        const answers = service.state === 'running' || service.reached
        service.check = answers
          ? { pending: false, ok: true, text: 'Reached through Tor: HTTP/1.1 200 OK', ms: 1840, at: Date.now(), auto: false }
          : { pending: false, ok: false, text: 'No answer yet. The descriptor may still be spreading.', ms: 0, at: Date.now(), auto: false }
      })
    },
    async restart () {
      state.phase = 'starting'
      state.error = null
      state.bootstrap = { frac: 0, ready: false, msg: 'Starting', blocked: null }
      emit()
      await new Promise((resolve) => setTimeout(resolve, 1200))
      state.phase = 'running'
      state.bootstrap = { frac: 1, ready: true, msg: 'Done', blocked: null }
      state.socks = { state: 'listening', host: '127.0.0.1', port: 9150, msg: '' }
      emit()
    },
    visitUrl (id) {
      const service = find(id)
      return service && service.onion ? `http://${service.onion}/` : ''
    }
  }

  boot()
  return {
    getState: () => state,
    subscribe (fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    actions
  }
}
