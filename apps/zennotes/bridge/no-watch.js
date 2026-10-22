// Stands in for chokidar. It watches with `fs.watch`, which Orivon's `fs` answers with ENOSYS, so
// every watcher upstream starts (the settings file, custom themes, the vault) would fail at start.
// This one never reports a change: a file edited outside the app shows when the app next reads it.

function watcher () {
  const self = {
    on () { return self },
    once () { return self },
    add () { return self },
    unwatch () { return self },
    getWatched () { return {} },
    async close () {}
  }
  return self
}

export const watch = () => watcher()
export default { watch }
