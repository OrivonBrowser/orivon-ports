// The Send page once Share is pressed: the steps while it runs, what went wrong, and the finished link.

import * as engine from '../engine.js'
import { h, icon } from '../dom.js'
import { count, formatBytes } from '../format.js'
import { copyField } from '../ui/copy-field.js'
import { downloadBlob, toast } from '../ui/dialog.js'
import { rememberKey } from '../ui/keys.js'
import { liveServing, nodeText, peersText, servingWarning, uploadedText } from '../ui/serving.js'

/**
 * @typedef {{ controller: AbortController, steps: ReturnType<typeof import('../ui/progress.js').stepList>, phase: 'running' | 'failed' | 'done',
 *   error: string, failedStep: string, result: Awaited<ReturnType<typeof engine.publishShare>> | null, password: string, title: string,
 *   encrypted: boolean, service: import('../ui/services.js').Service | null }} Job
 */

/** @param {Job} job @param {{ onCancel: () => void, onBack: () => void, onRetry: () => void }} actions */
export function runningCard (job, { onCancel, onBack, onRetry }) {
  if (job.phase === 'failed') {
    return h('section', { class: 'card', 'aria-label': 'Sharing failed' },
      h('h2', {}, 'It did not work'),
      h('div', { class: 'block' }, job.steps.el),
      h('div', { class: 'notice notice-error', role: 'alert' }, icon('alert'), h('div', {},
        h('strong', {}, job.failedStep ? `Stopped while: ${job.failedStep.toLowerCase()}` : 'Stopped'), h('p', {}, job.error))),
      h('div', { class: 'row block' },
        h('button', { type: 'button', class: 'button button-primary', onclick: onRetry }, icon('reload'), 'Try again'),
        h('button', { type: 'button', class: 'button button-ghost', onclick: onBack }, 'Back to what I chose')))
  }
  return h('section', { class: 'card', 'aria-label': 'Sharing' },
    h('h2', {}, job.encrypted ? 'Locking and sharing…' : 'Sharing…'),
    h('div', { class: 'block' }, job.steps.el),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'button button-secondary', onclick: onCancel }, 'Cancel'),
      h('span', { class: 'muted small' }, 'Keep this page open until it finishes.')))
}

/** Where the share is now: online from this computer, with who is connected, drawn again as that changes. @param {string} cid @param {boolean} online */
function onlineBlock (cid, online) {
  return liveServing((state) => {
    const mine = state.shares.find((share) => share.cid === cid)
    const live = mine?.online ?? online
    const warn = live ? servingWarning(state) : null
    const node = mine ? nodeText(mine.node) : null
    return h('div', { class: live && !warn ? 'notice notice-ok' : 'notice notice-warn' }, icon(live ? 'shield' : 'alert'), h('div', {},
      h('strong', {}, live ? 'Online from this computer' : 'Kept on this computer, but not online'),
      h('p', {}, live
        ? 'People can open the link while Orivon Share stays open on this computer. Closing it stops sharing, unless the share is also kept on a service.'
        : 'Nobody can open the link until it is put back online in My shares.'),
      live ? h('p', { class: 'small' }, `${peersText(mine?.peers ?? 0)} · ${uploadedText(mine?.uploaded ?? 0)}`) : null,
      node ? h('p', { class: 'small' }, node) : null,
      warn ? h('p', { class: 'small' }, warn) : null))
  }, 'div', { 'aria-live': 'polite' })
}

/** What happened with the service the person chose, if any. @param {NonNullable<Job['result']>} result @param {{ onRetryService: () => void }} actions */
function serviceNotice (result, { onRetryService }) {
  if (result.service === null) {
    if (result.copy?.ok) return null
    return h('p', { class: 'field-help' }, 'Want it online when Share is closed? Keep it with a service from ', h('a', { href: '#/shares' }, 'My shares'), '.')
  }
  if (result.service.ok) {
    return h('div', { class: 'notice' }, icon('check'), h('div', {}, h('strong', {}, `Also kept with ${result.service.label}`), h('p', {}, 'It stays online when Share is closed, for as long as that service keeps it.')))
  }
  return h('div', { class: 'notice notice-warn' }, icon('alert'), h('div', {},
    h('strong', {}, `${result.service.label} did not keep it`), h('p', {}, result.service.error ?? 'It did not answer.'),
    h('p', { class: 'small' }, 'The share is still online from this computer.'),
    h('button', { type: 'button', class: 'button button-secondary button-small', onclick: onRetryService }, icon('reload'), 'Try again')))
}

/** What happened with the copy on Orivon's server, if the person asked for one. @param {NonNullable<Job['result']>} result @param {boolean} encrypted @param {{ onRetryCopy: () => void }} actions */
function copyNotice (result, encrypted, { onRetryCopy }) {
  const copy = result.copy
  if (copy === null || copy === undefined) return null
  if (copy.ok) {
    const until = copy.keptUntil === null || copy.keptUntil === undefined ? '' : ` until ${new Date(copy.keptUntil).toLocaleDateString(undefined, { dateStyle: 'long' })}`
    return h('div', { class: 'notice' }, icon('check'), h('div', {},
      h('strong', {}, `A copy is kept on ${copy.label}${until}`),
      h('p', {}, 'The IPFS address and the gateway link open while this computer is off.'),
      h('p', { class: 'small' }, encrypted ? 'The copy is the locked file: only people with the password can read it.' : 'The copy is public: anyone who has the address can read it.')))
  }
  return h('div', { class: 'notice notice-warn' }, icon('alert'), h('div', {},
    h('strong', {}, `${copy.label} did not keep a copy`), h('p', {}, copy.error ?? 'It did not answer.'),
    h('p', { class: 'small' }, 'The share is still online from this computer.'),
    h('button', { type: 'button', class: 'button button-secondary button-small', onclick: onRetryCopy }, icon('reload'), 'Try again')))
}

/** @param {Job} job @param {{ onAnother: () => void, onRetryService: () => void, onRetryCopy: () => void }} actions */
export function resultCard (job, { onAnother, onRetryService, onRetryCopy }) {
  const result = /** @type {NonNullable<Job['result']>} */ (job.result)
  const heading = job.encrypted ? 'Your protected share is ready' : 'Your share is ready'
  const summary = `${count(result.files, 'file')}, ${formatBytes(result.bytes)}`
  const keyInLink = result.link.includes('key=')
  const carButton = h('button', { type: 'button', class: 'button button-secondary' }, icon('download'), 'Download as a CAR file')
  carButton.addEventListener('click', async () => {
    carButton.setAttribute('disabled', '')
    try {
      downloadBlob(await engine.exportCar(result.cid), `share-${result.cid.slice(-8)}.car`)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { kind: 'error', timeout: 8000 })
    } finally {
      carButton.removeAttribute('disabled')
    }
  })
  return h('section', { class: 'card', 'aria-label': 'Your share' },
    h('div', { class: 'success' },
      h('span', { class: 'success-mark' }, icon('check')),
      h('div', {}, h('h2', {}, heading), h('p', { class: 'muted' }, job.title ? `${job.title} · ${summary}` : summary))),
    h('div', { class: 'block' }, h('h3', {}, 'Link'), copyField({ value: result.link, label: 'link' }),
      h('p', { class: 'field-help' }, !job.encrypted ? 'Anyone with this link can read it.' : keyInLink ? 'The password is inside this link.' : 'Opening this link asks for the password.')),
    job.encrypted && keyInLink
      ? h('div', { class: 'notice notice-warn' }, icon('alert'), h('div', {}, h('strong', {}, 'Anyone who has this link can open the share.'), h('p', {}, 'Send it only to people you trust. A link that travels with its password is as private as the place you paste it.')))
      : null,
    job.encrypted && !keyInLink
      ? h('div', { class: 'block' }, h('h3', {}, 'Password'), copyField({ value: job.password, label: 'password', secret: true }),
          h('p', { class: 'field-help' }, 'Send the password another way than the link, for example in a different chat. Without it the share cannot be opened, and it cannot be recovered.'))
      : null,
    h('div', { class: 'block' }, onlineBlock(result.cid, result.online)),
    ...[serviceNotice(result, { onRetryService }), copyNotice(result, job.encrypted, { onRetryCopy })].map((notice) => notice === null ? null : h('div', { class: 'block' }, notice)),
    h('div', { class: 'row block' },
      h('a', { class: 'button button-primary', href: `#/${result.cid}`, onclick: () => { if (job.password) rememberKey(result.cid, job.password) } }, icon('open'), 'Open what people will see'),
      carButton,
      h('button', { type: 'button', class: 'button button-secondary', onclick: onAnother }, icon('plus'), 'Share something else')),
    h('details', { class: 'explain' },
      h('summary', {}, 'Other addresses'),
      h('p', {}, 'The same share on the IPFS network. These open it only once a pinning service or an IPFS node holds a copy.'),
      copyField({ value: result.ipfsUrl, label: 'IPFS address' }),
      copyField({ value: result.gatewayUrl, label: 'gateway link' }),
      job.encrypted ? h('p', { class: 'muted' }, 'They show the locked file. Opening it needs the password and this page, or any program that reads age files.') : null),
    h('details', { class: 'explain' },
      h('summary', {}, 'Good to know'),
      h('p', {}, 'Something shared on IPFS cannot be called back: copies may outlive yours. The address is a fingerprint of the content, so it stays the same wherever it is kept.'),
      h('p', {}, 'Two computers can sit behind routers that both refuse direct connections. If someone cannot open the link while Share is open here, keep the share with a pinning service, or send them the CAR file.')))
}
