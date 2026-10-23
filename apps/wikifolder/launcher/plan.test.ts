import { describe, expect, it } from 'vitest'
import {
  addressInUseDelay, appendLog, createPacer, APP_URL, downloadNotice, EMPTY_LOG, exitText, forEachLimited, heldPortText, HOST, initArgs, initDone,
  installMismatch, installNeeded, isAddressInUse, isReady, layout, logText, packMismatch, parentOf, parseInstall, popupOutcome, PORT,
  RETRY_DELAYS_MS, serverArgs, serverEnv, staleInstalls, stripAnsi, WRITES_PER_SECOND, wikiExists
} from './plan.js'

const STAMP = '0123456789abcdef01234567'

describe('the install tree', () => {
  const served = { stamp: 'b', files: [['a', 1]] as Array<[string, number]> }

  it('is written when none was, or the stamp differs, and left alone when it matches', () => {
    expect(installNeeded(served, null)).toBe(true)
    expect(installNeeded(served, { stamp: 'a', files: [] })).toBe(true)
    expect(installNeeded(served, { stamp: 'b', files: [] })).toBe(false)
  })

  it('parses install.json and refuses one that names a file outside the tree, a size that is no byte count, or a stamp that is no directory name', () => {
    expect(parseInstall(`{"stamp":"${STAMP}","files":[["boot/boot.js",12],["package.json",0]]}`)).toEqual({ stamp: STAMP, files: [['boot/boot.js', 12], ['package.json', 0]] })
    for (const text of ['{}', `{"stamp":"${STAMP}","files":[]}`, `{"stamp":"${STAMP}","files":[["../x",1]]}`, `{"stamp":"${STAMP}","files":[["/etc/x",1]]}`,
      `{"stamp":"${STAMP}","files":[["a/../../x",1]]}`, `{"stamp":"${STAMP}","files":[["",1]]}`, `{"stamp":"${STAMP}","files":["a"]}`,
      `{"stamp":"${STAMP}","files":[["a",-1]]}`, `{"stamp":"${STAMP}","files":[["a",1.5]]}`, `{"stamp":"${STAMP}","files":[["a","1"]]}`,
      '{"stamp":"../x","files":[["a",1]]}', '{"stamp":"s","files":[["a",1]]}']) {
      expect(() => parseInstall(text), text).toThrow()
    }
  })

  it('says when the served tree is not the one this page\'s server was built to read', () => {
    expect(installMismatch({ stamp: STAMP, files: [['a', 1]] }, STAMP)).toBeNull()
    expect(installMismatch({ stamp: 'f'.repeat(24), files: [['a', 1]] }, STAMP)).toContain('two different builds')
  })

  it('lays the files end to end in the order the index lists them, an empty file taking no room', () => {
    expect(layout([['a', 3], ['b', 0], ['c', 5]])).toEqual([{ name: 'a', offset: 0, size: 3 }, { name: 'b', offset: 3, size: 0 }, { name: 'c', offset: 3, size: 5 }])
  })

  it('refuses a pack whose length is not the sum of the sizes the index gives', () => {
    expect(packMismatch([['a', 3], ['b', 5]], 8)).toBeNull()
    expect(packMismatch([['a', 3], ['b', 5]], 7)).toContain('two different builds')
    expect(packMismatch([['a', 3], ['b', 5]], 9)).toContain('two different builds')
  })

  it('names the directory a file needs, so one recursive mkdir per file is the whole mechanism', () => {
    expect(parentOf('plugins/tiddlywiki/tiddlyweb/plugin.info')).toBe('plugins/tiddlywiki/tiddlyweb')
    expect(parentOf('package.json')).toBe('')
  })

  it('leaves the current tree alone and removes every other entry', () => {
    expect(staleInstalls([STAMP, 'f'.repeat(24), 'boot'], STAMP)).toEqual(['f'.repeat(24), 'boot'])
    expect(staleInstalls([STAMP], STAMP)).toEqual([])
    expect(staleInstalls([], STAMP)).toEqual([])
  })
})

describe('createPacer', () => {
  it('lets the calls in at the rate and no faster, with the clock the test gives it', async () => {
    let clock = 0
    const sleeps: number[] = []
    const pace = createPacer(100, () => clock, async (ms: number) => { sleeps.push(ms); clock += ms })
    for (let call = 0; call < 5; call++) await pace()
    expect(sleeps).toEqual([10, 10, 10, 10])
    expect(clock).toBe(40)
  })

  it('does not wait for a caller that was idle', async () => {
    let clock = 0
    const sleeps: number[] = []
    const pace = createPacer(100, () => clock, async (ms: number) => { sleeps.push(ms); clock += ms })
    await pace()
    clock = 1000
    await pace()
    expect(sleeps).toEqual([])
  })

  it('stays under the broker\'s refill rate of 100 control calls a second', () => {
    expect(WRITES_PER_SECOND).toBeLessThan(100)
  })
})

describe('forEachLimited', () => {
  it('never has more than the limit in flight and visits every item once', async () => {
    let running = 0
    let peak = 0
    const seen: number[] = []
    await forEachLimited([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (item: number) => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 2))
      seen.push(item)
      running -= 1
    })
    expect(peak).toBe(4)
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('stops handing out items after the first failure and rejects with it', async () => {
    const seen: number[] = []
    await expect(forEachLimited([1, 2, 3, 4, 5, 6], 1, async (item: number) => {
      seen.push(item)
      if (item === 2) throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(seen).toEqual([1, 2])
  })
})

describe('what the server and --init are run with', () => {
  it('listens on the loopback address and the port the manifest grants, for the wiki folder it was given', () => {
    expect(serverArgs('/root/wiki')).toEqual(['/root/wiki', '--listen', 'host=127.0.0.1', 'port=8777'])
    expect(HOST).toBe('127.0.0.1')
    expect(APP_URL).toBe(`http://wiki.localhost:${String(PORT)}/`)
  })

  it('makes the wiki with upstream\'s own server edition', () => {
    expect(initArgs('/root/wiki')).toEqual(['/root/wiki', '--init', 'server'])
  })

  it('tells the server where its install tree is, and nothing else', () => {
    expect(serverEnv('/root/install/x')).toEqual({ WIKIFOLDER_INSTALL: '/root/install/x' })
  })
})

describe('reading the server\'s output', () => {
  it('is ready on upstream\'s "Serving on" line, with or without colour codes', () => {
    expect(isReady('Serving on http://127.0.0.1:8777\n')).toBe(true)
    expect(isReady('\u001b[38;5;208mServing on http://127.0.0.1:8777\u001b[0m')).toBe(true)
    expect(isReady('Booting\n(press ctrl-C to exit)')).toBe(false)
  })

  it('recognises a held port', () => {
    expect(isAddressInUse('Error: listen EADDRINUSE: address already in use 127.0.0.1:8777')).toBe(true)
    expect(isAddressInUse('OrivonError: no free port in the granted range\n    at toNodeError')).toBe(true)
    expect(isAddressInUse('Serving on http://127.0.0.1:8777')).toBe(false)
  })

  it('strips colour codes and nothing else', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m text')).toBe('red text')
  })

  it('takes --init as done only on exit 0 with its "Copied edition" line', () => {
    expect(initDone("Copied edition 'server' to /root/wiki\n", 0)).toBe(true)
    expect(initDone("Copied edition 'server' to /root/wiki\n", 1)).toBe(false)
    expect(initDone('Wiki folder is not empty\n', 0)).toBe(false)
  })

  it('takes a folder with tiddlywiki.info as a wiki', () => {
    expect(wikiExists(['tiddlers', 'tiddlywiki.info'])).toBe(true)
    expect(wikiExists(['tiddlers'])).toBe(false)
    expect(wikiExists([])).toBe(false)
  })
})

describe('a start that finds the port held', () => {
  it('retries only when the port was this page\'s own a moment ago, through the delays and then gives up', () => {
    expect(addressInUseDelay(0, false)).toBeNull()
    expect(RETRY_DELAYS_MS.map((_, attempt) => addressInUseDelay(attempt, true))).toEqual([...RETRY_DELAYS_MS])
    expect(addressInUseDelay(RETRY_DELAYS_MS.length, true)).toBeNull()
  })

  it('names the port when it stays held and nothing loaded', () => {
    expect(heldPortText()).toContain('8777')
  })
})

describe('the log', () => {
  it('keeps whole lines, holds the unfinished one, and drops the oldest past the limit', () => {
    let log = appendLog(EMPTY_LOG, 'one\ntwo\nthr')
    expect(log).toEqual({ lines: ['one', 'two'], tail: 'thr' })
    log = appendLog(log, 'ee\nfour\n', 3)
    expect(logText(log)).toBe('two\nthree\nfour')
  })
})

describe('what a shown page may ask of the app', () => {
  it('opens a web address in a tab and names anything else', () => {
    expect(popupOutcome({ url: 'https://tiddlywiki.com/' })).toEqual({ kind: 'open', url: 'https://tiddlywiki.com/' })
    expect(popupOutcome({ url: 'about:blank' }).kind).toBe('notice')
    expect(popupOutcome({ url: 'mailto:a@b.c' })).toMatchObject({ kind: 'notice', text: expect.stringContaining('mailto:') })
    expect(popupOutcome({ url: 'not an address' })).toMatchObject({ kind: 'notice' })
    expect(popupOutcome(undefined).kind).toBe('notice')
  })

  it('says a download was not kept, with its name, type and size', () => {
    expect(downloadNotice({ filename: 'wiki.html', mimeType: 'text/html', totalBytes: 2 * 1024 * 1024 })).toBe('The page started a download of wiki.html (text/html, 2.0 MiB). Orivon does not save files from a shown page.')
    expect(downloadNotice({})).toContain('unknown type')
  })

  it('says how the server ended, and whether it had been ready', () => {
    expect(exitText(1, null, false)).toContain('before it was ready (exit code 1)')
    expect(exitText(null, 'SIGKILL', true)).toBe('The server stopped (signal SIGKILL).')
  })
})
