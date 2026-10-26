import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { currentStateBuild } from "../src/state-origin.mjs";
import { completedCheckpointCount, corruptLastCheckpoint, restoreHttpHistoryFixture } from "./http-history-fixture.mjs";

function temporary(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function database(path, count) {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE metadata(schema_version TEXT); CREATE TABLE records(id TEXT, body TEXT); BEGIN");
  db.prepare("INSERT INTO metadata VALUES (?)").run("touba-sandbox-checkpoints-v1");
  const insert = db.prepare("INSERT INTO records VALUES (?, ?)");
  for (let i = 0; i < count; i++) insert.run(String(count - i), JSON.stringify({
    id: String(count - i), status: i % 2 ? "completed" : "pending", human_wait: { request_digest: "original" },
  }));
  db.exec("COMMIT"); db.close();
}
function retained(t, history = 0) {
  const directory = temporary(t, "touba-http-fixture-"), root = temporary(t, "touba-durable-human-waits-");
  const baseline = join(directory, `history-${history}-retained`);
  mkdirSync(join(baseline, "state"), { recursive: true });
  mkdirSync(join(baseline, "project"));
  writeFileSync(join(baseline, "project/program.tb"), "module example\n");
  const origin = { schema_version: "touba-serve-state-origin-v1", project_root: realpathSync(root), build_id: currentStateBuild() };
  const metadata = { history, originalProjectRoot: root, origin };
  const save = () => {
    writeFileSync(join(baseline, "preservation.json"), JSON.stringify(metadata));
    writeFileSync(join(baseline, "state/state-origin.json"), JSON.stringify(metadata.origin));
  };
  save(); rmSync(root, { recursive: true });
  return { directory, baseline, root, metadata, save };
}

test("HTTP observer counts all records read-only and corrupts only the physical last row", t => {
  const path = join(temporary(t, "touba-http-count-"), "state.sqlite");
  database(path, 10000);
  const before = readFileSync(path);
  assert.equal(completedCheckpointCount(path), 5000);
  assert.deepEqual(readFileSync(path), before);
  corruptLastCheckpoint(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM records WHERE json_extract(body, '$.human_wait.request_digest')='original'").get().count, 9999);
    const last = JSON.parse(db.prepare("SELECT body FROM records ORDER BY rowid DESC LIMIT 1").get().body);
    assert.equal(last.id, "1");
    assert.equal(last.human_wait.request_digest, "sha256:" + "0".repeat(64));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM records").get().count, 10000);
  } finally { db.close(); }
});

test("HTTP observer refuses an absent, empty or foreign checkpoint store", t => {
  const path = join(temporary(t, "touba-http-count-"), "state.sqlite");
  assert.throws(() => completedCheckpointCount(path));
  assert.throws(() => corruptLastCheckpoint(path));
  assert.equal(existsSync(path), false);
  database(path, 0);
  assert.equal(completedCheckpointCount(path), 0);
  assert.throws(() => corruptLastCheckpoint(path));
  const db = new DatabaseSync(path);
  db.exec("UPDATE metadata SET schema_version='foreign'"); db.close();
  assert.throws(() => completedCheckpointCount(path));
  assert.throws(() => corruptLastCheckpoint(path));
});

test("HTTP replay preserves origin and refuses to replace any existing project", t => {
  const f = retained(t);
  assert.equal(restoreHttpHistoryFixture(f.directory, 0), f.root);
  assert.equal(readFileSync(join(f.root, "program.tb"), "utf8"), "module example\n");
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, ".touba/state-origin.json"))), f.metadata.origin);
  assert.throws(() => restoreHttpHistoryFixture(f.directory, 0), /never replace/);
  assert.equal(readFileSync(join(f.root, "program.tb"), "utf8"), "module example\n");
});

test("HTTP replay refuses build reassignment, identity mismatch and an invalid count before copying", t => {
  const f = retained(t, 2);
  database(join(f.baseline, "state/sandbox-checkpoints.sqlite"), 2); // only one completed
  assert.throws(() => restoreHttpHistoryFixture(f.directory, 2));
  assert.equal(existsSync(f.root), false);
  f.metadata.origin.build_id = "source:" + "0".repeat(64); f.save();
  assert.throws(() => restoreHttpHistoryFixture(f.directory, 2), /different build/);
  assert.equal(existsSync(f.root), false);
  f.metadata.origin.build_id = currentStateBuild();
  f.metadata.origin.project_root = "/"; f.save();
  assert.throws(() => restoreHttpHistoryFixture(f.directory, 2));
  assert.equal(existsSync(f.root), false);
  assert.throws(() => restoreHttpHistoryFixture(f.directory, -1));
});
