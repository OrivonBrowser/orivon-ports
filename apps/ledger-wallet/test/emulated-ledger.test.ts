// The pure parts of the one-command emulator: environment parsing and the docker arguments it builds.
import { describe, expect, it } from 'vitest'
import { buildArgs, cloneArgs, elfName, ETHEREUM_TAG, parseConfig, speculosRunArgs } from './emulated-ledger.ts'

const root = '/work/orivon-ports'

describe('parseConfig', () => {
  it('defaults to the container, ports, model and serial the README names', () => {
    const config = parseConfig({}, root)
    expect(config).toMatchObject({ container: 'orivon-speculos', apduPort: 9999, restPort: 5000, model: 'nanox', serial: '0001', hours: 8 })
    expect(config.speculosDir).toBe('/work/orivon-ports/out/speculos')
    expect(config.mvpRoot).toBe('/work/orivon-mvp')
    expect(config.responder).toBe('/work/orivon-ports/apps/ledger-wallet/test/speculos-responder.ts')
  })

  it('takes every setting from the environment', () => {
    const config = parseConfig({
      ORIVON_SPECULOS_NAME: 'mine', ORIVON_SPECULOS_APDU_PORT: '29999', ORIVON_SPECULOS_REST_PORT: '25000',
      ORIVON_SPECULOS_SERIAL: '0003', ORIVON_SPECULOS_HOURS: '0.5', ORIVON_MVP_ROOT: '/elsewhere/mvp'
    }, root)
    expect(config).toMatchObject({ container: 'mine', apduPort: 29999, restPort: 25000, serial: '0003', hours: 0.5, mvpRoot: '/elsewhere/mvp' })
  })

  it('refuses values that would make a bad docker command or a bad device', () => {
    for (const env of [
      { ORIVON_SPECULOS_NAME: '-rm' }, { ORIVON_SPECULOS_NAME: 'a b' },
      { ORIVON_SPECULOS_APDU_PORT: '0' }, { ORIVON_SPECULOS_APDU_PORT: '70000' }, { ORIVON_SPECULOS_REST_PORT: 'x' },
      { ORIVON_SPECULOS_APDU_PORT: '5000' }, { ORIVON_SPECULOS_MODEL: 'stax' }, { ORIVON_SPECULOS_SERIAL: '' },
      { ORIVON_SPECULOS_SERIAL: 'a/b' }, { ORIVON_SPECULOS_HOURS: '0' }, { ORIVON_SPECULOS_HOURS: '100' }
    ]) {
      expect(() => parseConfig(env, root), JSON.stringify(env)).toThrow()
    }
  })
})

describe('docker arguments', () => {
  it('starts Speculos on loopback only, restarted on failure, with the 1.22.5 app', () => {
    const args = speculosRunArgs(parseConfig({ ORIVON_SPECULOS_NAME: 'mine', ORIVON_SPECULOS_APDU_PORT: '29999', ORIVON_SPECULOS_REST_PORT: '25000' }, root))
    expect(args.slice(0, 6)).toEqual(['run', '-d', '--name', 'mine', '--restart', 'on-failure'])
    expect(args).toContain('127.0.0.1:29999:9999')
    expect(args).toContain('127.0.0.1:25000:5000')
    expect(args).toContain('/work/orivon-ports/out/speculos:/apps:ro')
    expect(args.slice(args.indexOf('--model'))).toEqual(['--model', 'nanox', '/apps/app-1.22.5-nanox.elf', '--display', 'headless', '--apdu-port', '9999', '--api-port', '5000'])
    for (const published of args.filter((_, i) => args[i - 1] === '-p')) expect(published.startsWith('127.0.0.1:')).toBe(true)
  })

  it('builds the app with the SDK of the builder image, capped to 2 cores and 3 GB, as the caller', () => {
    const args = buildArgs('/src', 'nanox', { uid: 1000, gid: 1001 })
    expect(args.slice(0, 7)).toEqual(['run', '--rm', '--cpus', '2', '--memory', '3g', '--user'])
    expect(args).toContain('1000:1001')
    expect(args).toContain('/src:/app')
    expect(args.slice(-3)).toEqual(['sh', '-c', 'make -j2 BOLOS_SDK=$NANOX_SDK'])
    expect(() => buildArgs('/src', 'stax')).toThrow()
  })

  it('clones the pinned tag shallowly with its submodules, and names the app after its version and model', () => {
    expect(cloneArgs('/dest')).toEqual(['clone', '--branch', ETHEREUM_TAG, '--depth', '1', '--recurse-submodules', '--shallow-submodules', 'https://github.com/LedgerHQ/app-ethereum.git', '/dest'])
    expect(elfName('nanox')).toBe('app-1.22.5-nanox.elf')
  })
})
