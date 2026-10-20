// The release watcher the workflow runs: `scan` reads each recipe's upstream
// and writes what it found, `report` keeps one issue per app up to date from
// that file, and `pin-prs` opens draft pull requests moving the pins (only
// when the workflow's repository variable allows it). The logic is in
// src/upstream-release.ts and src/pin-pr.ts; this only wires it to argv and
// the environment.
import { readFile, writeFile } from 'node:fs/promises'
import { loadAllRecipes } from '../src/apps.ts'
import { githubApi } from '../src/github-api.ts'
import { REPO_ROOT } from '../src/paths.ts'
import { openPinPrs } from '../src/pin-pr.ts'
import { LABEL_CANDIDATES, applyActions, chooseLabel, describeAction, listIssues, listLabels, pinsOf, planIssues, scanAll } from '../src/upstream-release.ts'
import type { Finding } from '../src/upstream-release.ts'

const [command, ...rest] = process.argv.slice(2)
const option = (name: string): string | undefined => {
  const at = rest.indexOf(`--${name}`)
  return at === -1 ? undefined : rest[at + 1]
}

async function findings (): Promise<Finding[]> {
  const path = option('from')
  if (path === undefined) throw new Error('--from <file written by scan> is required')
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error(`${path} is not a list of findings`)
  return parsed as Finding[]
}

function repository (): string {
  const repo = option('repo') ?? process.env['GITHUB_REPOSITORY']
  if (repo === undefined || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('--repo owner/name (or GITHUB_REPOSITORY) is required')
  return repo
}

if (command === 'scan') {
  const found = await scanAll(githubApi(process.env['GITHUB_TOKEN']), pinsOf(await loadAllRecipes()))
  for (const finding of found) {
    const note = finding.kind === 'update' ? `${finding.tag} is newer than the pin` : finding.kind === 'current' ? `up to date (${finding.tag})` : finding.why
    process.stderr.write(`[${finding.app}] ${finding.kind}: ${note}\n`)
  }
  const out = option('out')
  if (out === undefined) process.stdout.write(`${JSON.stringify(found)}\n`)
  else await writeFile(out, `${JSON.stringify(found)}\n`)
} else if (command === 'report') {
  const api = githubApi(process.env['GITHUB_TOKEN'])
  const repo = repository()
  const found = await findings()
  const actions = planIssues(found, await listIssues(api, repo))
  for (const action of actions) process.stderr.write(`${rest.includes('--dry-run') ? 'would ' : ''}${describeAction(action)}\n`)
  if (actions.length === 0) process.stderr.write('every issue is already as it should be\n')
  if (!rest.includes('--dry-run')) await applyActions(api, repo, actions, chooseLabel(await listLabels(api, repo), LABEL_CANDIDATES))
  // After the issues are right, so one app GitHub would not answer for never hides the others; the run still ends red.
  const failed = found.filter((finding) => finding.kind === 'error')
  if (failed.length > 0) throw new Error(`could not check: ${failed.map((finding) => finding.app).join(', ')}`)
} else if (command === 'pin-prs') {
  const updates = (await findings()).filter((finding): finding is Extract<Finding, { kind: 'update' }> => finding.kind === 'update')
  const opened = await openPinPrs(updates, REPO_ROOT, option('base') ?? 'main')
  process.stderr.write(opened.length === 0 ? 'no pull request to open\n' : `opened: ${opened.join(', ')}\n`)
} else {
  throw new Error('usage: upstream-release.ts scan [--out file] | report --from file [--repo o/n] [--dry-run] | pin-prs --from file [--base main]')
}
