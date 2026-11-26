import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

function run(args, expectedExit) {
  const child = spawnSync("touba", ["run", "approval.air.json", "--entry",
    "strategy:examples.approval_roles/ApproveInvoice",
    "--human-approval-host", "host.mjs", "--output", "json", ...args], { encoding: "utf8" });
  assert.equal(child.status, expectedExit, child.stdout + child.stderr);
  return JSON.parse(child.stdout);
}
function save(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}
const paused = run(["--inputs-json", JSON.stringify({ invoice: "Invoice INV-42" }),
  "--human-checkpoint-out", "approval.checkpoint.json"], 3);
assert.equal(paused.reason, "human_approval_pending");
const checkpoint = JSON.parse(readFileSync("approval.checkpoint.json", "utf8"));
const request = checkpoint.approval_state.requests[checkpoint.approval_ref];
save("host-evidence.json", { id: "signed-decision:42", request_id: request.request_id,
  run_id: request.run_id, decision: "approved", subject_ref: "employee:reviewer" });
save("decisions.json", { [checkpoint.approval_ref]: {
  decision: "approved", evidence_ref: "signed-decision:42" } });
const resume = ["--human-resume-checkpoint", "approval.checkpoint.json",
  "--human-decisions", "decisions.json"];
save("host-directory.json", { "employee:reviewer": [] });
assert.equal(run(resume, 1).reason, "HumanApprovalRoleRequired");
save("host-directory.json", { "employee:reviewer": ["finance"] });
const accepted = run(resume, 0);
assert.equal(accepted.result, "Accepted by finance");
assert.ok(!JSON.stringify(accepted.trace).includes("employee:reviewer"));
console.log("APPROVAL_ROLE_AND_RESUME_OK");
