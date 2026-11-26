import { readFileSync } from "node:fs";

export const initiatorRef = "employee:requester";

export function attestHumanApproval({ request, decision, evidenceRef }) {
  // Local teaching adapter: these files are written only by the trusted host.
  const evidence = JSON.parse(readFileSync(new URL("./host-evidence.json", import.meta.url), "utf8"));
  const directory = JSON.parse(readFileSync(new URL("./host-directory.json", import.meta.url), "utf8"));
  if (evidence.id !== evidenceRef || evidence.request_id !== request.request_id
    || evidence.run_id !== request.run_id || evidence.decision !== decision) {
    throw new Error("Evidence does not match the current request");
  }
  const roles = directory[evidence.subject_ref];
  if (!Array.isArray(roles)) throw new Error("Signer is not active");
  return { request_id: request.request_id, run_id: request.run_id, decision,
    subject_ref: evidence.subject_ref, roles };
}
