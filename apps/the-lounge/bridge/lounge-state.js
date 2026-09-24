// The page-side model The Lounge's server keeps: networks, channels, users,
// messages. Shapes are transcribed from upstream's typed contracts
// (shared/types/msg.ts, network.ts, chan.ts) and its models
// (server/models/{chan,network,user,prefix}.ts) so the client cannot tell the
// difference. Messages live in memory for the session, which is upstream's
// own public-mode behaviour.

let idChan = 1
let idMsg = 1

export function nextChanId () { return idChan++ }
export function nextMsgId () { return idMsg++ }

export const CHANTYPES = ['#', '&']

// shared/types/chan.ts
export const ChanState = { PARTED: 0, JOINED: 1 }

// server/models/network.ts's own default PREFIX (replaced when the server
// sends its 005 ISUPPORT), not irc-framework's.
export const DEFAULT_PREFIX = [
  { symbol: '!', mode: 'Y' },
  { symbol: '@', mode: 'o' },
  { symbol: '%', mode: 'h' },
  { symbol: '+', mode: 'v' }
]

export const MAX_HISTORY = 10000

export class Prefix {
  constructor (list) {
    this.prefix = list || []
    this.modeToSymbol = {}
    this.symbols = []
    for (const p of this.prefix) {
      this.modeToSymbol[p.mode] = p.symbol
      this.symbols.push(p.symbol)
    }
  }

  update (list) {
    const next = new Prefix(list)
    this.prefix = next.prefix
    this.modeToSymbol = next.modeToSymbol
    this.symbols = next.symbols
  }
}

export function makeUser (nick, prefix) {
  const user = { nick, modes: [], away: '', lastMessage: 0, mode: '' }
  setModes(user, [], prefix)
  return user
}

export function setModes (user, modeChars, prefix) {
  user.modes = (modeChars || []).map((mode) => prefix.modeToSymbol[mode]).filter(Boolean)
  user.mode = user.modes[0] || ''
}

// A wire message. Upstream's Msg is a Date-carrying class; over the socket it
// is JSON, so `time` and `when` go out as the same ISO strings socket.io's
// parser would produce. `from`/`target` are copied down to their mode and
// nick, exactly what server/models/msg.ts's constructor does.
export function makeMsg (attrs = {}) {
  const { from, target, ...rest } = attrs
  const msg = {
    from: {},
    previews: [],
    text: '',
    type: 'message',
    self: false,
    ...rest
  }
  if (from) msg.from = { mode: from.mode || '', nick: from.nick || '' }
  if (target) msg.target = { mode: target.mode || '', nick: target.nick || '' }
  msg.id = attrs.id ?? nextMsgId()
  msg.time = new Date(attrs.time ?? Date.now()).toISOString()
  return msg
}

export class Chan {
  constructor (attrs = {}) {
    this.id = attrs.id ?? nextChanId()
    this.messages = []
    this.name = attrs.name || ''
    this.key = ''
    this.topic = ''
    this.firstUnread = 0
    this.unread = 0
    this.highlight = 0
    this.users = new Map()
    this.muted = false
    this.type = attrs.type || 'channel'
    this.state = attrs.state ?? 0
    this.userAway = undefined
    this.special = attrs.special
    this.data = attrs.data
    this.closed = undefined
    this.num_users = undefined
  }

  findUser (nick) {
    return this.users.get(String(nick).toLowerCase())
  }

  getUser (nick) {
    return this.findUser(nick) || makeUser(nick, new Prefix([]))
  }

  setUser (user) {
    this.users.set(user.nick.toLowerCase(), user)
  }

  removeUser (user) {
    this.users.delete(user.nick.toLowerCase())
  }

  getSortedUsers () {
    const priority = {}
    this.network.serverOptions.PREFIX.prefix.forEach((p, index) => { priority[p.symbol] = index })
    priority[''] = 99
    return Array.from(this.users.values()).sort((a, b) => {
      if (a.mode === b.mode) return a.nick.toLowerCase() < b.nick.toLowerCase() ? -1 : 1
      return priority[a.mode] - priority[b.mode]
    })
  }

  // server/models/chan.ts getFilteredClone
  clone (activeChannel, lastMessage) {
    let msgs
    if (lastMessage && lastMessage > -1) {
      msgs = this.messages.filter((m) => m.id > lastMessage).slice(-100)
    } else {
      const count = activeChannel === true || this.id === activeChannel ? 100 : 1
      msgs = this.messages.slice(-count)
    }
    return {
      id: this.id,
      messages: msgs,
      totalMessages: this.messages.length,
      name: this.name,
      key: this.key,
      topic: this.topic,
      firstUnread: this.firstUnread,
      unread: this.unread,
      highlight: this.highlight,
      muted: this.muted,
      type: this.type,
      state: this.state,
      special: this.special,
      data: this.data,
      closed: this.closed,
      num_users: this.num_users
    }
  }
}

export class Network {
  constructor (attrs) {
    this.uuid = attrs.uuid
    this.name = attrs.name || attrs.host || ''
    this.host = attrs.host
    this.port = attrs.port
    this.tls = attrs.tls
    this.rejectUnauthorized = attrs.rejectUnauthorized
    this.password = attrs.password || ''
    this.nick = attrs.nick
    this.username = attrs.username
    this.realname = attrs.realname
    this.leaveMessage = attrs.leaveMessage
    this.sasl = attrs.sasl
    this.saslAccount = attrs.saslAccount
    this.saslPassword = attrs.saslPassword
    this.commands = attrs.commands || []
    this.userDisconnected = !!attrs.userDisconnected
    this.keepNick = null
    this.awayMessage = ''
    this.serverOptions = { CHANTYPES: [...CHANTYPES], PREFIX: new Prefix(DEFAULT_PREFIX), NETWORK: this.name || '' }
    this.channels = attrs.channels || []
    this.irc = null
    this.lobby = new Chan({ name: this.name, type: 'lobby' })
    this.lobby.network = this
    this.channels.unshift(this.lobby)
  }

  getLobby () {
    return this.lobby
  }

  getNetworkStatus () {
    const connected = !!(this.irc && this.irc.connected)
    return { connected, secure: connected && !!this.irc.secure }
  }

  setNick (nick) { this.nick = nick }

  getChannel (name) {
    const lower = String(name).toLowerCase()
    return this.channels.find((chan) => chan.name.toLowerCase() === lower)
  }

  addChannel (chan) {
    chan.network = this
    let index = this.channels.length
    if (chan.type === 'channel' || chan.type === 'query') {
      for (let i = 1; i < this.channels.length; i++) {
        const compare = this.channels[i]
        if (chan.name.localeCompare(compare.name, undefined, { sensitivity: 'base' }) <= 0 || (compare.type !== 'channel' && compare.type !== 'query')) {
          index = i
          break
        }
      }
    }
    this.channels.splice(index, 0, chan)
    return index
  }

  clone (activeChannel, lastMessage) {
    return {
      uuid: this.uuid,
      name: this.name,
      nick: this.nick,
      serverOptions: this.serverOptions,
      status: this.getNetworkStatus(),
      channels: this.channels.map((chan) => chan.clone(activeChannel, lastMessage))
    }
  }
}

// pushMessage: assigns an id, keeps history bounded, maintains unread and
// highlight counters, and reports the message to the client — the parts of
// server/models/chan.ts pushMessage that a public-mode session keeps.
export function pushMessage (emit, state, chan, msg, increasesUnread = false) {
  msg.id = nextMsgId()
  const isOpen = state.openChannel === chan.id
  if (msg.self) {
    chan.unread = 0
    chan.firstUnread = msg.id
    chan.highlight = 0
  } else if (!isOpen) {
    if (!chan.firstUnread) chan.firstUnread = msg.id
    if (increasesUnread || msg.highlight) chan.unread++
    if (msg.highlight) chan.highlight++
  }
  chan.messages.push(msg)
  if (chan.messages.length > MAX_HISTORY) chan.messages.splice(0, chan.messages.length - MAX_HISTORY)
  emit('msg', { chan: chan.id, msg: { ...msg }, unread: chan.unread, highlight: chan.highlight })
}
