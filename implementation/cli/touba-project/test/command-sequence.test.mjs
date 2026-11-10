import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ToubaEngine } from "../../../runtime/touba-handler-sdk/src/index.mjs";
import { captureProject, compileCapture } from "../../touba-inspect/src/explorer/project.mjs";

const cli = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
const program = value => `module sequence.main\nstrategy Main\n    gives Int\n    do\n        give ${value}\n`;
const digest = path => createHash("sha256").update(readFileSync(path)).digest("hex");
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touba sequence ")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function command(root, ...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

test("completed compilation exposes saved changes immediately and preserves explicit AIR selection", async t => {
  const root = fixture(t);
  mkdirSync(join(root, "nested"));
  writeFileSync(join(root, "main.tb"), program(1));
  command(root, "compile", "main.tb", "--out", "main.air.json");
  const first = digest(join(root, "main.air.json"));
  assert.equal(JSON.parse(command(root, "run", "main.air.json", "--output", "json")).result, 1);
  // An editor buffer alone cannot alter the saved source or compiled AIR.
  const unsaved = program(2);
  assert.equal(JSON.parse(command(root, "run", "main.air.json", "--output", "json")).result, 1);
  writeFileSync(join(root, "main.tb"), unsaved);
  assert.equal(JSON.parse(command(root, "run", "main.air.json", "--output", "json")).result, 1);
  command(join(root, "nested"), "compile", "../main.tb", "--out", "../main.air.json");
  assert.notEqual(digest(join(root, "main.air.json")), first);
  assert.equal(JSON.parse(command(root, "run", "main.air.json", "--output", "json")).result, 2);

  for (const executionMode of ["process", "persistent"]) {
    const engine = new ToubaEngine({ projectRoot: root, command: process.execPath, commandArgs: [cli], executionMode });
    try {
      for (const value of [3, 4, 5]) {
        writeFileSync(join(root, "main.tb"), program(value));
        const compiled = await engine.compile({ source: "main.tb" });
        assert.equal((await engine.run({ airJson: compiled.airJson })).result, value);
        assert.equal((await engine.run({ source: "main.tb" })).result, value);
      }
    } finally { await engine.close(); }
  }
});

test("prepare write/check/run and Explorer read saved revisions without a delay", async t => {
  const root = fixture(t);
  command(root, "init", "--root", ".");
  mkdirSync(join(root, "src/sequence"));
  let previous;
  for (const value of [10, 11, 12]) {
    writeFileSync(join(root, "src/sequence/main.tb"), program(value));
    command(root, "prepare", "--root", ".", "--mode", "write");
    command(root, "prepare", "--root", ".", "--mode", "check");
    const run = JSON.parse(command(root, "run", "--project", ".", "--entry", "strategy:sequence.main/Main", "--output", "json"));
    assert.equal(run.result, value);
    const capture = await captureProject(root);
    const projection = await compileCapture(capture);
    assert.ok(projection.graph, JSON.stringify(projection.diagnostics));
    assert.notEqual(capture.revision, previous);
    assert.equal(capture.files.find(file => file.path === "src/sequence/main.tb").text, program(value));
    previous = capture.revision;
  }
});

test("two independent compiler processes finish before their AIR is consumed", async t => {
  const root = fixture(t);
  for (const value of [20, 21]) writeFileSync(join(root, `${value}.tb`), program(value));
  await Promise.all([20, 21].map(value => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "compile", `${value}.tb`, "--out", `${value}.air.json`], { cwd: root });
    let stderr = "";
    child.stdout.resume(); child.stderr.on("data", bytes => { stderr += bytes; });
    child.on("error", reject);
    child.on("close", code => {
      try {
        assert.equal(code, 0, stderr);
        assert.equal(JSON.parse(command(root, "run", `${value}.air.json`, "--output", "json")).result, value);
        resolve();
      } catch (error) { reject(error); }
    });
  })));
});

test("recompilation publishes a complete replacement while an existing reader keeps its AIR", t => {
  const root = fixture(t);
  writeFileSync(join(root, "main.tb"), program(30));
  command(root, "compile", "main.tb", "--out", "main.air.json");
  const output = join(root, "main.air.json"), previous = readFileSync(output, "utf8");
  if (process.platform !== "win32") chmodSync(output, 0o600);
  const reader = openSync(output, "r");
  try {
    writeFileSync(join(root, "main.tb"), program(31));
    command(root, "compile", "main.tb", "--out", "main.air.json");
    assert.notEqual(readFileSync(output, "utf8"), previous);
    assert.equal(readFileSync(reader, "utf8"), previous);
    if (process.platform !== "win32") assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.ok(readdirSync(root).every(name => !name.startsWith(".touba-compile-")));
  } finally { closeSync(reader); }
});

test("a failed compilation retains the last complete AIR and refuses output aliases", t => {
  const root = fixture(t), output = join(root, "main.air.json");
  writeFileSync(join(root, "main.tb"), program(40));
  command(root, "compile", "main.tb", "--out", "main.air.json");
  const previous = digest(output);
  writeFileSync(join(root, "main.tb"), "invalid source");
  const failed = spawnSync(process.execPath, [cli, "compile", "main.tb", "--out", "main.air.json"], { cwd: root, encoding: "utf8" });
  assert.notEqual(failed.status, 0);
  assert.equal(digest(output), previous);
  assert.ok(readdirSync(root).every(name => !name.startsWith(".touba-compile-")));
  if (process.platform !== "win32") {
    symlinkSync(output, join(root, "alias.air.json"));
    writeFileSync(join(root, "main.tb"), program(41));
    const alias = spawnSync(process.execPath, [cli, "compile", "main.tb", "--out", "alias.air.json"], { cwd: root, encoding: "utf8" });
    assert.notEqual(alias.status, 0);
    assert.match(alias.stderr, /regular file/);
    assert.equal(digest(output), previous);
    if (process.getuid?.() !== 0) {
      chmodSync(output, 0o400);
      try {
        const readonly = spawnSync(process.execPath, [cli, "compile", "main.tb", "--out", "main.air.json"], { cwd: root, encoding: "utf8" });
        assert.notEqual(readonly.status, 0);
        assert.equal(digest(output), previous);
      } finally { chmodSync(output, 0o600); }
    }
  }
});
