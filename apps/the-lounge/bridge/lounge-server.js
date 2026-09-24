// The Lounge's server-side socket API in the page. On the client's socket.io
// connect, a public-mode server performs authentication immediately and sends
// configuration, init and commands (server/server.ts performAuthentication ->
// initializeClient); after that it answers the events in
// shared/types/socket-events.d.ts. Everything this engine does not carry is
// answered with upstream's own "not available" shape, never with fake data.

import { Chan, Network, makeMsg, pushMessage } from './lounge-state.js'
import { wireIrcEvents } from './lounge-handlers.js'
import { handleInput, getCommandList } from './lounge-commands.js'
import { IrcClient } from './lounge-irc.js'

const SETTINGS_KEY = 'orivon.the-lounge.settings'

export class LoungeServer {
  constructor () {
    this.networks = []
    this.openChannel = -1
    this.mentions = []
    this.settings = this.loadSettings()
  }

  loadSettings () {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') } catch { return {} }
  }

  saveSettings (settings) {
    this.settings = settings
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)) } catch { /* private mode or full quota: settings are session-only */ }
  }

  emit (event, ...args) {
    this.sio.emit(event, ...args)
  }

  push (chan, msg, increasesUnread = false) {
    pushMessage((event, ...args) => this.emit(event, ...args), this, chan, msg, increasesUnread)
    if (msg.highlight && chan.type === 'channel') {
      this.mentions.push({
        chanId: chan.id,
        msgId: msg.id,
        type: msg.type,
        time: msg.time,
        text: msg.text,
        from: msg.from
      })
      if (this.mentions.length > 100) this.mentions.splice(0, this.mentions.length - 100)
    }
  }

  attach (sio) {
    this.sio = sio
    sio.on('connect', () => this.performAuthentication())
    sio.on('input', (data) => { if (data && typeof data.text === 'string') this.input(data) })
    sio.on('more', (data) => {
      const history = this.more(data)
      if (history !== null) this.emit('more', history)
    })
    sio.on('open', (id) => {
      this.openChannel = id
      // client.open(): opening a channel is what clears its unread state.
      const found = this.find(id)
      if (found) {
        found.chan.unread = 0
        found.chan.highlight = 0
        found.chan.firstUnread = found.chan.messages.length > 0 ? found.chan.messages[found.chan.messages.length - 1].id : 0
      }
    })
    sio.on('names', (data) => this.names(data))
    sio.on('network:new', (data) => { if (data) this.connectToNetwork(data) })
    sio.on('network:get', (uuid) => this.networkInfo(uuid))
    sio.on('network:edit', (data) => this.networkEdit(data))
    sio.on('setting:get', () => this.emit('setting:all', this.settings))
    sio.on('setting:set', (data) => {
      if (!data || typeof data.name !== 'string') return
      this.saveSettings({ ...this.settings, [data.name]: data.value })
      this.emit('setting:new', { name: data.name, value: data.value })
    })
    sio.on('sort:networks', (data) => this.sortNetworks(data))
    sio.on('sort:channels', (data) => this.sortChannels(data))
    sio.on('mentions:get', () => this.emit('mentions:list', this.mentions))
    sio.on('mentions:dismiss', (msgId) => {
      this.mentions = this.mentions.filter((mention) => mention.msgId !== msgId)
      this.emit('mentions:list', this.mentions)
    })
    sio.on('mentions:dismiss_all', () => {
      this.mentions = []
      this.emit('mentions:list', this.mentions)
    })
    sio.on('history:clear', (data) => this.clearHistory(data))
    sio.on('changelog', () => this.emit('changelog', {
      current: { prerelease: false, version: '4.5.2', url: 'https://thelounge.chat/changelog' },
      expiresAt: Date.now() + 3600000
    }))
    sio.on('search', () => this.emit('search:results', {
      results: [],
      query: { searchTerm: '', target: '' },
      backend: 'memory'
    }))
    sio.on('change-password', () => this.emit('change-password', { success: false, error: 'no_user' }))
    sio.on('sessions:get', () => this.emit('sessions:list', []))
    sio.on('push:register', () => this.emit('push:unregister'))
    sio.on('push:unregister', () => this.emit('push:issubscribed', false))
    sio.on('mute:change', () => { /* session-scoped: mute state lives until the page closes */ })
    sio.on('upload:auth', () => this.emit('upload:auth', ''))
    sio.on('upload:ping', () => this.emit('upload:auth', ''))
    sio.on('disconnect', () => {
      // Public mode: upstream quits every network when the page goes away.
      for (const network of this.networks) {
        if (network.irc && network.irc.connected) network.irc.quit('Page closed')
      }
    })
  }

  performAuthentication () {
    this.emit('auth:success')
    this.emit('configuration', this.configuration())
    this.emit('push:issubscribed', false)
    this.emit('init', { active: this.openChannel, networks: this.networks.map((network) => network.clone(this.openChannel, -1)) })
    this.emit('commands', getCommandList())
  }

  configuration () {
    return {
      fileUpload: false,
      ldapEnabled: false,
      isUpdateAvailable: false,
      applicationServerKey: undefined,
      version: '4.5.2',
      gitCommit: null,
      themes: [
        { displayName: 'Default', name: 'default', themeColor: null },
        { displayName: 'Morning', name: 'morning', themeColor: null }
      ],
      defaultTheme: 'default',
      public: true,
      useHexIp: false,
      prefetch: false,
      fileUploadMaxFileSize: undefined,
      lockNetwork: false,
      defaults: {
        name: 'Libera.Chat',
        host: 'irc.libera.chat',
        port: 6697,
        password: '',
        tls: true,
        rejectUnauthorized: true,
        nick: expandDefaultNick('thelounge%%'),
        username: 'thelounge',
        realname: '',
        join: '#thelounge',
        leaveMessage: '',
        sasl: '',
        saslAccount: '',
        saslPassword: ''
      }
    }
  }

  input (data) {
    const found = this.find(data.target)
    if (!found) return
    const text = data.text.trim()
    if (text.length === 0) return
    handleInput(this.ctx(), found.network, found.chan, text)
  }

  more (data) {
    const found = this.find(data.target)
    if (!found) return null
    // server/client.ts more(): lastId < 0 means the last 100, otherwise the
    // 100 before the requested id; an unknown id is an empty page. Condensed
    // pagination is a log-feature of storage backends the port does not keep.
    const messages = found.chan.messages
    let index
    if (data.lastId < 0) index = messages.length
    else index = messages.findIndex((message) => message.id === data.lastId)
    const page = index > 0 ? messages.slice(Math.max(0, index - 100), index) : []
    return { chan: found.chan.id, messages: page, totalMessages: messages.length }
  }

  names (data) {
    const found = this.find(data.target)
    if (!found) return
    this.emit('names', { id: found.chan.id, users: found.chan.getSortedUsers() })
  }

  connectToNetwork (args) {
    const network = new Network({
      uuid: crypto.randomUUID(),
      name: args.name || args.host || '',
      host: args.host || '',
      port: parseInt(args.port, 10) || 6667,
      tls: !!args.tls,
      rejectUnauthorized: !!args.rejectUnauthorized,
      password: args.password || '',
      nick: args.nick || '',
      username: args.username || '',
      realname: args.realname || '',
      leaveMessage: args.leaveMessage || '',
      sasl: args.sasl || '',
      saslAccount: args.saslAccount || '',
      saslPassword: args.saslPassword || '',
      commands: args.commands || [],
      channels: (args.join || '')
        .replace(/,/g, ' ')
        .split(/\s+/g)
        .filter(Boolean)
        .map((name) => new Chan({ name: /^[#&!+]/.test(name) ? name : `#${name}` }))
    })
    this.networks.push(network)
    this.emit('network', { network: network.clone(this.openChannel, -1) })

    const lobby = network.getLobby()
    if (!args.host || !args.nick) {
      this.push(lobby, makeMsg({ type: 'error', text: 'You must specify a hostname and a nickname.' }), true)
      return
    }
    this.push(lobby, makeMsg({ text: `Network created, connecting to ${network.host}:${network.port}...` }), true)

    const irc = new IrcClient({
      host: network.host,
      port: network.port,
      tls: network.tls,
      rejectUnauthorized: network.rejectUnauthorized,
      password: network.password,
      nick: network.nick,
      username: network.username,
      realname: network.realname,
      sasl: network.sasl,
      saslAccount: network.saslAccount,
      saslPassword: network.saslPassword
    })
    network.irc = irc
    wireIrcEvents(this.ctx(), network, irc)
    irc.connect()
  }

  networkInfo (uuid) {
    const network = this.networks.find((network) => network.uuid === uuid)
    if (!network) return
    // network.exportForEdit()'s field list: plain data only, never the irc handle.
    this.emit('network:info', {
      uuid: network.uuid,
      name: network.name,
      nick: network.nick,
      host: network.host,
      port: network.port,
      tls: network.tls,
      rejectUnauthorized: network.rejectUnauthorized,
      password: network.password,
      username: network.username,
      realname: network.realname,
      leaveMessage: network.leaveMessage,
      sasl: network.sasl,
      saslAccount: network.saslAccount,
      saslPassword: network.saslPassword,
      commands: network.commands,
      useHexIp: false
    })
  }

  networkEdit (data) {
    if (!data || !data.uuid) return
    const network = this.networks.find((network) => network.uuid === data.uuid)
    if (!network) return
    for (const field of ['name', 'nick', 'username', 'realname', 'leaveMessage', 'password', 'saslAccount', 'saslPassword', 'host', 'port', 'tls', 'rejectUnauthorized']) {
      if (data[field] !== undefined) network[field] = data[field]
    }
    if (data.commands) network.commands = data.commands
  }

  sortNetworks (data) {
    if (!Array.isArray(data.order)) return
    const byUuid = new Map(this.networks.map((network) => [network.uuid, network]))
    const sorted = data.order.map((uuid) => byUuid.get(uuid)).filter(Boolean)
    for (const network of this.networks) if (!data.order.includes(network.uuid)) sorted.push(network)
    this.networks = sorted
  }

  sortChannels (data) {
    if (!Array.isArray(data.order) || typeof data.network !== 'string') return
    const network = this.networks.find((network) => network.uuid === data.network)
    if (!network) return
    const byId = new Map(network.channels.map((chan) => [chan.id, chan]))
    const sorted = data.order.map((id) => byId.get(id)).filter(Boolean)
    for (const chan of network.channels) if (!data.order.includes(chan.id)) sorted.push(chan)
    network.channels = sorted
  }

  clearHistory (data) {
    const found = this.find(data.target)
    if (!found) return
    found.chan.messages = []
    found.chan.unread = 0
    found.chan.highlight = 0
    found.chan.firstUnread = 0
    this.emit('history:clear', { target: found.chan.id })
  }

  find (chanId) {
    for (const network of this.networks) {
      for (const chan of network.channels) {
        if (chan.id === chanId) return { network, chan }
      }
    }
    return null
  }

  ctx () {
    return {
      emit: (event, ...args) => this.emit(event, ...args),
      push: (chan, msg, increasesUnread) => this.push(chan, msg, increasesUnread),
      createQuery: (network, name, shouldOpen) => this.createQuery(network, name, shouldOpen)
    }
  }

  createQuery (network, name, shouldOpen = false) {
    const newChan = new Chan({ type: 'query', name })
    this.emit('join', {
      network: network.uuid,
      chan: newChan.clone(true),
      shouldOpen,
      index: network.addChannel(newChan)
    })
    return newChan
  }
}

function expandDefaultNick (pattern) {
  return pattern.replace(/%/g, () => Math.floor(Math.random() * 10).toString())
}
