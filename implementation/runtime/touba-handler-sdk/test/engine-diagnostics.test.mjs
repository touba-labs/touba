import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ToubaEngine } from "../src/index.mjs";

for (const executionMode of ["process", "persistent"]) test(`entry admission diagnostic survives ${executionMode} transport`, async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-entry-diagnostic-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "main.tb"), "module diagnostic\nstrategy Main\n    gives Int\n    do\n        give 1\n");
  const engine = new ToubaEngine({ projectRoot: root, executionMode, command: process.execPath,
    commandArgs: [fileURLToPath(new URL("../../../cli/touba-project/src/main.mjs", import.meta.url))] });
  t.after(() => engine.close());
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
