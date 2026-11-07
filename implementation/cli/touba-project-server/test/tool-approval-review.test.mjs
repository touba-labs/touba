import assert from "node:assert/strict";
import test from "node:test";
import { toolApprovalReview, validateParallelApprovalMetadata } from "../src/tool-approval-review.mjs";
import { issuePackageAdmission } from "../../../contracts/package-admission.mjs";
import { canonicalDigest } from "../../../runtime/touba-runtime/src/execution-checkpoints.mjs";
import { validateObject } from "../../../contracts/product-surfaces/validate.mjs";
import schema from "../../../contracts/product-surfaces/schemas/touba-approval-request-v1.schema.json" with { type: "json" };
import baseRequest from "../../../contracts/product-surfaces/fixtures/valid/touba-approval-request-v1.json" with { type: "json" };

const ref = "tool:example.records/Export", digest = canonicalDigest("fixture");
function fixture() {
  const request = { request_id: "human:one", review_context: { operation: {
    tool_ref: ref, run_id: "run:one", caller_ref: "strategy:client/Run", agent_ref: "agent:client/Clerk",
    arguments: { customer: "private-customer", amount: 42, password: "not-for-display" },
  } } };
  return { checkpoint: { run_id: "run:one", approval_ref: "approval:one", required_by_ref: ref,
    approval_state: { requests: { "approval:one": request }, receipts: [] } },
  admission: { document: { definitions: { tools: [{ id: ref, approval_policy: { role: "reviewer" } }] } },
    toolBindingManifest: { bindings: new Map([[ref, { approvalPolicy: { role: "reviewer" } }]]) },
    packageAdmission: issuePackageAdmission({ package_lock_digest: digest, manifest_digest: digest,
      packages: [{ name: "example.records", version: "0.1.0", digest, tools: [ref], private_path: "/private/path" }] }),
  } };
}

test("tool review projects admitted version, policy origin and exact occurrence without arguments or private host data", () => {
  const f = fixture(), projected = toolApprovalReview(f.checkpoint, f.admission);
  assert.deepEqual(validateObject(schema, { ...baseRequest, tool_operation: projected }), []);
  assert.equal(projected.policy_origin, "source_and_consumer");
  assert.equal(projected.package.version, "0.1.0");
  assert.equal(projected.package.lock_digest, digest);
  assert.equal(projected.agent_ref, "agent:client/Clerk");
  assert.doesNotMatch(JSON.stringify(projected), /private-customer|not-for-display|private_path|\/private\/path|"amount"/);
  const request = f.checkpoint.approval_state.requests["approval:one"];
  request.review_context.operation.arguments.amount++;
  const changed = toolApprovalReview(f.checkpoint, f.admission);
  assert.notEqual(projected.operation_digest, changed.operation_digest);
  assert.notEqual(projected.arguments_digest, changed.arguments_digest);
  request.request_id = "human:two";
  assert.notEqual(changed.arguments_digest, toolApprovalReview(f.checkpoint, f.admission).arguments_digest);
});

test("tool review distinguishes source and retained consumer policy; ordinary checkpoints stay unchanged", () => {
  const f = fixture();
  delete f.admission.document.definitions.tools[0].approval_policy;
  assert.equal(toolApprovalReview(f.checkpoint, f.admission).policy_origin, "consumer");
  f.admission.document.definitions.tools[0].approval_policy = {};
  f.admission.toolBindingManifest.bindings.clear();
  assert.equal(toolApprovalReview(f.checkpoint, f.admission).policy_origin, "source");
  delete f.admission.document.definitions.tools[0].approval_policy;
  assert.throws(() => toolApprovalReview(f.checkpoint, f.admission), { code: "ToubaServePendingHumanRequestInvalid" });
  assert.equal(toolApprovalReview({}), undefined);
  assert.deepEqual(validateObject(schema, baseRequest), []);
});

test("signers are runtime-receipt pseudonyms, bounded and never fabricated for pending or rejected decisions", () => {
  const f = fixture();
  f.checkpoint.approval_state.receipts = Array.from({ length: 10 }, (_, i) => ({
    subject_ref: `private:person:${i}`, decision: "approved", accepted_at: "2026-11-06T12:00:00.000Z",
    attested_roles: Array.from({ length: 10 }, (_, n) => `role${n}`),
  }));
  f.checkpoint.approval_state.receipts.push({ subject_ref: "private:rejected", decision: "rejected" });
  const result = toolApprovalReview(f.checkpoint, f.admission);
  assert.deepEqual(validateObject(schema, { ...baseRequest, tool_operation: result }), []);
  assert.equal(result.prior_signers.length, 8);
  assert.equal(result.prior_signers_truncated, true);
  assert.equal(result.prior_signers[0].roles.length, 8);
  assert.equal(result.prior_signers[0].roles_truncated, true);
  assert.equal(result.prior_signers[0].signer_ref, canonicalDigest({ run_id: "run:one", subject_ref: "private:person:2" }));
  assert.doesNotMatch(JSON.stringify(result), /private:person|private:rejected/);
});

test("projection rejects mismatched execution and forged package admission", () => {
  const f = fixture();
  f.checkpoint.run_id = "run:other";
  assert.throws(() => toolApprovalReview(f.checkpoint, f.admission), { code: "ToubaServePendingHumanRequestInvalid" });
  f.checkpoint.run_id = "run:one";
  assert.throws(() => toolApprovalReview(f.checkpoint, { ...f.admission, packageAdmission: {} }), { code: "PackageAdmissionInvalid" });
});

test("parallel metadata matches the selected occurrence and its saved approval state", () => {
  const f = fixture(), checkpoint = f.checkpoint;
  checkpoint.kind = "parallel_group";
  delete checkpoint.required_by_ref;
  checkpoint.operation = structuredClone(checkpoint.approval_state.requests[checkpoint.approval_ref].review_context.operation);
  checkpoint.approval_policy = { role: "reviewer" };
  checkpoint.approval_state.requests[checkpoint.approval_ref].policy = { role: "reviewer" };
  checkpoint.pending_approvals = [{ approval_ref: checkpoint.approval_ref, caller_ref: ref,
    operation: structuredClone(checkpoint.operation), approval_policy: { role: "reviewer" } }];
  validateParallelApprovalMetadata(checkpoint);
  assert.equal(toolApprovalReview(checkpoint, f.admission).tool_ref, ref);
  for (const mutate of [c => c.operation.arguments.amount++, c => delete c.approval_policy,
    c => c.pending_approvals[0].approval_ref = 'foreign', c => c.pending_approvals = {},
    c => { c.operation.arguments.amount++; c.pending_approvals[0].operation.arguments.amount++; }]) {
    const changed = structuredClone(checkpoint); mutate(changed);
    assert.throws(() => validateParallelApprovalMetadata(changed), { code: "ToubaServeSandboxCheckpointStoreInvalid" });
  }
});

test("canonical request refuses additional argument values, malformed fingerprints and unbounded review metadata", () => {
  const f = fixture(), original = toolApprovalReview(f.checkpoint, f.admission);
  for (const mutate of [r => r.arguments = { password: "hidden" }, r => r.operation_digest = "bad", r => r.package.name = "x".repeat(257),
    r => r.prior_signers = Array(9).fill({}), r => r.policy_origin = "browser"]) {
    const r = structuredClone(original); mutate(r);
    assert.ok(validateObject(schema, { ...baseRequest, tool_operation: r }).length);
  }
});
