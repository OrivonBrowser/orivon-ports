// The pure parts of the emulated-Ledger responder: HID framing both ways on a host-chosen channel,
// and the dashboard answers Ledger Wallet's connect flow depends on (hex taken from a real run).
import { describe, expect, it } from 'vitest'
import { ApduAssembler, Bolos, frameResponse } from './speculos-responder.ts'

const hex = (bytes: Uint8Array | Buffer): string => Buffer.from(bytes).toString('hex')

/** What a host writes: the same framing, with the APDU length on the first packet. */
function hostPackets (apdu: Uint8Array, channel: number): Uint8Array[] {
  return frameResponse(apdu, channel)
}

describe('HID framing', () => {
  it('reassembles an APDU from several packets on a random channel and remembers the channel', () => {
    for (const channel of [0x0101, 0x11b9, 0xbeef, 0xffff, 0x0000]) {
      const apdu = Uint8Array.from({ length: 150 }, (_, i) => i & 0xff)
      const assembler = new ApduAssembler()
      const packets = hostPackets(apdu, channel)
      expect(packets).toHaveLength(3)
      const results = packets.map((packet) => assembler.push(packet))
      expect(results[0]).toBeUndefined()
      expect(results[1]).toBeUndefined()
      expect(hex(results[2]!)).toBe(hex(apdu))
      expect(assembler.channel).toBe(channel)
    }
  })

  it('answers on the channel the host used, in 64-byte packets with a length on the first', () => {
    const answer = Buffer.alloc(100, 0xab)
    const packets = frameResponse(answer, 0x6cd2)
    expect(packets.map((p) => p.length)).toEqual([64, 64])
    expect(hex(packets[0]!.subarray(0, 7))).toBe('6cd2050000' + '0064')
    expect(hex(packets[1]!.subarray(0, 5))).toBe('6cd2050001')
  })

  it('frames a short answer in one packet and a 57-byte one exactly', () => {
    expect(frameResponse(Buffer.from('9000', 'hex'), 0x0101)).toHaveLength(1)
    expect(frameResponse(Buffer.alloc(57), 0x0101)).toHaveLength(1)
    expect(frameResponse(Buffer.alloc(58), 0x0101)).toHaveLength(2)
  })

  it('refuses a packet out of order, and one that is not an APDU', () => {
    const assembler = new ApduAssembler()
    const [first, second, third] = hostPackets(new Uint8Array(150), 0x1234)
    assembler.push(first!)
    expect(() => assembler.push(third!)).toThrow(/out of order/)
    expect(() => new ApduAssembler().push(Uint8Array.from([0x01, 0x01, 0x02, 0, 0, 0, 0]))).toThrow(/not an APDU/)
    void second
  })

  it('starts a new APDU after a complete one', () => {
    const assembler = new ApduAssembler()
    expect(hex(assembler.push(hostPackets(Buffer.from('b001000000', 'hex'), 0x4242)[0]!)!)).toBe('b001000000')
    expect(hex(assembler.push(hostPackets(Buffer.from('e001000000', 'hex'), 0x4242)[0]!)!)).toBe('e001000000')
  })
})

describe('the emulated dashboard', () => {
  const apdu = (text: string): Buffer => Buffer.from(text, 'hex')

  it('starts with the app open, so its APDUs belong to Speculos', () => {
    const bolos = new Bolos()
    expect(bolos.answer(apdu('b001000000'))).toBeUndefined()
    expect(bolos.answer(apdu('e002000015'))).toBeUndefined()
  })

  it('quits to the dashboard on B0A7 without ending Speculos, then answers as BOLOS', () => {
    const bolos = new Bolos()
    expect(hex(bolos.answer(apdu('b0a7000000'))!)).toBe('9000')
    expect(bolos.state).toBe('dashboard')
    expect(hex(bolos.answer(apdu('b001000000'))!)).toBe('0105424f4c4f5305322e322e3301009000')
    expect(hex(bolos.answer(apdu('e001000000'))!)).toBe('3300000405322e322e3304e600000b04322e333004312e31360100010001009000')
  })

  it('agrees to the secure-channel start (E004) and refuses what it does not know', () => {
    const bolos = new Bolos()
    bolos.answer(apdu('b0a7000000'))
    expect(hex(bolos.answer(apdu('e00400000433000004'))!)).toBe('9000')
    expect(hex(bolos.answer(apdu('e064000000'))!)).toBe('6d00')
    expect(hex(bolos.answer(apdu('e0500000081ced212481b84398'))!)).toBe('6d00')
  })

  it('opens Ethereum and hands later APDUs to the app, and refuses another app by name', () => {
    const bolos = new Bolos()
    bolos.answer(apdu('b0a7000000'))
    const open = (name: string): Buffer => apdu(`e0d80000${name.length.toString(16).padStart(2, '0')}${Buffer.from(name).toString('hex')}`)
    expect(hex(bolos.answer(open('Bitcoin'))!)).toBe('6807')
    expect(bolos.state).toBe('dashboard')
    expect(hex(bolos.answer(open('Ethereum'))!)).toBe('9000')
    expect(bolos.state).toBe('app')
    expect(bolos.answer(apdu('e002000015'))).toBeUndefined()
  })
})
