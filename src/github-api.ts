const API = 'https://api.github.com'

/** What the upstream watcher needs of GitHub: JSON reads (undefined for a 404) and issue writes. */
export interface GithubApi {
  get: (path: string) => Promise<unknown>
  post: (path: string, body: unknown) => Promise<unknown>
  patch: (path: string, body: unknown) => Promise<unknown>
}

/** The REST API over `fetch`, authenticated when a token is given. A rate limit or any status but 404 throws, with GitHub's own words. */
export function githubApi (token: string | undefined, base: string = API): GithubApi {
  async function call (method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'orivon-ports-upstream-watch',
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000)
    })
    if (response.status === 404 && method === 'GET') return undefined
    const text = await response.text()
    if (!response.ok) {
      let message = text.slice(0, 200)
      try { message = String((JSON.parse(text) as { message?: unknown }).message ?? message) } catch { /* not JSON: the text stands */ }
      throw new Error(`GitHub ${method} ${path} answered ${String(response.status)}: ${message}`)
    }
    return text === '' ? undefined : JSON.parse(text)
  }
  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
    patch: (path, body) => call('PATCH', path, body)
  }
}

/** `owner/name` of a GitHub repository URL, or undefined for any other host. */
export function githubRepoOf (url: string): string | undefined {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url)
  return match === null ? undefined : `${match[1] ?? ''}/${match[2] ?? ''}`
}

/** A ref for a URL path: each segment encoded, the slashes between them kept. */
export function refPath (ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/')
}
