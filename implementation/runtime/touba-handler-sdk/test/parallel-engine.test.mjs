import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ToubaEngine } from "../src/index.mjs";

const source = `module industrial.parallel
tool Diagnose
    takes request as Text
    gives Text
skill Review
    takes request as Text
    gives Text
    do
        Diagnose
            with request as request
            into report
        human.approve
            with context as report
            into approval
        give report
strategy Run
    takes incidents as List of Text
    gives List of Text
    do
        parallel Review
            each incident in incidents
            with request as incident
            max_concurrency 3
            max_items 20
            into reports
        give reports
`;

test("SDK and CLI resume concurrent external-write branches across processes without duplicate effects", async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-parallel-sdk-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "source.tb"), source);
  const marker = join(root, "effects.jsonl");
  writeFileSync(join(root, "handler.mjs"), `import { appendFileSync } from 'node:fs';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
await new Promise(resolve => setTimeout(resolve, 30));
appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ value: request.arguments.request, effect: request.effect.effect_id }) + '\\n');
process.stdout.write(JSON.stringify({ ok: true, value: request.arguments.request, effect_receipt: {
effect_id: request.effect.effect_id, request_digest: request.effect.request_digest, outcome: 'applied' }}));`);
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: {
    "tool:industrial.parallel/Diagnose": { handler: { kind: "process", command: process.execPath, args: [join(root, "handler.mjs")] },
      grants: [], timeout_ms: 2000, max_payload_bytes: 65536, effect_contract: { kind: "external_write", retry_mode: "none" } },
  } }));
  const engine = new ToubaEngine({ projectRoot: root, command: process.execPath,
    commandArgs: [fileURLToPath(new URL("../../../cli/touba-project/src/main.mjs", import.meta.url))],
    env: { TOUBA_COMPILE_BIN: fileURLToPath(new URL("../../../target/debug/touba-compile", import.meta.url)) } });
  const config = { source: "source.tb", entryRef: "strategy:industrial.parallel/Run", manifest: "manifest.json",
    effectJournal: "run.effect-journal.json", parallelCheckpointOut: "progress.json", parallelLimits: { maxExternalCalls: 2 } };
  let result = await engine.run({ ...config, inputs: { incidents: ["incident-a", "incident-b", "incident-c", "incident-d"] } });
  assert.equal(result.reason, "human_approval_pending");
  for (let i = 0; result.status === "stopped" && i < 8; i++) {
    const checkpoint = JSON.parse(readFileSync(join(root, "progress.json"), "utf8"));
    assert.equal(statSync(join(root, "progress.json")).mode & 0o777, 0o600);
    result = await engine.run({ ...config, parallelResumeCheckpoint: "progress.json",
      humanDecisions: { [checkpoint.approval_ref]: "approved" } });
  }
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.deepEqual(result.result, ["incident-a", "incident-b", "incident-c", "incident-d"]);
  const effects = readFileSync(marker, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(effects.length, 4);
  assert.equal(new Set(effects.map(effect => effect.effect)).size, 4);
  const again = await engine.run({ ...config, parallelResumeCheckpoint: "progress.json" });
  assert.equal(again.status, "success");
  assert.equal(readFileSync(marker, "utf8").trim().split("\n").length, 4);
});
