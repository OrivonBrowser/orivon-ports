// One command that gives a person an emulated Ledger Nano X: builds the Ethereum app if needed, (re)starts a
// Speculos container, and plugs a virtual USB Nano X in front of it until Ctrl+C. Our verification helper, not
// Ledger's: README.md, "Testing with an emulated Ledger". The pure parts (environment, docker arguments) are
// exported for emulated-ledger.test.ts; the rest runs only when the file is the entry point.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Ledger Wallet requires Ethereum >= 1.22.5 (its config_nanoapp_ethereum); an older app makes it quit to look for an update. */
export const ETHEREUM_VERSION = '1.22.5'
export const ETHEREUM_TAG = 'nanox_2.7.1_1.22.5_sdk_v26.6.2'
export const SPECULOS_IMAGE = 'ghcr.io/ledgerhq/speculos'
export const BUILDER_IMAGE = 'ghcr.io/ledgerhq/ledger-app-builder/ledger-app-builder-lite:latest'
const ETHEREUM_REPOSITORY = 'https://github.com/LedgerHQ/app-ethereum.git'

/** The models this recipe can build and plug: the USB identity and the SDK variable of Ledger's builder image. */
const MODELS: Readonly<Record<string, { productId: number, name: string, sdk: string }>> = {
  nanox: { productId: 0x4011, name: 'Nano X', sdk: 'NANOX_SDK' }
}
const LEDGER_VENDOR_ID = 0x2c97

export interface EmulatorConfig {
  container: string
  apduPort: number
  restPort: number
  model: string
  serial: string
  hours: number
  speculosDir: string
  mvpRoot: string
  responder: string
}

function port (name: string, text: string): number {
  const value = Number(text)
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a port number from 1 to 65535, got "${text}"`)
  return value
}

/** Reads the environment into a config. `repoRoot` is the orivon-ports checkout; every field has a default. */
export function parseConfig (env: Readonly<Record<string, string | undefined>>, repoRoot: string): EmulatorConfig {
  const container = env['ORIVON_SPECULOS_NAME'] ?? 'orivon-speculos'
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(container)) throw new Error(`ORIVON_SPECULOS_NAME is not a valid container name: "${container}"`)
  const apduPort = port('ORIVON_SPECULOS_APDU_PORT', env['ORIVON_SPECULOS_APDU_PORT'] ?? '9999')
  const restPort = port('ORIVON_SPECULOS_REST_PORT', env['ORIVON_SPECULOS_REST_PORT'] ?? '5000')
  if (apduPort === restPort) throw new Error('the APDU port and the REST port must differ')
  const model = env['ORIVON_SPECULOS_MODEL'] ?? 'nanox'
  if (MODELS[model] === undefined) throw new Error(`ORIVON_SPECULOS_MODEL "${model}" is not supported; supported: ${Object.keys(MODELS).join(', ')}`)
  const serial = env['ORIVON_SPECULOS_SERIAL'] ?? '0001'
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(serial)) throw new Error(`ORIVON_SPECULOS_SERIAL must be 1 to 32 of letters, digits, ".", "_", "-": "${serial}"`)
  const hours = Number(env['ORIVON_SPECULOS_HOURS'] ?? '8')
  if (!(hours > 0 && hours <= 72)) throw new Error('ORIVON_SPECULOS_HOURS must be above 0 and at most 72')
  return {
    container, apduPort, restPort, model, serial, hours,
    speculosDir: join(repoRoot, 'out', 'speculos'),
    mvpRoot: resolve(env['ORIVON_MVP_ROOT'] ?? join(repoRoot, '..', 'orivon-mvp')),
    responder: join(repoRoot, 'apps', 'ledger-wallet', 'test', 'speculos-responder.ts')
  }
}

export function elfName (model: string): string {
  return `app-${ETHEREUM_VERSION}-${model}.elf`
}

/** `docker run` arguments for Speculos: loopback only, restarted when the app exits (Quit app on its screen). */
export function speculosRunArgs (config: EmulatorConfig): string[] {
  return [
    'run', '-d', '--name', config.container, '--restart', 'on-failure',
    '-p', `127.0.0.1:${config.apduPort}:9999`, '-p', `127.0.0.1:${config.restPort}:5000`,
    '-v', `${config.speculosDir}:/apps:ro`,
    SPECULOS_IMAGE, '--model', config.model, `/apps/${elfName(config.model)}`,
    '--display', 'headless', '--apdu-port', '9999', '--api-port', '5000'
  ]
}

export function cloneArgs (directory: string): string[] {
  return ['clone', '--branch', ETHEREUM_TAG, '--depth', '1', '--recurse-submodules', '--shallow-submodules', ETHEREUM_REPOSITORY, directory]
}

/**
 * `docker run` arguments that build the app in Ledger's builder image, as the caller so the files stay theirs.
 * The SDK path is a variable of the image, so make runs through `sh -c`.
 */
export function buildArgs (sourceDir: string, model: string, user?: { uid: number, gid: number }): string[] {
  const sdk = MODELS[model]?.sdk
  if (sdk === undefined) throw new Error(`no build recipe for model "${model}"`)
  return [
    'run', '--rm', '--cpus', '2', '--memory', '3g',
    ...(user === undefined ? [] : ['--user', `${user.uid}:${user.gid}`]),
    '-v', `${sourceDir}:/app`, '-w', '/app', BUILDER_IMAGE,
    'sh', '-c', `make -j2 BOLOS_SDK=$${sdk}`
  ]
}

function docker (args: string[], options: { quiet?: boolean } = {}): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: options.quiet === true ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'] })
}

/** Makes sure `<speculosDir>/app-1.22.5-<model>.elf` exists, building it from Ledger's source when it does not. */
function ensureElf (config: EmulatorConfig): string {
  const elf = join(config.speculosDir, elfName(config.model))
  if (existsSync(elf)) return elf
  mkdirSync(config.speculosDir, { recursive: true })
  const source = join(config.speculosDir, `app-ethereum-${ETHEREUM_TAG}`)
  if (!existsSync(join(source, 'Makefile'))) {
    console.log(`Fetching Ledger's Ethereum app ${ETHEREUM_VERSION} (${ETHEREUM_TAG})...`)
    execFileSync('git', cloneArgs(source), { stdio: 'inherit' })
  }
  console.log('Building it in Ledger\'s builder image (a few minutes, 2 cores, 3 GB)...')
  const user = process.getuid === undefined || process.getgid === undefined ? undefined : { uid: process.getuid(), gid: process.getgid() }
  execFileSync('docker', buildArgs(source, config.model, user), { stdio: 'inherit' })
  const built = join(source, 'build', config.model, 'bin', 'app.elf')
  if (!existsSync(built)) throw new Error(`the build did not produce ${built}`)
  copyFileSync(built, elf)
  return elf
}

function startSpeculos (config: EmulatorConfig): void {
  try { docker(['rm', '-f', config.container], { quiet: true }) } catch { /* none to remove */ }
  docker(speculosRunArgs(config), { quiet: true })
}

async function waitForPort (target: number, seconds: number): Promise<void> {
  for (let attempt = 0; attempt < seconds * 4; attempt++) {
    const open = await new Promise<boolean>((resolveOpen) => {
      const socket = net.connect(target, '127.0.0.1', () => { socket.destroy(); resolveOpen(true) })
      socket.on('error', () => { socket.destroy(); resolveOpen(false) })
    })
    if (open) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`Speculos did not open its APDU port ${target} within ${seconds} s; see: docker logs <container>`)
}

/** The two members of orivon-mvp's virtual-HID harness this file calls; orivon-mvp is not a dependency, so its types are not imported. */
interface VirtualHid {
  startVirtualHidDevice: (options: {
    vendorId: number, productId: number, name: string, serial: string, responder: string, env: Record<string, string>, lifetimeS: number
  }) => Promise<{ node: string, stop: () => Promise<void> }>
  virtualHidAvailable: () => Promise<true | string>
}

async function main (): Promise<void> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const config = parseConfig(process.env, repoRoot)
  const hid = join(config.mvpRoot, 'test', 'support', 'virtual-hid', 'index.ts')
  if (!existsSync(hid)) throw new Error(`orivon-mvp not found at ${config.mvpRoot}; set ORIVON_MVP_ROOT to your checkout`)
  const { startVirtualHidDevice, virtualHidAvailable } = await import(pathToFileURL(hid).href) as VirtualHid
  const why = await virtualHidAvailable()
  if (why !== true) throw new Error(`cannot plug a virtual device: ${why}`)

  ensureElf(config)
  startSpeculos(config)
  await waitForPort(config.apduPort, 30)

  const model = MODELS[config.model]
  if (model === undefined) throw new Error('unreachable: model was validated')
  const device = await startVirtualHidDevice({
    vendorId: LEDGER_VENDOR_ID, productId: model.productId, name: model.name, serial: config.serial,
    responder: config.responder,
    env: { ORIVON_SPECULOS_APDU: `127.0.0.1:${config.apduPort}` },
    lifetimeS: Math.round(config.hours * 3600)
  })
  console.log(`${model.name} (serial ${config.serial}) plugged in at /dev/${device.node}, Ethereum ${ETHEREUM_VERSION} in Speculos "${config.container}".`)
  console.log(`Buttons and screen: http://127.0.0.1:${config.restPort}. Ctrl+C unplugs it (after ${config.hours} h it unplugs itself).`)
  console.log(`Remove the emulator: docker rm -f ${config.container}`)

  let stopping = false
  const unplug = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    await device.stop()
    console.log('Unplugged.')
    process.exit(0)
  }
  process.on('SIGINT', () => { void unplug() })
  process.on('SIGTERM', () => { void unplug() })
  setInterval(() => {}, 1 << 30)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
