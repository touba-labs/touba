import { executeAirDocument } from "../../runtime/touba-runtime/src/index.mjs";

export default {
  name: "touba-runtime-principal-v1",
  async runCase(document, entryRef) {
    const result = await executeAirDocument(document, { entryRef });
    return runtimeObservation(result);
  },
};

function runtimeObservation(result) {
  const failure = result.trace.events.find((event) => event.kind === "failure_detected")?.payload;
  return {
    status: result.status,
    result: result.result,
    failure_code: failure?.runtime_error_code ?? null,
    failure_family: failure?.failure_family ?? null,
    essential_events: result.trace.events
      .map((event) => event.kind)
      .filter((kind) => ["run_started", "scope_entered", "scope_exited", "failure_detected", "run_completed"].includes(kind)),
  };
}
