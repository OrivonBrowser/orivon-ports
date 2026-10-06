// The `domain` field of an app's orivon.json: the one name the app calls home.
// The shape is the one a client that reads `domain` enforces: it rejects a
// manifest whose domain is anything but the canonical host, so a port that
// ships one fails to load rather than loading unverified.

const MAX_LENGTH = 253

// Letters, digits and inner hyphens, 63 characters at most: the label rule the client applies.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * Apps that are never published and so have no home. Each entry is a mock or a
 * fixture; adding a real port here would let it ship without a domain, so an
 * entry needs a reason.
 */
export const NO_DOMAIN_APPS: ReadonlySet<string> = new Set([
  // A filmed mock of a desktop app; it is served locally and never published.
  'bisq-fake'
])

/** One URL-canonical lowercase host, two labels at least, no IP, `localhost` or `.orivon` name. */
export function isValidDomain (value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_LENGTH) return false
  let host: string
  try {
    host = new URL(`https://${value}`).hostname
  } catch {
    return false
  }
  if (host !== value) return false
  const labels = value.split('.')
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return false
  if (/^\d+$/.test(labels[labels.length - 1] ?? '')) return false
  return !(value.endsWith('.orivon') || value === 'localhost' || value.endsWith('.localhost'))
}

/** The problem with an app's `domain`, or undefined when it is right. */
export function domainProblem (appId: string, value: unknown): string | undefined {
  if (NO_DOMAIN_APPS.has(appId)) {
    return value === undefined ? undefined : `apps/${appId}: this app is never published and must not name a domain -- remove "domain", or take the app off NO_DOMAIN_APPS in src/manifest-domain.ts`
  }
  if (value === undefined) {
    return `apps/${appId}: "domain" is required -- the one name this app is published at, a subname of orivonstack.eth`
  }
  if (!isValidDomain(value)) {
    return `apps/${appId}: "domain" ${JSON.stringify(value)} is not one URL-canonical lowercase host (two labels at least, 253 characters at most, no scheme, port, path, IP, localhost or .orivon name)`
  }
  return undefined
}
