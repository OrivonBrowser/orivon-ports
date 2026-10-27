// The step list of a share being made: each step with its mark, the current one with a percentage and a bar.

import { h, icon, replace } from '../dom.js'
import { announce } from './live.js'

/** The steps of sharing, in the order they happen, as the engine names them. */
export const SHARE_STEPS = /** @type {const} */ ([
  ['read', 'Reading files'],
  ['encrypt', 'Encrypting'],
  ['address', 'Computing the address'],
  ['send', 'Keeping it'],
  ['node', 'Starting Orivon\'s IPFS node'],
  ['check', 'Checking the address']
])

/** @typedef {import('../engine.js').Progress} Progress */

/**
 * @param {readonly (readonly [string, string])[]} plan every step that may happen
 * @param {string[]} expected the keys shown from the start; another one appears when the engine reports it
 */
export function stepList (plan, expected) {
  /** @type {Map<string, { li: HTMLElement, mark: HTMLElement, percent: HTMLElement, bar: HTMLElement, detail: HTMLElement }>} */
  const rows = new Map()
  const el = h('ol', { class: 'progress', 'aria-label': 'Steps' })
  for (const [key, label] of plan) {
    const mark = h('span', { class: 'step-mark' })
    const percent = h('span', { class: 'step-percent' })
    const bar = h('progress', { class: 'bar hidden', max: '100', value: '0', 'aria-label': label })
    const detail = h('span', { class: 'step-detail hidden' })
    const li = h('li', { class: 'progress-step', hidden: !expected.includes(key) }, mark, h('span', {}, label), percent, bar, detail)
    rows.set(key, { li, mark, percent, bar, detail })
  }
  el.append(...[...rows.values()].map((row) => row.li))
  const keys = plan.map(([key]) => key)
  /** @type {string | null} */
  let current = null

  /** @param {string} key @param {'idle' | 'active' | 'done' | 'failed'} state */
  function mark (key, state) {
    const row = rows.get(key)
    if (!row) return
    row.li.className = `progress-step progress-${state}`
    replace(row.mark, state === 'done' ? icon('check') : state === 'failed' ? icon('alert') : state === 'active' ? h('span', { class: 'spinner' }) : null)
    if (state !== 'active') {
      row.percent.textContent = ''
      row.bar.classList.add('hidden')
      row.detail.classList.add('hidden')
    }
  }
  for (const key of keys) mark(key, 'idle')

  return {
    el,
    /** The label of the step in progress, for a failure message. */
    get currentLabel () { return plan.find(([key]) => key === current)?.[1] ?? '' },
    /** @param {Progress} progress */
    update (progress) {
      const index = keys.indexOf(progress.step)
      const row = rows.get(progress.step)
      if (index < 0 || !row) return
      row.li.hidden = false
      if (current !== progress.step) {
        for (const key of keys.slice(0, index)) if (!rows.get(key)?.li.hidden) mark(key, 'done')
        mark(progress.step, 'active')
        current = progress.step
        announce(plan[index]?.[1] ?? '')
      }
      if (progress.total && progress.total > 0) {
        const percent = Math.min(100, Math.floor(((progress.done ?? 0) / progress.total) * 100))
        row.percent.textContent = `${percent}%`
        row.bar.classList.remove('hidden')
        row.bar.setAttribute('value', String(percent))
      }
      if (progress.text) {
        row.detail.textContent = progress.text
        row.detail.classList.remove('hidden')
      }
    },
    finish () {
      for (const [key, row] of rows) if (!row.li.hidden) mark(key, 'done')
    },
    fail () {
      if (current !== null) mark(current, 'failed')
    }
  }
}
