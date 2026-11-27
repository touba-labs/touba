import { openSync, closeSync, writeFileSync, fsyncSync, renameSync, lstatSync, unlinkSync } from "node:fs";
import { dirname, basename, resolve, join } from "node:path";
import { randomUUID } from "node:crypto";

// A published snapshot is complete and private. Never follow a checkpoint link.
export function writeCheckpointFile(path, checkpoint, indent) {
  const target = resolve(path);
  try { if (!lstatSync(target).isFile()) throw new Error("checkpoint target must be a regular file"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(checkpoint, null, indent) + "\n");
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, target);
    // Node cannot open directories with `r` on Windows (EISDIR). The file is
    // flushed before the atomic replacement on every platform; POSIX also
    // supports flushing the directory entry after the rename.
    if (process.platform !== "win32") {
      const directory = openSync(dirname(target), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
