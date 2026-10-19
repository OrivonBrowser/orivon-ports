// Keccak-256 as Ethereum uses it: the original Keccak padding (0x01), not NIST SHA-3's (0x06).
// Lanes are BigInts; a handful of hashes per page load makes speed irrelevant.

const MASK = (1n << 64n) - 1n
const RATE = 136

/** @param {bigint} value @param {number} bits */
const rotl = (value, bits) => (bits === 0 ? value : ((value << BigInt(bits)) | (value >> BigInt(64 - bits))) & MASK)

/** The 24 round constants, from the Keccak LFSR. */
const ROUND_CONSTANTS = (() => {
  const out = []
  let lfsr = 1
  for (let round = 0; round < 24; round++) {
    let constant = 0n
    for (let j = 0; j < 7; j++) {
      lfsr = ((lfsr << 1) ^ ((lfsr >> 7) * 0x71)) & 0xff
      if (lfsr & 2) constant |= 1n << BigInt((1 << j) - 1)
    }
    out.push(constant)
  }
  return out
})()

/** @param {bigint[]} state 25 lanes, index x + 5y */
function permute (state) {
  for (const constant of ROUND_CONSTANTS) {
    const column = []
    for (let x = 0; x < 5; x++) column.push(state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20])
    for (let x = 0; x < 5; x++) {
      const mix = column[(x + 4) % 5] ^ rotl(column[(x + 1) % 5], 1)
      for (let y = 0; y < 5; y++) state[x + 5 * y] = state[x + 5 * y] ^ mix
    }
    let x = 1
    let y = 0
    let current = state[1]
    for (let t = 0; t < 24; t++) {
      const next = [y, (2 * x + 3 * y) % 5]
      x = next[0]
      y = next[1]
      const held = state[x + 5 * y]
      state[x + 5 * y] = rotl(current, (((t + 1) * (t + 2)) / 2) % 64)
      current = held
    }
    for (let row = 0; row < 5; row++) {
      const line = state.slice(5 * row, 5 * row + 5)
      for (let col = 0; col < 5; col++) {
        state[col + 5 * row] = line[col] ^ (~line[(col + 1) % 5] & MASK & line[(col + 2) % 5])
      }
    }
    state[0] = state[0] ^ constant
  }
}

/**
 * @param {Uint8Array} input
 * @returns {Uint8Array} 32 bytes
 */
export function keccak256 (input) {
  const padded = new Uint8Array(Math.ceil((input.length + 1) / RATE) * RATE)
  padded.set(input)
  padded[input.length] ^= 0x01
  padded[padded.length - 1] = padded[padded.length - 1] ^ 0x80
  const state = new Array(25).fill(0n)
  for (let block = 0; block < padded.length; block += RATE) {
    for (let lane = 0; lane < RATE / 8; lane++) {
      let value = 0n
      for (let b = 7; b >= 0; b--) value = (value << 8n) | BigInt(padded[block + lane * 8 + b])
      state[lane] ^= value
    }
    permute(state)
  }
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = Number((state[Math.floor(i / 8)] >> BigInt(8 * (i % 8))) & 0xffn)
  return out
}
