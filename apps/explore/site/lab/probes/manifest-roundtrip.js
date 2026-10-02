/** @type {import('../probes.js').Probe} */
export default {
  id: 'manifest-roundtrip',
  title: 'Orivon registered the manifest this page serves',
  capability: null,
  declares: {},
  async run ({ orivon, served }) {
    const [registered, published] = await Promise.all([orivon.app.manifest(), served.manifest()])
    const sameCapabilities = JSON.stringify(registered.capabilities) === JSON.stringify(published.capabilities)
    const same = registered.id === published.id && registered.version === published.version && sameCapabilities
    return same
      ? { ok: true, detail: `${registered.id} ${registered.version}, same as the published manifest` }
      : { ok: false, detail: sameCapabilities ? `registered ${registered.id} ${registered.version}, published ${published.id} ${published.version}` : 'the registered capabilities differ from the published ones' }
  }
}
