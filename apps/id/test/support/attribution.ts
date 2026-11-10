// An Attribution as the registry reads it, for the tests of the words that explain one: all four clauses hold unless a
// test changes one.

import { ADDRESSES, type Attribution } from '../../site/sdk/orivonid.js'
import { OWNER_ROLES } from './fake-registry.ts'

export const HOLDER = '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826'

export function attribution(change: Partial<Attribution> = {}, label = 'alice'): Attribution {
  return {
    label, address: HOLDER, ok: true, owner: { ok: true, owner: HOLDER }, roles: { ok: true, roleCount: OWNER_ROLES, roles: OWNER_ROLES, problem: null },
    forward: { ok: true, resolver: ADDRESSES.resolverImplementation, address: HOLDER, problem: null },
    records: { ok: true, resolver: ADDRESSES.resolverImplementation, problem: null }, ...change
  }
}

/** One clause failed: `ok` is false with it. */
export const failing = (change: Partial<Attribution>, label = 'alice') => attribution({ ok: false, ...change }, label)
