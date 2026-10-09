// A virtual-HID responder that makes mvp's virtual device answer like a USB Ledger Nano X
// backed by Speculos. Our verification helper, not Ledger's: README.md, "Testing with an emulated Ledger".
// Ledger HID framing: channel (2 bytes, chosen by the host), tag 0x05, sequence (2), and on the first
// packet a 2-byte APDU length. Speculos' APDU port: 4-byte big-endian length + APDU in, and
// 4-byte big-endian (length - 2) + data + status word out.
import net from 'node:net'

const TAG_APDU = 0x05
const PACKET = 64
const OK = Buffer.from('9000', 'hex')
const at = (bytes: Uint8Array, index: number): number => bytes[index] ?? 0
const ascii = (text: string): string => Buffer.from(text).toString('hex')

/** Splits an answer into 64-byte packets on the host's channel. */
export function frameResponse (data: Uint8Array, channel: number): Uint8Array[] {
  const packets: Uint8Array[] = []
  let offset = 0
  let seq = 0
  do {
    const packet = new Uint8Array(PACKET)
    packet.set([channel >> 8, channel & 0xff, TAG_APDU, seq >> 8, seq & 0xff])
    let head = 5
    if (seq === 0) {
      packet.set([data.length >> 8, data.length & 0xff], 5)
      head = 7
    }
    const chunk = data.subarray(offset, offset + PACKET - head)
    packet.set(chunk, head)
    offset += chunk.length
    packets.push(packet)
    seq++
  } while (offset < data.length)
  return packets
}

/** Rebuilds APDUs from packets. The channel is whatever the host used on its first packet: DMK picks one at random. */
export class ApduAssembler {
  channel = 0x0101
  private expected = -1
  private nextSeq = 0
  private parts: Uint8Array[] = []
  private received = 0

  /** Returns a complete APDU once its last packet arrives, otherwise undefined. */
  push (packet: Uint8Array): Uint8Array | undefined {
    const channel = (at(packet, 0) << 8) | at(packet, 1)
    const seq = (at(packet, 3) << 8) | at(packet, 4)
    if (seq === 0 && at(packet, 2) === TAG_APDU) this.channel = channel
    if (channel !== this.channel || at(packet, 2) !== TAG_APDU) throw new Error(`not an APDU packet: ${Buffer.from(packet.subarray(0, 5)).toString('hex')}`)
    if (seq !== this.nextSeq) throw new Error(`packet ${seq} out of order, expected ${this.nextSeq}`)
    let body: Uint8Array
    if (seq === 0) {
      this.expected = (at(packet, 5) << 8) | at(packet, 6)
      this.parts = []
      this.received = 0
      body = packet.subarray(7)
    } else {
      body = packet.subarray(5)
    }
    const take = body.subarray(0, Math.min(body.length, this.expected - this.received))
    this.parts.push(take)
    this.received += take.length
    this.nextSeq++
    if (this.received < this.expected) return undefined
    this.nextSeq = 0
    return Buffer.concat(this.parts)
  }
}

/**
 * A real Ledger sits at its dashboard (BOLOS) until an app opens, and "quit app" (B0A7) returns to it.
 * Speculos runs one app and exits when it quits, so the dashboard is emulated for the commands Ledger
 * Wallet's connect flow sends there; everything else goes to the app. Starts with Ethereum open.
 */
export class Bolos {
  state: 'dashboard' | 'app' = 'app'
  private readonly osVersion = Buffer.from(`3300000405${ascii('2.2.3')}04e600000b04${ascii('2.30')}04${ascii('1.16')}0100010001009000`, 'hex')
  private readonly dashboardApp = Buffer.from(`0105${ascii('BOLOS')}05${ascii('2.2.3')}01009000`, 'hex')

  /** True when the last answer moved the device between the dashboard and an app; a real Ledger replugs then. */
  switched = false

  /** The answer for an APDU the emulated dashboard handles, or undefined when it belongs to the app in Speculos. */
  answer (apdu: Uint8Array): Buffer | undefined {
    const before = this.state
    const answer = this.decide(apdu)
    this.switched = this.state !== before
    return answer
  }

  private decide (apdu: Uint8Array): Buffer | undefined {
    const request = Buffer.from(apdu)
    const head = request.subarray(0, 4).toString('hex')
    if (head === 'b0a70000') {
      this.state = 'dashboard'
      return OK
    }
    if (this.state === 'app') return undefined
    if (head === 'b0010000') return this.dashboardApp
    if (head === 'e0010000') return this.osVersion
    if (head === 'e0040000') return OK
    if (head === 'e0d80000') {
      if (request.subarray(5, 5 + at(request, 4)).toString() !== 'Ethereum') return Buffer.from('6807', 'hex')
      this.state = 'app'
      return OK
    }
    return Buffer.from('6d00', 'hex')
  }
}

const [host, portText] = (process.env['ORIVON_SPECULOS_APDU'] ?? '127.0.0.1:9999').split(':')
let socket: net.Socket | undefined
let buffered = Buffer.alloc(0)
let waiting: ((answer: Buffer) => void) | undefined

function connect (): Promise<net.Socket> {
  if (socket !== undefined && !socket.destroyed) return Promise.resolve(socket)
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(portText), host, () => { socket = s; resolve(s) })
    s.on('error', reject)
    s.on('close', () => { socket = undefined })
    s.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.length < 4) return
      const total = buffered.readUInt32BE(0) + 2
      if (buffered.length < 4 + total) return
      const answer = buffered.subarray(4, 4 + total)
      buffered = buffered.subarray(4 + total)
      const done = waiting
      waiting = undefined
      done?.(Buffer.from(answer))
    })
  })
}

async function exchange (apdu: Uint8Array): Promise<Buffer> {
  const s = await connect()
  const header = Buffer.alloc(4)
  header.writeUInt32BE(apdu.length)
  const answer = new Promise<Buffer>((resolve) => { waiting = resolve })
  s.write(Buffer.concat([header, apdu]))
  return await answer
}

const assembler = new ApduAssembler()
const bolos = new Bolos()

export default async function respond (
  report: Uint8Array, send: (report: Uint8Array) => void, device?: { replug: () => void }
): Promise<void> {
  const apdu = assembler.push(report)
  if (apdu === undefined) return
  process.stdout.write(`apdu > ${Buffer.from(apdu).toString('hex')}  [${bolos.state}]\n`)
  const answer = bolos.answer(apdu) ?? await exchange(apdu)
  process.stdout.write(`apdu < ${answer.toString('hex')}\n`)
  for (const packet of frameResponse(answer, assembler.channel)) send(packet)
  // A Ledger leaves the bus and comes back after opening or quitting an app, and Ledger Wallet waits for that.
  if (bolos.switched) device?.replug()
}
