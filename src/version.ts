// An app's version as the browser orders it: dot-separated numbers, compared
// part by part (orivon-mvp src/trust/app-update-trust.ts), so `0.25.3.1` is
// above `0.25.3`. A ported app's version is `<upstream>.<build>`
// (docs/recipe-format.md); `release` is what raises the build.

const VERSION = /^\d+(?:\.\d+)*$/

/** The numeric parts of `version`, or undefined when it is not dot-separated numbers only. */
export function parseVersion (version: string): number[] | undefined {
  if (!VERSION.test(version)) return undefined
  const parts = version.split('.').map(Number)
  return parts.every(Number.isSafeInteger) ? parts : undefined
}

/** Negative when `a` is lower than `b`, zero when equal, positive when higher; a missing part counts as 0. Throws on a version `parseVersion` refuses. */
export function compareVersions (a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === undefined) throw new Error(`"${a}" is not a version -- numbers separated by dots, e.g. 0.24.0.2`)
  if (right === undefined) throw new Error(`"${b}" is not a version -- numbers separated by dots, e.g. 0.24.0.2`)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** The version one build later: its last number raised by one (`0.24.0.2` -> `0.24.0.3`, `0.1.0` -> `0.1.1`). */
export function raiseBuild (version: string): string {
  const parts = parseVersion(version)
  if (parts === undefined) throw new Error(`"${version}" is not a version -- numbers separated by dots, e.g. 0.24.0.2`)
  parts[parts.length - 1] = (parts[parts.length - 1] ?? 0) + 1
  return parts.join('.')
}

/** The first build of an upstream release: `1.12.33` -> `1.12.33.1`. */
export function firstBuild (upstream: string): string {
  if (parseVersion(upstream) === undefined) throw new Error(`"${upstream}" is not a version -- numbers separated by dots, e.g. 1.12.33`)
  return `${upstream}.1`
}

const VERSION_FIELD = /("version"\s*:\s*")([^"\\]*)(")/g

/** `text` (a manifest as written by hand) with its one `"version"` value replaced, every other byte as it was. */
export function withVersion (text: string, version: string): string {
  const found = [...text.matchAll(VERSION_FIELD)]
  if (found.length !== 1) throw new Error(`expected exactly one "version" field in the manifest, found ${String(found.length)}`)
  return text.replace(VERSION_FIELD, (_whole, open: string, _old: string, close: string) => `${open}${version}${close}`)
}
