import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ToubaEngine } from "../src/index.mjs";

for (const executionMode of ["process", "persistent"]) test(`AIR diagnostics guide recovery with ${executionMode} transport`, async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-air-diagnostic-"));
  const cli = fileURLToPath(new URL("../../../cli/touba-project/src/main.mjs", import.meta.url));
  const engine = new ToubaEngine({ projectRoot: root, executionMode, command: process.execPath, commandArgs: [cli] });
  t.after(async () => {
    await engine.close();
    if (existsSync(join(root, "denied.air.json"))) chmodSync(join(root, "denied.air.json"), 0o600);
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "broken.air.json"), '{"PRIVATE_CONTENT":"secret"');
  writeFileSync(join(root, "invalid.air.json"), JSON.stringify({ schema_version: "PRIVATE_SCHEMA" }));
  const cases = [
    ["missing.air.json", "AirUnreadable", 2, /not found.*current directory/],
    [".", "AirUnreadable", 2, /directory.*compiled/],
    ["broken.air.json", "AirInvalid", 1, /file was read.*Recompile/],
    ["invalid.air.json", "AirInvalid", 1, /file was read.*Recompile/],
  ];
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    writeFileSync(join(root, "denied.air.json"), "{}");
    chmodSync(join(root, "denied.air.json"), 0);
    cases.push(["denied.air.json", "AirUnreadable", 2, /access denied.*permissions/]);
  }
  for (const [air, reason, exitCode, guidance] of cases) {
    const result = spawnSync(process.execPath, [cli, "run", air, "--output", "json"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, exitCode, result.stderr);
    assert.match(result.stderr, guidance);
    assert.doesNotMatch(result.stderr, /PRIVATE_|secret|touba-air-diagnostic-/);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.reason, reason);
    assert.deepEqual(envelope.trace.events.map(event => event.kind), ["admission_refused"]);
    await assert.rejects(engine.run({ air }), error => {
      assert.equal(error.code, reason);
      assert.equal(error.details.reason, reason);
      assert.equal(error.phase, "run");
      assert.equal(error.details.exitCode, exitCode);
      assert.match(error.message, reason === "AirInvalid" ? /Recompile/ : /projectRoot/);
      assert.doesNotMatch(error.message, /PRIVATE_|secret|touba-air-diagnostic-/);
      return true;
    });
  }
  // Recovery uses freshly compiled, saved source. No handler can run on refusal.
  writeFileSync(join(root, "main.tb"), "module recovery\nstrategy Main\n    gives Int\n    do\n        give 42\n");
  assert.equal((await engine.run({ source: "main.tb" })).result, 42);
});

for (const executionMode of ["process", "persistent"]) test(`entry admission diagnostic survives ${executionMode} transport`, async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-entry-diagnostic-"));
  let engine;
  t.after(async () => {
    // Windows retains a live worker's current directory. Close it before
    // removing the fixture; do not depend on the order of separate hooks.
    await engine?.close();
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "main.tb"), "module diagnostic\nstrategy Main\n    gives Int\n    do\n        give 1\n");
  engine = new ToubaEngine({ projectRoot: root, executionMode, command: process.execPath,
    commandArgs: [fileURLToPath(new URL("../../../cli/touba-project/src/main.mjs", import.meta.url))] });
  await assert.rejects(engine.run({ source: "main.tb", entryRef: "strategy:diagnostic/Missing" }), error => {
    assert.equal(error.code, "EntryNotFound");
    assert.equal(error.details.exitCode, 1);
    return true;
  });
});

test("interrupted execution has a bounded diagnostic rather than a completed result", async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-interrupted-diagnostic-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const envelope = { schema_version: "touba-command-error-v1", code: "ExecutionInterrupted", stage: "execution" };
  writeFileSync(join(root, "failed.mjs"), `process.stdout.write(${JSON.stringify(JSON.stringify(envelope))}); process.exitCode = 1;`);
  const engine = new ToubaEngine({ projectRoot: root, command: process.execPath, commandArgs: [join(root, "failed.mjs")] });
  await assert.rejects(engine.run({ airJson: {} }), error => {
    assert.equal(error.code, "ExecutionInterrupted");
    assert.equal(error.details.exitCode, 1);
    assert.equal(error.details.stage, "execution");
    assert.equal(Object.hasOwn(error.details, "trace"), false);
    return true;
  });
});

test("failed CLI preserves exit status without leaking stderr", async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-command-diagnostic-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "failed.mjs"), 'process.stderr.write("PRIVATE_TOKEN=hidden"); process.exit(17);');
  const engine = new ToubaEngine({ projectRoot: root, command: process.execPath, commandArgs: [join(root, "failed.mjs")] });
  await assert.rejects(engine.run({ airJson: {} }), error => {
    assert.equal(error.code, "EngineCommandFailed");
    assert.equal(error.details.exitCode, 17);
    assert.equal(JSON.stringify(error).includes("PRIVATE"), false);
    return true;
  });
});
