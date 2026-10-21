// Where a problem with a port is reported: the issue form of this repository, with the app and a
// title filled in. The Orivon hint's "Report a problem" link and the manifest's `support.issues`
// are this one address, written by prepare.ts.

import type { Recipe } from './recipe.ts'

const REPORT_URL = 'https://github.com/OrivonBrowser/orivon-ports/issues/new'
const REPORT_TEMPLATE = 'port-problem.yml'

/** The name the issue form lists an app under: its hint name, else its own. */
export function reportName (recipe: Pick<Recipe, 'name' | 'hint'>): string {
  return recipe.hint?.name ?? recipe.name
}

/**
 * The form's `app` dropdown is filled from the query parameter named after its id and matched
 * against an option's label, which is the app's hint name.
 */
export function portProblemUrl (name: string): string {
  const title = `Problem with the Orivon community build of ${name}`
  return `${REPORT_URL}?template=${REPORT_TEMPLATE}&app=${encodeURIComponent(name)}&title=${encodeURIComponent(title)}`
}

/**
 * The manifest with `support.issues` set to the form's address for `name`. An app whose manifest
 * already names a `support` keeps it. Text that is not a JSON object is returned as it is (the
 * declaration step names that fault).
 */
export function withSupport (manifestText: string, name: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(manifestText)
  } catch {
    return manifestText
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return manifestText
  const manifest = parsed as Record<string, unknown>
  if (manifest['support'] !== undefined) return manifestText
  return `${JSON.stringify({ ...manifest, support: { issues: portProblemUrl(name) } }, null, 2)}\n`
}
