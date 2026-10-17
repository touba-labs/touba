import { openSync, closeSync, writeFileSync, fsyncSync, renameSync, lstatSync, unlinkSync } from "node:fs";
import { dirname, basename, resolve, join } from "node:path";
import { randomUUID } from "node:crypto";

// A published snapshot is complete and private. Never follow a checkpoint link.
export function writeParallelCheckpoint(path, checkpoint) {
  const target = resolve(path);
  try { if (!lstatSync(target).isFile()) throw new Error("checkpoint target must be a regular file"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(checkpoint) + "\n");
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, target);
    const directory = openSync(dirname(target), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
