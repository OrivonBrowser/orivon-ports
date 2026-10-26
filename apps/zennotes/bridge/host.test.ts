// What the page says about the computer and the build, and the features this build hides.
import { describe, expect, it } from 'vitest'
import { adjustHost, CAPABILITY_OVERRIDES, engine, FIRST_RUN_PREFS, installInfo, platform, seedFirstRun } from './host.js'
import { PREFS_KEY } from './build-plan.js'

const nav = (fields: object) => fields as Navigator

describe('platform', () => {
  it('reads the operating system from the browser, not from the shim\'s fixed answer', () => {
    expect(platform(nav({ userAgentData: { platform: 'macOS' } }))).toBe('darwin')
    expect(platform(nav({ platform: 'MacIntel' }))).toBe('darwin')
    expect(platform(nav({ platform: 'Win32' }))).toBe('win32')
    expect(platform(nav({ userAgentData: { platform: 'Windows' } }))).toBe('win32')
    expect(platform(nav({ platform: 'Linux x86_64' }))).toBe('linux')
    expect(platform(nav({}))).toBe('linux')
  })

  it('names the system for the about screen, and the build as an Orivon app', () => {
    expect(installInfo(nav({ platform: 'MacIntel' }))).toEqual({ os: 'macOS', install: 'Orivon app' })
  })
})

describe('engine', () => {
  it('names the browser the app runs in', () => {
    expect(engine(nav({ userAgent: 'Mozilla/5.0 Chrome/146.0.7680.0 Safari/537.36' }))).toBe('Orivon (Chromium 146.0.7680.0)')
    expect(engine(nav({ userAgent: '' }))).toBe('Orivon')
  })
})

describe('adjustHost', () => {
  const upstream = () => ({
    getCapabilities: () => ({ supportsCloudSync: true, supportsLocalFilesystemPickers: true, supportsWorkflows: true, supportsUpdater: true }),
    getAppInfo: () => ({ productName: 'ZenNotes', engine: 'Electron undefined' }),
    platformSync: () => 'linux'
  })

  it('hides what the build cannot back and keeps what it can', () => {
    const zen = adjustHost(upstream() as never, nav({ platform: 'MacIntel', userAgent: '' })) as unknown as ReturnType<typeof upstream>
    expect(zen.getCapabilities()).toMatchObject({ supportsCloudSync: false, supportsUpdater: false, supportsLocalFilesystemPickers: true, supportsWorkflows: true })
    expect(zen.getAppInfo()).toEqual({ productName: 'ZenNotes', engine: 'Orivon' })
    expect(zen.platformSync()).toBe('darwin')
  })

  it('overrides only features, each to false', () => {
    for (const [name, value] of Object.entries(CAPABILITY_OVERRIDES)) {
      expect(name, name).toMatch(/^supports[A-Z]/)
      expect(value, name).toBe(false)
    }
  })
})

describe('seedFirstRun', () => {
  const storage = (initial: Record<string, string> = {}) => {
    const items = new Map(Object.entries(initial))
    return { items, getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value) } } as unknown as Storage & { items: Map<string, string> }
  }

  it('starts a first run with ordinary typing and no dead window buttons, and still shows the welcome steps', () => {
    const empty = storage()
    expect(seedFirstRun(empty)).toBe(true)
    expect(JSON.parse(empty.items.get(PREFS_KEY) as string)).toEqual({ vimMode: false, showWindowTitleBar: false, hasCompletedOnboarding: false })
    expect(FIRST_RUN_PREFS.hasCompletedOnboarding).toBe(false)
  })

  it('writes nothing once the page has preferences, so a choice made later is kept, Vim on included', () => {
    const stored = storage({ [PREFS_KEY]: '{"vimMode":true}' })
    expect(seedFirstRun(stored)).toBe(false)
    expect(stored.items.get(PREFS_KEY)).toBe('{"vimMode":true}')
  })

  it('leaves storage that throws alone', () => {
    const blocked = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } } as unknown as Storage
    expect(seedFirstRun(blocked)).toBe(false)
  })
})
