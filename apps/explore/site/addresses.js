// Where a listed site can be reached, and which of those addresses a click should use.
// Pure: no DOM, no window.

/**
 * @typedef {{ inOrivon: boolean }} Env
 * @typedef {{
 *   kind: 'ens' | 'ipfs' | 'web',
 *   text: string,
 *   title: string,
 *   href: string | null
 * }} Chip
 */

const ORIVON_ORDER = ['ens', 'ipfs', 'web']
const OPEN_WEB_ORDER = ['web', 'ens', 'ipfs']

/**
 * A site that runs only in Orivon has no link outside it: a gateway would load the
 * page, and the page would then not work.
 * @param {import('./catalog.js').Site} site
 * @param {Env} env
 */
export function isBlocked (site, env) {
  return site.orivon?.needsOrivon === true && !env.inOrivon
}

/**
 * An Orivon app can be announced before it has an address. `published: false` says so;
 * anything else is live.
 * @param {import('./catalog.js').Site} site
 */
export function isPublished (site) {
  return site.orivon?.published !== false
}

/**
 * The link to the project a port was ported from, on every port card whether or not the
 * port is published. It is the upstream project's own page, so it works in any browser.
 * @param {import('./catalog.js').Site} site
 * @returns {{ text: string, title: string, href: string } | null}
 */
export function upstreamChip (site) {
  const href = site.orivon?.upstream
  if (!href) return null
  return { text: `Ported from ${site.name} \u2197`, title: href, href }
}

/** @param {string} cid */
export function shortCid (cid) {
  return cid.length > 16 ? `${cid.slice(0, 8)}…${cid.slice(-4)}` : cid
}

/**
 * Every address the site has, in the order a click should prefer them. Inside Orivon a
 * .eth name and an ipfs:// address open as themselves; elsewhere they go through the
 * eth.limo and inbrowser.link gateways.
 * @param {import('./catalog.js').Site} site
 * @param {Env} env
 * @returns {Chip[]}
 */
export function chipsFor (site, env) {
  const blocked = isBlocked(site, env)
  /** @type {Chip[]} */
  const chips = []
  for (const kind of env.inOrivon ? ORIVON_ORDER : OPEN_WEB_ORDER) {
    if (kind === 'ens' && site.ens) {
      const href = env.inOrivon ? `https://${site.ens}/` : `https://${site.ens}.limo/`
      chips.push({ kind, text: `${site.ens} · ENS + IPFS`, title: `${site.ens}, resolved through ENS to IPFS`, href: blocked ? null : href })
    } else if (kind === 'ipfs' && site.ipfs) {
      const href = env.inOrivon ? `ipfs://${site.ipfs}/` : `https://inbrowser.link/ipfs/${site.ipfs}/`
      chips.push({ kind, text: `ipfs · ${shortCid(site.ipfs)}`, title: site.ipfs, href: blocked ? null : href })
    } else if (kind === 'web' && site.web) {
      chips.push({ kind, text: new URL(site.web).host, title: site.web, href: blocked ? null : site.web })
    }
  }
  return chips
}

/** The address the card's open button uses, or null when there is none to offer here. */
export function primaryHref (site, env) {
  return chipsFor(site, env).find((chip) => chip.href !== null)?.href ?? null
}
