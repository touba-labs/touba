import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeParallelCheckpoint } from "../src/parallel-checkpoint-file.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "touba-checkpoint-file-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("parallel checkpoints are complete and replaceable on the native platform", t => {
  const root = fixture(t), target = join(root, "progress.json");
  for (const checkpoint of [{ completed: [], question: "é🙂" }, { completed: [1, 2] }]) {
    writeParallelCheckpoint(target, checkpoint);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), checkpoint);
    assert.deepEqual(readdirSync(root), ["progress.json"]);
    if (process.platform !== "win32") assert.equal(statSync(target).mode & 0o777, 0o600);
  }
});

test("failed checkpoint serialization preserves the prior snapshot and cleans its temporary file", t => {
  const root = fixture(t), target = join(root, "progress.json");
  writeParallelCheckpoint(target, { completed: [1] });
  const circular = {}; circular.self = circular;
  assert.throws(() => writeParallelCheckpoint(target, circular), TypeError);
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { completed: [1] });
  assert.deepEqual(readdirSync(root), ["progress.json"]);
});

test("checkpoints reject directories and links without changing their targets", t => {
  const root = fixture(t), directory = join(root, "directory"), link = join(root, "link");
  mkdirSync(directory);
  symlinkSync(directory, link, process.platform === "win32" ? "junction" : "dir");
  for (const target of [directory, link]) assert.throws(() => writeParallelCheckpoint(target, {}), /regular file/);
  assert.deepEqual(readdirSync(directory), []);
});
