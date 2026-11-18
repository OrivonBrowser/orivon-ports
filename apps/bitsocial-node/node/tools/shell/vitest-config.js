// The config `run.js` hands the Orivon checkout's vitest: only the shell drive, one at a time.
export default { root: new URL('.', import.meta.url).pathname, test: { environment: 'node', include: ['shell-drive.js'], reporters: ['verbose'], fileParallelism: false } }
