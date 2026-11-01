import { constants, openSync, closeSync, fchmodSync, fstatSync, lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Shared by host state stores. The caller owns the directory and maps errors
// to its public diagnostic; no database payload is inspected here.
export function preparePrivateSqliteFile(filename, fail) {
  if (filename === ":memory:") return;
  const parent = lstatSync(dirname(resolve(filename)));
  if (!parent.isDirectory() || parent.isSymbolicLink()
      || (process.platform !== "win32" && (parent.mode & 0o022) !== 0)) {
    fail("database requires a directory not writable by other users");
  }
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    let fd;
    try {
      let before;
      try { before = lstatSync(filename + suffix); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      // lstat can observe an inode concurrently unlinked by SQLite, too.
      if (suffix && before?.isFile() && before.nlink === 0) continue;
      if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)) {
        fail("database storage must be a regular file without links");
      }
      fd = openSync(filename + suffix, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0)
        | (suffix === "" ? constants.O_CREAT : 0), 0o600);
      const stat = fstatSync(fd);
      // SQLite may unlink a rollback journal while another process opens it.
      // An already-unlinked sidecar is no longer a storage path to secure.
      // Never apply this exception to the database or to hard/symbolic links.
      if (suffix && stat.isFile() && stat.nlink === 0) continue;
      if (!stat.isFile() || stat.nlink !== 1) fail("database storage must be a regular file without links");
      if (before && (before.dev !== stat.dev || before.ino !== stat.ino)) {
        if (!suffix) fail("database storage changed while opening");
        // A new journal may replace the previous one between lstat and open.
        // Recheck the current pathname; O_NOFOLLOW and fstat protect the fd.
        let current;
        try { current = lstatSync(filename + suffix); }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1) fail("database storage must be a regular file without links");
        if (current.dev !== stat.dev || current.ino !== stat.ino) continue;
      }
      if (process.platform !== "win32") fchmodSync(fd, 0o600);
    } catch (error) {
      if (suffix && error.code === "ENOENT") continue;
      if (error.code === "ELOOP") fail("database storage cannot be a symbolic link");
      throw error;
    } finally { if (fd !== undefined) closeSync(fd); }
  }
}
