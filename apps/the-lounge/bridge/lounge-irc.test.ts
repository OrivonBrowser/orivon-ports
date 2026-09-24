// The IRC line codec: what the wire sends and what we write back. Cases are
// the ones the protocol's grammar makes load-bearing -- tags, prefixes with
// and without idents, trailing parameters, and mode strings whose parameters
// follow the add/remove direction.
import { describe, expect, it } from 'vitest'
import { formatLine, parseLine, parseModeString } from './lounge-irc.js'

describe('parseLine', () => {
  it('splits prefix, command and params', () => {
    const message = parseLine(':alice!a@host.example PRIVMSG #chan :hello there')
    expect(message).toMatchObject({
      nick: 'alice',
      ident: 'a',
      hostname: 'host.example',
      command: 'PRIVMSG',
      params: ['#chan', 'hello there']
    })
  })

  it('reads message tags, including msgid and server-time', () => {
    const message = parseLine('@time=2026-09-24T12:00:00.000Z;msgid=abc :nick PRIVMSG #chan :hi')
    expect(message.tags).toEqual({ time: '2026-09-24T12:00:00.000Z', msgid: 'abc' })
    expect(message.nick).toBe('nick')
  })

  it('handles server-origin lines with no prefix-less forms and bare commands', () => {
    const message = parseLine('PING :server.example')
    expect(message).toMatchObject({ nick: '', command: 'PING', params: ['server.example'] })
    expect(parseLine('NOTICE AUTH :looking up your hostname').params[0]).toBe('AUTH')
  })

  it('keeps empty trailing params and collapses runs of spaces', () => {
    const message = parseLine(':nick PRIVMSG #chan :two  spaces kept')
    expect(message.params).toEqual(['#chan', 'two  spaces kept'])
  })
})

describe('formatLine', () => {
  it('trails the last parameter when it contains spaces', () => {
    expect(formatLine('privmsg', ['#chan', 'hello world'])).toBe('PRIVMSG #chan :hello world')
  })

  it('does not trail a plain single-word parameter', () => {
    expect(formatLine('join', ['#chan', 'key'])).toBe('JOIN #chan key')
  })

  it('trails an empty final parameter so it is not dropped', () => {
    expect(formatLine('part', ['#chan', ''])).toBe('PART #chan :')
  })

  it('drops middle empty parameters the way the protocol cannot carry them', () => {
    expect(formatLine('user', ['thelounge', '', '*', 'real name'])).toBe('USER thelounge * :real name')
  })
})

describe('parseModeString', () => {
  it('pairs directed modes with their parameters', () => {
    expect(parseModeString('+o-v', ['alice', 'bob'])).toEqual([
      { mode: '+o', param: 'alice' },
      { mode: '-v', param: 'bob' }
    ])
  })

  it('does not give list-less modes a parameter', () => {
    expect(parseModeString('+m', [])).toEqual([{ mode: '+m', param: undefined }])
  })

  it('consumes parameters for channel list modes in both directions', () => {
    expect(parseModeString('+b-b', ['*!spam@*', '*!other@*'])).toEqual([
      { mode: '+b', param: '*!spam@*' },
      { mode: '-b', param: '*!other@*' }
    ])
  })

  it('survives more parameters than modes', () => {
    expect(parseModeString('+k', ['secret', 'ignored'])).toEqual([{ mode: '+k', param: 'secret' }])
  })
})
