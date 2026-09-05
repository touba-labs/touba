import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const implementationRoot = path.resolve(fixtureRoot, "../..");
const corpusRoot = path.join(implementationRoot, "grammar/tree-sitter-touba/examples/record-construction-v1");
const tmpRoot = mkdtempSync(path.join(tmpdir(), "touba-record-v1-"));
const airPath = path.join(tmpRoot, "record.air.json");
const tracePath = path.join(tmpRoot, "record.trace.json");
const compiler = ["run", "-p", "touba-cli", "--bin", "touba-compile", "--quiet", "--"];

try {
  const positive = compile("positive/tb-record-v1-p01-nominal.tb");
  assert.equal(positive.status, 0, positive.stderr);
  const air = JSON.parse(positive.stdout);
  writeFileSync(airPath, positive.stdout, "utf8");
  const record = air.execution_graphs[0].expressions.find((expression) => expression.kind === "construct_record");
  assert.deepEqual(record.record_fields.map((field) => field.name), ["approved", "label", "risk"]);

  const run = spawnSync(process.execPath, [
    path.join(implementationRoot, "cli/touba-run/src/run.mjs"),
    airPath,
    "--entry", "function:examples.record_construction/BuildDecision",
    "--inputs-json", JSON.stringify({ score: 0.7 }),
    "--trace-out", tracePath,
    "--output", "result",
  ], { cwd: implementationRoot, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { approved: true, label: "accepted", risk: 0.7 });
  const traceText = readFileSync(tracePath, "utf8");
  assert.doesNotMatch(traceText, /accepted|0\.7/);

  const negatives = new Map([
    ["tb-record-v1-n01-unknown-type.tb", "UnknownRecordType"],
    ["tb-record-v1-n02-missing-field.tb", "MissingRecordField"],
    ["tb-record-v1-n03-unknown-field.tb", "UnknownRecordField"],
    ["tb-record-v1-n04-duplicate-field.tb", "DuplicateRecordField"],
    ["tb-record-v1-n05-wrong-type.tb", "RecordFieldTypeMismatch"],
  ]);
  for (const [name, code] of negatives) {
    const result = compile(`negative/semantic/${name}`);
    assert.notEqual(result.status, 0, `${name} must fail`);
    assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(code));
  }
  console.log("record-construction-v1: status=success positive=1 negatives=5 runtime=deterministic");
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

function compile(relativePath) {
  return spawnSync(process.env.CARGO ?? "cargo", [
    ...compiler,
    path.relative(implementationRoot, path.join(corpusRoot, relativePath)),
  ], { cwd: implementationRoot, encoding: "utf8" });
}
