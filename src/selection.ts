// The apps a command acts on: read off the command line once, the same way
// for every command that takes them, then worked through one at a time.

/** Flags that take a value, so the value is never mistaken for an app id. */
const VALUED = new Set(['--port', '--emit', '--global'])

export function flag (argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`)
}

export function option (argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

/** The non-flag arguments. The command itself is never in the list -- callers hand it `argv.slice(1)`. */
export function positionals (argv: readonly string[]): string[] {
  const values: string[] = []
  let skipValue = false
  for (const arg of argv) {
    if (skipValue) { skipValue = false; continue }
    if (VALUED.has(arg)) { skipValue = true; continue }
    if (arg.startsWith('--')) continue
    values.push(arg)
  }
  return values
}

/**
 * The ids named after the command, in order and once each, or every known app
 * for `--all`. One origin per app makes the port part of the app's identity
 * (src/README.md), so `--port`, which moves one, refuses a list.
 */
export function selectApps (argv: readonly string[], known: readonly string[]): string[] {
  const command = argv[0] ?? ''
  const named = [...new Set(positionals(argv.slice(1)))]
  let ids = named
  if (flag(argv, 'all')) {
    if (named.length > 0) throw new Error(`--all already means every app -- drop ${named.join(', ')} or drop --all`)
    if (known.length === 0) throw new Error('no apps yet -- `orivon-port new <id>` makes one')
    ids = [...known]
  }
  if (ids.length === 0) {
    throw new Error(`${command} needs at least one app id -- known apps: ${known.join(', ') || 'none yet'} (--all for every app)`)
  }
  if (option(argv, 'port') !== undefined && ids.length > 1) {
    throw new Error('--port moves a single app; a list of apps serves each on the port its recipe declares')
  }
  return ids
}

function message (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * `work` for each app in turn, never two at once: a build is the app's whole
 * toolchain, and two side by side double the machine's load and interleave
 * their logs. A failure is said as it happens and the rest still run, so a
 * list does what running each app by hand would; the failures are named again
 * at the end, where the other apps' output cannot bury them. Returns the apps
 * that succeeded, and throws only when none did. A single app's error is
 * thrown as it is.
 */
export async function eachApp<T extends { readonly id: string }> (
  apps: readonly T[],
  work: (app: T) => Promise<unknown>,
  say: (line: string) => void
): Promise<T[]> {
  if (apps.length === 1) {
    await work(apps[0] as T)
    return [...apps]
  }
  const done: T[] = []
  const failed: string[] = []
  for (const app of apps) {
    try {
      await work(app)
      done.push(app)
    } catch (error) {
      // Among several apps' output, a bare ENOENT is nobody's.
      const text = message(error)
      say(text.startsWith(`[${app.id}]`) ? text : `[${app.id}] ${text}`)
      failed.push(app.id)
    }
  }
  if (failed.length === 0) return done
  const summary = `${String(failed.length)} of ${String(apps.length)} apps failed: ${failed.join(', ')}`
  if (done.length === 0) throw new Error(summary)
  say(`[orivon-port] ${summary}`)
  return done
}
