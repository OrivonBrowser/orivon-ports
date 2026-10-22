//! Arti keeps its directory cache in SQLite. Built for WASI, SQLite's default
//! VFS locks with a dot-file and re-reads the file header on every statement,
//! and every file call here is a round trip to Orivon's broker; the daemon is
//! the database's only user, so the VFS without locks is made the default
//! before Arti opens it (orivon-mvp's `src/shim/wasi-p2/README.md`, section
//! What a file call costs).

use rusqlite::ffi;

pub fn prefer_unlocked_vfs() {
    // SAFETY: both calls take a NUL-terminated name and SQLite's own VFS
    // pointer, before any connection is open; a missing VFS is left alone.
    unsafe {
        let vfs = ffi::sqlite3_vfs_find(c"unix-none".as_ptr());
        if !vfs.is_null() {
            ffi::sqlite3_vfs_register(vfs, 1);
        }
    }
}
