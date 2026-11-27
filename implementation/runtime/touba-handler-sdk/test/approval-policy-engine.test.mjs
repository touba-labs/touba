import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ToubaEngine } from "../src/index.mjs";

const cli = fileURLToPath(new URL("../../../cli/touba-project/src/main.mjs", import.meta.url));

for (const [page, marker] of [
  ["validation-avant-effet-externe", "APPROVAL_GRANTS_AND_SINGLE_ACQUIRED_WRITE_OK"],
  ["orchestration-multi-agent-sequentielle", "THREE_AGENTS_APPROVAL_SCOPES_AND_ONE_ACQUIRED_WRITE_OK"],
]) test(`the ${page} example refuses checkpoint replay with a single acquired effect`, t => {
  const root = mkdtempSync(join(tmpdir(), "touba-approval-effect-tutorial-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(new URL(`./fixtures/approval-examples/${page}/`, import.meta.url), root, { recursive: true });
  mkdirSync(join(root, "node_modules/@touba"), { recursive: true });
  symlinkSync(fileURLToPath(new URL("../", import.meta.url)), join(root, "node_modules/@touba/sdk"), "junction");
  const options = { cwd: root, encoding: "utf8", timeout: 30000 };
  execFileSync(process.execPath, ["configure.mjs"], options);
  assert.ok(execFileSync(process.execPath, ["exercise.mjs", cli], options).includes(marker));
});

test("the roles example compiles and executes its host evidence and refusal example", t => {
  const root = mkdtempSync(join(tmpdir(), "touba-approval-tutorial-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(new URL("./fixtures/approval-examples/approbations-roles-delais/", import.meta.url), root, { recursive: true });
  const options = { cwd: root, encoding: "utf8", timeout: 30000 };
  execFileSync(process.execPath, [cli, "compile", "approval.tb", "--out", "approval.air.json"], options);
  assert.match(execFileSync(process.execPath, ["exercise.mjs", cli], options), /APPROVAL_ROLE_AND_RESUME_OK/);
});

for (const executionMode of ["process", "persistent"]) test(`Engine (${executionMode}) consumes host-attested evidence, not client identity claims`, async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-approval-policy-sdk-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = new URL("../../../grammar/tree-sitter-touba/examples/human-approval-v1/positive/approval-policy.tb", import.meta.url);
  writeFileSync(join(root, "source.tb"), readFileSync(fixture));
  writeFileSync(join(root, "authority.mjs"), `import { readFileSync } from "node:fs";
export const initiatorRef = "employee:initiator";
export function attestHumanApproval({request, decision, evidenceRef}) {
  const records = JSON.parse(readFileSync(new URL("./evidence.json", import.meta.url)));
  const record = records[evidenceRef];
  if (!record || record.request_id !== request.request_id || record.run_id !== request.run_id || record.decision !== decision) throw new Error("Evidence not bound to request");
  return record;
}
`);
  const marker = join(root, "committed.txt");
  writeFileSync(join(root, "handler.mjs"), `import { writeFileSync } from "node:fs";
let raw = ""; for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw); writeFileSync(${JSON.stringify(marker)}, request.arguments.value);
process.stdout.write(JSON.stringify({ok:true,value:request.arguments.value,effect_receipt:{
  effect_id:request.effect.effect_id,request_digest:request.effect.request_digest,outcome:"applied"}}));
`);
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: {
    "tool:approval_policy/Commit": { handler: { kind: "process", command: process.execPath, args: [join(root, "handler.mjs")] },
      grants: [], timeout_ms: 2000, max_payload_bytes: 65536, effect_contract: { kind: "external_write", retry_mode: "none" } },
  } }));
  const engine = new ToubaEngine({ executionMode, projectRoot: root, command: process.execPath,
    commandArgs: [cli] });
  const options = { source: "source.tb", entryRef: "strategy:approval_policy/ApproveTwice", manifest: "manifest.json",
    humanApprovalHost: "authority.mjs", humanApprovalAuthorityTimeoutMs: 12000,
    humanCheckpointOut: "waiting.json", effectJournal: "run.effect-journal.sqlite" };
  assert.equal((await engine.run({ ...options, inputs: { dossier: "invoice" } })).reason, "human_approval_pending");
  for (const signer of ["employee:one", "employee:two"]) {
    const checkpoint = JSON.parse(readFileSync(join(root, "waiting.json")));
    await assert.rejects(engine.run({ ...options, humanResumeCheckpoint: "waiting.json", humanDecisions: {
      [checkpoint.approval_ref]: { decision: "approved", roles: ["finance"], subject_ref: signer },
    } }), error => error.details.reason === "HumanApprovalEvidenceRequired");
    assert.equal(existsSync(marker), false);
    const request = checkpoint.approval_state.requests[checkpoint.approval_ref];
    writeFileSync(join(root, "evidence.json"), JSON.stringify({ receipt: { request_id: request.request_id, run_id: request.run_id,
      decision: "approved", subject_ref: signer, roles: ["finance"] } }));
    const result = await engine.run({ ...options, humanResumeCheckpoint: "waiting.json", humanDecisions: {
      [checkpoint.approval_ref]: { decision: "approved", evidence_ref: "receipt" },
    } });
    assert.equal(result.status, signer === "employee:one" ? "stopped" : "success");
  }
  assert.equal(readFileSync(marker, "utf8"), "invoice");
  const completed = JSON.parse(readFileSync(join(root, "waiting.json")));
  await assert.rejects(engine.run({ ...options, humanResumeCheckpoint: "waiting.json", humanDecisions: {
    [completed.approval_ref]: { decision: "approved", evidence_ref: "receipt" },
  } }), error => error.details.reason === "HumanApprovalCheckpointAlreadyConsumed");
  assert.equal(readFileSync(marker, "utf8"), "invoice");
  await engine.close();
});
