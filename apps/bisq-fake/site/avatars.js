// Flat-illustration peer avatars in the style Bisq draws next to each
// offer, one per seed, so a seller keeps the same face across re-renders.
// The ring says what the account-info column says: orange for account age
// on a method that needs no signing, red for unsigned, green for signed.
'use strict'

;(function () {
  const BACKGROUNDS = ['#6fa874', '#b34a44', '#3f8c85', '#7d7d7d', '#5a7fb0', '#a87a4f', '#8b5a9e', '#4f7f4a']
  const SKIN = ['#f5d5b0', '#e7b58c', '#c98e5e', '#8d5a36', '#f0c8a0', '#ae7148']
  const HAIR = ['#2b1a10', '#5e3519', '#b88a2c', '#e9e5dc', '#161616', '#8c3f1f', '#6d6d6d']
  const SHIRTS = ['#6fa3d6', '#c0392b', '#7f8c8d', '#8e7cc3', '#d9822b', '#9aa5a6', '#3d6f99', '#b8b060']
  const RINGS = { age: '#ef9212', unsigned: '#a51212', signed: '#1d8a1d' }

  // A seed becomes a small stream of numbers: mulberry32, which is enough to
  // spread thirty avatars across the palettes without visible repeats.
  function stream (seed) {
    let state = seed >>> 0
    return (count) => {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return (((t ^ (t >>> 14)) >>> 0) % count)
    }
  }

  const HAIRCUTS = [
    () => '',
    (c) => `<path d="M10.4 13c-.3-5.6 2.1-7.9 5.6-7.9s5.9 2.3 5.6 7.9c-.9-2.6-2.8-3.8-5.6-3.8s-4.7 1.2-5.6 3.8z" fill="${c}"/>`,
    (c) => `<path d="M10.2 13.5c-.4-5.8 2.1-8.4 5.8-8.4s6.2 2.6 5.8 8.4c-1.4-2.7-3.2-4.6-5.8-4.9-1.6 1.6-3.4 3-5.8 4.9z" fill="${c}"/>`,
    (c) => `<path d="M16 4.6c-4.9 0-6.9 3.4-6.6 8.6l.4 9.3h12.4l.4-9.3c.3-5.2-1.7-8.6-6.6-8.6z" fill="${c}"/>`,
    (c) => `<circle cx="16" cy="4.8" r="2.6" fill="${c}"/><path d="M10.4 13c-.3-5.6 2.1-7.9 5.6-7.9s5.9 2.3 5.6 7.9c-.9-2.6-2.8-3.8-5.6-3.8s-4.7 1.2-5.6 3.8z" fill="${c}"/>`,
    (c) => `<path d="M10.3 12.6 11 7.4l1.6 1.4.9-3.6 1.8 2.6 1.4-3.4 1.2 3.4 2-2.3.3 3.5 1.6-.8.1 4.4c-1.2-1.8-3.2-2.7-5.9-2.7s-4.6.9-5.6 2.7z" fill="${c}"/>`
  ]

  // Long hair falls behind the head and shoulders, so it is drawn first.
  const LONG = 3

  function avatar (seed, ring) {
    const pick = stream(seed)
    const bg = BACKGROUNDS[pick(BACKGROUNDS.length)]
    const skin = SKIN[pick(SKIN.length)]
    const hair = HAIR[pick(HAIR.length)]
    const shirt = SHIRTS[pick(SHIRTS.length)]
    const cut = pick(HAIRCUTS.length)
    const beard = pick(4) === 0 && cut !== LONG
    const glasses = pick(7) === 0

    const parts = [`<circle cx="16" cy="16" r="16" fill="${bg}"/>`]
    if (cut === LONG) parts.push(HAIRCUTS[LONG](hair))
    parts.push(
      `<path d="M3.5 32c.4-6.9 5.4-10.4 12.5-10.4S28.1 25.1 28.5 32z" fill="${shirt}"/>`,
      `<path d="M13.6 17.5h4.8v5.1c-.8 1.1-4 1.1-4.8 0z" fill="${skin}"/>`,
      `<ellipse cx="16" cy="12.9" rx="5.7" ry="6.6" fill="${skin}"/>`
    )
    if (cut !== LONG) parts.push(HAIRCUTS[cut](hair))
    else parts.push(`<path d="M10.5 12.4c.4-3.8 2.5-5.6 5.5-5.6s5.1 1.8 5.5 5.6c-1.8-1.8-3.4-2.9-5.5-3.2-1.5 1.4-3.3 2.5-5.5 3.2z" fill="${hair}"/>`)
    if (beard) parts.push(`<path d="M10.5 13.6c.2 5.6 2.4 8 5.5 8s5.3-2.4 5.5-8c-.8 2.4-2.1 3.2-3.2 3.2-.8-.7-3.8-.7-4.6 0-1.1 0-2.4-.8-3.2-3.2z" fill="${hair}"/>`)
    if (glasses) parts.push('<rect x="11.2" y="11.3" width="4.2" height="2.6" rx=".9" fill="#1b1b1b"/><rect x="16.6" y="11.3" width="4.2" height="2.6" rx=".9" fill="#1b1b1b"/><path d="M15.4 12.2h1.2" stroke="#1b1b1b" stroke-width=".8"/>')

    const clip = `bq-avatar-${String(seed)}-${ring}`
    return `<svg class="avatar" viewBox="0 0 32 32"><clipPath id="${clip}"><circle cx="16" cy="16" r="14.6"/></clipPath>` +
      `<g clip-path="url(#${clip})">${parts.join('')}</g>` +
      `<circle cx="16" cy="16" r="14.6" fill="none" stroke="${RINGS[ring]}" stroke-width="2.6"/></svg>`
  }

  window.BisqAvatar = avatar
})()
