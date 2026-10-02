// Element building without innerHTML: every string reaches the page as text or as an
// attribute value, so catalog data and error messages cannot become markup.

/**
 * @param {string} tag
 * @param {{ class?: string, text?: string, on?: Record<string, (event: Event) => void>, [attribute: string]: any }} [props]
 * @param {...(Node | string | null | undefined | false | Array<Node | string | null | undefined | false>)} children
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
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue
    node.append(child)
  }
  return node
}

/** Replace everything inside `parent`. */
export function fill (parent, ...children) {
  parent.replaceChildren(...children.flat().filter((child) => child !== undefined && child !== null && child !== false))
}
