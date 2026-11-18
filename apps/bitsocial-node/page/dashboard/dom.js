// The one DOM call the dashboard's sections build their markup with.

/**
 * An element with its attributes, listeners and children. A prop that is undefined, null or false is left out; `class` sets the
 * class name, `text` the text, `on` the listeners (`{ click: fn }`); anything else is an attribute.
 * @param {Document} doc @param {string} tag
 * @param {Record<string, any>} [props] @param {...(Node | string | null | false | undefined)} children
 * @returns {any}
 */
export function h (doc, tag, props = {}, ...children) {
  const element = doc.createElement(tag)
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (name === 'class') element.className = String(value)
    else if (name === 'text') element.textContent = String(value)
    else if (name === 'on') for (const [type, listener] of Object.entries(value)) element.addEventListener(type, listener)
    else element.setAttribute(name, value === true ? '' : String(value))
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) element.append(child)
  return element
}
