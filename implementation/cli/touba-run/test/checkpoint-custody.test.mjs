import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("CLI protects the invoice and effect identity with fixed original host evidence across fresh processes", t => {
  const root = mkdtempSync(join(tmpdir(), "touba-custody-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const implementation = fileURLToPath(new URL("../../../", import.meta.url));
  const air = execFileSync(join(implementation, `target/debug/touba-compile${process.platform === "win32" ? ".exe" : ""}`),
    [join(implementation, "runtime/touba-runtime/test/fixtures/checkpoint-custody.tb")]);
  writeFileSync(join(root, "source.air.json"), air);
  writeFileSync(join(root, "host.mjs"), `import { readFileSync } from 'node:fs';
export function attestHumanApproval() { return JSON.parse(readFileSync(new URL('./evidence.json', import.meta.url))); }
`);
  writeFileSync(join(root, "pay.mjs"), `import { appendFileSync } from 'node:fs';
let raw=''; for await (const chunk of process.stdin) raw += chunk;
const request=JSON.parse(raw);
appendFileSync(${JSON.stringify(join(root, "payments.jsonl"))}, JSON.stringify(request.arguments.invoice)+'\\n');
process.stdout.write(JSON.stringify({ok:true,value:'paid',effect_receipt:{effect_id:request.effect.effect_id,request_digest:request.effect.request_digest,outcome:'applied'}}));
`);
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: {
    "tool:checkpoint_custody/Pay": { handler: { kind: "process", command: process.execPath, args: [join(root, "pay.mjs")] },
      grants: [], timeout_ms: 10000, max_payload_bytes: 65536, effect_contract: { kind: "external_write", retry_mode: "none" } },
  } }));
  const invoke = extra => {
    const result = spawnSync(process.execPath, [join(implementation, "cli/touba-run/src/run.mjs"), join(root, "source.air.json"),
      "--manifest", join(root, "manifest.json"), "--human-approval-host", join(root, "host.mjs"),
      "--effect-journal", join(root, "effects.effect-journal.sqlite"), "--trace-store", join(root, "traces.sqlite"),
      "--entry", "strategy:checkpoint_custody/Process", "--output", "json", ...extra],
    { cwd: root, encoding: "utf8", timeout: 30000 });
    assert.ok(result.stdout, result.stderr);
    return JSON.parse(result.stdout);
  };
  const checkpoint = join(root, "checkpoint.json"), altered = join(root, "altered.json");
  const paused = invoke(["--inputs-json", JSON.stringify({ invoice: { id: "synthetic-only", amount: 100 } }), "--human-checkpoint-out", checkpoint]);
  assert.equal(paused.reason, "human_approval_pending");
  const original = JSON.parse(readFileSync(checkpoint));
  const request = original.approval_state.requests[original.approval_ref];
  writeFileSync(join(root, "evidence.json"), JSON.stringify({ request_id: request.request_id, run_id: request.run_id,
    decision: "approved", subject_ref: "reviewer", roles: ["finance"] }));
  const resume = path => invoke(["--human-resume-checkpoint", path, "--human-decisions-json",
    JSON.stringify({ [original.approval_ref]: { decision: "approved", evidence_ref: "original-evidence" } })]);
  for (const mutate of [cp => { cp.values["value:invoice"].amount = 9000; }, cp => { cp.effect_state.next_effect_index++; }]) {
    const copy = structuredClone(original); mutate(copy); writeFileSync(altered, JSON.stringify(copy));
    assert.equal(resume(altered).reason, "HumanApprovalCheckpointIntegrityMismatch");
    assert.equal(existsSync(join(root, "payments.jsonl")), false);
  }
  assert.equal(resume(checkpoint).status, "success");
  assert.equal(resume(checkpoint).reason, "HumanApprovalCheckpointAlreadyConsumed");
  const replay = structuredClone(original); replay.effect_state.next_effect_index++;
  writeFileSync(altered, JSON.stringify(replay));
  assert.equal(resume(altered).reason, "HumanApprovalCheckpointIntegrityMismatch");
  assert.deepEqual(readFileSync(join(root, "payments.jsonl"), "utf8").trim().split("\n").map(JSON.parse), [{ id: "synthetic-only", amount: 100 }]);
});
