// An IRC client in the page, over orivon.net. The capability a browser cannot
// have is the whole point of this port: raw TCP for plain 6667, broker-side
// TLS for 6697, broker-side DNS via connect()'s own resolution. Registration
// (NICK/USER, optional SASL PLAIN via CAP 302), the PING loop and the
// numeric-to-event translation reproduce what upstream gets from
// irc-framework (pinned github:kiwiirc/irc-framework#9578e59) and listens to
// in server/plugins/irc-events/.

import { DEFAULT_PREFIX } from './lounge-state.js'

export class Emitter {
  constructor () { this.listeners = new Map() }

  on (event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event).add(handler)
    return this
  }

  emit (event, data) {
    const set = this.listeners.get(event)
    if (!set) return
    for (const handler of set) handler(data)
  }
}

// <tags> <nick!user@host> <command> <params...> [:<trailing>]
export function parseLine (line) {
  let rest = line
  const tags = {}
  if (rest.startsWith('@')) {
    const space = rest.indexOf(' ')
    for (const pair of rest.slice(1, space).split(';')) {
      const eq = pair.indexOf('=')
      if (eq === -1) tags[pair] = ''
      else tags[pair.slice(0, eq)] = pair.slice(eq + 1)
    }
    rest = rest.slice(space + 1)
  }
  let nick = ''
  let ident = ''
  let hostname = ''
  if (rest.startsWith(':')) {
    const space = rest.indexOf(' ')
    const prefix = rest.slice(1, space)
    rest = rest.slice(space + 1)
    const bang = prefix.indexOf('!')
    const at = prefix.indexOf('@')
    nick = bang === -1 ? prefix.split('@')[0] : prefix.slice(0, bang)
    ident = bang === -1 ? '' : prefix.slice(bang + 1, at === -1 ? undefined : at)
    hostname = at === -1 ? '' : prefix.slice(at + 1)
  }
  const params = []
  let trailing
  while (rest.length > 0) {
    if (rest.startsWith(':')) { trailing = rest.slice(1); break }
    const space = rest.indexOf(' ')
    if (space === -1) { params.push(rest); break }
    params.push(rest.slice(0, space))
    rest = rest.slice(space + 1).replace(/^ +/, '')
  }
  if (trailing !== undefined) params.push(trailing)
  return { tags, nick, ident, hostname, command: (params[0] || '').toUpperCase(), params: params.slice(1), trailing }
}

export function formatLine (command, params) {
  const parts = [command.toUpperCase()]
  const rest = (params || []).filter((p) => p !== undefined && p !== null)
  // Middle parameters cannot be empty on the wire, but a trailing one must go
  // out as an empty trailing parameter or the server sees no parameter at all.
  const kept = rest.filter((p, i) => p !== '' || i === rest.length - 1)
  for (let i = 0; i < kept.length; i++) {
    const last = i === kept.length - 1
    if (last && (kept[i].startsWith(':') || kept[i].includes(' ') || kept[i] === '')) parts.push(':' + kept[i])
    else parts.push(kept[i])
  }
  return parts.join(' ')
}

function base64Utf8 (text) {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export class IrcClient extends Emitter {
  constructor (options) {
    super()
    this.options = options
    this.user = { nick: options.nick, username: options.username || options.nick, host: options.hostname || 'orivon' }
    this.connected = false
    this.registered = false
    this.secure = !!options.tls
    this.network = { options: { PREFIX: DEFAULT_PREFIX, CHANTYPES: ['#', '&'], NICKLEN: '16' }, cap: { enabled: [], isEnabled: (name) => this.network.cap.enabled.includes(name) } }
    this.socket = null
    this.buffer = ''
  }

  async connect () {
    this.emit('connecting')
    const { host, port, tls, rejectUnauthorized } = this.options
    const orivon = window.orivon
    const opts = { host, port }
    let handle
    try {
      handle = tls ? await orivon.net.connectSecure({ ...opts, rejectUnauthorized: rejectUnauthorized !== false }) : await orivon.net.connect(opts)
    } catch (error) {
      this.emit('socket error', String(error && error.message ? error.message : error))
      this.emit('close')
      return
    }
    this.socket = handle
    this.connected = true
    this.emit('socket connected')
    this.writer = handle.writable.getWriter()
    handle.readable.pipeTo(new WritableStream({ write: (chunk) => this.feed(chunk) })).catch(() => this.teardown())
    this.register()
  }

  feed (chunk) {
    this.buffer += new TextDecoder().decode(chunk)
    let index
    while ((index = this.buffer.indexOf('\r\n')) !== -1) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 2)
      if (line) this.handleLine(line)
    }
  }

  raw (...params) {
    if (typeof params[0] === 'string' && params.length === 1 && params[0].includes(' ')) {
      this.write(params[0])
    } else {
      this.write(formatLine(params[0], params.slice(1)))
    }
  }

  write (line) {
    if (!this.socket) return
    this.emit('raw', { line, from_server: false })
    this.writer.write(new TextEncoder().encode(line + '\r\n'))
  }

  say (target, message) {
    this.raw('PRIVMSG', target, message)
  }

  ctcpResponse (target, type, message) {
    this.raw('NOTICE', target, `\u0001${type} ${message}\u0001`.trim())
  }

  changeNick (nick) {
    this.raw('NICK', nick)
  }

  join (channel, key) {
    this.raw('JOIN', channel, key)
  }

  quit (message) {
    this.raw('QUIT', message || '')
    this.teardown()
  }

  teardown () {
    const socket = this.socket
    this.socket = null
    this.connected = false
    this.registered = false
    if (socket) { try { socket.close() } catch { /* already gone */ } }
    this.emit('socket close')
    this.emit('close')
  }

  register () {
    const o = this.options
    if (o.password) this.raw('PASS', o.password)
    if (o.sasl) {
      this.network.cap.requested = true
      this.raw('CAP', 'LS', '302')
    } else {
      this.sendUser()
    }
  }

  sendUser () {
    this.raw('NICK', this.user.nick)
    this.raw('USER', this.user.username, '0', '*', this.options.realname || this.user.nick)
  }

  handleSasl (message) {
    const { command, params } = message
    if (command === 'CAP' && params[1] === 'LS') {
      const offered = String(params[2] || '').split(' ')
      if (offered.includes('sasl')) this.raw('CAP', 'REQ', 'sasl')
      else this.finishSasl()
    } else if (command === 'CAP' && params[1] === 'ACK') {
      this.raw('AUTHENTICATE', 'PLAIN')
    } else if (command === 'CAP' && params[1] === 'NAK') {
      this.finishSasl()
    } else if (command === 'AUTHENTICATE' && params[0] === '+') {
      // The server's empty challenge: answer with the base64 PLAIN payload.
      this.raw('AUTHENTICATE', base64Utf8(`\0${this.options.saslAccount || this.user.nick}\0${this.options.saslPassword}`))
    }
  }

  finishSasl () {
    this.raw('CAP', 'END')
    this.sendUser()
  }

  handleLine (line) {
    const message = parseLine(line)
    this.emit('raw', { line, from_server: true })
    if (message.command === 'PING') { this.raw('PONG', message.params[0] || ''); return }
    if (message.command === 'ERROR') { this.emit('irc error', { reason: message.params.join(' '), from_server: true }); return }
    if (this.options.sasl && this.network.cap.requested && !this.registered) {
      if (['CAP', 'AUTHENTICATE', '902', '903', '904', '905'].includes(message.command)) {
        if (message.command === '903') { this.network.cap.enabled.push('sasl'); this.finishSasl(); return }
        if (['902', '904', '905'].includes(message.command)) { this.emit('irc error', { reason: 'SASL authentication failed', from_server: true }); this.finishSasl(); return }
        this.handleSasl(message)
        return
      }
    }
    if (message.command === 'CAP') {
      if (message.params[1] === 'ACK' && String(message.params[2] || '').includes('sasl')) this.network.cap.enabled.push('sasl')
      return
    }
    this.dispatch(message)
  }

  dispatch (message) {
    const { command, params, nick, ident, hostname, tags } = message
    const time = tags && tags.time ? Date.parse(tags.time) : undefined
    const actor = { nick, ident, hostname, time }
    if (command === 'PRIVMSG' || command === 'NOTICE') {
      this.emitCommandMessage(command, actor, params[0], params[1], tags)
    } else if (command === 'JOIN') {
      this.emit('join', { ...actor, channel: params[0], ident, hostname, gecos: undefined, account: tags && tags.account })
    } else if (command === 'PART') {
      this.emit('part', { ...actor, channel: params[0], message: params[1] || '' })
    } else if (command === 'QUIT') {
      this.emit('quit', { ...actor, message: params[0] || '' })
    } else if (command === 'NICK') {
      this.emit('nick', { ...actor, new_nick: params[0] })
    } else if (command === 'KICK') {
      this.emit('kick', { ...actor, channel: params[0], kicked: params[1], message: params[2] || '' })
    } else if (command === 'INVITE') {
      this.emit('invite', { ...actor, invited: params[0], channel: params[1] })
    } else if (command === 'TOPIC') {
      this.emit('topic', { ...actor, channel: params[0], topic: params[1] || '' })
    } else if (command === 'MODE') {
      this.emitMode(actor, params)
    } else if (command === 'WALLOPS') {
      this.emit('wallops', { ...actor, from_server: true, message: params[0] || '' })
    } else if (command === 'ERROR') {
      this.emit('irc error', { reason: params.join(' '), from_server: true })
    } else if (command === '001') {
      this.user.nick = params[0]
      this.registered = true
      this.emit('registered', { nick: params[0] })
    } else if (command === '005') {
      this.emitIsupport(params)
    } else if (command === '331') {
      this.emit('topic', { ...actor, channel: params[1], topic: '' })
    } else if (command === '332') {
      this.emit('topic', { ...actor, channel: params[1], topic: params[2] || '' })
    } else if (command === '333') {
      this.emit('topicsetby', { ...actor, channel: params[1], nick: params[2], when: Number(params[3]) })
    } else if (command === '324') {
      this.emit('channel info', { ...actor, channel: params[1], modes: parseModeString(params[2], params.slice(3)), raw_modes: params[2] || '', raw_params: params.slice(3) })
    } else if (command === '353') {
      this.queueNames(params)
    } else if (command === '366') {
      this.emitNames(params[1])
    } else if (command === '221') {
      this.emit('user info', { ...actor, raw_modes: params[0] })
    } else if (command === '305' || command === '306') {
      this.emit(command === '306' ? 'away' : 'back', { ...actor, self: true, message: params[0] || '' })
    } else if (command === '375' || command === '372' || command === '422') {
      this.emit('motd', { motd: params[1] !== undefined ? params[1] : params[0] })
    } else if (command === '376' || command === '423') {
      // end of MOTD / no MOTD: nothing the client shows
    } else if (command === '311' || command === '312' || command === '313' || command === '317' || command === '319' || command === '330' || command === '338' || command === '671') {
      this.collectWhois(command, params)
    } else if (command === '318') {
      this.emit('whois', this.whois || { nick: params[1] })
      this.whois = null
    } else if (command === '321' || command === '323') {
      this.emit(command === '321' ? 'channel list start' : 'channel list end')
    } else if (command === '322') {
      this.emit('channel list', [{ channelName: params[1], num_users: Number(params[2]) || 0, topic: params[3] || '' }])
    } else if (command === '421') {
      this.emit('irc error', { reason: `Unknown command: ${params[1]}`, command: params[1], from_server: true })
    } else if (command === '433' || command === '432') {
      this.emitNickInUse(command, message)
    } else if (command.startsWith('4') || command.startsWith('5')) {
      this.emit('irc error', { reason: params.slice(1).join(' '), channel: params[1] && params[1].startsWith('#') ? params[1] : undefined, nick: params[1], command, from_server: true })
    }
  }
}

// The rest of the handlers live as prototype methods below; split out of the
// class body above to keep dispatch readable.

IrcClient.prototype.emitCommandMessage = function (command, actor, target, text, tags) {
  const ctcp = text && text.startsWith('\u0001') && text.endsWith('\u0001') ? text.slice(1, -1) : null
  if (ctcp !== null) {
    const space = ctcp.indexOf(' ')
    const type = space === -1 ? ctcp : ctcp.slice(0, space)
    if (type === 'ACTION') {
      this.emit('action', { ...actor, target, message: space === -1 ? '' : ctcp.slice(space + 1), tags })
      return
    }
    // irc-framework's ctcp request/response handlers read data.message as the
    // full \u0001-wrapped payload (server/plugins/irc-events/ctcp.ts).
    const data = { ...actor, target, type, message: `\u0001${ctcp}\u0001`, from_server: actor.hostname && !actor.nick }
    this.emit(command === 'NOTICE' ? 'ctcp response' : 'ctcp request', data)
    return
  }
  this.emit(command === 'NOTICE' ? 'notice' : 'privmsg', { ...actor, target, message: text || '', tags, msgid: tags && tags.msgid })
}

IrcClient.prototype.emitMode = function (actor, params) {
  const target = params[0]
  const modes = parseModeString(params[1], params.slice(2))
  const data = { ...actor, target, modes, raw_modes: params[1] || '', raw_params: params.slice(2) }
  if (target === this.user.nick) this.emit('user mode', data)
  else this.emit('mode', data)
}

IrcClient.prototype.emitIsupport = function (params) {
  const options = { ...this.network.options }
  for (const token of params.slice(0, -1)) {
    const eq = token.indexOf('=')
    if (eq === -1) continue
    const name = token.slice(0, eq)
    const value = token.slice(eq + 1)
    if (name === 'PREFIX' && value.startsWith('(')) {
      const modes = value.slice(1, value.indexOf(')'))
      const symbols = value.slice(value.indexOf(')') + 1)
      options.PREFIX = modes.split('').map((mode, i) => ({ mode, symbol: symbols[i] }))
    } else if (name === 'CHANTYPES') {
      options.CHANTYPES = value === '' ? [] : value.split('')
    } else {
      options[name] = value
    }
  }
  this.network.options = options
  this.emit('server options', { options })
}

IrcClient.prototype.emitNickInUse = function (command, message) {
  const data = { nick: message.params[1], reason: message.params[2] || 'Nickname is already in use.' }
  this.emit(command === '433' ? 'nick in use' : 'nick invalid', data)
  if (!this.registered) {
    const nickLen = Number(this.network.options.NICKLEN) || 16
    const random = (data.nick || this.user.nick) + Math.floor(Math.random() * 10)
    if (random.length <= nickLen) {
      this.user.nick = random
      this.changeNick(random)
    }
  }
}

IrcClient.prototype.queueNames = function (params) {
  // 353: <symbol> <channel> :<nick[@~ident@host]...>
  if (!this.namesQueue) this.namesQueue = new Map()
  const channel = params[2]
  if (!this.namesQueue.has(channel)) this.namesQueue.set(channel, [])
  const prefixBySymbol = new Map(DEFAULT_PREFIX.concat(this.network.options.PREFIX).map((p) => [p.symbol, p.mode]))
  for (const entry of (params[3] || '').split(' ').filter(Boolean)) {
    let nick = entry
    const modes = []
    while (nick.length > 1 && prefixBySymbol.has(nick[0])) {
      modes.push(prefixBySymbol.get(nick[0]))
      nick = nick.slice(1)
    }
    this.namesQueue.get(channel).push({ nick, modes })
  }
}

IrcClient.prototype.emitNames = function (channel) {
  const queue = this.namesQueue ? this.namesQueue.get(channel) : undefined
  this.namesQueue = new Map()
  if (queue) this.emit('userlist', { channel, users: queue })
}

IrcClient.prototype.collectWhois = function (command, params) {
  if (!this.whois) this.whois = { nick: params[1] }
  const whois = this.whois
  if (command === '311') { whois.nick = params[1]; whois.ident = params[2]; whois.hostname = params[3]; whois.real_name = params[5] }
  else if (command === '312') whois.server = params[2]
  else if (command === '313') whois.operator = params.slice(2).join(' ')
  else if (command === '317') { whois.idle = Number(params[2]) || 0; whois.logon = Number(params[3]) || 0 }
  else if (command === '319') whois.channels = (whois.channels || []).concat(params[2].split(' '))
  else if (command === '330') { whois.account = params[2]; whois.nickserv = params[2] }
  else if (command === '671') whois.secure = params.slice(2).join(' ')
}

// "+o-v nick1 nick2" -> [{mode: "+o", param: "nick1"}, {mode: "-v", param: "nick2"}]
export function parseModeString (modes, params) {
  if (!modes) return []
  const result = []
  let paramIndex = 0
  let adding = true
  for (const char of modes) {
    if (char === '+') { adding = true; continue }
    if (char === '-') { adding = false; continue }
    // Only modes that take a parameter consume one; the common list is the
    // channel modes carrying one plus the user modes that always do.
    const takesParam = adding || 'ovkbqeI'.includes(char)
    if (takesParam && params[paramIndex] !== undefined) {
      result.push({ mode: (adding ? '+' : '-') + char, param: params[paramIndex++] })
    } else {
      result.push({ mode: (adding ? '+' : '-') + char, param: undefined })
    }
  }
  return result
}
