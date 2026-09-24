// server/plugins/inputs/ plus client.inputLine's dispatch, in the page. The
// flow is upstream's: a non-command goes out as PRIVMSG to the channel, a
// "//"-escaped line sends its text literally, a known command routes to its
// handler, and an unknown command is forwarded to the IRC connection verbatim
// -- which is how /join works upstream: the JOIN echo opens the window.
// Commands needing server-side state the page does not keep answer with an
// honest error (see apps/the-lounge/README.md).

import { makeMsg } from './lounge-state.js'

// Commands that are usable before the network is connected, upstream's
// allowDisconnected flags.
const ALLOW_DISCONNECTED = ['part', 'close', 'leave', 'connect', 'disconnect', 'quit']

export function handleInput (ctx, network, chan, text) {
  for (const line of text.split('\n')) {
    if (line.trim().length > 0) inputLine(ctx, network, chan, line)
  }
}

function inputLine (ctx, network, chan, text) {
  const { push } = ctx
  const connected = !!(network.irc && network.irc.connected)
  const error = (msg) => push(chan, makeMsg({ type: 'error', text: msg }), true)
  const notConnected = () => error('You are not connected to the IRC network, unable to send your command.')

  let cmd
  let args
  if (text.charAt(0) !== '/' || text.charAt(1) === '/') {
    if (chan.type === 'lobby') {
      push(chan, makeMsg({ type: 'error', text: 'Messages can not be sent to lobbies.' }), true)
      return
    }
    cmd = 'say'
    args = text.replace(/^\//, '').split(' ')
  } else {
    const parts = text.substring(1).split(' ')
    cmd = (parts.shift() || '').toLowerCase()
    args = parts
  }

  if (!Object.hasOwn(ROUTES, cmd)) {
    if (!connected) return notConnected()
    // Unknown command: upstream forwards the line to the IRC connection
    // verbatim (server/client.ts inputLine's irc.raw(text)).
    network.irc.raw(text.substring(1))
    return
  }
  if (!connected && !ALLOW_DISCONNECTED.includes(cmd)) return notConnected()
  ROUTES[cmd](ctx, network, chan, args)
}

function sendMessage (network, targetName, message) {
  network.irc.say(targetName, message)
  simulateSelfMessage(network, targetName, message)
}

const ROUTES = {
  msg (ctx, network, chan, args) {
    const targetName = args.shift()
    const message = args.join(' ')
    if (!targetName || message.length === 0) return true
    sendMessage(network, targetName, message)
    return true
  },

  query (ctx, network, chan, args) {
    const targetName = args.shift()
    if (!targetName) {
      ctx.push(chan, makeMsg({ type: 'error', text: 'You cannot open a query window without an argument.' }), true)
      return
    }
    if (network.getChannel(targetName) === undefined) {
      if (network.serverOptions.CHANTYPES.includes(targetName[0])) {
        ctx.push(chan, makeMsg({ type: 'error', text: 'You can not open query windows for channels, use /join instead.' }), true)
        return
      }
      if (network.serverOptions.PREFIX.symbols.includes(targetName[0])) {
        ctx.push(chan, makeMsg({ type: 'error', text: 'You can not open query windows for names starting with a user prefix.' }), true)
        return
      }
      ctx.createQuery(network, targetName, true)
    }
    const message = args.join(' ')
    if (message.length > 0) sendMessage(network, targetName, message)
  },

  say (ctx, network, chan, args) {
    const message = args.join(' ')
    if (message.length === 0) return true
    sendMessage(network, chan.name, message)
  },

  me (ctx, network, chan, args) {
    if (args.length === 0) {
      ctx.push(chan, makeMsg({ type: 'error', text: 'You cannot send an empty message.' }), true)
      return
    }
    if (chan.type === 'lobby' || chan.type === 'special') {
      ctx.push(chan, makeMsg({ type: 'error', text: 'You can only send messages to channels and queries.' }), true)
      return
    }
    sendMessage(network, chan.name, `\u0001ACTION ${args.join(' ')}\u0001`)
  },

  action (ctx, network, chan, args) {
    ROUTES.me(ctx, network, chan, args)
  },

  slap (ctx, network, chan, args) {
    if (!args[0]) {
      ctx.push(chan, makeMsg({ type: 'error', text: 'Usage: /slap <nick>' }), true)
      return
    }
    sendMessage(network, chan.name, `\u0001ACTION slaps ${args[0]} around a bit with a large trout\u0001`)
  },

  nick (ctx, network, chan, args) {
    if (!args[0]) {
      ctx.push(chan, makeMsg({ type: 'error', text: 'You cannot change to an empty nickname.' }), true)
      return
    }
    network.irc.changeNick(args[0])
  },

  away (ctx, network, chan, args) {
    network.irc.raw('AWAY', args.join(' '))
  },

  back (ctx, network, chan, args) {
    network.irc.raw('AWAY')
  },

  connect (ctx, network, chan, args) {
    network.userDisconnected = false
    if (network.irc.connected) {
      ctx.push(chan, makeMsg({ type: 'error', text: 'You are already connected.' }), true)
      return
    }
    network.irc.connect()
  },

  disconnect (ctx, network, chan, args) {
    network.userDisconnected = true
    if (network.irc.connected) network.irc.quit(args.join(' ') || 'User disconnected')
  },

  quit (ctx, network, chan, args) {
    if (network.irc.connected) network.irc.quit(args.join(' ') || network.leaveMessage || '')
  },

  part (ctx, network, chan, args) {
    let target = chan
    if (args.length > 0) {
      const named = network.getChannel(args[0])
      if (named !== undefined) { target = named; args.shift() }
    }
    if (target.type === 'lobby') {
      ctx.push(target, makeMsg({ type: 'error', text: 'You can not part from networks, use /quit instead.' }), true)
      return
    }
    if (target.type !== 'channel' || target.state !== 1 || !network.irc.connected) {
      network.channels = network.channels.filter((c) => c !== target)
      ctx.emit('part', { chan: target.id })
    } else {
      network.irc.raw('PART', target.name, args.join(' ') || network.leaveMessage || '')
    }
  },

  close (ctx, network, chan, args) {
    ROUTES.part(ctx, network, chan, args)
  },

  leave (ctx, network, chan, args) {
    ROUTES.part(ctx, network, chan, args)
  },

  topic (ctx, network, chan, args) {
    if (chan.type !== 'channel') {
      ctx.push(chan, makeMsg({ type: 'error', text: `${'topic'} command can only be used in channels.` }), true)
      return
    }
    if (args.length === 0) network.irc.raw('TOPIC', chan.name)
    else network.irc.raw('TOPIC', chan.name, args.join(' '))
  },

  notice (ctx, network, chan, args) {
    const target = args.shift()
    if (!target || args.length === 0) {
      ctx.push(chan, makeMsg({ type: 'error', text: 'Usage: /notice <nick> <message>' }), true)
      return
    }
    network.irc.raw('NOTICE', target, args.join(' '))
  },

  kick (ctx, network, chan, args) {
    const target = args.shift()
    if (chan.type !== 'channel' || !target) {
      ctx.push(chan, makeMsg({ type: 'error', text: 'Usage: /kick <nick> [reason]' }), true)
      return
    }
    network.irc.raw('KICK', chan.name, target, args.join(' '))
  },

  mode (ctx, network, chan, args) {
    if (args.length === 0) {
      network.irc.raw('MODE', chan.type === 'channel' ? chan.name : network.nick)
      return
    }
    network.irc.raw('MODE', ...args)
  },

  invite (ctx, network, chan, args) {
    const nick = args.shift()
    if (!nick) {
      ctx.push(chan, makeMsg({ type: 'error', text: 'Usage: /invite <nick> [channel]' }), true)
      return
    }
    network.irc.raw('INVITE', nick, args[0] || chan.name)
  },

  whois (ctx, network, chan, args) {
    const target = args[0] || (chan.type === 'query' ? chan.name : undefined)
    if (!target) {
      ctx.push(chan, makeMsg({ type: 'error', text: 'Usage: /whois <nick>' }), true)
      return
    }
    network.irc.raw('WHOIS', target, target)
  },

  whowas (ctx, network, chan, args) {
    if (args.length === 0) {
      ctx.push(chan, makeMsg({ type: 'error', text: 'Usage: /whowas <nick>' }), true)
      return
    }
    network.irc.raw('WHOWAS', ...args)
  },

  ctcp (ctx, network, chan, args) {
    const target = args.shift()
    const type = (args.shift() || '').toUpperCase()
    if (!target || !type) {
      ctx.push(chan, makeMsg({ type: 'error', text: 'Usage: /ctcp <nick> <type> [message]' }), true)
      return
    }
    network.irc.say(target, `\u0001${type} ${args.join(' ')}\u0001`.trim())
  },

  raw (ctx, network, chan, args) {
    if (args.length === 0) {
      ctx.push(chan, makeMsg({ type: 'error', text: 'Usage: /raw <line>' }), true)
      return
    }
    network.irc.raw(args.join(' '))
  },

  quote (ctx, network, chan, args) {
    ROUTES.raw(ctx, network, chan, args)
  },

  list (ctx, network, chan, args) {
    network.irc.raw('LIST', ...args)
  },

  collapse () { /* client-side in upstream too */ },
  expand () { /* client-side in upstream too */ },
  search () { /* client-side in upstream too */ },

  ignore (ctx, network, chan, args) {
    ctx.push(chan, makeMsg({ type: 'error', text: 'The ignore list is not available in this port: it is server-side state the page does not keep.' }), true)
  },
  ban (ctx, network, chan, args) {
    ctx.push(chan, makeMsg({ type: 'error', text: 'Ban lists are not available in this port: they are server-side state the page does not keep.' }), true)
  },
  kickban (ctx, network, chan, args) {
    ctx.push(chan, makeMsg({ type: 'error', text: 'Ban lists are not available in this port: they are server-side state the page does not keep.' }), true)
  },
  kill (ctx, network, chan, args) {
    ctx.push(chan, makeMsg({ type: 'error', text: 'Operator commands are not available in this port.' }), true)
  },
  mute (ctx, network, chan, args) {
    ctx.push(chan, makeMsg({ type: 'error', text: 'Muting is session-only in this port and not reachable through /mute.' }), true)
  },
  rejoin (ctx, network, chan, args) {
    ctx.push(chan, makeMsg({ type: 'error', text: '/rejoin needs a keyed channel record the page does not keep; use /join #channel key.' }), true)
  }
}

export function getCommandList () {
  const commands = Object.keys(ROUTES).filter((name) => !['collapse', 'expand', 'search'].includes(name))
  const clientSide = ['/collapse', '/expand', '/search']
  const passThrough = ['/as', '/bs', '/cs', '/ho', '/hs', '/join', '/ms', '/ns', '/os', '/rs']
  return commands.map((command) => `/${command}`).concat(clientSide).concat(passThrough).sort()
}

function simulateSelfMessage (network, targetName, message) {
  // Without echo-message the client never sees what it sends, so the message
  // is emitted locally (server/plugins/inputs/msg.ts does the same).
  if (network.irc.network.cap.enabled.includes('echo-message')) return
  network.irc.emit('privmsg', {
    nick: network.irc.user.nick,
    ident: network.irc.user.username,
    hostname: network.irc.user.host,
    target: targetName,
    message
  })
}
