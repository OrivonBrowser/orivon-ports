// Element building without innerHTML: every string reaches the page as text or as an attribute value, so a name,
// an error message or a record read from the chain can never become markup.

/**
 * A child may be an array nested to any depth: it is flattened completely.
 * @typedef {Node | string | null | undefined | false | Child[]} Child
 */

/**
 * @param {string} tag
 * @param {{ class?: string, text?: string, on?: Record<string, (event: any) => void>, [attribute: string]: any }} [props]
 * @param {...Child} children
 * @returns {HTMLElement}
 */
export function el (tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key === 'on') for (const [name, handler] of Object.entries(value)) node.addEventListener(name, handler)
    else node.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue
    node.append(child)
  }
  return node
}

/** Replaces everything inside `parent`. @param {Element} parent @param {...Child} children */
export function fill (parent, ...children) {
  parent.replaceChildren(...children.flat(Infinity).filter((child) => child !== undefined && child !== null && child !== false))
}

/** Sets the text of a node only when it differs, so a live region is not announced again for the same words. @param {Element} node @param {string} text */
export function setText (node, text) {
  if (node.textContent !== text) node.textContent = text
}
