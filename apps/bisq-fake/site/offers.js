// The offer book. The first sixteen EUR offers are the ones the reference
// screenshot shows, row for row; everything below them, and every other
// currency, is generated from a fixed seed so the book is the same on every
// load. Nothing here is fetched: the market price is a starting value that
// app.js walks.
'use strict'

;(function () {
  // pricing: a market-based offer is `pct` away from the market price and
  // moves with it; a fixed one is `price` and does not.
  // account: 'age' needs no signing, 'unsigned' and 'signed' do.
  const m = (pct, min, max, method, deposit, account, days) => ({ pricing: 'market', pct, min, max, method, deposit, account, days })
  const fixed = (price, min, max, method, deposit, account, days) => ({ pricing: 'fixed', price, min, max, method, deposit, account, days })

  const EUR_SCREEN = [
    m(-2.00, 0.0090, 0.0090, 'CashByMail', '0.003150 (35%)', 'age', 12),
    fixed(74600, 0.0150, 0.0150, 'SEPA (PL)', '0.004461 (30%)', 'unsigned'),
    m(-1.00, 0.0130, 0.0130, 'SEPA Instant (BE)', '0.003250 (25%)', 'unsigned'),
    m(-1.00, 0.0068, 0.0068, 'SEPA Instant (FR)', '0.00254116 (37%)', 'unsigned'),
    m(-1.00, 0.0400, 0.0400, 'SEPA (SK)', '0.014948 (37%)', 'unsigned'),
    m(-1.00, 0.0130, 0.0260, 'CashByMail', '0.0039 (15%)', 'age', 3),
    m(-0.02, 0.0100, 0.0100, 'SEPA (IT)', '0.0015 (15%)', 'signed', 2309),
    m(-0.01, 0.0624, 0.0624, 'SEPA (CZ)', '0.018720 (30%)', 'signed', 809),
    m(0.00, 0.0110, 0.0110, 'Revolut', '0.001650 (15%)', 'signed', 1117),
    m(0.00, 0.0226, 0.0226, 'SEPA (ES)', '0.004520 (20%)', 'unsigned'),
    m(0.00, 0.0600, 0.0600, 'SEPA (IT)', '0.0150 (25%)', 'signed', 2309),
    m(0.00, 0.0300, 0.0300, 'SEPA (DE)', '0.008922 (30%)', 'unsigned'),
    m(0.30, 0.0052, 0.0052, 'SEPA (GR)', '0.00194319 (37%)', 'unsigned'),
    m(0.99, 0.0312, 0.0312, 'SEPA (CZ)', '0.009360 (30%)', 'signed', 809),
    m(0.99, 0.0312, 0.0312, 'SEPA Instant (CZ)', '0.009360 (30%)', 'signed', 530),
    m(0.99, 0.0100, 0.0100, 'SEPA (CZ)', '0.0030 (30%)', 'signed', 809)
  ]

  // Methods that need no account signing show account age, not a signature.
  const UNSIGNED_METHODS = ['CashByMail', 'Amazon eGift Card', 'US Postal Money Order']

  const MARKETS = {
    EUR: {
      name: 'Euro',
      price: 75512.81337,
      count: 75,
      methods: [
        'SEPA (DE)', 'SEPA (DE)', 'SEPA (FR)', 'SEPA (NL)', 'SEPA (ES)', 'SEPA (IT)', 'SEPA (AT)', 'SEPA (BE)', 'SEPA (PT)',
        'SEPA (FI)', 'SEPA (IE)', 'SEPA (LT)', 'SEPA Instant (DE)', 'SEPA Instant (NL)', 'SEPA Instant (FR)', 'SEPA Instant (ES)',
        'Revolut', 'Revolut', 'Wise', 'Amazon eGift Card', 'CashByMail', 'Money Beam (N26)'
      ]
    },
    USD: {
      name: 'US Dollar',
      price: 88440.62,
      count: 38,
      methods: ['Zelle', 'Zelle', 'Strike', 'Revolut', 'Wise', 'Amazon eGift Card', 'US Postal Money Order', 'CashByMail', 'Cash deposit']
    },
    GBP: {
      name: 'British Pound',
      price: 65605.53,
      count: 11,
      methods: ['Faster Payments', 'Faster Payments', 'Revolut', 'Wise', 'CashByMail']
    },
    CHF: {
      name: 'Swiss Franc',
      price: 70914.08,
      count: 6,
      methods: ['National bank transfer (CH)', 'Revolut', 'Wise', 'CashByMail']
    }
  }

  function random (seed) {
    let state = seed >>> 0
    return () => {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  const DEPOSIT_PCTS = [15, 15, 20, 25, 25, 30, 30, 35, 37, 50]

  // Bisq prints BTC with at least four decimals, then two more at a time
  // for as long as they carry anything, down to the satoshi.
  function btcText (value) {
    const sats = Math.round(value * 1e8)
    for (const digits of [4, 6]) {
      if (sats % 10 ** (8 - digits) === 0) return (sats / 1e8).toFixed(digits)
    }
    return (sats / 1e8).toFixed(8)
  }

  const depositFor = (max, pct) => `${btcText(max * pct / 100)} (${String(pct)}%)`

  function generate (currency, from, count, startPct, seed) {
    const market = MARKETS[currency]
    const rand = random(seed)
    const out = []
    let pct = startPct
    for (let i = 0; i < count; i++) {
      pct += rand() < 0.35 ? 0 : 0.05 + rand() * 0.22
      const method = market.methods[Math.floor(rand() * market.methods.length)]
      const single = rand() < 0.72
      const base = [0.005, 0.01, 0.0125, 0.015, 0.02, 0.025, 0.03, 0.05, 0.06, 0.08, 0.1, 0.25][Math.floor(rand() * 12)]
      const min = Math.round(base * (0.8 + rand() * 0.6) * 10000) / 10000
      const max = single ? min : Math.round(min * (2 + Math.floor(rand() * 3)) * 10000) / 10000
      const depositPct = DEPOSIT_PCTS[Math.floor(rand() * DEPOSIT_PCTS.length)]
      const needsSigning = !UNSIGNED_METHODS.includes(method)
      const account = !needsSigning ? 'age' : (rand() < 0.62 ? 'signed' : 'unsigned')
      const days = account === 'unsigned' ? undefined : 20 + Math.floor(rand() * (account === 'age' ? 400 : 2300))
      const deposit = depositFor(max, depositPct)
      if (rand() < 0.1) {
        const price = Math.round(market.price * (1 + pct / 100) / 500) * 500
        out.push(fixed(price, min, max, method, deposit, account, days))
      } else {
        out.push(m(Math.round(pct * 100) / 100, min, max, method, deposit, account, days))
      }
    }
    return out.map((offer, index) => ({ ...offer, id: from + index }))
  }

  function book (currency) {
    if (currency === 'EUR') {
      const screen = EUR_SCREEN.map((offer, index) => ({ ...offer, id: index + 1 }))
      return screen.concat(generate('EUR', 17, MARKETS.EUR.count - screen.length, 0.99, 0xb15c))
    }
    const seeds = { USD: 0x05d0, GBP: 0x0c8b, CHF: 0x0c4f }
    return generate(currency, 1000 * Object.keys(MARKETS).indexOf(currency), MARKETS[currency].count, -1.5, seeds[currency])
  }

  window.BisqOffers = { MARKETS, book }
})()
