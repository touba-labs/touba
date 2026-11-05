import { createAdmissionRefusalTrace } from "../../../runtime/touba-runtime/src/admission-trace.mjs";
import { publicRunResult } from "../../../contracts/run-outcome.mjs";

const PROJECT_ADMISSION_CODES = new Set(["ProjectEntrypointNotAllowed", "ProjectEntrypointsInvalid"]);

// Shared by the CLI and persistent Engine. Never serialize exception messages,
// private paths or arbitrary error codes across the SDK boundary.
export function projectAdmissionFailure(error) {
  if (!(error instanceof Error) || !PROJECT_ADMISSION_CODES.has(error.code)) return null;
  return publicRunResult({ status: "failure", reason: error.code, result: null, messages: [],
    trace: createAdmissionRefusalTrace(error.code, "project_entry") });
}

export function requestsJsonRunOutput(args) {
  let mode;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--output") mode = args[++index];
    else if (args[index].startsWith("--output=")) mode = args[index].slice("--output=".length);
  }
  return mode === "json" || mode === "json-reference";
}
