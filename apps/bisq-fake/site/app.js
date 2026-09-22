// The Buy BTC offer book: rendering, filters, sorting, and the few things
// that keep moving while it is on screen -- the market price, the block
// download and the peer counts. Every button is local: nothing here opens a
// socket, and nothing is ever submitted anywhere.
'use strict'

;(function () {
  const { icon, fill } = window.BisqIcons
  const { MARKETS, book } = window.BisqOffers
  const avatar = window.BisqAvatar

  // The payment accounts this profile has set up. An offer needing any
  // other method is shown dimmed, and "Offers matching my accounts" hides it.
  const MY_ACCOUNTS = ['CashByMail']
  const BLOCK_HEIGHT = 924039
  const SYNC_START_PCT = 12
  const SYNC_SECONDS = 170

  const state = {
    currency: 'EUR',
    method: null,
    matching: false,
    sort: { key: 'price', dir: 1 },
    prices: Object.fromEntries(Object.entries(MARKETS).map(([code, market]) => [code, market.price])),
    offers: book('EUR'),
    synced: false,
    peers: { btc: 6, bisq: 3 }
  }

  const $ = (id) => document.getElementById(id)

  // Formatting, the way Bisq prints each column.

  const priceText = (value) => value.toFixed(4)
  const pctText = (value) => `(${(Math.abs(value) < 0.005 ? 0 : value).toFixed(2)}%)`

  function amountHtml (value) {
    const text = value.toFixed(4)
    const match = /^(\d+\.\d*?[1-9])(0*)$/.exec(text)
    if (match === null || match[2] === '') return text
    return `${match[1]}<span class="zeros">${match[2]}</span>`
  }

  function offerPrice (offer) {
    const market = state.prices[state.currency]
    if (offer.pricing === 'fixed') return { price: offer.price, pct: (offer.price / market - 1) * 100 }
    return { price: market * (1 + offer.pct / 100), pct: offer.pct }
  }

  function volumeText (offer, price) {
    const low = Math.round(offer.min * price)
    const high = Math.round(offer.max * price)
    return low === high ? String(low) : `${String(low)} - ${String(high)}`
  }

  function accountHtml (offer) {
    if (offer.account === 'unsigned') return `Not signed yet<span class="row-icon">${icon('unsigned')}</span>`
    const days = `${offer.days.toLocaleString('en-US')} days`
    return `${days}<span class="row-icon">${icon(offer.account === 'age' ? 'age' : 'signed')}</span>`
  }

  const takeable = (offer) => MY_ACCOUNTS.includes(offer.method)

  // Filtering and sorting.

  const SORTS = {
    price: (offer) => offerPrice(offer).price,
    amount: (offer) => offer.max,
    volume: (offer) => offer.max * offerPrice(offer).price,
    method: (offer) => offer.method,
    deposit: (offer) => parseFloat(offer.deposit),
    account: (offer) => (offer.account === 'unsigned' ? -1 : offer.days)
  }

  function visibleOffers () {
    const key = SORTS[state.sort.key]
    return state.offers
      .filter((offer) => state.method === null || offer.method === state.method)
      .filter((offer) => !state.matching || takeable(offer))
      .sort((a, b) => {
        const x = key(a)
        const y = key(b)
        const order = typeof x === 'string' ? x.localeCompare(y) : x - y
        return (order === 0 ? a.id - b.id : order) * state.sort.dir
      })
  }

  function rowHtml (offer) {
    const { price, pct } = offerPrice(offer)
    const priceIcon = offer.pricing === 'fixed' ? 'lock' : 'chart'
    return `<div class="row${takeable(offer) ? '' : ' dim'}" data-id="${String(offer.id)}">
      <div class="td"><div class="cell">${priceText(price)}<span class="row-icon">${icon(priceIcon)}</span>${pctText(pct)}</div></div>
      <div class="td"><div class="cell"><span>${offer.min === offer.max ? amountHtml(offer.min) : `${amountHtml(offer.min)} - ${amountHtml(offer.max)}`}</span></div></div>
      <div class="td"><div class="cell">${volumeText(offer, price)}</div></div>
      <div class="td"><div class="cell"><span class="method">${offer.method}</span><span class="info-icon">${icon('info')}</span></div></div>
      <div class="td"><div class="cell">${offer.deposit}</div></div>
      <div class="td"><div class="cell">${accountHtml(offer)}</div></div>
      <div class="td td-action"><div class="cell" style="width:100%"><button class="take"><span class="take-icon">${icon('buyTray')}</span>BUY</button></div></div>
      <div class="td td-seller"><div class="cell">${avatar(offer.id * 7919 + 17, offer.account)}</div></div>
    </div>`
  }

  function render () {
    const offers = visibleOffers()
    $('table-body').innerHTML = offers.length === 0
      ? '<div class="empty">No offers available</div>'
      : offers.map(rowHtml).join('')
    $('offer-count').textContent = `No. of offers: ${String(offers.length)}`
    for (const th of document.querySelectorAll('.th[data-sort]')) {
      const sorted = th.dataset.sort === state.sort.key
      th.classList.toggle('sorted', sorted)
      th.querySelector('.sort-arrow').style.transform = sorted && state.sort.dir < 0 ? 'rotate(180deg)' : ''
    }
  }

  function renderMarketPrice () {
    $('market-price').textContent = `BTC/EUR: ${state.prices.EUR.toFixed(2)}`
  }

  // Combo boxes.

  function combo (id, items, selected, onPick) {
    const box = $(id)
    const list = box.querySelector('.combo-list')
    list.innerHTML = items.map((item) => `<li data-value="${item.value}"${item.value === selected ? ' class="selected"' : ''}>${item.label}</li>`).join('')
    box.onclick = (event) => {
      const choice = event.target.closest('li')
      if (choice !== null) {
        box.classList.remove('open')
        onPick(choice.dataset.value)
        return
      }
      const open = !box.classList.contains('open')
      for (const other of document.querySelectorAll('.combo.open')) other.classList.remove('open')
      box.classList.toggle('open', open)
    }
  }

  const currencyLabel = (code) => `${code}&nbsp;&ndash;&nbsp;&nbsp;${MARKETS[code].name}`

  function setupCombos () {
    $('currency-value').innerHTML = currencyLabel(state.currency)
    combo('currency-combo', Object.keys(MARKETS).map((code) => ({ value: code, label: currencyLabel(code) })), state.currency, (code) => {
      state.currency = code
      state.method = null
      state.offers = book(code)
      $('price-header').textContent = `Price in ${code} for 1 BTC`
      $('volume-header').textContent = `${code} (min - max)`
      setupCombos()
      render()
    })

    const methods = [...new Set(state.offers.map((offer) => offer.method))].sort()
    $('method-value').textContent = state.method ?? 'Show all'
    combo('method-combo', [{ value: '', label: 'Show all' }, ...methods.map((method) => ({ value: method, label: method }))], state.method ?? '', (method) => {
      state.method = method === '' ? null : method
      setupCombos()
      render()
    })
  }

  document.addEventListener('click', (event) => {
    if (event.target.closest('.combo') === null) {
      for (const box of document.querySelectorAll('.combo.open')) box.classList.remove('open')
    }
  })

  // Popups, worded as Bisq words them.

  function popup (headline, message, primary) {
    $('popup-headline').textContent = headline
    $('popup-message').textContent = message
    $('popup-primary').hidden = primary === undefined
    $('popup-primary').textContent = primary ?? ''
    $('popup-secondary').textContent = primary === undefined ? 'Close' : 'Cancel'
    $('popup').hidden = false
  }

  const closePopup = () => { $('popup').hidden = true }
  $('popup-primary').onclick = closePopup
  $('popup-secondary').onclick = closePopup
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closePopup() })

  function notSynced () {
    popup('Warning', 'You need to wait until the download of missing Bitcoin blocks is complete.')
  }

  function needsFunds (amountBtc) {
    popup('Information',
      `To take this offer you need to fund your Bisq wallet with ${amountBtc} BTC.\n\n` +
      'That covers the security deposit, the trade fee and the mining fee. Your available balance is 0.00 BTC.\n\n' +
      'You can fund your wallet at "Funds/Receive funds".', 'Go to Funds')
  }

  function take (offer) {
    if (!takeable(offer)) {
      popup('No matching payment account.',
        'This offer uses a payment method you haven\'t set up yet.\n\n' +
        'You need to set up this payment method in "Account" if you want to take this offer.\n\n' +
        'Would you like to do this now?', 'Yes')
      return
    }
    if (!state.synced) { notSynced(); return }
    needsFunds((parseFloat(offer.deposit) + 0.0003 + offer.max * 0.0115).toFixed(8))
  }

  $('table-body').addEventListener('click', (event) => {
    const button = event.target.closest('.take')
    if (button === null) return
    const id = Number(button.closest('.row').dataset.id)
    const offer = state.offers.find((candidate) => candidate.id === id)
    if (offer !== undefined) take(offer)
  })

  $('create-offer').onclick = () => {
    if (!state.synced) { notSynced(); return }
    needsFunds('0.00150000')
  }

  $('matching-toggle').onclick = (event) => {
    event.preventDefault()
    state.matching = !state.matching
    $('matching-toggle').classList.toggle('on', state.matching)
    render()
  }

  for (const th of document.querySelectorAll('.th[data-sort]')) {
    th.onclick = () => {
      const key = th.dataset.sort
      state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : 1 }
      render()
    }
  }

  // What keeps moving.

  function tickPrice () {
    const factor = 1 + (Math.random() - 0.5) * 0.0012
    for (const code of Object.keys(state.prices)) state.prices[code] *= factor
    renderMarketPrice()
    render()
    setTimeout(tickPrice, 8000 + Math.random() * 7000)
  }

  const started = performance.now()
  function tickSync () {
    const t = (performance.now() - started) / 1000
    if (t >= SYNC_SECONDS) {
      state.synced = true
      $('btc-sync').textContent = `Synchronized with Bitcoin Mainnet (via Tor) at block: ${String(BLOCK_HEIGHT)}`
      return
    }
    const pct = SYNC_START_PCT + (100 - SYNC_START_PCT) * (1 - Math.pow(1 - t / SYNC_SECONDS, 2.2))
    $('btc-sync').textContent = `Synchronizing with Bitcoin Mainnet (via Tor) at block: ${String(BLOCK_HEIGHT)} / ${pct.toFixed(2)}%`
    setTimeout(tickSync, 600 + Math.random() * 500)
  }

  function tickPeers () {
    const { peers } = state
    if (peers.btc < 8 && Math.random() < 0.5) peers.btc += 1
    if (peers.bisq < 9 && Math.random() < 0.7) peers.bisq += 1
    else if (peers.bisq > 6 && Math.random() < 0.3) peers.bisq -= 1
    $('peers').textContent = `Bitcoin network peers: ${String(peers.btc)} / Bisq network peers: ${String(peers.bisq)}`
    setTimeout(tickPeers, 6000 + Math.random() * 14000)
  }

  document.addEventListener('contextmenu', (event) => { event.preventDefault() })

  fill(document)
  for (const arrow of document.querySelectorAll('.sort-arrow')) arrow.innerHTML = icon('sortUp')
  setupCombos()
  renderMarketPrice()
  render()
  setTimeout(tickPrice, 9000)
  setTimeout(tickSync, 1500)
  setTimeout(tickPeers, 7000)
})()
