import { describe, expect, it } from 'vitest'
import { eachApp, positionals, selectApps } from './selection.ts'

const KNOWN = ['asgardex', 'explore', 'freetube']

describe('positionals', () => {
  it('skips every flag, and the value of each flag that takes one', () => {
    expect(positionals(['freetube', '--rebuild', '--port', '9000', 'asgardex', '--emit', 'x', '--global', 'y'])).toEqual(['freetube', 'asgardex'])
  })
})

describe('selectApps', () => {
  it('takes the ids named after the command, in order and once each', () => {
    expect(selectApps(['build', 'freetube', '--rebuild', 'asgardex', 'freetube'], KNOWN)).toEqual(['freetube', 'asgardex'])
  })

  it('takes every known app for --all', () => {
    expect(selectApps(['run', '--all', '--rebuild'], KNOWN)).toEqual(KNOWN)
  })

  it('refuses --all beside named apps, rather than guessing which was meant', () => {
    expect(() => selectApps(['run', 'freetube', '--all'], KNOWN)).toThrow(/--all .*freetube/)
  })

  it('refuses no apps at all, and names the ones it knows', () => {
    expect(() => selectApps(['fetch', '--force'], KNOWN)).toThrow(/fetch needs at least one app id -- known apps: asgardex, explore, freetube/)
  })

  it('refuses --all when there are no apps yet', () => {
    expect(() => selectApps(['build', '--all'], [])).toThrow(/no apps yet/)
  })

  it('lets --port move one app, and refuses it for a list or for --all', () => {
    expect(selectApps(['run', 'freetube', '--port', '9000'], KNOWN)).toEqual(['freetube'])
    expect(() => selectApps(['run', 'freetube', 'asgardex', '--port', '9000'], KNOWN)).toThrow(/--port/)
    expect(() => selectApps(['serve', '--all', '--port', '9000'], KNOWN)).toThrow(/--port/)
  })
})

describe('eachApp', () => {
  const apps = KNOWN.map((id) => ({ id }))

  it('works through the apps one at a time, in order', async () => {
    const events: string[] = []
    const done = await eachApp(apps, async ({ id }) => {
      events.push(`start ${id}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
      events.push(`end ${id}`)
    }, () => {})
    expect(done).toEqual(apps)
    expect(events).toEqual(['start asgardex', 'end asgardex', 'start explore', 'end explore', 'start freetube', 'end freetube'])
  })

  it('keeps going past a failure, says it, and names every failure again at the end', async () => {
    const said: string[] = []
    const ran: string[] = []
    const done = await eachApp(apps, async ({ id }) => {
      ran.push(id)
      if (id !== 'explore') throw new Error(`[${id}] broke`)
    }, (line) => said.push(line))
    expect(ran).toEqual(KNOWN)
    expect(done).toEqual([{ id: 'explore' }])
    expect(said).toEqual(['[asgardex] broke', '[freetube] broke', '[orivon-port] 2 of 3 apps failed: asgardex, freetube'])
  })

  it('throws when every app fails, and names the app on an error that does not', async () => {
    const said: string[] = []
    await expect(eachApp(apps, async () => { throw new Error('ENOENT') }, (line) => said.push(line)))
      .rejects.toThrow('3 of 3 apps failed: asgardex, explore, freetube')
    expect(said).toEqual(['[asgardex] ENOENT', '[explore] ENOENT', '[freetube] ENOENT'])
  })

  it('throws a single app\'s own error, with nothing to summarise', async () => {
    const said: string[] = []
    await expect(eachApp([{ id: 'freetube' }], async () => { throw new Error('[freetube] broke') }, (line) => said.push(line)))
      .rejects.toThrow(/^\[freetube\] broke$/)
    expect(said).toEqual([])
  })
})
