// The page's link to torsocksd. A daemon this app already runs (another tab
// started it, or this page before a reload) is found on its control port and
// joined; otherwise one is spawned, through Orivon's Node shim, as a
// WebAssembly program of the app's own. Either way every event arrives over
// the control connection, so all of the app's tabs see the same thing.

import { spawn } from 'child_process'

import { BUSY_TEXT } from './events.js'
import { DAEMON_ROOT } from './files.js'

export const PROGRAM = '/bin/torsocksd'
export const SOCKS_PORTS = '9150-9158'
export const CONTROL_PORT = 9159
const ATTACH_WAIT_MS = 90_000
const RETRY_MS = 500
const REJOIN_ATTEMPTS = 6
const STDERR_KEPT = 4096

const encoder = new TextEncoder()

/** Splits a byte stream into lines; the last partial line waits for more. */
export function lineSplitter () {
  const decoder = new TextDecoder()
  let pending = ''
  return (bytes) => {
    pending += decoder.decode(bytes, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    return lines.filter((line) => line.trim() !== '')
  }
}

class Refused extends Error {}

/** One authenticated control connection; resolves once the daemon welcomed it. */
async function connect (key, onEvent, onClose) {
  const socket = await window.orivon.net.connect({ host: '127.0.0.1', port: CONTROL_PORT })
  const writer = socket.writable.getWriter()
  const reader = socket.readable.getReader()
  const split = lineSplitter()
  await writer.write(encoder.encode(`${JSON.stringify({ op: 'hello', key })}\n`))
  let welcomed = false
  const first = new Promise((resolve, reject) => {
    const pump = async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          for (const line of split(value)) {
            let event
            try { event = JSON.parse(line) } catch { continue }
            if (!welcomed) {
              if (event.t !== 'welcome') { reject(new Refused('refused')); return }
              welcomed = true
              resolve()
            }
            onEvent(event)
          }
        }
      } catch {
        // A reset reads as the end of the connection.
      }
      if (!welcomed) reject(new Error('the daemon closed the connection'))
      else onClose()
    }
    pump()
  })
  await first
  return {
    send: (command) => writer.write(encoder.encode(`${JSON.stringify(command)}\n`)),
    close: () => socket.close()
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * `onEvent(event)` hears every daemon event; `onPhase(phase, error)` hears
 * 'checking', 'starting', 'running' and 'failed'.
 */
export function createDaemonLink ({ key, onEvent, onPhase }) {
  let link = null
  let child = null
  let childExit = null
  let stderr = ''
  let stopping = false

  const attach = async () => {
    link = await connect(key, onEvent, () => {
      link = null
      if (!stopping) rejoin()
    })
    onPhase('running', null)
  }

  const tryAttach = async () => {
    try {
      await attach()
      return true
    } catch (error) {
      if (error instanceof Refused) throw new Error(BUSY_TEXT)
      return false
    }
  }

  const spawnDaemon = (publish) => {
    stderr = ''
    childExit = null
    const args = ['--data', DAEMON_ROOT, '--socks-port', SOCKS_PORTS, '--control-port', String(CONTROL_PORT)]
    if (publish.length > 0) args.push('--publish', publish.join(','))
    const started = spawn(PROGRAM, args)
    child = started
    const split = lineSplitter()
    started.stdout.on('data', (chunk) => {
      // Before the control port answers, only a fatal start has to come this way.
      for (const line of split(chunk)) {
        try {
          const event = JSON.parse(line)
          if (event.t === 'fatal' && link === null) onEvent(event)
        } catch {}
      }
    })
    const errors = lineSplitter()
    started.stderr.on('data', (chunk) => {
      const text = new TextDecoder().decode(chunk)
      stderr = (stderr + text).slice(-STDERR_KEPT)
      // What the program says on stderr (a Rust panic among it) belongs in the log the person reads.
      for (const line of errors(chunk)) onEvent({ t: 'log', level: 'WARN', target: 'torsocksd stderr', msg: line })
    })
    started.on('error', (error) => { childExit = error.message })
    started.on('exit', (code, signal) => {
      childExit = `the daemon ended (${signal ?? `code ${String(code)}`})${stderr.trim() === '' ? '' : `: ${stderr.trim().split('\n').slice(-3).join(' ')}`}`
      if (child === started) child = null
    })
  }

  const start = async (publish) => {
    stopping = false
    onPhase('checking', null)
    try {
      if (await tryAttach()) return
      onPhase('starting', null)
      spawnDaemon(publish)
      const deadline = Date.now() + ATTACH_WAIT_MS
      while (Date.now() < deadline) {
        if (childExit !== null) throw new Error(childExit)
        if (await tryAttach()) return
        await sleep(RETRY_MS)
      }
      throw new Error('The Tor daemon did not answer within 90 seconds.')
    } catch (error) {
      onPhase('failed', error instanceof Error ? error.message : String(error))
    }
  }

  const rejoin = async () => {
    onPhase('checking', null)
    for (let attempt = 0; attempt < REJOIN_ATTEMPTS && !stopping; attempt++) {
      if (childExit !== null) break
      await sleep(RETRY_MS * (attempt + 1))
      if (await tryAttach().catch(() => false)) return
    }
    if (!stopping) onPhase('failed', childExit ?? 'The connection to the Tor daemon was lost.')
  }

  return {
    start,
    send (command) {
      if (link === null) return false
      link.send(command).catch(() => {})
      return true
    },
    /** Asks the daemon to quit, waits for its port to close, then starts it again. */
    async restart (publish) {
      stopping = true
      if (link !== null) {
        link.send({ op: 'quit' }).catch(() => {})
        link.close().catch(() => {})
        link = null
      }
      child?.kill()
      for (let i = 0; i < 20; i++) {
        await sleep(RETRY_MS)
        const probe = await window.orivon.net.connect({ host: '127.0.0.1', port: CONTROL_PORT }).catch(() => null)
        if (probe === null) break
        await probe.close().catch(() => {})
      }
      await start(publish)
    }
  }
}
