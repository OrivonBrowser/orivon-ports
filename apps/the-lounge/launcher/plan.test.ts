import { describe, expect, it } from 'vitest'
import {
  accountCreated, accountProblems, addArgs, appendLog, APP_URL, directoriesOf, downloadNotice, EMPTY_LOG, exitText,
  hasAccounts, installNeeded, isAddressInUse, isReady, logText, parseInstall, popupOutcome, serverArgs, serverEnv, stripAnsi
} from './plan.js'

describe('the install tree', () => {
  const served = { stamp: 'b', files: ['a'] }

  it('is written when none was, or the stamp differs, and left alone when it matches', () => {
    expect(installNeeded(served, null)).toBe(true)
    expect(installNeeded(served, { stamp: 'a', files: [] })).toBe(true)
    expect(installNeeded(served, { stamp: 'b', files: [] })).toBe(false)
  })

  it('parses install.json and refuses one that names a file outside the tree', () => {
    expect(parseInstall('{"stamp":"s","files":["public/index.html"]}')).toEqual({ stamp: 's', files: ['public/index.html'] })
    for (const text of ['{}', '{"stamp":"s","files":[]}', '{"stamp":"s","files":["../x"]}', '{"stamp":"s","files":["/etc/x"]}', '{"stamp":"s","files":["a/../../x"]}', '{"stamp":"s","files":[""]}']) {
      expect(() => parseInstall(text), text).toThrow()
    }
  })

  it('lists each parent directory once, shortest first, so mkdir needs no recursion', () => {
    expect(directoriesOf(['public/assets/a.js', 'public/index.html', 'dist/defaults/config.js'])).toEqual(['dist', 'public', 'dist/defaults', 'public/assets'])
    expect(directoriesOf(['LICENSE'])).toEqual([])
  })
})

describe('the server', () => {
  it('is started on the loopback address and the port the manifest lists, and shown at the origin the manifest\'s pattern admits', () => {
    expect(serverArgs()).toEqual(['start', '-c', 'port=9000', '-c', 'host=127.0.0.1'])
    expect(APP_URL).toBe('http://lounge.localhost:9000/')
  })

  it('gets its home, the installed layout, and no search for native accelerators', () => {
    expect(serverEnv('/orivon/app/lounge-home')).toEqual({
      THELOUNGE_HOME: '/orivon/app/lounge-home', NODE_ENV: 'production', WS_NO_BUFFER_UTIL: '1', WS_NO_UTF_8_VALIDATE: '1'
    })
  })

  it('is ready on upstream\'s own line, coloured or not, and not before', () => {
    expect(isReady('The Lounge 4.5.2 (Node.js 22)\nConfiguration file: /x\n')).toBe(false)
    expect(isReady('Available at http://127.0.0.1:9000/ in private mode')).toBe(true)
    expect(isReady('Available at \u001b[32mhttp://127.0.0.1:9000/\u001b[39m in \u001b[1mprivate\u001b[22m mode')).toBe(true)
  })

  it('reports a held port from the error upstream logs', () => {
    expect(isAddressInUse('Error: listen EADDRINUSE: address already in use 127.0.0.1:9000')).toBe(true)
    expect(isAddressInUse('Available at http://127.0.0.1:9000/')).toBe(false)
  })

  it('says how it ended, and whether it had been ready', () => {
    expect(exitText(1, null, false)).toBe('The server stopped before it was ready (exit code 1). The log below says why.')
    expect(exitText(null, 'SIGKILL', true)).toBe('The server stopped (signal SIGKILL).')
  })
})

describe('the log', () => {
  it('keeps whole lines, holds an unfinished one, and joins a line split across chunks', () => {
    let log = appendLog(EMPTY_LOG, 'one\ntw')
    expect(log).toEqual({ lines: ['one'], tail: 'tw' })
    log = appendLog(log, 'o\nthree\r\nfo')
    expect(log).toEqual({ lines: ['one', 'two', 'three'], tail: 'fo' })
    expect(logText(log)).toBe('one\ntwo\nthree\nfo')
  })

  it('strips colour and keeps only the last lines', () => {
    const log = appendLog(EMPTY_LOG, '\u001b[32ma\u001b[39m\nb\nc\nd\n', 2)
    expect(log.lines).toEqual(['c', 'd'])
    expect(stripAnsi('\u001b[1mx\u001b[22m')).toBe('x')
  })
})

describe('the first account', () => {
  const ok = { name: 'alice', password: 'correct horse', confirm: 'correct horse' }

  it('accepts a plain name and matching passwords', () => {
    expect(accountProblems(ok)).toEqual([])
  })

  it('refuses each way the name would break the file name or the command line', () => {
    for (const name of ['', ' ', ' a', 'a ', 'a/b', 'a\\b', 'a:b', '-x', '.hidden', '..', 'a'.repeat(65), 'a\u0000b']) {
      expect(accountProblems({ ...ok, name }), JSON.stringify(name)).not.toEqual([])
    }
  })

  it('refuses an empty password and two that differ', () => {
    expect(accountProblems({ ...ok, password: '', confirm: '' })).toEqual(['Choose a password.'])
    expect(accountProblems({ ...ok, confirm: 'other' })).toEqual(['The two passwords differ.'])
  })

  it('builds upstream\'s add command, with the password as one token and the history flag only when chosen', () => {
    expect(addArgs({ ...ok, keepHistory: true })).toEqual(['add', '--password=correct horse', '--save-logs', 'alice'])
    expect(addArgs({ name: 'bob', password: '-secret', keepHistory: false })).toEqual(['add', '--password=-secret', 'bob'])
  })

  it('counts an account made only when add says so, since it exits 0 for a name that exists', () => {
    expect(accountCreated('User alice created.\nUser file located at /x.', 0)).toBe(true)
    expect(accountCreated('User \u001b[1malice\u001b[22m created.', 0)).toBe(true)
    expect(accountCreated('User alice already exists.', 0)).toBe(false)
    expect(accountCreated('User alice created.', 1)).toBe(false)
  })

  it('recognises an account by its file, and nothing else in users/', () => {
    expect(hasAccounts(['alice.json'])).toBe(true)
    expect(hasAccounts([])).toBe(false)
    expect(hasAccounts(['alice.json.tmp', 'notes.txt'])).toBe(false)
  })
})

describe('what a shown page asks of the app', () => {
  const noticeText = (detail: { url: string }): string => (popupOutcome(detail) as { text: string }).text

  it('opens a web address in a tab', () => {
    expect(popupOutcome({ url: 'https://example.org/a?b=c' })).toEqual({ kind: 'open', url: 'https://example.org/a?b=c' })
    expect(popupOutcome({ url: 'http://example.org/' }).kind).toBe('open')
  })

  it('names any other scheme in a notice, and opens nothing', () => {
    for (const url of ['magnet:?xt=urn:btc', 'mailto:a@b.c', 'irc://irc.libera.chat/#x', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://x/y']) {
      const outcome = popupOutcome({ url })
      expect(outcome.kind, url).toBe('notice')
      expect(noticeText({ url }), url).toContain(`${url.split(':')[0]}:`)
    }
  })

  it('says so for a blank window and for text that is no address, and clips a long address', () => {
    expect(noticeText({ url: 'about:blank' })).toContain('empty window')
    expect(popupOutcome({ url: '' }).kind).toBe('notice')
    expect(noticeText({ url: 'not an address' })).toContain('not an address')
    expect(noticeText({ url: `magnet:?${'x'.repeat(500)}` }).length).toBeLessThan(260)
  })

  it('names a download and says it is not kept', () => {
    expect(downloadNotice({ filename: 'export.zip', mimeType: 'application/zip', totalBytes: 2048 }))
      .toBe('The page started a download of export.zip (application/zip, 2 KiB). Orivon does not save files from a shown page.')
    expect(downloadNotice({ filename: '', mimeType: '', totalBytes: 0 })).toContain('a file (unknown type)')
    expect(downloadNotice({ filename: 'big.bin', mimeType: 'x/y', totalBytes: 5 * 1024 * 1024 })).toContain('5.0 MiB')
  })
})
