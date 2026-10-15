import { randomUUID } from "node:crypto";
import { TRACE_PROTOCOL_VERSION, TRACE_CAPABILITY_PROFILE, validateTraceMachineContract } from "../../../contracts/machine/contracts.mjs";

// Only controlled stage/code identifiers belong here. No exception messages,
// paths, caller inputs or unvalidated AIR identifiers are retained.
export function createAdmissionRefusalTrace(code, stage) {
  const runId = `admission:${randomUUID()}`;
  return validateTraceMachineContract({
    trace_protocol_version: TRACE_PROTOCOL_VERSION,
    trace_capability_profile: TRACE_CAPABILITY_PROFILE,
    run: { run_id: runId, admission: "refused", air_schema_version: null, air_digest: null, module_ref: null, entry_ref: null },
    events: [{ event_id: `event:${runId}:1`, run_id: runId, sequence_index: 0,
      kind: "admission_refused", payload: { code, stage } }],
  });
}
