// The second half of the Send page: whether to protect the share with a password, and where it is kept.

import * as engine from '../engine.js'
import { h, icon, replace, secretInput } from '../dom.js'
import { describeKeeping, describeService } from '../ui/services.js'

/** @typedef {import('../engine.js').Target} Service */
/**
 * @typedef {{ protect: boolean, password: string, showPassword: boolean, keyInLink: boolean, remember: boolean,
 *   title: string, message: string, serviceId: string | null }} Options
 */

const LEVELS = { weak: 1, fair: 2, strong: 3, 'very strong': 4 }
const TITLE_MAX = 120
const MESSAGE_MAX = 2000

/** @param {string} password @param {boolean} protect @returns {string | null} why the password blocks Share, or null */
export function passwordProblem (password, protect) {
  if (!protect) return null
  const strength = engine.passwordStrength(password)
  if (password.length < engine.LIMITS.minPasswordLength) return `A password needs at least ${engine.LIMITS.minPasswordLength} characters. “Generate” makes a strong one.`
  return strength.acceptable ? null : `That password is too easy to guess. ${strength.hint}`.trim()
}

/** @param {{ on: boolean, text: string, help: string, onChange: (on: boolean) => void }} options */
function toggle ({ on, text, help, onChange }) {
  const input = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', role: 'switch', checked: on }))
  input.addEventListener('change', () => onChange(input.checked))
  return h('label', { class: 'switch' }, input, h('span', { class: 'switch-track' }), h('span', { class: 'switch-text' }, h('strong', {}, text), h('span', { class: 'muted small' }, help)))
}

/**
 * @param {Options} options
 * @param {{ onChange: () => void }} actions called when something the Share button depends on changes
 */
export function passwordCard (options, { onChange }) {
  const detail = h('div', { class: 'indent stack block' })
  const strengthEl = h('div', { class: 'strength', 'aria-live': 'polite' })
  /** @type {HTMLInputElement} */
  let input

  function showStrength () {
    if (options.password === '') {
      replace(strengthEl)
      strengthEl.removeAttribute('data-level')
      return
    }
    const strength = engine.passwordStrength(options.password)
    strengthEl.setAttribute('data-level', String(LEVELS[strength.label]))
    replace(strengthEl, h('span', { class: 'strength-bars', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'), h('span')),
      h('span', { class: 'strength-label' }, `Password: ${strength.label}`), strength.hint && strength.label !== 'strong' && strength.label !== 'very strong' ? h('span', { class: 'muted' }, strength.hint) : null)
  }

  function renderDetail () {
    if (!options.protect) {
      replace(detail)
      detail.classList.add('hidden')
      return
    }
    detail.classList.remove('hidden')
    input = secretInput({
      id: 'password-input', class: 'input input-mono', masked: !options.showPassword, value: options.password,
      'aria-label': 'Password', 'aria-describedby': 'password-help'
    })
    input.addEventListener('input', () => {
      options.password = input.value
      showStrength()
      onChange()
    })
    const show = h('button', { type: 'button', class: 'button button-secondary', 'aria-pressed': String(options.showPassword), onclick: () => { options.showPassword = !options.showPassword; renderDetail() } },
      icon(options.showPassword ? 'eyeOff' : 'eye'), options.showPassword ? 'Hide' : 'Show')
    const generate = h('button', { type: 'button', class: 'button button-secondary', onclick: () => {
      options.password = engine.generatePassword()
      options.showPassword = true
      renderDetail()
      onChange()
    } }, icon('reload'), 'Generate')
    replace(detail,
      h('div', { class: 'field' },
        h('label', { class: 'field-label', for: 'password-input' }, 'Password'),
        h('div', { class: 'input-group' }, input, show, generate),
        strengthEl,
        h('span', { class: 'field-help', id: 'password-help' }, 'Only people who have this password can read the share. It cannot be recovered: if it is lost, so is the share.')),
      toggle({
        on: options.keyInLink, text: 'Put the password in the link', help: 'Off: you send the password separately, which is safer. On: anyone who has the link can open the share.',
        onChange: (value) => { options.keyInLink = value }
      }),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: options.remember, onchange: (/** @type {Event} */ event) => { options.remember = /** @type {HTMLInputElement} */ (event.target).checked } }),
        h('span', { class: 'switch-text' }, h('strong', {}, 'Remember the password in this browser'), h('span', { class: 'muted small' }, 'My shares then shows it again. It is kept in this browser\'s storage, readable by anyone who uses this browser profile.'))),
      h('div', { class: 'field' },
        h('label', { class: 'field-label', for: 'share-title' }, 'Title ', h('span', { class: 'muted' }, '(optional)')),
        h('input', { class: 'input', id: 'share-title', type: 'text', maxlength: String(TITLE_MAX), value: options.title, autocomplete: 'off',
          placeholder: 'Holiday photos', oninput: (/** @type {Event} */ event) => { options.title = /** @type {HTMLInputElement} */ (event.target).value } }),
        h('span', { class: 'field-help' }, 'Shown once the password is entered. Not visible to anyone without it.')),
      h('div', { class: 'field' },
        h('label', { class: 'field-label', for: 'share-message' }, 'Message ', h('span', { class: 'muted' }, '(optional)')),
        h('textarea', { class: 'textarea', id: 'share-message', maxlength: String(MESSAGE_MAX), placeholder: 'A note for whoever opens it',
          oninput: (/** @type {Event} */ event) => { options.message = /** @type {HTMLTextAreaElement} */ (event.target).value } }, options.message)))
    showStrength()
  }

  const box = toggle({
    on: options.protect, text: 'Protect with a password', help: 'Locks the share on your device before it leaves. Without the password, nobody can read it, not even a computer or service that passes it on.',
    onChange: (value) => {
      options.protect = value
      if (value && options.password === '') {
        options.password = engine.generatePassword()
        options.showPassword = true
      }
      renderDetail()
      onChange()
    }
  })
  renderDetail()
  return h('section', { class: 'card', 'aria-label': 'Password' }, box, detail)
}

/**
 * @param {Options} options
 * @param {Service[]} services the services the person set up
 * @param {{ onChange: () => void }} actions
 */
export function keepCard (options, services, { onChange }) {
  /** @param {string | null} id @param {string} title @param {string} text */
  const choice = (id, title, text) => {
    const radio = /** @type {HTMLInputElement} */ (h('input', { type: 'radio', name: 'service', value: id ?? '', checked: id === options.serviceId }))
    radio.addEventListener('change', () => { options.serviceId = id; onChange() })
    return h('label', { class: 'choice' }, radio, h('span', { class: 'choice-text' }, h('strong', {}, title), h('span', { class: 'muted small' }, text)))
  }
  return h('section', { class: 'card', 'aria-label': 'Where it is kept' },
    h('h2', {}, 'Where it is kept'),
    h('div', { class: 'notice notice-ok' }, icon('shield'), h('div', {},
      h('strong', {}, 'On this computer'),
      h('p', {}, 'Your computer shares it directly with whoever opens the link, for as long as Orivon Share is open. Nothing is uploaded to anyone\'s server.'))),
    h('fieldset', { class: 'choices block' },
      h('legend', {}, 'Also keep it online when Share is closed'),
      choice(null, 'No, only from this computer', 'People can open the link while Share is open here.'),
      services.map((service) => choice(service.id, describeService(service), describeKeeping(service)))),
    h('p', { class: 'field-help block' },
      services.length === 0 ? 'A pinning service keeps a share online without your computer. ' : '',
      h('a', { href: '#/settings' }, services.length === 0 ? 'Add your IPFS node or a pinning service' : 'Add another service'), '.'))
}
