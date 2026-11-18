// Runs one of the shell drives under the vitest of the Orivon checkout (`ORIVON_MVP_ROOT`), so its TypeScript test support loads:
// this repository's own suite never picks the file up, because it needs that checkout, a kubo and a built app. `DRIVE_MODE`
// chooses: unset, the go/no-go with a local reader (`shell.js`, `DRIVE_BUSY_S` seconds of busy window after it); `start`, the node's
// start alone (`starts.js`); `restart`, a board that comes back after the app is closed and opened again (`restart.js`); `network`, a board hosted on the real network (`network.js`); `manager`, the 5chan board manager archiving at capacity (`manager.js`).
const { it, expect } = await import(`${process.env['ORIVON_MVP_ROOT']}/node_modules/vitest/dist/index.js`)
const mode = process.env['DRIVE_MODE'] ?? 'go'

if (mode === 'start') {
  const { runStart } = await import('./starts.js')
  it('the node starts in the shell, and the result says how', async () => {
    const result = await runStart()
    expect(result.error ?? null).toBeNull()
  }, 600_000)
} else if (mode === 'restart') {
  const { runRestart } = await import('./restart.js')
  it('a board comes back after the app is closed and opened again', async () => {
    const result = await runRestart()
    expect(result.error ?? null).toBeNull()
    expect(result.ok).toBe(true)
  }, 1_800_000)
} else if (mode === 'manager') {
  const { runManager } = await import('./manager.js')
  it('the board manager runs in the Worker and archives a board at capacity', async () => {
    const result = await runManager()
    expect(result.error ?? null).toBeNull()
    expect(result.ok).toBe(true)
  }, 1_800_000)
} else if (mode === 'network') {
  const { runNetwork } = await import('./network.js')
  it('a board hosted by the Worker in the shell is read and posted to from a public machine', async () => {
    const result = await runNetwork({ minutes: Number(process.env['DRIVE_NET_MINUTES'] ?? '8') })
    expect(result.error ?? null).toBeNull()
  }, 3_600_000)
} else {
  const { runShell } = await import('./shell.js')
  it('a community hosted by the Worker in the shell is read and posted to by a Bitsocial client on a real kubo', async () => {
    const result = await runShell({ busyMs: Number(process.env['DRIVE_BUSY_S'] ?? '0') * 1000 })
    expect(result.error ?? null).toBeNull()
    expect(result.ok).toBe(true)
  }, 1_800_000)
}
