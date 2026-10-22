import { describe, expect, it } from 'vitest'
import { initialState } from '../page/src/model.js'
import {
  articleCount,
  badgeFor,
  baseName,
  chipFor,
  filterLogs,
  formatClock,
  formatDate,
  formatSocks,
  groupOnion,
  humanSize,
  percent,
  pickProblem,
  summarizeFiles,
  topFolderName
} from '../page/src/ui/helpers.js'

const ONION = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx.onion'

function file (name: string, size: number, path = '', type = '') {
  return { name, size, type, webkitRelativePath: path }
}

describe('humanSize', () => {
  it('prints bytes plainly and larger sizes in binary steps', () => {
    expect(humanSize(0)).toBe('0 B')
    expect(humanSize(1)).toBe('1 B')
    expect(humanSize(1023)).toBe('1023 B')
    expect(humanSize(1024)).toBe('1.0 KB')
    expect(humanSize(1536)).toBe('1.5 KB')
    expect(humanSize(100 * 1024)).toBe('100 KB')
    expect(humanSize(12.4 * 1024 * 1024)).toBe('12.4 MB')
    expect(humanSize(2 * 1024 ** 3)).toBe('2.0 GB')
  })

  it('moves to the next unit instead of printing 1024', () => {
    expect(humanSize(1023.6 * 1024)).toBe('1.0 MB')
  })

  it('treats nonsense as empty', () => {
    expect(humanSize(-5)).toBe('0 B')
    expect(humanSize(Number.NaN)).toBe('0 B')
    expect(humanSize(undefined as unknown as number)).toBe('0 B')
  })
})

describe('percent', () => {
  it('rounds and clamps', () => {
    expect(percent(0.456)).toBe(46)
    expect(percent(-1)).toBe(0)
    expect(percent(7)).toBe(100)
    expect(percent(Number.NaN)).toBe(0)
  })
})

describe('formatSocks', () => {
  it('shows an address only while the proxy listens', () => {
    expect(formatSocks({ state: 'listening', host: '127.0.0.1', port: 9150, msg: '' })).toBe('127.0.0.1:9150')
    expect(formatSocks({ state: 'waiting', host: '127.0.0.1', port: 0, msg: '' })).toBe('')
    expect(formatSocks({ state: 'failed', host: '127.0.0.1', port: 9150, msg: 'busy' })).toBe('')
    expect(formatSocks({ state: 'listening', host: '', port: 9151, msg: '' })).toBe('127.0.0.1:9151')
  })
})

describe('groupOnion', () => {
  it('splits an address into groups of eight and keeps the suffix apart', () => {
    const { groups, suffix } = groupOnion(ONION)
    expect(groups).toHaveLength(7)
    expect(groups.every((group) => group.length === 8)).toBe(true)
    expect(groups.join('') + suffix).toBe(ONION)
  })

  it('returns nothing before an address exists', () => {
    expect(groupOnion(null)).toEqual({ groups: [], suffix: '' })
    expect(groupOnion('')).toEqual({ groups: [], suffix: '' })
  })
})

describe('dates', () => {
  it('formats an ISO date as YYYY-MM-DD in UTC', () => {
    expect(formatDate('2026-10-22T23:59:59Z')).toBe('2026-10-22')
    expect(formatDate('2026-10-22T23:30:00-05:00')).toBe('2026-10-23')
    expect(formatDate('not a date')).toBe('')
  })

  it('formats a log time as HH:MM:SS', () => {
    expect(formatClock(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe('03:04:05')
  })
})

describe('chipFor', () => {
  const running = () => {
    const state = initialState()
    state.phase = 'running'
    state.socks = { state: 'listening', host: '127.0.0.1', port: 9150, msg: '' }
    return state
  }

  it('says what is going on in plain words', () => {
    const state = initialState()
    expect(chipFor(state)).toEqual({ text: 'Looking for Tor…', tone: 'busy' })
    state.phase = 'outside-orivon'
    expect(chipFor(state).text).toBe('Not in Orivon')
    state.phase = 'failed'
    expect(chipFor(state)).toEqual({ text: 'Stopped', tone: 'bad' })
  })

  it('follows the bootstrap while running', () => {
    const state = running()
    state.bootstrap.frac = 0.45
    expect(chipFor(state)).toEqual({ text: 'Connecting 45%', tone: 'busy' })
    state.bootstrap.ready = true
    expect(chipFor(state)).toEqual({ text: 'Online', tone: 'ok' })
  })

  it('reports a proxy that failed even when Tor is up', () => {
    const state = running()
    state.bootstrap.ready = true
    state.socks = { state: 'failed', host: '127.0.0.1', port: 9150, msg: 'address in use' }
    expect(chipFor(state)).toEqual({ text: 'Proxy failed', tone: 'bad' })
  })
})

describe('badgeFor', () => {
  it('colours each service state', () => {
    expect(badgeFor('running')).toMatchObject({ text: 'Online', tone: 'ok', pulse: false })
    for (const name of ['starting', 'publishing', 'recovering']) expect(badgeFor(name)).toMatchObject({ tone: 'busy', pulse: true })
    expect(badgeFor('degraded').tone).toBe('warn')
    expect(badgeFor('unreachable').tone).toBe('bad')
    expect(badgeFor('broken').tone).toBe('bad')
    expect(badgeFor('off').tone).toBe('idle')
    expect(badgeFor('stopped').tone).toBe('idle')
  })
})

describe('filterLogs', () => {
  const logs = (['ERROR', 'WARN', 'INFO', 'DEBUG'] as const).map((level, i) => ({ time: i, level, target: 't', msg: level }))

  it('keeps warnings and errors for Warnings, errors only for Errors', () => {
    expect(filterLogs(logs, 'all')).toHaveLength(4)
    expect(filterLogs(logs, 'warn').map((line: { level: string }) => line.level)).toEqual(['ERROR', 'WARN'])
    expect(filterLogs(logs, 'error').map((line: { level: string }) => line.level)).toEqual(['ERROR'])
  })
})

describe('picked files', () => {
  it('sums count and bytes', () => {
    expect(summarizeFiles([file('a', 10), file('b', 32)])).toEqual({ count: 2, bytes: 42 })
  })

  it('names the folder or the file for a title suggestion', () => {
    expect(topFolderName([file('a.txt', 1, 'notes/a.txt')])).toBe('notes')
    expect(topFolderName([file('a.txt', 1)])).toBe('')
    expect(baseName('holiday.photo.jpg')).toBe('holiday.photo')
    expect(baseName('.bashrc')).toBe('.bashrc')
  })
})

describe('pickProblem', () => {
  const limits = { maxBytes: 100, maxFiles: 2, titleLength: 120, articleLength: 1000 }

  it('has no complaint about an empty or fine pick', () => {
    expect(pickProblem('file', [], limits)).toBe('')
    expect(pickProblem('file', [file('a', 10), file('b', 10)], limits)).toBe('')
  })

  it('refuses past the limits', () => {
    expect(pickProblem('file', [file('a', 1), file('b', 1), file('c', 1)], limits)).toMatch(/at most 2/)
    expect(pickProblem('file', [file('a', 101)], limits)).toMatch(/at most 100 B/)
  })

  it('wants one image for a picture', () => {
    expect(pickProblem('picture', [file('a.png', 5, '', 'image/png')], limits)).toBe('')
    expect(pickProblem('picture', [file('a.txt', 5, '', 'text/plain')], limits)).toMatch(/not a picture/)
    expect(pickProblem('picture', [file('a.png', 1, '', 'image/png'), file('b.png', 1, '', 'image/png')], limits)).toMatch(/one picture/)
  })

  it('wants a folder for a folder and an index.html at its top for a website', () => {
    expect(pickProblem('folder', [file('a', 1)], limits)).toMatch(/folder/)
    expect(pickProblem('folder', [file('a', 1, 'dir/a')], limits)).toBe('')
    expect(pickProblem('website', [file('index.html', 1, 'site/index.html'), file('a.css', 1, 'site/a.css')], limits)).toBe('')
    expect(pickProblem('website', [file('index.html', 1, 'site/docs/index.html')], limits)).toMatch(/index\.html/)
    expect(pickProblem('website', [file('a.css', 1, 'site/a.css')], limits)).toMatch(/index\.html/)
  })
})

describe('articleCount', () => {
  it('warns near the limit and again past it', () => {
    expect(articleCount(1234, 200000)).toEqual({ text: '1,234 / 200,000', tone: '' })
    expect(articleCount(180000, 200000).tone).toBe('warn')
    expect(articleCount(200001, 200000).tone).toBe('bad')
  })
})
