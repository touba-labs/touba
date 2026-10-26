// Test observer only. Production admission and measured workers stay unchanged.
// Counting must not materialize the historical JSON corpus in the parent that
// shares the worker's memory-limited container.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { currentStateBuild } from "../src/state-origin.mjs";

export function completedCheckpointCount(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT schema_version FROM metadata").get().schema_version, "touba-sandbox-checkpoints-v1");
    return db.prepare("SELECT COUNT(*) AS count FROM records WHERE json_extract(body, '$.status') = 'completed'").get().count;
  } finally { db.close(); }
}

export function corruptLastCheckpoint(path) {
  assert.ok(existsSync(path), "corruption probe requires an existing store");
  const db = new DatabaseSync(path);
  try {
    assert.equal(db.prepare("SELECT schema_version FROM metadata").get().schema_version, "touba-sandbox-checkpoints-v1");
    const last = db.prepare("SELECT rowid, body FROM records ORDER BY rowid DESC LIMIT 1").get();
    assert.ok(last, "corruption probe requires a stored checkpoint");
    const record = JSON.parse(last.body);
    record.human_wait.request_digest = "sha256:" + "0".repeat(64);
    assert.equal(db.prepare("UPDATE records SET body=? WHERE rowid=?").run(JSON.stringify(record), last.rowid).changes, 1);
  } finally { db.close(); }
}

export function restoreHttpHistoryFixture(directory, history) {
  assert.ok(Number.isSafeInteger(history) && history >= 0 && history <= 10000);
  const matches = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith(`history-${history}-`));
  assert.equal(matches.length, 1, "require exactly one retained baseline for this size");
  const baseline = join(directory, matches[0].name);
  const retained = JSON.parse(readFileSync(join(baseline, "preservation.json"), "utf8"));
  const origin = JSON.parse(readFileSync(join(baseline, "state/state-origin.json"), "utf8"));
  assert.equal(retained.history, history);
  assert.deepEqual(retained.origin, origin);
  assert.equal(origin.build_id, currentStateBuild(), "a retained history cannot be assigned to a different build");
  const root = resolve(retained.originalProjectRoot);
  assert.equal(realpathSync(dirname(root)), realpathSync(tmpdir()), "only an original temporary test root can be restored");
  assert.match(basename(root), /^touba-durable-human-waits-[A-Za-z0-9]{6}$/);
  assert.equal(origin.project_root, join(realpathSync(dirname(root)), basename(root)));
  assert.equal(existsSync(root), false, "never replace an existing project for a replay");
  const checkpoints = join(baseline, "state/sandbox-checkpoints.sqlite");
  if (history !== 0 || existsSync(checkpoints)) assert.equal(completedCheckpointCount(checkpoints), history);
  mkdirSync(root, { mode: 0o700 });
  try {
    cpSync(join(baseline, "project"), root, { recursive: true });
    cpSync(join(baseline, "state"), join(root, ".touba"), { recursive: true });
    assert.equal(readFileSync(join(root, ".touba/state-origin.json"), "utf8"),
      readFileSync(join(baseline, "state/state-origin.json"), "utf8"));
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
