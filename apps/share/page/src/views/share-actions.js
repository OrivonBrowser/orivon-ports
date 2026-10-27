// What My shares does to a share kept on this computer: keep it with a service, save it as a CAR file, stop and delete it.

import * as engine from '../engine.js'
import { h, replace } from '../dom.js'
import * as store from '../store.js'
import { confirmDialog, downloadBlob, openDialog, toast } from '../ui/dialog.js'
import { describeService, describeKeeping, loadServices } from '../ui/services.js'

/** @param {unknown} error */
function messageOf (error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {string} cid */
export async function saveCar (cid) {
  try {
    downloadBlob(await engine.exportCar(cid), `share-${cid.slice(-8)}.car`)
  } catch (error) {
    toast(messageOf(error), { kind: 'error', timeout: 8000 })
  }
}

/** Asks which service should also keep the share, and sends it from the bytes kept here. @param {string} cid @param {() => void} done */
export async function keepElsewhere (cid, done) {
  const services = await loadServices()
  if (services.length === 0) {
    const dialog = openDialog({
      title: 'Keep it online elsewhere',
      body: [h('p', {}, 'A pinning service keeps the share online when Share is closed and when this computer is off. Add your own IPFS node or a pinning service first.')],
      actions: [{ label: 'Not now', kind: 'ghost', onClick: () => dialog.close() }, { label: 'Add a service', kind: 'primary', autofocus: true, onClick: () => { dialog.close(); location.hash = '#/settings' } }]
    })
    return
  }
  let choice = services[0]?.id ?? ''
  const status = h('p', { class: 'form-status', role: 'status' })
  const controller = new AbortController()
  const dialog = openDialog({
    title: 'Keep it online elsewhere',
    body: [
      h('p', {}, 'The share is sent from this computer to the service, which must report the same address before it counts.'),
      h('fieldset', { class: 'choices' }, h('legend', { class: 'sr-only' }, 'Service'), services.map((service) => {
        const radio = h('input', { type: 'radio', name: 'keep-service', value: service.id, checked: service.id === choice, onchange: () => { choice = service.id } })
        return h('label', { class: 'choice' }, radio, h('span', { class: 'choice-text' }, h('strong', {}, describeService(service)), h('span', { class: 'muted small' }, describeKeeping(service))))
      })),
      status],
    onClose: () => controller.abort(),
    actions: [
      { label: 'Cancel', kind: 'ghost', onClick: () => dialog.close() },
      { label: 'Keep it there', kind: 'primary', autofocus: true, onClick: async () => {
        const service = services.find((candidate) => candidate.id === choice)
        if (!service) return
        dialog.setBusy(true)
        status.className = 'form-status'
        try {
          await engine.pinElsewhere(cid, service, { signal: controller.signal, onProgress: (p) => { status.textContent = p.text ?? 'Sending…' } })
          await store.addService(cid, describeService(service))
          dialog.setBusy(false)
          dialog.close()
          toast(`${describeService(service)} keeps it now`, { kind: 'success' })
          done()
        } catch (error) {
          dialog.setBusy(false)
          status.className = 'form-status form-status-error'
          status.textContent = messageOf(error)
        }
      } }
    ]
  })
}

/** Stops sharing a share and deletes it from this computer, after asking. @param {{ cid: string, title: string, services: unknown[] }} share @param {() => void} done */
export async function stopAndDelete (share, done) {
  const sure = await confirmDialog({
    title: 'Stop sharing and delete it from this computer?',
    message: `“${share.title}” is deleted from this computer and nobody can reach it from here any more.${share.services.length > 0 ? ' Copies kept with a service stay where they are.' : ' If nobody else holds a copy, the link stops working for good.'}`,
    confirm: 'Stop and delete', danger: true
  })
  if (!sure) return
  try {
    await engine.deleteKept(share.cid)
    await store.deleteShare(share.cid)
    toast('Deleted from this computer')
    done()
  } catch (error) {
    toast(messageOf(error), { kind: 'error', timeout: 8000 })
  }
}

/** The line about this browser's storage. @param {{ used: number, quota: number, persisted: boolean, kept: number, durable: boolean } | null} info @param {(n: number) => string} format */
export function storageLine (info, format) {
  if (info === null) return h('span', {}, 'This browser did not say how much room it gives Share.')
  if (!info.durable) return h('span', {}, 'This browser gave Share no lasting storage here, so shares are kept only until this page closes.')
  const root = h('span', {})
  replace(root, `Shares kept here take ${format(info.kept)}; this browser lets Share use about ${format(info.quota)}. `, info.persisted ? 'The browser keeps them unless you clear this site\'s data.' : 'The browser may clear them when the disk is full.')
  return root
}
