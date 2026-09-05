#!/usr/bin/env node

import {
  existsSync as defaultExistsSync,
  readFileSync as defaultReadFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_PLAN_SCHEMA_VERSION = "touba-action-plan-v0.1";
export const VALIDATION_SCHEMA_VERSION = "touba-action-plan-validation-v0.1";

const EXPECTED_AIR_SCHEMA_VERSION = "touba-air-v1";
const EXPECTED_MANIFEST_VERSION = "touba-manifest-v1";
const EXPECTED_TRACE_PROTOCOL_VERSION = "touba-trace-v1";

const ALLOWED_ACTIONS = new Set([
  "AddMemory",
  "GrantMemoryScope",
  "CreateMemoryAccessTool",
  "BindMemoryBackend",
  "GenerateMemoryHandlerStub",
  "ValidateMemoryAccess",
]);
const ALLOWED_MODES = new Set(["plan", "validate", "apply"]);
const EXECUTABLE_MODES = new Set(["plan", "validate"]);
const MEMORY_ACCESSES = new Set(["read", "write"]);
const ALLOWED_READ_KINDS = new Set(["source", "air", "manifest", "trace", "architecture"]);
const FORBIDDEN_READ_KINDS = new Set([
  "backend",
  "postgres",
  "vector_db",
  "env",
  "secrets",
  "workspace_scan",
  "handler_discovery",
  "filesystem_scan",
]);
const PATCH_WRITE_KINDS = new Set(["source_patch", "manifest_patch", "handler_stub"]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const implementationDir = path.resolve(__dirname, "../../..");
export const repoToubaDir = path.resolve(implementationDir, "..");

const defaultFs = {
  existsSync: defaultExistsSync,
  readFileSync: defaultReadFileSync,
};

export function validateActionPlanDocument(plan, artifacts = {}) {
  const diagnostics = [];
  const action = typeof plan?.action === "string" ? plan.action : "absent";
  const mode = typeof plan?.mode === "string" ? plan.mode : "absent";

  validatePlanShape(plan, diagnostics);
  validateArtifactRequirements(plan, artifacts, diagnostics);
  validateArtifactVersions(artifacts, diagnostics);

  if (action === "ValidateMemoryAccess") {
    validateMemoryAccessPlan(plan, artifacts, diagnostics);
  }

  const status = diagnostics.some((diagnostic) => diagnostic.severity === "error")
    ? "failed"
    : diagnostics.some((diagnostic) => diagnostic.severity === "warning")
      ? "warning"
      : "ok";

  return {
    validation_schema_version: VALIDATION_SCHEMA_VERSION,
    plan_schema_version: plan?.action_plan_schema_version,
    action,
    mode,
    status,
    artifacts: summarizeArtifacts(artifacts),
    diagnostics,
  };
}

export function renderActionPlanValidation(report) {
  const lines = [
    `Touba Action Plan ${report.validation_schema_version}`,
    `Plan ${valueOrAbsent(report.plan_schema_version)} action=${report.action} mode=${report.mode}`,
    `Status ${report.status}`,
    `Artifacts source=${presence(report.artifacts.source)} air=${presence(
      report.artifacts.air,
    )} manifest=${presence(report.artifacts.manifest)} trace=${presence(report.artifacts.trace)}`,
  ];

  if (report.diagnostics.length === 0) {
    lines.push("Diagnostics ok");
  } else {
    lines.push("Diagnostics:");
    for (const diagnostic of report.diagnostics) {
      lines.push(`- ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function loadActionPlanArtifacts(inputPaths, options = {}) {
  const fs = fsAdapter(options);
  const artifacts = {};
  if (inputPaths.source) {
    const sourcePath = path.resolve(inputPaths.source);
    assertExistingFile(sourcePath, fs);
    artifacts.source = {
      kind: "source",
      path: sourcePath,
    };
  }
  if (inputPaths.air) {
    artifacts.air = readJsonArtifact(inputPaths.air, fs);
  }
  if (inputPaths.manifest) {
    artifacts.manifest = readJsonArtifact(inputPaths.manifest, fs);
  }
  if (inputPaths.trace) {
    artifacts.trace = readJsonArtifact(inputPaths.trace, fs);
  }
  return artifacts;
}

export function readActionPlan(planPath, options = {}) {
  return readJsonArtifact(planPath, fsAdapter(options));
}

function validatePlanShape(plan, diagnostics) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    diagnostics.push(error("InvalidActionPlan", "plan root must be a JSON object"));
    return;
  }
  if (plan.action_plan_schema_version !== EXPECTED_PLAN_SCHEMA_VERSION) {
    diagnostics.push(
      error(
        "UnsupportedActionPlanSchema",
        `expected ${EXPECTED_PLAN_SCHEMA_VERSION}, got ${valueOrAbsent(
          plan.action_plan_schema_version,
        )}`,
      ),
    );
  }
  if (!ALLOWED_ACTIONS.has(plan.action)) {
    diagnostics.push(error("UnsupportedAction", `unsupported action ${valueOrAbsent(plan.action)}`));
  }
  if (!ALLOWED_MODES.has(plan.mode)) {
    diagnostics.push(error("UnsupportedMode", `unsupported mode ${valueOrAbsent(plan.mode)}`));
  } else if (!EXECUTABLE_MODES.has(plan.mode)) {
    diagnostics.push(error("ApplyModeUnsupported", "mode apply is reserved and is not executable in this tranche"));
  }
  if (!isPlainObject(plan.inputs)) {
    diagnostics.push(error("InvalidActionPlan", "inputs must be an object"));
  }
  validateReads(plan.reads, diagnostics);
  validateWrites(plan.mode, plan.writes, diagnostics);
}

function validateReads(reads, diagnostics) {
  if (!Array.isArray(reads)) {
    diagnostics.push(error("InvalidActionPlan", "reads must be an array"));
    return;
  }
  for (const read of reads) {
    const kind = read?.kind;
    if (FORBIDDEN_READ_KINDS.has(kind)) {
      diagnostics.push(error("ForbiddenArtifactRead", `read kind ${kind} is forbidden`));
      continue;
    }
    if (!ALLOWED_READ_KINDS.has(kind)) {
      diagnostics.push(error("UnsupportedArtifactRead", `unsupported read kind ${valueOrAbsent(kind)}`));
    }
  }
}

function validateWrites(mode, writes, diagnostics) {
  if (!Array.isArray(writes)) {
    diagnostics.push(error("InvalidActionPlan", "writes must be an array"));
    return;
  }
  for (const write of writes) {
    const kind = write?.kind;
    const effect = write?.effect;
    if (mode === "validate" && PATCH_WRITE_KINDS.has(kind)) {
      diagnostics.push(
        error(
          "WriteIntentUnsupportedInValidateMode",
          `validate mode cannot write ${kind}`,
        ),
      );
    }
    if (mode === "plan" && PATCH_WRITE_KINDS.has(kind) && effect !== "propose") {
      diagnostics.push(
        error(
          "WriteEffectMustBePropose",
          `plan mode write ${kind} must use effect=propose`,
        ),
      );
    }
  }
}

function validateArtifactRequirements(plan, artifacts, diagnostics) {
  if (!isPlainObject(plan?.artifacts)) {
    return;
  }
  for (const [artifactName, requirement] of Object.entries(plan.artifacts)) {
    if (requirement?.required === true && !artifacts[artifactName]) {
      diagnostics.push(error("MissingArtifact", `plan requires artifact ${artifactName}`));
    }
  }
}

function validateArtifactVersions(artifacts, diagnostics) {
  if (artifacts.air && artifacts.air.air_schema_version !== EXPECTED_AIR_SCHEMA_VERSION) {
    diagnostics.push(
      error(
        "AirSchemaMismatch",
        `expected ${EXPECTED_AIR_SCHEMA_VERSION}, got ${valueOrAbsent(
          artifacts.air.air_schema_version,
        )}`,
      ),
    );
  }
  if (
    artifacts.manifest &&
    artifacts.manifest.manifest_version !== EXPECTED_MANIFEST_VERSION
  ) {
    diagnostics.push(
      error(
        "ManifestVersionMismatch",
        `expected ${EXPECTED_MANIFEST_VERSION}, got ${valueOrAbsent(
          artifacts.manifest.manifest_version,
        )}`,
      ),
    );
  }
  if (artifacts.trace && artifacts.trace.trace_protocol_version !== EXPECTED_TRACE_PROTOCOL_VERSION) {
    diagnostics.push(
      error(
        "TraceProtocolMismatch",
        `expected ${EXPECTED_TRACE_PROTOCOL_VERSION}, got ${valueOrAbsent(
          artifacts.trace.trace_protocol_version,
        )}`,
      ),
    );
  }
}

function validateMemoryAccessPlan(plan, artifacts, diagnostics) {
  const inputs = isPlainObject(plan.inputs) ? plan.inputs : {};
  const toolRef = requiredInput(inputs, "tool_ref", diagnostics);
  const memoryRef = requiredInput(inputs, "memory_ref", diagnostics);
  const access = requiredInput(inputs, "access", diagnostics);
  const ownerRef = requiredInput(inputs, "owner_ref", diagnostics);

  if (typeof access === "string" && !MEMORY_ACCESSES.has(access)) {
    diagnostics.push(error("InvalidMemoryAccess", `memory access must be read or write, got ${access}`));
  }
  if (!toolRef || !memoryRef || !access || !ownerRef || !MEMORY_ACCESSES.has(access)) {
    return;
  }

  if (artifacts.air) {
    validateMemoryAccessAgainstAir(artifacts.air, { toolRef, memoryRef, access, ownerRef }, diagnostics);
  }
  if (artifacts.air && artifacts.manifest) {
    validateMemoryAccessAgainstManifest(
      artifacts.air,
      artifacts.manifest,
      { toolRef, memoryRef, access },
      diagnostics,
    );
  }
  const requireProvenance = inputs.require_provenance === true;
  const requireIntegrityEvidence = inputs.require_integrity_evidence === true;
  if ((requireProvenance || requireIntegrityEvidence) && !artifacts.trace) {
    diagnostics.push(error("MissingArtifact", "PI-1 metadata validation requires artifact trace"));
  }
  if (artifacts.trace) {
    validateMemoryAccessAgainstTrace(
      artifacts.trace,
      { toolRef, memoryRef, access },
      { requireProvenance, requireIntegrityEvidence },
      diagnostics,
    );
  }
}

function validateMemoryAccessAgainstAir(air, query, diagnostics) {
  const tool = findById(air.definitions?.tools, query.toolRef);
  const memory = findById(air.definitions?.memories, query.memoryRef);
  const owner = findOwner(air, query.ownerRef);

  if (!tool) {
    diagnostics.push(error("UnknownToolReference", `AIR has no tool ${query.toolRef}`));
  }
  if (!memory) {
    diagnostics.push(error("UnknownMemoryReference", `AIR has no memory ${query.memoryRef}`));
  }
  if (tool && !hasMemoryAccess(tool.memory_accesses, query.memoryRef, query.access)) {
    diagnostics.push(
      error(
        "ToolMemoryAccessMissing",
        `tool ${query.toolRef} does not declare ${query.memoryRef}:${query.access}`,
      ),
    );
  }
  if (!owner) {
    diagnostics.push(error("UnknownOwnerReference", `AIR has no owner ${query.ownerRef}`));
  } else if (!hasMemoryAccess(owner.memory_scopes, query.memoryRef, query.access)) {
    diagnostics.push(
      error(
        "MissingOwnerMemoryScope",
        `owner ${query.ownerRef} lacks ${query.memoryRef}:${query.access}`,
      ),
    );
  }
}

function validateMemoryAccessAgainstManifest(air, manifest, query, diagnostics) {
  const tool = findById(air.definitions?.tools, query.toolRef);
  const binding = manifest.bindings?.[query.toolRef];
  if (!binding) {
    diagnostics.push(error("MissingToolBinding", `manifest has no binding for ${query.toolRef}`));
    return;
  }

  const grants = new Set(Array.isArray(binding.grants) ? binding.grants : []);
  const requiredCapabilities = new Set(Array.isArray(tool?.required_capabilities) ? tool.required_capabilities : []);
  requiredCapabilities.add(query.access === "read" ? "memory_read" : "memory_write");
  for (const capability of requiredCapabilities) {
    if (!grants.has(capability)) {
      diagnostics.push(
        error(
          "MissingToolGrant",
          `binding ${query.toolRef} is missing grant ${capability}`,
        ),
      );
    }
  }

  const bindingMemories = Array.isArray(binding.memories) ? binding.memories : [];
  if (!hasManifestMemoryAccess(bindingMemories, query.memoryRef, query.access)) {
    diagnostics.push(
      error(
        "MissingToolMemoryGrant",
        `binding ${query.toolRef} is missing memory access ${query.memoryRef}:${query.access}`,
      ),
    );
  }
}

function validateMemoryAccessAgainstTrace(trace, query, options, diagnostics) {
  const events = Array.isArray(trace.events) ? trace.events : [];
  const matching = events.filter((event) => traceEventMatchesMemoryAccess(event, query));
  const refused = matching.find((event) => event.kind === "memory_access_refused");
  if (refused) {
    diagnostics.push(
      error(
        "TraceMemoryAccessRefused",
        `trace contains refused memory access ${query.memoryRef}:${query.access} for ${query.toolRef}`,
      ),
    );
    return;
  }
  const authorized = matching.find((event) => event.kind === "memory_access_authorized");
  if (!authorized) {
    diagnostics.push(
      warning(
        "TraceMemoryAccessMissing",
        `trace has no memory access event ${query.memoryRef}:${query.access} for ${query.toolRef}`,
      ),
    );
  }

  const matchingPi1 = events.filter((event) => traceEventMatchesMemoryOperation(event, query));
  const metadataRefused = matchingPi1.find((event) => event.kind === "memory_metadata_refused");
  if (metadataRefused) {
    diagnostics.push(
      error(
        "TraceMemoryMetadataRefused",
        `trace contains refused memory metadata ${query.memoryRef}:${query.access} for ${query.toolRef}`,
      ),
    );
  }
  const integrityRefused = matchingPi1.find((event) => event.kind === "memory_integrity_refused");
  if (integrityRefused) {
    diagnostics.push(
      error(
        "TraceMemoryIntegrityRefused",
        `trace contains refused memory integrity evidence ${query.memoryRef}:${query.access} for ${query.toolRef}`,
      ),
    );
  }
  if (
    options.requireProvenance &&
    !matchingPi1.some((event) => event.kind === "memory_provenance_observed")
  ) {
    diagnostics.push(
      error(
        "TraceMemoryProvenanceMissing",
        `trace has no PI-1 provenance event ${query.memoryRef}:${query.access} for ${query.toolRef}`,
      ),
    );
  }
  if (
    options.requireIntegrityEvidence &&
    !matchingPi1.some((event) => {
      if (event.kind !== "memory_integrity_observed") return false;
      const evidence = event.payload?.integrity_evidence;
      return typeof evidence === "string" && evidence.length > 0 && evidence !== "none";
    })
  ) {
    diagnostics.push(
      error(
        "TraceMemoryIntegrityMissing",
        `trace has no PI-1 integrity evidence ${query.memoryRef}:${query.access} for ${query.toolRef}`,
      ),
    );
  }
}

function requiredInput(inputs, key, diagnostics) {
  const value = inputs[key];
  if (typeof value !== "string" || value.length === 0) {
    diagnostics.push(error("MissingPlanInput", `missing input ${key}`));
    return undefined;
  }
  return value;
}

function findById(values, id) {
  return (Array.isArray(values) ? values : []).find((value) => value?.id === id);
}

function findOwner(air, ownerRef) {
  for (const key of ["skills", "agents", "strategies"]) {
    const owner = findById(air.definitions?.[key], ownerRef);
    if (owner) return owner;
  }
  return undefined;
}

function hasMemoryAccess(accesses, memoryRef, access) {
  return (Array.isArray(accesses) ? accesses : []).some(
    (entry) => entry?.memory_ref === memoryRef && entry?.access === access,
  );
}

function hasManifestMemoryAccess(accesses, memoryRef, access) {
  return accesses.some(
    (entry) => (entry?.ref ?? entry?.memory_ref) === memoryRef && entry?.access === access,
  );
}

function traceEventMatchesMemoryAccess(event, query) {
  if (event?.kind !== "memory_access_authorized" && event?.kind !== "memory_access_refused") {
    return false;
  }
  const payload = event.payload ?? {};
  return (
    payload.tool_ref === query.toolRef &&
    payload.memory_ref === query.memoryRef &&
    payload.access === query.access
  );
}

function traceEventMatchesMemoryOperation(event, query) {
  if (
    event?.kind !== "memory_provenance_observed" &&
    event?.kind !== "memory_integrity_observed" &&
    event?.kind !== "memory_metadata_refused" &&
    event?.kind !== "memory_integrity_refused"
  ) {
    return false;
  }
  const payload = event.payload ?? {};
  return (
    payload.tool_ref === query.toolRef &&
    payload.memory_ref === query.memoryRef &&
    payload.operation === query.access
  );
}

function readJsonArtifact(inputPath, fs = defaultFs) {
  const absolutePath = path.resolve(inputPath);
  assertExistingFile(absolutePath, fs);
  try {
    return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(`invalid JSON artifact ${absolutePath}: ${error.message}`);
  }
}

function assertExistingFile(absolutePath, fs) {
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`input not found: ${absolutePath}`);
  }
}

function summarizeArtifacts(artifacts) {
  return {
    source: artifacts.source
      ? { present: true, path: artifacts.source.path }
      : { present: false },
    air: artifacts.air
      ? { present: true, schema_version: artifacts.air.air_schema_version }
      : { present: false },
    manifest: artifacts.manifest
      ? { present: true, manifest_version: artifacts.manifest.manifest_version }
      : { present: false },
    trace: artifacts.trace
      ? { present: true, protocol_version: artifacts.trace.trace_protocol_version }
      : { present: false },
  };
}

function parseArgs(args) {
  const paths = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      return { mode: "help" };
    }
    if (["--plan", "--source", "--air", "--manifest", "--trace"].includes(arg)) {
      const optionName = arg.slice(2);
      if (paths[optionName]) {
        throw new Error(`duplicate option: ${arg}`);
      }
      const value = args[index + 1];
      if (!value) {
        throw new Error(`missing value for option: ${arg}`);
      }
      paths[optionName] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  if (!paths.plan) {
    throw new Error("--plan is required");
  }
  return { mode: "validate", paths };
}

function usage() {
  return [
    "usage: touba-action-plan --plan <plan.json> [--source <file.tb>] [--air <file.air.json>] [--manifest <touba.manifest.json>] [--trace <file.trace.json>]",
    "",
  ].join("\n");
}

function error(code, message) {
  return { severity: "error", code, message };
}

function warning(code, message) {
  return { severity: "warning", code, message };
}

function presence(artifact) {
  return artifact?.present ? "present" : "absent";
}

function valueOrAbsent(value) {
  return value ?? "absent";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fsAdapter(options) {
  return options.fs ?? defaultFs;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(usage());
    process.exit(2);
  }
  if (parsed.mode === "help") {
    process.stdout.write(usage());
    process.exit(0);
  }

  try {
    const plan = readActionPlan(parsed.paths.plan);
    const artifacts = loadActionPlanArtifacts(parsed.paths);
    const report = validateActionPlanDocument(plan, artifacts);
    process.stdout.write(renderActionPlanValidation(report));
    process.exit(report.status === "failed" ? 1 : 0);
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

if (path.resolve(process.argv[1] ?? "") === __filename) {
  await main();
}
