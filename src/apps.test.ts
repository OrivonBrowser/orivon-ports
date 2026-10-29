import { describe, expect, it } from 'vitest'
import { appOfManifestId, listAppIds, manifestIdsOfApps } from './apps.ts'

// A built tree names itself by its manifest's id and an app is known by its recipe's, and the two differ
// for nearly every app here. Everything that goes from a tree to an app's files depends on this lookup.
describe('finding an app by the id in its manifest', () => {
  it('reaches every app here from the id its own manifest carries, which no other app shares', async () => {
    const apps = await manifestIdsOfApps()
    expect(apps.map((app) => app.id).sort()).toEqual((await listAppIds()).sort())
    for (const app of apps) expect(await appOfManifestId(app.manifestId), `apps/${app.id}`).toEqual(app)
    expect(new Set(apps.map((app) => app.manifestId)).size).toBe(apps.length)
  })
})
