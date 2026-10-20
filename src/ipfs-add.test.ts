import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cidOfTree, ipfsAddCommand, kuboVersion } from './ipfs-add.ts'

const maintain = await readFile(new URL('../.claude/skills/orivon-porting/maintain.md', import.meta.url), 'utf8')
const attested = await readFile(new URL('../.github/workflows/build-attested.yml', import.meta.url), 'utf8')

describe('the one flag set for app trees', () => {
  it('is the set every published CID was made with', () => {
    expect(ipfsAddCommand('<dir>')).toBe('ipfs add -r -H --cid-version=1 -Q <dir>')
  })

  it('is the set the maintenance guide documents, character for character', () => {
    expect(maintain).toContain(`\`${ipfsAddCommand('<dir>')}\``)
  })

  it('reaches the attested build only through the CLI, never as a second spelling of the flags', () => {
    expect(attested).toMatch(/src\/cli\.ts cid /)
    expect(attested).not.toMatch(/ipfs add/)
  })
})

describe.skipIf(await kuboVersion() === undefined)('cidOfTree', () => {
  async function tree (files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'orivon-cid-'))
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(root, path, '..'), { recursive: true })
      await writeFile(join(root, path), text)
    }
    return root
  }

  it('gives a CIDv1 that depends on content and names, and not on when the files were written', async () => {
    const files = { 'index.html': '<p>hi</p>\n', '.well-known/orivon.json': '{}\n' }
    const first = await tree(files)
    const second = await tree(files)
    const other = await tree({ ...files, 'index.html': '<p>ho</p>\n' })
    try {
      const cid = await cidOfTree(first)
      expect(cid).toMatch(/^bafy[a-z2-7]+$/)
      expect(await cidOfTree(second)).toBe(cid)
      expect(await cidOfTree(other)).not.toBe(cid)
    } finally {
      await Promise.all([first, second, other].map((dir) => rm(dir, { recursive: true, force: true })))
    }
  })

  it('counts a dot directory in the tree, which is why -H is in the set', async () => {
    const bare = await tree({ 'index.html': '<p>hi</p>\n' })
    const withManifest = await tree({ 'index.html': '<p>hi</p>\n', '.well-known/orivon.json': '{}\n' })
    try {
      expect(await cidOfTree(withManifest)).not.toBe(await cidOfTree(bare))
    } finally {
      await Promise.all([bare, withManifest].map((dir) => rm(dir, { recursive: true, force: true })))
    }
  })
})
