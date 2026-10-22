//! `fslock-guard`'s public API, for a target without file locks.
//!
//! WASI 0.2 has no `flock`, so the real crate builds there but every lock
//! fails, and Arti stops at its first state or cache directory. TorSocks runs
//! one daemon per app, refused a second start by its control port, so the
//! lock it would take has no rival: this one creates the lock file, as the
//! real one does, and always succeeds.

use std::fs;
use std::path::Path;

/// A lock on a file, held until dropped.
#[derive(Debug)]
pub struct LockFileGuard {
    _file: fs::File,
}

impl LockFileGuard {
    fn open(path: &Path) -> Result<fs::File, std::io::Error> {
        fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path)
    }

    /// Takes the lock, creating the file when it is missing.
    pub fn lock<P: AsRef<Path>>(path: P) -> Result<Self, std::io::Error> {
        Ok(Self { _file: Self::open(path.as_ref())? })
    }

    /// Takes the lock, creating the file when it is missing; never `None` here.
    pub fn try_lock<P: AsRef<Path>>(path: P) -> Result<Option<Self>, std::io::Error> {
        Self::lock(path).map(Some)
    }

    /// Removes the lock file and releases the lock.
    pub fn delete_lock_file<P: AsRef<Path>>(self, path: P) -> Result<(), std::io::Error> {
        fs::remove_file(path)
    }
}
