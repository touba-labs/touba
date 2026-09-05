#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  AIR_CAPABILITY_PROFILE, AIR_JSON_PROFILE, AIR_SCHEMA_VERSION,
  TRACE_CAPABILITY_PROFILE, TRACE_PROTOCOL_VERSION,
  failureFamilyForRuntimeCode, validateAirMachineContract, validateTraceMachineContract,
} from "../machine/contracts.mjs";

export function migrateMachineArtifact(input) {
  const source = structuredClone(input);
  if (source?.air_schema_version !== undefined) return migrateAir(source);
  if (source?.trace_protocol_version !== undefined) return migrateTrace(source);
  throw migrationError("MigrationArtifactUnknown", "artifact is neither AIR nor trace");
}

function migrateAir(air) {
  if (air.air_schema_version === AIR_SCHEMA_VERSION) {
    validateAirMachineContract(air);
    return report("air", air, [], false);
  }
  if (air.air_schema_version !== "air-minimal-v0.1") {
    throw migrationError("MigrationSourceVersionUnsupported", `unsupported AIR source ${air.air_schema_version}`);
  }
  rejectMandatoryExtensions(air);
  air.air_schema_version = AIR_SCHEMA_VERSION;
  air.air_capability_profile = AIR_CAPABILITY_PROFILE;
  air.air_json_profile = AIR_JSON_PROFILE;
  validateAirMachineContract(air);
  return report("air", air, [
    "renamed air_schema_version",
    "declared explicit AIR capability profile",
    "declared canonical JSON profile",
  ], false);
}

function migrateTrace(trace) {
  if (trace.trace_protocol_version === TRACE_PROTOCOL_VERSION) {
    validateTraceMachineContract(trace);
    return report("trace", trace, [], false);
  }
  if (trace.trace_protocol_version !== "trace-minimal-v0.1") {
    throw migrationError("MigrationSourceVersionUnsupported", `unsupported trace source ${trace.trace_protocol_version}`);
  }
  rejectMandatoryExtensions(trace);
  trace.trace_protocol_version = TRACE_PROTOCOL_VERSION;
  trace.trace_capability_profile = TRACE_CAPABILITY_PROFILE;
  const changes = ["renamed trace_protocol_version", "declared explicit trace capability profile"];
  for (const event of trace.events ?? []) {
    if (event.kind === "failure_detected" && event.payload?.failure_family === undefined) {
      event.payload.failure_family = failureFamilyForRuntimeCode(
        event.payload.runtime_error_code, event.payload.failure_mode,
      );
      changes.push("classified legacy failure_detected event");
    }
  }
  validateTraceMachineContract(trace);
  return report("trace", trace, [...new Set(changes)], changes.includes("classified legacy failure_detected event"));
}

function rejectMandatoryExtensions(value) {
  if (value.required_extensions !== undefined || value.required_extension !== undefined) {
    throw migrationError("MigrationMandatoryExtensionUnsupported", "legacy mandatory extensions cannot be inferred");
  }
}

function report(kind, artifact, changes, semanticReviewRequired) {
  return {
    schema_version: "touba-machine-migration-report-v1", kind,
    target_version: kind === "air" ? AIR_SCHEMA_VERSION : TRACE_PROTOCOL_VERSION,
    changes, semantic_review_required: semanticReviewRequired, artifact,
  };
}

function migrationError(code, message) {
  return Object.assign(new Error(message), { name: "MachineMigrationError", code });
}

async function main() {
  const inputIndex = process.argv.indexOf("--input");
  const outputIndex = process.argv.indexOf("--output");
  if (inputIndex < 0 || outputIndex < 0) throw migrationError("MigrationUsageInvalid", "use --input FILE --output FILE");
  if (process.argv.includes("--downgrade")) throw migrationError("MigrationDangerousDowngradeRefused", "downgrade is not supported");
  const result = migrateMachineArtifact(JSON.parse(await readFile(process.argv[inputIndex + 1], "utf8")));
  await writeFile(process.argv[outputIndex + 1], `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ status: "success", changes: result.changes })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "failure", code: error.code ?? "MigrationFailed", message: error.message })}\n`);
    process.exitCode = 1;
  });
}
