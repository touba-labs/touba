import { canonicalDigest } from "../../../runtime/touba-runtime/src/execution-checkpoints.mjs";
import { packageAdmissionEvidence } from "../../../contracts/package-admission.mjs";

export const PARALLEL_APPROVAL_METADATA_FIELDS = ["approval_policy", "operation", "expiration_branch", "rejection_branch"];

export function validateParallelApprovalMetadata(checkpoint) {
  const fail = () => { throw Object.assign(new Error("parallel approval metadata differs from its bound occurrence"), { code: "ToubaServeSandboxCheckpointStoreInvalid" }); };
  const selected = Array.isArray(checkpoint.pending_approvals)
    ? checkpoint.pending_approvals.find(item => item?.approval_ref === checkpoint.approval_ref) : undefined;
  for (const field of PARALLEL_APPROVAL_METADATA_FIELDS) {
    if (Object.hasOwn(checkpoint, field) !== Object.hasOwn(selected ?? {}, field)) fail();
    if (Object.hasOwn(checkpoint, field) && canonicalDigest(checkpoint[field]) !== canonicalDigest(selected[field])) fail();
  }
  const request = checkpoint.approval_state?.requests?.[checkpoint.approval_ref];
  if (checkpoint.operation !== undefined && (!request?.review_context?.operation
    || canonicalDigest(checkpoint.operation) !== canonicalDigest(request.review_context.operation))) fail();
  if (checkpoint.approval_policy !== undefined && (!request?.policy
    || canonicalDigest(checkpoint.approval_policy) !== canonicalDigest(request.policy))) fail();
  for (const field of ["expiration_branch", "rejection_branch"]) if (checkpoint[field] !== undefined && checkpoint[field] !== true) fail();
}

// A read-only projection of the runtime's bound occurrence and the exact host
// admission used for this run. Never accepts browser-supplied policy/evidence.
export function toolApprovalReview(checkpoint, { document, toolBindingManifest, packageAdmission } = {}) {
  const request = checkpoint.approval_state?.requests?.[checkpoint.approval_ref];
  const operation = request?.review_context?.operation;
  if (!operation) return undefined; // Existing continuation checkpoints stay compatible.
  const tool = document?.definitions?.tools?.find(item => item.id === operation.tool_ref);
  const owner = checkpoint.kind === "parallel_group"
    ? checkpoint.pending_approvals?.find(item => item.approval_ref === checkpoint.approval_ref)?.caller_ref
    : checkpoint.required_by_ref;
  if (!tool || operation.run_id !== checkpoint.run_id || owner !== tool.id) {
    throw Object.assign(new Error("tool approval context does not match its execution"), { code: "ToubaServePendingHumanRequestInvalid" });
  }
  const source = Object.hasOwn(tool, "approval_policy");
  const consumer = toolBindingManifest?.bindings?.get(tool.id)?.approvalPolicy !== undefined;
  if (!source && !consumer) throw Object.assign(new Error("tool approval policy is missing"), { code: "ToubaServePendingHumanRequestInvalid" });
  const admission = packageAdmissionEvidence(packageAdmission);
  const pkg = admission?.packages.find(item => item.tools.includes(tool.id));
  const receipts = (checkpoint.approval_state.receipts ?? []).filter(item => item.subject_ref && item.decision === "approved");
  return {
    tool_ref: tool.id,
    caller_ref: operation.caller_ref ?? null,
    agent_ref: operation.agent_ref ?? null,
    policy_origin: source ? consumer ? "source_and_consumer" : "source" : "consumer",
    operation_digest: canonicalDigest(operation),
    // Scope the commitment to this occurrence; do not publish an unsalted
    // hash of a low-entropy business value or any raw argument value.
    arguments_digest: canonicalDigest({ run_id: checkpoint.run_id, request_id: request.request_id, arguments: operation.arguments }),
    ...(pkg ? { package: {
      name: pkg.name, version: pkg.version, digest: pkg.digest,
      admission_id: admission.admission_id,
      lock_digest: admission.package_lock_digest,
      manifest_digest: admission.manifest_digest,
    } } : {}),
    prior_signers: receipts.slice(-8).map(receipt => ({
      signer_ref: canonicalDigest({ run_id: checkpoint.run_id, subject_ref: receipt.subject_ref }),
      accepted_at: receipt.accepted_at,
      roles: receipt.attested_roles.slice(0, 8),
      roles_truncated: receipt.attested_roles.length > 8,
    })),
    prior_signers_truncated: receipts.length > 8,
  };
}
