// A grant is a declared capability, narrowed by the user. One that names a capability the
// manifest does not declare would be a fault in Orivon. An empty manifest has no grants.

/** Where in a manifest's `capabilities` each grantable kind is declared. */
const DECLARED_AT = {
  'tcp.connect': ['net', 'tcp', 'connect'],
  'tcp.listen.local': ['net', 'tcp', 'listen'],
  'tcp.listen.network': ['net', 'tcp', 'listen'],
  'udp.bind.local': ['net', 'udp', 'bind'],
  'udp.bind.network': ['net', 'udp', 'bind'],
  'udp.send': ['net', 'udp', 'send'],
  'https.connect': ['net', 'https', 'connect'],
  fs: ['fs'],
  id: ['id'],
  'web.context': ['web', 'contexts'],
  'web.embed': ['web', 'embed'],
  'media.camera': ['media', 'camera'],
  'media.microphone': ['media', 'microphone'],
  'clipboard.read': ['clipboard', 'read'],
  secrets: ['secrets']
}

/**
 * @param {Record<string, any>} capabilities
 * @param {string} kind
 */
function isDeclared (capabilities, kind) {
  const path = Object.hasOwn(DECLARED_AT, kind) ? DECLARED_AT[/** @type {keyof typeof DECLARED_AT} */ (kind)] : null
  if (!path) return false
  let node = capabilities
  for (const key of path) {
    if (typeof node !== 'object' || node === null || !(key in node)) return false
    node = node[key]
  }
  return true
}

/** @type {import('../probes.js').Probe} */
export default {
  id: 'grants-within-manifest',
  title: 'No grant exceeds what the manifest declares',
  capability: null,
  declares: {},
  async run ({ orivon }) {
    const [manifest, held] = await Promise.all([orivon.app.manifest(), orivon.app.grants()])
    const outside = held.filter((grant) => !isDeclared(manifest.capabilities, grant.capability))
    if (outside.length > 0) return { ok: false, detail: `granted but not declared: ${outside.map((grant) => grant.capability).join(', ')}` }
    return { ok: true, detail: held.length === 0 ? 'no grants held, none declared' : `${held.length} grant(s), all declared` }
  }
}
