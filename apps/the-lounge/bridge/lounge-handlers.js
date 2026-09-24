// server/plugins/irc-events/ in the page: the same translations of IRC
// traffic into The Lounge's client messages, for an IrcClient instead of
// irc-framework. Each handler names the upstream file it mirrors; the shapes
// are the SharedMsg ones in shared/types/msg.ts.

import { Chan, ChanState, makeMsg, makeUser, setModes } from './lounge-state.js'

const NICK_REGEXP = /(?:[0-9]{1,2}(?:,[0-9]{1,2})?)?([\w[\]\\`^{|}-]+)/g

export function wireIrcEvents (ctx, network, irc) {
  const { emit, push, createQuery } = ctx
  const getUser = (chan, nick) => chan.getUser(nick)

  const lobby = () => network.getLobby()

  irc.on('socket connected', () => {
    if (irc.network.options.PREFIX) network.serverOptions.PREFIX.update(irc.network.options.PREFIX)
    push(lobby(), makeMsg({ text: `Connected to the network.` }), true)
    sendStatus()
  })

  irc.on('socket error', (err) => {
    push(lobby(), makeMsg({ type: 'error', text: `Socket error: ${String(err)}` }), true)
  })

  irc.on('socket close', (err) => {
    for (const chan of network.channels) {
      chan.users = new Map()
      chan.state = ChanState.PARTED
    }
    if (err) push(lobby(), makeMsg({ type: 'error', text: `Connection closed unexpectedly: ${String(err)}` }), true)
    else push(lobby(), makeMsg({ text: 'Disconnected from the network, and will not reconnect. Use /connect to reconnect again.' }), true)
    sendStatus()
  })

  irc.on('ping timeout', () => {
    push(lobby(), makeMsg({ text: 'Ping timeout, disconnecting…' }), true)
    irc.teardown()
  })

  irc.on('registered', (data) => {
    network.setNick(data.nick)
    push(lobby(), makeMsg({ text: `You're now known as ${data.nick}` }), false)
    if (irc.network.cap.enabled.length > 0) {
      push(lobby(), makeMsg({ text: `Enabled capabilities: ${irc.network.cap.enabled.join(', ')}` }), true)
    }
    emit('nick', { network: network.uuid, nick: data.nick })
    for (const chan of network.channels) {
      if (chan.type === 'channel') setTimeout(() => irc.join(chan.name, chan.key), 0)
    }
  })

  irc.on('server options', (data) => {
    if (data.options.PREFIX) network.serverOptions.PREFIX.update(data.options.PREFIX)
    if (data.options.CHANTYPES) network.serverOptions.CHANTYPES = data.options.CHANTYPES
    network.serverOptions.NETWORK = data.options.NETWORK || network.serverOptions.NETWORK
    emit('network:options', { network: network.uuid, serverOptions: network.serverOptions })
  })

  irc.on('join', (data) => {
    let chan = network.getChannel(data.channel)
    if (chan === undefined) {
      chan = new Chan({ name: data.channel, state: ChanState.JOINED })
      emit('join', {
        network: network.uuid,
        chan: chan.clone(true),
        shouldOpen: false,
        index: network.addChannel(chan)
      })
      irc.raw('MODE', chan.name)
    } else if (data.nick === irc.user.nick) {
      chan.state = ChanState.JOINED
      emit('channel:state', { chan: chan.id, state: chan.state })
    }
    push(chan, makeMsg({
      time: data.time,
      from: makeUser(data.nick, network.serverOptions.PREFIX),
      hostmask: `${data.ident}@${data.hostname}`,
      gecos: data.gecos,
      account: data.account,
      type: 'join',
      self: data.nick === irc.user.nick
    }), false)
    const user = makeUser(data.nick, network.serverOptions.PREFIX)
    chan.setUser(user)
    emit('users', { chan: chan.id })
  })

  irc.on('part', (data) => {
    if (!data.channel) return
    const chan = network.getChannel(data.channel)
    if (chan === undefined) return
    const user = getUser(chan, data.nick)
    push(chan, makeMsg({
      type: 'part',
      time: data.time,
      text: data.message || '',
      hostmask: `${data.ident}@${data.hostname}`,
      from: user,
      self: data.nick === irc.user.nick
    }), false)
    if (data.nick === irc.user.nick) partChan(chan)
    else chan.removeUser(user)
  })

  irc.on('kick', (data) => {
    const chan = network.getChannel(data.channel)
    if (chan === undefined) return
    const user = getUser(chan, data.kicked)
    push(chan, makeMsg({
      type: 'kick',
      time: data.time,
      from: getUser(chan, data.nick),
      target: user,
      text: data.message || '',
      highlight: data.kicked === irc.user.nick,
      self: data.nick === irc.user.nick
    }), true)
    if (data.kicked === irc.user.nick) partChan(chan)
    else chan.removeUser(user)
  })

  irc.on('quit', (data) => {
    for (const chan of network.channels) {
      const user = chan.findUser(data.nick)
      if (user === undefined) continue
      push(chan, makeMsg({
        time: data.time,
        type: 'quit',
        text: data.message || '',
        hostmask: `${data.ident}@${data.hostname}`,
        from: user
      }), false)
      chan.removeUser(user)
    }
  })

  irc.on('nick', (data) => {
    const self = data.nick === irc.user.nick
    if (self) {
      network.setNick(data.new_nick)
      push(lobby(), makeMsg({ text: `You're now known as ${data.new_nick}` }), true)
      emit('nick', { network: network.uuid, nick: data.new_nick })
    }
    for (const chan of network.channels) {
      const user = chan.findUser(data.nick)
      if (user === undefined) continue
      push(chan, makeMsg({ time: data.time, from: user, type: 'nick', new_nick: data.new_nick }), false)
      chan.removeUser(user)
      user.nick = data.new_nick
      chan.setUser(user)
      emit('users', { chan: chan.id })
    }
  })

  irc.on('topic', (data) => {
    const chan = network.getChannel(data.channel)
    if (chan === undefined) return
    push(chan, makeMsg({
      time: data.time,
      type: 'topic',
      from: data.nick && getUser(chan, data.nick),
      text: data.topic,
      self: data.nick === irc.user.nick
    }), false)
    chan.topic = data.topic
    emit('topic', { chan: chan.id, topic: chan.topic })
  })

  irc.on('topicsetby', (data) => {
    const chan = network.getChannel(data.channel)
    if (chan === undefined) return
    push(chan, makeMsg({
      type: 'topic_set_by',
      from: getUser(chan, data.nick),
      when: new Date(data.when * 1000),
      self: data.nick === irc.user.nick
    }), false)
  })

  irc.on('channel info', (data) => {
    const chan = network.getChannel(data.channel)
    if (chan === undefined || !data.modes) return
    for (const mode of data.modes) {
      if (mode.mode[1] === 'k') chan.key = mode.mode[0] === '+' ? mode.param : ''
    }
    push(chan, makeMsg({ type: 'mode_channel', text: `${data.raw_modes} ${data.raw_params.join(' ')}` }), false)
  })

  irc.on('user info', (data) => {
    push(lobby(), makeMsg({ type: 'mode_user', raw_modes: data.raw_modes, self: false, showInActive: true }), false)
  })

  irc.on('mode', (data) => {
    let chan
    if (data.target === irc.user.nick) chan = lobby()
    else {
      chan = network.getChannel(data.target)
      if (chan === undefined) return
    }
    const users = data.raw_params.filter((param) => chan.findUser(param))
    push(chan, makeMsg({
      time: data.time,
      type: 'mode',
      from: getUser(chan, data.nick),
      text: `${data.raw_modes} ${data.raw_params.join(' ')}`,
      self: data.nick === irc.user.nick,
      ...(users.length > 0 ? { users } : {})
    }), false)
    let usersUpdated = false
    for (const mode of data.modes) {
      if (mode.mode[1] === 'k') chan.key = mode.mode[0] === '+' ? mode.param : ''
      if (!mode.param) continue
      const user = chan.findUser(mode.param)
      if (!user) continue
      usersUpdated = true
      const symbol = network.serverOptions.PREFIX.modeToSymbol[mode.mode[1]]
      if (symbol === undefined) continue
      if (mode.mode[0] === '-') user.modes = user.modes.filter((m) => m !== symbol)
      else if (!user.modes.includes(symbol)) user.modes.push(symbol)
      setModes(user, user.modes.map((s) => symbolToMode(network, s)), network.serverOptions.PREFIX)
    }
    if (usersUpdated) emit('users', { chan: chan.id })
  })

  irc.on('userlist', (data) => {
    const chan = network.getChannel(data.channel)
    if (chan === undefined) return
    const newUsers = new Map()
    for (const entry of data.users) {
      const user = getUser(chan, entry.nick)
      setModes(user, entry.modes, network.serverOptions.PREFIX)
      newUsers.set(entry.nick.toLowerCase(), user)
    }
    chan.users = newUsers
    emit('users', { chan: chan.id })
  })

  irc.on('away', (data) => handleAway('away', data))
  irc.on('back', (data) => handleAway('back', data))

  irc.on('privmsg', (data) => handleMessage('message', data))
  irc.on('notice', (data) => handleMessage('notice', data))
  irc.on('action', (data) => handleMessage('action', data))
  irc.on('wallops', (data) => handleMessage('wallops', { ...data, from_server: true }))

  irc.on('ctcp response', (data) => {
    const chan = network.getChannel(data.nick) || lobby()
    push(chan, makeMsg({ type: 'ctcp', time: data.time, from: getUser(chan, data.nick), ctcpMessage: data.message }), true)
  })

  irc.on('ctcp request', (data) => {
    const responses = { CLIENTINFO: () => 'PING PONG SOURCE VERSION', PING: () => data.message.replace(/^\u0001PING /, ''), SOURCE: () => 'https://github.com/thelounge/thelounge', VERSION: () => 'The Lounge -- https://thelounge.chat/' }
    const response = responses[data.type]
    if (response) irc.ctcpResponse(data.from_server ? data.hostname : data.nick, data.type, response(data))
    push(lobby(), makeMsg({
      type: 'ctcp_request',
      time: data.time,
      from: makeUser(data.from_server ? data.hostname : data.nick, network.serverOptions.PREFIX),
      hostmask: `${data.ident}@${data.hostname}`,
      ctcpMessage: data.message
    }), true)
  })

  irc.on('irc error', (data) => {
    const msg = makeMsg({
      type: 'error',
      error: data.error,
      showInActive: true,
      nick: data.nick,
      channel: data.channel,
      reason: data.reason,
      command: data.command
    })
    let target = lobby()
    if (data.channel) {
      const channel = network.getChannel(data.channel)
      if (channel !== undefined) { target = channel; msg.showInActive = false }
    }
    push(target, msg, true)
  })

  irc.on('nick in use', (data) => {
    const message = `${data.nick}: ${data.reason || 'Nickname is already in use.'}`
    push(lobby(), makeMsg({ type: 'error', text: message, showInActive: true }), true)
    emit('nick', { network: network.uuid, nick: irc.user.nick })
  })

  irc.on('nick invalid', (data) => {
    push(lobby(), makeMsg({ type: 'error', text: `${data.nick}: ${data.reason || 'Nickname is invalid.'}`, showInActive: true }), true)
    emit('nick', { network: network.uuid, nick: irc.user.nick })
  })

  irc.on('motd', (data) => {
    const text = data.motd || data.error
    if (text) push(lobby(), makeMsg({ type: 'monospace_block', command: 'motd', text }), false)
  })

  irc.on('help', (data) => {
    if (data.help) push(lobby(), makeMsg({ type: 'monospace_block', command: 'help', text: data.help }), true)
  })

  irc.on('info', (data) => {
    if (data.info) push(lobby(), makeMsg({ type: 'monospace_block', command: 'info', text: data.info }), true)
  })

  irc.on('whois', (data) => handleWhois(data))
  irc.on('whowas', (data) => handleWhois({ ...data, whowas: true }))

  irc.on('channel list start', () => updateChannelList({ text: 'Loading channel list, this can take a moment...' }))
  irc.on('channel list', (channels) => {
    network.chanCache = (network.chanCache || []).concat(channels)
    updateChannelList({ text: `Loaded ${network.chanCache.length} channels...` })
  })
  irc.on('channel list end', () => {
    updateChannelList([...(network.chanCache || [])].sort((a, b) => b.num_users - a.num_users).slice(0, 500))
    network.chanCache = []
  })

  irc.on('invite', (data) => {
    push(lobby(), makeMsg({
      type: 'invite',
      time: data.time,
      from: makeUser(data.nick, network.serverOptions.PREFIX),
      invitedYou: data.invited === irc.user.nick,
      channel: data.channel
    }), true)
  })

  function partChan (chan) {
    // client.part(): the channel leaves the sidebar entirely, mentions with it.
    network.channels = network.channels.filter((c) => c !== chan)
    emit('part', { chan: chan.id })
  }

  function sendStatus () {
    emit('network:status', { ...network.getNetworkStatus(), network: network.uuid })
  }

  function handleWhois (data) {
    let chan = network.getChannel(data.nick)
    if (chan === undefined) {
      if (data.error) chan = lobby()
      else chan = createQuery(network, data.nick, true)
    }
    if (data.error) {
      push(chan, makeMsg({ type: 'error', text: `No such nick: ${data.nick}` }), false)
    } else {
      data.idleTime = Date.now() - (data.idle || 0) * 1000
      data.logonTime = (data.logon || 0) * 1000
      push(chan, makeMsg({ type: 'whois', whois: data }), false)
    }
  }

  function updateChannelList (msg) {
    let chan = network.getChannel('Channel List')
    if (chan === undefined) {
      chan = new Chan({ type: 'special', special: 'list_channels', name: 'Channel List', data: msg })
      emit('join', {
        network: network.uuid,
        chan: chan.clone(true),
        shouldOpen: false,
        index: network.addChannel(chan)
      })
    } else {
      chan.data = msg
      emit('msg:special', { chan: chan.id, data: msg })
    }
  }

  function handleAway (type, data) {
    if (data.self) {
      push(lobby(), makeMsg({ self: true, type, text: data.message, time: data.time }), true)
      return
    }
    for (const chan of network.channels) {
      if (chan.type === 'query') {
        if (data.nick.toLowerCase() !== chan.name.toLowerCase()) continue
        if (chan.userAway === data.message) continue
        chan.userAway = data.message
        push(chan, makeMsg({ type, text: data.message || '', time: data.time, from: getUser(chan, data.nick) }), false)
      } else if (chan.type === 'channel') {
        const user = chan.findUser(data.nick)
        if (!user || user.away === data.message) continue
        user.away = data.message
      }
    }
  }

  // server/plugins/irc-events/message.ts, without ignore lists, link
  // prefetch, push notifications and custom highlight regexes (see the recon
  // doc's scope decisions).
  function handleMessage (type, data) {
    let chan
    let from
    let highlight = false
    let showInActive = false
    const self = data.nick === irc.user.nick
    if (!data.nick) { data.from_server = true; data.nick = data.hostname || network.host }

    if (data.from_server && (!data.target || !network.getChannel(data.target) || network.getChannel(data.target).type !== 'channel')) {
      chan = lobby()
      from = getUser(chan, data.nick)
    } else {
      let target = data.target
      if (target.toLowerCase() === irc.user.nick.toLowerCase()) target = data.nick
      chan = network.getChannel(target)
      if (chan === undefined) {
        if (type === 'notice') {
          showInActive = true
          chan = lobby()
        } else {
          chan = createQuery(network, target)
        }
      }
      from = getUser(chan, data.nick)
      if (chan.type === 'query') highlight = !self
      else if (chan.type === 'channel') from.lastMessage = data.time || Date.now()
    }

    const msg = makeMsg({
      type,
      time: data.time,
      text: data.message,
      self,
      from,
      highlight,
      users: [],
      msgid: data.msgid
    })
    if (showInActive) msg.showInActive = true

    if (!msg.highlight && !msg.self) {
      const nickPattern = new RegExp(`(?:^|[^a-z0-9_\`{|}^\\\\-])${escapeRegExp(network.nick)}(?:[^a-z0-9_\`{|}^\\\\-]|$)`, 'i')
      msg.highlight = type === 'message' && nickPattern.test(data.message)
    }
    if (data.group) msg.statusmsgGroup = data.group

    let match
    NICK_REGEXP.lastIndex = 0
    while ((match = NICK_REGEXP.exec(data.message))) {
      if (chan.findUser(match[1])) msg.users.push(match[1])
    }

    push(chan, msg, !msg.self)
  }

  function escapeRegExp (nick) {
    return nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  function symbolToMode (networkRef, symbol) {
    for (const p of networkRef.serverOptions.PREFIX.prefix) {
      if (p.symbol === symbol) return p.mode
    }
    return ''
  }
}
