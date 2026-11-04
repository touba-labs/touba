import { closeSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createSqliteEffectJournal } from "../../../runtime/touba-runtime/src/sqlite-effect-journal.mjs";
import { ToubaRuntimeError } from "../../../runtime/touba-runtime/src/runtime-errors.mjs";

export function effectJournalPathDiagnostic(path) {
  if (typeof path === "string" && path.endsWith(".effect-journal.sqlite")) return null;
  return "--effect-journal requires a .effect-journal.sqlite path. For an old JSON journal, stop its writers, preview: "
    + "touba state migrate effects <source.json> --out .touba/effects.effect-journal.sqlite; "
    + "then repeat with --apply. Keep the source and related approval/checkpoint stores; do not rename JSON or start an empty journal to resume prior effects.";
}

// The CLI execution is single-writer. A lease spans the whole execution,
// including pauses in a process; a crashed lease is never stolen automatically.
export function openCliEffectJournal(inputPath, secretValues = []) {
  if (typeof inputPath !== "string" || !inputPath.endsWith(".sqlite")) {
    throw new ToubaRuntimeError("EffectJournalPathInvalid", "effect journal path must end with .sqlite; migrate old JSON explicitly");
  }
  const requested = resolve(inputPath);
  mkdirSync(dirname(requested), { recursive: true });
  const path = join(realpathSync(dirname(requested)), basename(requested));
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ToubaRuntimeError("EffectJournalPathInvalid", "effect journal must be a regular file, not a link");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const leasePath = `${path}.lock`;
  let fd;
  try { fd = openSync(leasePath, "wx", 0o600); }
  catch (error) {
    throw new ToubaRuntimeError(error.code === "EEXIST" ? "EffectJournalBusy" : "EffectJournalUnavailable",
      "cannot acquire the effect journal lease; an existing lease requires host inspection before removal");
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    closeSync(fd);
    unlinkSync(leasePath);
  };
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }) + "\n");
    return { journal: createSqliteEffectJournal(path, { secretValues }), close };
  } catch (error) { close(); throw error; }
}
