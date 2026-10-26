// What the Publish dialog shows once a wiki is published: the address, how long Orivon's node keeps it,
// the key when the address was just made, and the ways to open and keep it.

import { h, icon, replace } from '../dom.js'
import { formatDay } from '../format.js'
import { addressesOf, nameAddressesOf } from '../publish/publish.js'
import { pageNodeAvailable } from '../publish/page-node.js'
import { FREE_DAYS } from '../publish/targets.js'
import { copyText } from './dialog.js'
import { downloadKey, downloadRecord } from './name-actions.js'

/** @param {string} text @param {string} what @param {string} [prefix] */
function addressBox (text, what, prefix) {
  return h('div', { class: 'cid-box' },
    prefix ? h('span', { class: 'muted small nowrap' }, prefix) : null,
    h('code', { class: 'cid' }, text),
    h('button', { type: 'button', class: 'icon-button', 'aria-label': `Copy the ${what}`, onclick: () => copyText(text, 'Address') }, icon('copy')))
}

/** @param {number | null} keptUntil When free pinning stops keeping the version, if it was pinned there. */
function versionNote (keptUntil) {
  if (keptUntil === null) return ''
  return `${pageNodeAvailable() ? 'Your IPFS node published it, and Orivon\'s node keeps' : 'Orivon keeps'} this version pinned until ${formatDay(keptUntil)}. To keep it up after that, pin the version on your own node or a pinning service, or publish with one of them from Settings.`
}

/**
 * The line under the address about Orivon's node: kept, or what went wrong with a way to send it again.
 * @param {{ keptUntil: number | null, versionUntil: number | null, problem: string | null, retry: () => Promise<{ keptUntil: number | null, problem: string | null }> }} state
 */
function keepNotice (state) {
  const host = h('div')
  /** @param {{ keptUntil: number | null, problem: string | null }} now */
  const draw = (now) => {
    if (now.problem === null) {
      replace(host, h('div', { class: 'notice' }, icon('history'), h('p', {},
        now.keptUntil === null ? 'The address is signed. ' : `Orivon's node keeps the address up until ${formatDay(now.keptUntil)}. `, versionNote(state.versionUntil))))
      return
    }
    const again = h('button', { type: 'button', class: 'button button-secondary button-small' }, 'Try again')
    again.addEventListener('click', async () => {
      again.setAttribute('disabled', '')
      replace(again, h('span', { class: 'spinner' }), ' Sending…')
      draw(await state.retry())
    })
    replace(host, h('div', { class: 'notice notice-plain' }, icon('alert'), h('div', {},
      h('strong', {}, 'The wiki is published, but its address is not kept up yet.'),
      h('p', {}, now.problem),
      h('p', { class: 'muted small' }, 'The record that points the address at this version is saved here. ', versionNote(state.versionUntil)),
      h('div', { class: 'row' }, again))))
  }
  draw(state)
  return host
}

/** The key of an address made by this publish, which this browser holds and nobody else does. @param {string} name */
function keyPanel (name) {
  return h('div', { class: 'key-panel' },
    h('h4', {}, 'Keep this address\'s key'),
    h('p', {}, 'This browser holds the key of the address. Download it and keep it safe: it lets you update this wiki from another browser or from your own IPFS node. Whoever has it can change what the address shows.'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'button button-primary', onclick: () => { void downloadKey(name) } }, icon('download'), 'Download the key'),
      h('button', { type: 'button', class: 'button button-secondary', onclick: () => { void downloadRecord(name) } }, icon('download'), 'Download the public record')))
}

/** @param {string} name */
function recordLink (name) {
  return h('p', { class: 'small' }, h('button', { type: 'button', class: 'link-button', onclick: () => { void downloadRecord(name) } }, 'Download the public record'))
}

/** What to do with the address afterwards, in words. @param {string} name */
function explanations (name) {
  return [
    h('details', { class: 'explain' },
      h('summary', {}, 'Give it a name'),
      h('p', {}, 'To publish it under an ENS name, open the name in the ENS app, then Records, and set its Content Hash to ', h('code', {}, `ipns://${name}`), ' once. Every later version you publish under this address follows it, with no new transaction.')),
    h('details', { class: 'explain' },
      h('summary', {}, 'Keep it available'),
      h('p', {}, `Orivon's node republishes the address for ${FREE_DAYS} days after each publish. Past that, republish the public record with any IPFS node (`, h('code', {}, `ipfs routing put /ipns/${name} ${name}.ipns-record`), '), or import the key into a node of yours (', h('code', {}, 'ipfs key import'), ') and publish from it. A version stays reachable while some node pins it.'))
  ]
}

/**
 * The result of a publish. With a `name` the address is the main one and the version's own sits under it.
 * @param {{ cid: string, title: string, keptUntil: number | null, name: string | null, made?: boolean,
 *   point?: { keptUntil: number | null, problem: string | null } | null, retry?: () => Promise<{ keptUntil: number | null, problem: string | null }> }} options
 */
export function resultView ({ cid, title, keptUntil, name, made = false, point = null, retry }) {
  const where = addressesOf(cid)
  const named = name === null ? null : nameAddressesOf(name)
  const main = named?.ipns ?? where.ipfs
  const gateway = named?.gateway ?? where.gateway
  return [
    h('div', { class: 'success' }, h('span', { class: 'success-mark' }, icon('check')), h('div', {},
      h('h3', {}, `“${title}” is on IPFS`),
      h('p', { class: 'muted' }, 'Anyone with this address can read it, and press the pen to edit their own copy.'))),
    addressBox(main, 'address'),
    named === null ? null : addressBox(where.ipfs, 'version\'s address', 'This version:'),
    named !== null && point !== null && retry !== undefined
      ? keepNotice({ keptUntil: point.keptUntil, versionUntil: keptUntil, problem: point.problem, retry })
      : keptUntil === null
        ? null
        : h('div', { class: 'notice' }, icon('history'), h('p', {}, versionNote(keptUntil))),
    name === null ? null : made ? keyPanel(name) : recordLink(name),
    h('div', { class: 'row' },
      h('a', { class: 'button button-secondary', href: main, target: '_blank', rel: 'noopener' }, icon('open'), 'Open it'),
      h('a', { class: 'button button-ghost', href: gateway, target: '_blank', rel: 'noopener noreferrer' }, icon('link'), 'Open on a public gateway')),
    named === null
      ? [
          h('details', { class: 'explain' },
            h('summary', {}, 'Give it a name'),
            h('p', {}, 'To publish it under an ENS name, open the name in the ENS app, then Records, and set its Content Hash to ', h('code', {}, where.ipfs), '. Readers of the name then get this version, and each later version you publish replaces it when you set the new address.')),
          h('details', { class: 'explain' },
            h('summary', {}, 'Keep it available'),
            h('p', {}, keptUntil === null
              ? 'A wiki on IPFS stays reachable while some node pins it. The service you published with pins it now; pinning it on a second service or your own node keeps it up if one of them stops.'
              : `A wiki on IPFS stays reachable while some node pins it. Free pinning keeps each version for ${FREE_DAYS} days, once: a new version you publish gets ${FREE_DAYS} days of its own. Anyone who pins the address keeps it up too.`))
        ]
      : explanations(name ?? '')
  ]
}

/**
 * The screen after a CAR file was downloaded: the version has no pin yet, so the address points at it
 * only once a node pins the file.
 * @param {{ cid: string, name: string | null, made?: boolean }} options
 */
export function carDoneView ({ cid, name, made = false }) {
  return [
    h('div', { class: 'success' }, h('span', { class: 'success-mark' }, icon('check')), h('div', {},
      h('h3', {}, 'The CAR file is saved'),
      h('p', { class: 'muted' }, 'Pin it on a node with ', h('code', {}, 'ipfs dag import'), ', or upload it to a pinning service that takes CAR files.'))),
    name === null ? addressBox(addressesOf(cid).ipfs, 'address') : addressBox(nameAddressesOf(name).ipns, 'address'),
    name === null ? null : addressBox(addressesOf(cid).ipfs, 'version\'s address', 'This version:'),
    name !== null
      ? [
          h('p', { class: 'muted' }, 'The address points at this version once a node holds it and the public record is published: ', h('code', {}, `ipfs routing put /ipns/${name} ${name}.ipns-record`), ' does that from any node. Settings can send the record to Orivon\'s node as well, once the version is pinned somewhere.'),
          made ? keyPanel(name) : recordLink(name)
        ]
      : null
  ]
}
