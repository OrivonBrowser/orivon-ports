// Labels the registrar's isValidLabel decides on, with the answer its rules give. The unit tests check the site's
// copy of the rule against this table, and the fork tests check the deployed contract against the same table.

const hex40 = '1234567890abcdef1234567890abcdef12345678'

export const LABEL_CASES: [label: string, valid: boolean][] = [
  ['abc', true], ['a-b', true], ['a1b', true], ['123', true], ['ab-cd', true], ['a--b', true], ['a'.repeat(63), true],
  ['0x' + hex40.slice(0, 39), true], ['0x' + hex40 + 'a', true], ['0xg' + hex40.slice(0, 39), true], ['0x' + hex40.slice(0, 38) + '-a', true],
  ['', false], ['a', false], ['ab', false], ['a'.repeat(64), false], ['-abc', false], ['abc-', false], ['---', false],
  ['ab--c', false], ['xn--abc', false], ['Alice', false], ['ABC', false], ['a_b', false], ['a.b', false], ['a b', false],
  ['abc\n', false], [' abc', false], ['a\u0000b', false], ['café', false], ['ａｂｃ', false], ['abc​', false],
  ['0x' + hex40, false], ['0x' + '0'.repeat(40), false], ['0x' + 'f'.repeat(40), false], ['0x' + 'F'.repeat(40), false]
]
