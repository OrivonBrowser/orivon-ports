// Workaround, deletable when the shim's `dns.setDefaultResultOrder` works: pkc-js asks for IPv4 first at load, and the
// shim's `dns` refuses the call, which would end the Worker at its first import. The shim answers `dns.lookup`
// only, so the order has nothing to apply to.

import { replaceText } from './text-patch.mjs'

/** @type {import('./text-patch.mjs').Patch} */
export const dnsResultOrder = {
  name: 'dns.setDefaultResultOrder is refused by the shim',
  file: /rpc-local-community-[\w-]+\.js$/,
  apply: replaceText('dns.setDefaultResultOrder("ipv4first");', 'try { dns.setDefaultResultOrder("ipv4first"); } catch { /* the shim has no resolver order to set */ }')
}
