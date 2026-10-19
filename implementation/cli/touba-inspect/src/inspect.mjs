#!/usr/bin/env node

import { execFileSync as defaultExecFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync as defaultExistsSync,
  mkdirSync as defaultMkdirSync,
  readFileSync as defaultReadFileSync,
  writeFileSync as defaultWriteFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  effectContractToJson,
  normalizeEffectContract,
  TOUBA_MANIFEST_V1,
  validateManifestEffectContracts,
} from "../../touba-manifest/src/effect-contract.mjs";
import { buildAirInputContract } from "../../../contracts/product-surfaces/input-contracts.mjs";

export const INSPECT_ABSENT_DATA = [
  "policies",
  "permissions",
  "costs",
  "risks",
  "confidence",
  "memory contents backends",
  "memory trust scores",
  "human approver identity",
  "provider token metering",
  "distributed budget quotas",
  "trace audit legal proof artifacts",
  "supply chain cryptographic proofs",
  "supply chain registries",
  "host code contents",
  "dependency vulnerability audit",
  "dependency graph resolution",
  "runtime lock enforcement",
  "end-to-end verification labels",
  "external adapters",
  "free code generation",
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const implementationDir = path.resolve(__dirname, "../../..");
const cargoManifest = path.join(implementationDir, "Cargo.toml");
const EXPECTED_AIR_SCHEMA_VERSION = "touba-air-v1";
const EXPECTED_TRACE_PROTOCOL_VERSION = "touba-trace-v1";
const EXPECTED_ARCHITECTURE_SCHEMA_VERSION = "architecture-projection-v1";
const SUPPORTED_MANIFEST_VERSIONS = new Set([
  TOUBA_MANIFEST_V1,
]);
const EXPECTED_PACKAGE_SCHEMA_VERSION = "touba-package-v1";
const EXPECTED_BINDING_FRAGMENT_SCHEMA_VERSION = "touba-binding-fragment-v1";
const EXPECTED_RESOURCE_BINDINGS_SCHEMA_VERSION = "touba-resource-bindings-v1";
const EXPECTED_RUN_PLAN_SCHEMA_VERSION = "touba-run-plan-v1";
const EXPECTED_OWNERSHIP_SCHEMA_VERSION = "touba-ownership-v1";
const EXPECTED_TRACE_AUDIT_SCHEMA_VERSION = "trace-audit-v1";
const EXPECTED_TRACE_AUDIT_VALIDATION_SCHEMA_VERSION = "trace-audit-validation-v1";
const EXPECTED_TRACE_AUDIT_EXPORT_SCHEMA_VERSION = "trace-audit-export-v1-local";
const EXPECTED_TRACE_TIMELINE_SCHEMA_VERSION = "touba-trace-timeline-v1";
const EXPECTED_SUPPLY_CHAIN_LOCK_SCHEMA_VERSION = "touba-lock-v1";
const EXPECTED_SUPPLY_CHAIN_VALIDATION_SCHEMA_VERSION = "touba-supply-chain-validation-v1";
const EXPECTED_TRIGGER_STATE_SCHEMA_VERSION = "touba-trigger-state-v1";
const EXPECTED_EFFECTIVE_PROJECT_SCHEMA_VERSION = "touba-effective-project-v1";
const INSPECT_REPORT_SUFFIX = ".inspect.txt";
const OTEL_EXPORT_SUFFIX = ".otel.json";
const OTEL_SEMCONV_SCHEMA_URL = "https://opentelemetry.io/schemas/1.41.1";
const SAFE_OTEL_PAYLOAD_KEYS = new Set([
  "action",
  "agent_ref",
  "approx_size_bytes",
  "budget_kind",
  "budget_max_bytes",
  "budget_ref",
  "call_ref",
  "capability_count",
  "content_mode",
  "consumed_bytes",
  "event_ref",
  "external_content_count",
  "input_ref",
  "interaction_ref",
  "memory_ref",
  "node_id",
  "observation_count",
  "provider_call_index",
  "provider_kind",
  "provider_mode",
  "provider_name",
  "provider_timeout_ms",
  "provider_version",
  "ref",
  "resource_ref",
  "runtime_error_code",
  "skill_pack_count",
  "skill_pack_ref",
  "source",
  "status",
  "target_ref",
  "tool_ref",
  "trigger_ref",
]);
const defaultFs = {
  existsSync: defaultExistsSync,
  mkdirSync: defaultMkdirSync,
  readFileSync: defaultReadFileSync,
  writeFileSync: defaultWriteFileSync,
};

export function inspectPath(inputPath, options = {}) {
  const absolutePath = path.resolve(inputPath);
  assertExistingFile(absolutePath, options);

  if (absolutePath.endsWith(".tb")) {
    const air = compileToubaSource(absolutePath, options);
    return inspectionDocument(absolutePath, "touba_source", {
      source: summarizeSource(absolutePath, air),
      air: summarizeAir(air),
      trace: absent("trace artifact not provided"),
      architecture: absent("architecture projection not provided"),
      manifest: absent("tool binding manifest not provided"),
      compatibility: compatibilityOk(),
    });
  }

  const artifact = readJsonArtifact(absolutePath, options);
  if (artifact.air_schema_version === EXPECTED_AIR_SCHEMA_VERSION) {
    return inspectionDocument(absolutePath, "air", {
      source: absent("source artifact not provided"),
      air: summarizeAir(artifact),
      trace: absent("trace artifact not provided"),
      architecture: absent("architecture projection not provided"),
      manifest: absent("tool binding manifest not provided"),
      compatibility: compatibilityOk(),
    });
  }

  if (artifact.trace_protocol_version === EXPECTED_TRACE_PROTOCOL_VERSION) {
    return inspectionDocument(absolutePath, "trace", {
      source: absent("source artifact not provided"),
      air: absent("AIR artifact not provided"),
      trace: summarizeTrace(artifact),
      architecture: absent("architecture projection not provided"),
      manifest: absent("tool binding manifest not provided"),
      compatibility: compatibilityOk(),
    });
  }

  if (artifact.projection_schema_version === EXPECTED_ARCHITECTURE_SCHEMA_VERSION) {
    return inspectionDocument(absolutePath, "architecture_projection", {
      source: absent("source artifact not provided"),
      air: absent("AIR artifact not provided"),
      trace: absent("trace artifact not provided"),
      architecture: summarizeArchitecture(artifact),
      manifest: absent("tool binding manifest not provided"),
      compatibility: compatibilityOk(),
    });
  }

  if (SUPPORTED_MANIFEST_VERSIONS.has(artifact.manifest_version)) {
    return inspectionDocument(absolutePath, "tool_binding_manifest", {
      source: absent("source artifact not provided"),
      air: absent("AIR artifact not provided"),
      trace: absent("trace artifact not provided"),
      architecture: absent("architecture projection not provided"),
      manifest: summarizeManifest(artifact),
      package: absent("package artifact not provided"),
      binding_fragment: absent("binding fragment artifact not provided"),
      resource_bindings: absent("resource bindings artifact not provided"),
      run_plan: absent("run plan artifact not provided"),
      trace_audit: absent("trace audit artifact not provided"),
      compatibility: compatibilityOk(),
    });
  }

  if (artifact.package_schema_version === EXPECTED_PACKAGE_SCHEMA_VERSION) {
    return inspectionDocument(absolutePath, "touba_package", {
      source: absent("source artifact not provided"),
      air: absent("AIR artifact not provided"),
      trace: absent("trace artifact not provided"),
      architecture: absent("architecture projection not provided"),
      manifest: absent("tool binding manifest not provided"),
      package: summarizePackage(artifact),
      binding_fragment: absent("binding fragment artifact not provided"),
      resource_bindings: absent("resource bindings artifact not provided"),
      run_plan: absent("run plan artifact not provided"),
      compatibility: compatibilityOk(),
    });
  }

  if (artifact.fragment_schema_version === EXPECTED_BINDING_FRAGMENT_SCHEMA_VERSION) {
    return inspectionDocument(absolutePath, "binding_fragment", {
      source: absent("source artifact not provided"),
      air: absent("AIR artifact not provided"),
      trace: absent("trace artifact not provided"),
      architecture: absent("architecture projection not provided"),
      manifest: absent("tool binding manifest not provided"),
      package: absent("package artifact not provided"),
      binding_fragment: summarizeBindingFragment(artifact),
      resource_bindings: absent("resource bindings artifact not provided"),
      run_plan: absent("run plan artifact not provided"),
      compatibility: compatibilityOk(),
    });
  }

  if (artifact.resource_bindings_schema_version === EXPECTED_RESOURCE_BINDINGS_SCHEMA_VERSION) {
    return inspectionDocument(absolutePath, "resource_bindings", {
      source: absent("source artifact not provided"),
      air: absent("AIR artifact not provided"),
      trace: absent("trace artifact not provided"),
      architecture: absent("architecture projection not provided"),
      manifest: absent("tool binding manifest not provided"),
      package: absent("package artifact not provided"),
      binding_fragment: absent("binding fragment artifact not provided"),
      resource_bindings: summarizeResourceBindings(artifact),
      run_plan: absent("run plan artifact not provided"),
      compatibility: compatibilityOk(),
    });
  }

  if (artifact.run_plan_schema_version === EXPECTED_RUN_PLAN_SCHEMA_VERSION) {
    return inspectionDocument(absolutePath, "run_plan", {
      source: absent("source artifact not provided"),
      air: absent("AIR artifact not provided"),
      trace: absent("trace artifact not provided"),
      architecture: absent("architecture projection not provided"),
      manifest: absent("tool binding manifest not provided"),
      package: absent("package artifact not provided"),
      binding_fragment: absent("binding fragment artifact not provided"),
      resource_bindings: absent("resource bindings artifact not provided"),
      run_plan: summarizeRunPlan(artifact),
      compatibility: compatibilityOk(),
    });
  }

  if (artifact.schema_version === EXPECTED_EFFECTIVE_PROJECT_SCHEMA_VERSION) {
    const effectiveProject = summarizeEffectiveProject(artifact);
    return inspectionDocument(absolutePath, "effective_project", {
      source: absent("source artifact is referenced by the effective projection"),
      air: absent("AIR artifacts are referenced by the effective projection"),
      trace: absent("trace artifact not provided"),
      architecture: absent("architecture projection not provided"),
      manifest: absent("manifest is referenced by the effective projection"),
      effective_project: effectiveProject,
      compatibility: compatibilityOk(),
    });
  }

  if (artifact.ownership_schema_version === EXPECTED_OWNERSHIP_SCHEMA_VERSION) {
    return inspectionDocument(absolutePath, "ownership", {
      source: absent("source artifact not provided"),
      air: absent("AIR artifact not provided"),
      trace: absent("trace artifact not provided"),
      architecture: absent("architecture projection not provided"),
      manifest: absent("tool binding manifest not provided"),
      package: absent("package artifact not provided"),
      binding_fragment: absent("binding fragment artifact not provided"),
      resource_bindings: absent("resource bindings artifact not provided"),
      run_plan: absent("run plan artifact not provided"),
      ownership: summarizeOwnership(artifact),
      compatibility: compatibilityOk(),
    });
  }

  const traceAudit = summarizeTraceAuditArtifact(artifact);
  if (traceAudit.present) {
    return inspectionDocument(absolutePath, traceAudit.artifact_kind, {
      source: absent("source artifact not provided"),
      air: absent("AIR artifact not provided"),
      trace: absent("trace artifact not provided"),
      architecture: absent("architecture projection not provided"),
      manifest: absent("tool binding manifest not provided"),
      trace_audit: traceAudit,
      compatibility: compatibilityOk(),
    });
  }

  const traceTimeline = summarizeTraceTimelineArtifact(artifact);
  if (traceTimeline.present) {
    return inspectionDocument(absolutePath, "trace_timeline", {
      source: absent("source artifact not provided"),
      air: absent("AIR artifact not provided"),
      trace: absent("trace artifact not provided"),
      architecture: absent("architecture projection not provided"),
      manifest: absent("tool binding manifest not provided"),
      trace_timeline: traceTimeline,
      compatibility: compatibilityOk(),
    });
  }

  const supplyChain = summarizeSupplyChainArtifact(artifact);
  if (supplyChain.present) {
    return inspectionDocument(absolutePath, supplyChain.artifact_kind, {
      source: absent("source artifact not provided"),
      air: absent("AIR artifact not provided"),
      trace: absent("trace artifact not provided"),
      architecture: absent("architecture projection not provided"),
      manifest: absent("tool binding manifest not provided"),
      trace_audit: absent("trace audit artifact not provided"),
      supply_chain: supplyChain,
      compatibility: compatibilityOk(),
    });
  }

  const triggerState = summarizeTriggerStateArtifact(artifact);
  if (triggerState.present) {
    return inspectionDocument(absolutePath, "trigger_state", {
      source: absent("source artifact not provided"),
      air: absent("AIR artifact not provided"),
      trace: absent("trace artifact not provided"),
      architecture: absent("architecture projection not provided"),
      manifest: absent("tool binding manifest not provided"),
      trigger_state: triggerState,
      compatibility: compatibilityOk(),
    });
  }

  throw new Error(
    "unsupported Touba artifact: expected .tb, AIR JSON, trace JSON, architecture projection JSON, tool binding manifest JSON, package JSON, binding fragment JSON, resource bindings JSON, run plan JSON, effective project JSON, ownership JSON, trace audit JSON, trace timeline JSON, supply chain JSON or trigger state JSON",
  );
}

export function inspectExplicitArtifacts(inputPaths, options = {}) {
  const sourcePath = optionalResolvedPath(inputPaths.source);
  const airPath = optionalResolvedPath(inputPaths.air);
  const tracePath = optionalResolvedPath(inputPaths.trace);
  const architecturePath = optionalResolvedPath(inputPaths.architecture);
  const manifestPath = optionalResolvedPath(inputPaths.manifest);
  const packagePath = optionalResolvedPath(inputPaths.package);
  const bindingFragmentPath = optionalResolvedPath(inputPaths.binding_fragment);
  const resourceBindingsPath = optionalResolvedPath(inputPaths.resource_bindings);
  const runPlanPath = optionalResolvedPath(inputPaths.run_plan);
  const ownershipPath = optionalResolvedPath(inputPaths.ownership);
  const traceAuditPath = optionalResolvedPath(inputPaths.trace_audit);
  const supplyChainPath = optionalResolvedPath(inputPaths.supply_chain);

  if (
    !sourcePath &&
    !airPath &&
    !tracePath &&
    !architecturePath &&
    !manifestPath &&
    !packagePath &&
    !bindingFragmentPath &&
    !resourceBindingsPath &&
    !runPlanPath &&
    !ownershipPath &&
    !traceAuditPath &&
    !supplyChainPath
  ) {
    throw new Error("at least one explicit Touba artifact path is required");
  }

  const artifacts = {};
  const source = sourcePath
    ? summarizeExplicitSource(sourcePath, options)
    : absent("source artifact not provided");

  if (airPath) {
    artifacts.air = readJsonArtifact(airPath, options);
  }
  if (tracePath) {
    artifacts.trace = readJsonArtifact(tracePath, options);
  }
  if (architecturePath) {
    artifacts.architecture = readJsonArtifact(architecturePath, options);
  }
  if (manifestPath) {
    artifacts.manifest = readJsonArtifact(manifestPath, options);
  }
  if (packagePath) {
    artifacts.package = readJsonArtifact(packagePath, options);
  }
  if (bindingFragmentPath) {
    artifacts.binding_fragment = readJsonArtifact(bindingFragmentPath, options);
  }
  if (resourceBindingsPath) {
    artifacts.resource_bindings = readJsonArtifact(resourceBindingsPath, options);
  }
  if (runPlanPath) {
    artifacts.run_plan = readJsonArtifact(runPlanPath, options);
  }
  if (ownershipPath) {
    artifacts.ownership = readJsonArtifact(ownershipPath, options);
  }
  if (traceAuditPath) {
    artifacts.trace_audit = readJsonArtifact(traceAuditPath, options);
  }
  if (supplyChainPath) {
    artifacts.supply_chain = readJsonArtifact(supplyChainPath, options);
  }

  const air = airPath ? summarizeAir(artifacts.air) : absent("AIR artifact not provided");
  const trace = tracePath
    ? summarizeTrace(artifacts.trace)
    : absent("trace artifact not provided");
  const architecture = architecturePath
    ? summarizeArchitecture(artifacts.architecture)
    : absent("architecture projection not provided");
  const manifest = manifestPath
    ? summarizeManifest(artifacts.manifest)
    : absent("tool binding manifest not provided");
  const packageSummary = packagePath
    ? summarizePackage(artifacts.package)
    : absent("package artifact not provided");
  const bindingFragment = bindingFragmentPath
    ? summarizeBindingFragment(artifacts.binding_fragment)
    : absent("binding fragment artifact not provided");
  const resourceBindings = resourceBindingsPath
    ? summarizeResourceBindings(artifacts.resource_bindings)
    : absent("resource bindings artifact not provided");
  const runPlan = runPlanPath
    ? summarizeRunPlan(artifacts.run_plan)
    : absent("run plan artifact not provided");
  const ownership = ownershipPath
    ? summarizeOwnership(artifacts.ownership)
    : absent("ownership artifact not provided");
  const traceAudit = traceAuditPath
    ? summarizeTraceAuditArtifact(artifacts.trace_audit)
    : absent("trace audit artifact not provided");
  const supplyChain = supplyChainPath
    ? summarizeSupplyChainArtifact(artifacts.supply_chain)
    : absent("supply chain artifact not provided");
  const compatibility = validateCompatibility({
    source,
    air,
    trace,
    architecture,
    manifest,
    package: packageSummary,
    binding_fragment: bindingFragment,
    resource_bindings: resourceBindings,
    run_plan: runPlan,
    ownership,
    traceAudit,
    supplyChain,
    artifacts,
  });

  return inspectionDocument(
    {
      source: sourcePath,
      air: airPath,
      trace: tracePath,
      architecture: architecturePath,
      manifest: manifestPath,
      package: packagePath,
      binding_fragment: bindingFragmentPath,
      resource_bindings: resourceBindingsPath,
      run_plan: runPlanPath,
      ownership: ownershipPath,
      trace_audit: traceAuditPath,
      supply_chain: supplyChainPath,
    },
    "multi_artifacts",
    {
      source,
      air,
      trace,
      architecture,
      manifest,
      package: packageSummary,
      binding_fragment: bindingFragment,
      resource_bindings: resourceBindings,
      run_plan: runPlan,
      ownership,
      trace_audit: traceAudit,
      supply_chain: supplyChain,
      trace_timeline: absent("trace timeline artifact not provided"),
      compatibility,
    },
  );
}

export function readJsonArtifact(absolutePath, options = {}) {
  assertExistingFile(absolutePath, options);
  try {
    return JSON.parse(fsAdapter(options).readFileSync(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(
      `unsupported Touba artifact: non-JSON input is only allowed for .tb sources (${error.message})`,
    );
  }
}

export function renderInspection(inspection) {
  const lines = [
    `Touba Inspect ${inspection.inspect_schema_version}`,
    ...renderInputPaths(inspection),
    `Artifact ${inspection.artifact_kind}`,
  ];

  for (const [key, render] of [
    ["source", renderSource], ["air", renderAir], ["trace", renderTrace],
    ["architecture", renderArchitecture], ["manifest", renderManifest],
    ["package", renderPackage], ["binding_fragment", renderBindingFragment],
    ["resource_bindings", renderResourceBindings], ["run_plan", renderRunPlan],
    ["ownership", renderOwnership], ["workspace_package_surface", renderWorkspacePackageSurface],
    ["trace_audit", renderTraceAudit], ["trace_timeline", renderTraceTimeline],
    ["supply_chain", renderSupplyChain], ["trigger_state", renderTriggerState],
    ["effective_project", renderEffectiveProject],
  ]) {
    if (inspection[key]?.present) render(lines, inspection[key]);
  }
  renderCompatibility(lines, inspection.compatibility);

  return `${lines.join("\n")}\n`;
}

export function projectInspectionContract(inspection, options = {}) {
  if (inspection.artifact_kind === "effective_project" && inspection.effective_project?.present) {
    return inspection.effective_project.document;
  }
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const root = projectRootFromInspection(inspection, options);
  return {
    schema_version: "touba-project-inspection-v1",
    generated_at: generatedAt,
    project: {
      root,
      name: projectNameFromInspection(inspection, root),
      host_language: hostLanguageFromInspection(inspection),
    },
    artifacts: projectInspectionArtifacts(inspection),
    entrypoints: projectInspectionEntrypoints(inspection),
    packages: [],
    diagnostics: projectInspectionDiagnostics(inspection),
  };
}

function projectRootFromInspection(inspection, options) {
  if (typeof options.root === "string" && options.root.trim() !== "") {
    return options.root;
  }
  const firstPath = firstInspectionPath(inspection);
  return firstPath ? path.dirname(firstPath) : process.cwd();
}

function firstInspectionPath(inspection) {
  if (typeof inspection.input_path === "string") {
    return inspection.input_path;
  }
  const paths = inspection.input_paths ?? {};
  return [
    paths.source,
    paths.air,
    paths.manifest,
    paths.trace,
    paths.supply_chain,
    paths.trace_audit,
  ].find((item) => typeof item === "string" && item.length > 0);
}

function projectNameFromInspection(inspection, root) {
  const moduleName = inspection.air?.present ? inspection.air.module_name : undefined;
  if (typeof moduleName === "string" && moduleName.trim() !== "") {
    return moduleName;
  }
  const name = path.basename(root);
  return name && name !== "." ? name : "touba-project";
}

function hostLanguageFromInspection(inspection) {
  if (inspection.source?.present) {
    return "touba";
  }
  if (inspection.manifest?.present || inspection.binding_fragment?.present) {
    return "javascript";
  }
  return "unknown";
}

function projectInspectionArtifacts(inspection) {
  const artifacts = [];
  addProjectArtifact(artifacts, "source", inspection.source, artifactPath(inspection, "source"));
  addProjectArtifact(artifacts, "air", inspection.air, artifactPath(inspection, "air"));
  addProjectArtifact(artifacts, "manifest", inspection.manifest, artifactPath(inspection, "manifest"));
  addProjectArtifact(artifacts, "trace", inspection.trace, artifactPath(inspection, "trace"));
  addProjectArtifact(artifacts, "lock", supplyChainLockSummary(inspection), artifactPath(inspection, "supply_chain"));
  addProjectArtifact(artifacts, "report", traceAuditReportSummary(inspection), artifactPath(inspection, "trace_audit"));
  addProjectArtifact(artifacts, "report", supplyChainReportSummary(inspection), artifactPath(inspection, "supply_chain"));
  return artifacts;
}

function addProjectArtifact(artifacts, kind, summary, pathValue) {
  artifacts.push({
    kind,
    path: pathValue ?? kind,
    status: summary?.present === true ? "present" : "missing",
  });
}

function artifactPath(inspection, key) {
  if (inspection.input_paths?.[key]) {
    return inspection.input_paths[key];
  }
  if (inspection.input_path && singleInputMatchesArtifact(inspection, key)) {
    return inspection.input_path;
  }
  if (key === "air" && inspection.input_path && inspection.artifact_kind === "touba_source") {
    return "compiled-from-source";
  }
  return undefined;
}

function singleInputMatchesArtifact(inspection, key) {
  return (
    (key === "source" && inspection.artifact_kind === "touba_source") ||
    (key === "air" && inspection.artifact_kind === "air") ||
    (key === "trace" && inspection.artifact_kind === "trace") ||
    (key === "manifest" && inspection.artifact_kind === "tool_binding_manifest") ||
    (key === "supply_chain" && inspection.artifact_kind?.startsWith("supply_chain")) ||
    (key === "trace_audit" && inspection.artifact_kind?.startsWith("trace_audit"))
  );
}

function supplyChainLockSummary(inspection) {
  return inspection.supply_chain?.artifact_kind === "supply_chain_lock"
    ? inspection.supply_chain
    : absent("supply chain lock artifact not provided");
}

function supplyChainReportSummary(inspection) {
  return inspection.supply_chain?.artifact_kind === "supply_chain_validation_report"
    ? inspection.supply_chain
    : absent("supply chain validation report not provided");
}

function traceAuditReportSummary(inspection) {
  return inspection.trace_audit?.present === true ? inspection.trace_audit : absent("trace audit report not provided");
}

function projectInspectionEntrypoints(inspection) {
  return Array.isArray(inspection.air?.entrypoints) ? inspection.air.entrypoints : [];
}

function projectInspectionDiagnostics(inspection) {
  const diagnostics = [];
  for (const diagnostic of inspection.compatibility?.diagnostics ?? []) {
    diagnostics.push(projectDiagnostic("warning", diagnostic.code, diagnostic.message));
  }
  for (const code of inspection.supply_chain?.diagnostic_codes ?? []) {
    diagnostics.push(projectDiagnostic("error", code, `Supply-chain diagnostic ${code}`));
  }
  for (const code of inspection.trace_audit?.diagnostic_codes ?? []) {
    diagnostics.push(projectDiagnostic("warning", code, `Trace audit diagnostic ${code}`));
  }
  return diagnostics;
}

function projectDiagnostic(severity, code, message) {
  return {
    severity,
    code: typeof code === "string" && code ? code : "Diagnostic",
    message: typeof message === "string" && message ? message : "Diagnostic emitted by Touba inspect",
    source_ref: null,
  };
}

function inspectionDocument(inputPath, artifactKind, summaries) {
  const document = {
    inspect_schema_version: "touba-inspect-v1",
    input_path: typeof inputPath === "string" ? inputPath : undefined,
    input_paths: typeof inputPath === "string" ? undefined : compactObject(inputPath),
    artifact_kind: artifactKind,
    ...summaries,
    package: summaries.package ?? absent("package artifact not provided"),
    binding_fragment:
      summaries.binding_fragment ?? absent("binding fragment artifact not provided"),
    resource_bindings:
      summaries.resource_bindings ?? absent("resource bindings artifact not provided"),
    run_plan: summaries.run_plan ?? absent("run plan artifact not provided"),
    ownership: summaries.ownership ?? absent("ownership artifact not provided"),
    trace_audit: summaries.trace_audit ?? absent("trace audit artifact not provided"),
    trace_timeline: summaries.trace_timeline ?? absent("trace timeline artifact not provided"),
    supply_chain: summaries.supply_chain ?? absent("supply chain artifact not provided"),
    trigger_state: summaries.trigger_state ?? absent("trigger state artifact not provided"),
    effective_project: summaries.effective_project ?? absent("effective project artifact not provided"),
    absent_data: INSPECT_ABSENT_DATA,
  };
  document.workspace_package_surface = summarizeWorkspacePackageSurface(document);
  return document;
}

function compileToubaSource(sourcePath, options) {
  const cargo = options.cargo ?? process.env.CARGO ?? "cargo";
  const execFileSync = options.execFileSync ?? defaultExecFileSync;
  const airJson = execFileSync(
    cargo,
    [
      "run",
      "--manifest-path",
      cargoManifest,
      "-p",
      "touba-cli",
      "--bin",
      "touba-compile",
      "--quiet",
      "--",
      sourcePath,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(airJson);
}

function summarizeExplicitSource(sourcePath, options) {
  assertExistingFile(sourcePath, options);
  if (!sourcePath.endsWith(".tb")) {
    throw new Error(`unsupported source artifact: expected .tb file (${sourcePath})`);
  }
  return {
    present: true,
    path: sourcePath,
  };
}

function summarizeSource(sourcePath, compiledAir) {
  return {
    present: true,
    path: sourcePath,
    compiled_air_schema_version: compiledAir.air_schema_version,
    compiled_module_ref: compiledAir.module?.id,
    compiled_module_name: compiledAir.module?.name,
  };
}

function summarizeAir(air) {
  const imports = summarizeAirImports(air);
  return {
    present: true,
    schema_version: air.air_schema_version,
    module_ref: air.module?.id,
    module_name: air.module?.name,
    declarations: {
      constants: count(air.definitions?.constants),
      types: count(air.definitions?.types),
      functions: count(air.definitions?.functions),
      tools: count(air.definitions?.tools),
      memories: count(air.definitions?.memories),
      skills: count(air.definitions?.skills),
      agents: count(air.definitions?.agents),
      strategies: count(air.definitions?.strategies),
      triggers: count(air.definitions?.triggers),
    },
    execution_graphs: count(air.execution_graphs),
    expressions: countExpressions(air.execution_graphs),
    flow_edges: countFlowEdges(air.execution_graphs),
    call_arguments: countCallArguments(air.execution_graphs),
    result_bindings: countResultBindings(air.execution_graphs),
    local_bindings: countFlowNodesByKind(air.execution_graphs, "bind"),
    human_approvals: countHumanApprovals(air.execution_graphs),
    user_interactions: countUserInteractions(air.execution_graphs),
    failure_paths: countFailurePaths(air.execution_graphs),
    required_capabilities: countToolRequirement(air, "required_capabilities"),
    required_secrets: countToolRequirement(air, "required_secrets"),
    memory_accesses: countToolRequirement(air, "memory_accesses"),
    memory_scopes: countMemoryScopes(air),
    memory_model: summarizeMemoryModel(air),
    callable_by: countCallableBy(air),
    agent_authority: summarizeAgentAuthority(air),
    entrypoints: summarizeAirEntryPoints(air),
    triggers: summarizeAirTriggers(air),
    run_budgets: summarizeAirRunBudgets(air),
    imports,
    trace_points: count(air.trace_points),
  };
}

function summarizeTrace(trace, sourcePath = undefined) {
  const events = trace.events ?? [];
  const noteworthy = new Set([
    "run_started", "run_completed", "admission_refused", "tool_binding_authorized",
    "agent_decision_recorded", "agent_capability_selected", "agent_direct_answer_returned",
    "human_approval_requested", "human_approval_decided", "human_approval_rejected",
    "human_approval_expired", "human_approval_cancelled", "user_interaction_paused",
    "failure_detected", "run_cancelled", "budget_limit_exceeded", "fallback_selected",
  ]);
  return {
    present: true,
    source_path: sourcePath,
    protocol_version: trace.trace_protocol_version,
    run_id: trace.run?.run_id,
    module_ref: trace.run?.module_ref,
    entry_ref: trace.run?.entry_ref,
    air_digest: trace.run?.air_digest,
    status: trace.run?.admission === "refused" ? "admission_refused" : finalRunStatus(events) ?? "absent",
    events: events.length,
    reason: events.at(-1)?.payload?.reason,
    chronology: events.filter(event => noteworthy.has(event.kind)).map(event => ({
      index: event.sequence_index,
      kind: event.kind,
      ...Object.fromEntries(Object.entries(event.payload ?? {}).filter(([key, value]) =>
        ["repeated_from_step", "identical_invocation_number"].includes(key)
        && Number.isSafeInteger(value) && value >= 0)),
      ...(typeof event.payload?.reason === "string" && event.payload.reason.length > 0
        ? { reported_reason: event.payload.reason } : {}),
      ...Object.fromEntries(Object.entries(event.payload ?? {}).filter(([key, value]) =>
        ["action", "selected_ref", "target_ref", "tool_ref", "agent_ref", "approval_ref", "interaction_ref", "decision", "runtime_error_code", "status"].includes(key)
        && typeof value === "string")),
    })),
    effective_limits: events.filter(event => event.kind === "budget_limit_checked").map(event => ({
      kind: event.payload.budget_kind, limit: event.payload.limit_value, authority: event.payload.authority_source,
    })),
    human_approvals: summarizeHumanApprovalTrace(events),
    user_interactions: summarizeUserInteractionTrace(events),
    bindings: summarizeBindingTrace(events),
    agent_invocations: summarizeAgentInvocationTrace(events),
    memory_accesses: summarizeMemoryAccessTrace(events),
    memory_metadata: summarizeMemoryMetadataTrace(events),
    triggers: summarizeTriggerTrace(events),
    run_controls: summarizeRunControlTrace(events),
    budgets: summarizeBudgetTrace(events),
  };
}

export function exportTraceToOpenTelemetry(trace, options = {}) {
  if (!trace || trace.trace_protocol_version !== EXPECTED_TRACE_PROTOCOL_VERSION) {
    throw new Error(`expected ${EXPECTED_TRACE_PROTOCOL_VERSION} trace for OpenTelemetry export`);
  }
  const runId = trace.run?.run_id ?? "run-unknown";
  const traceId = stableHex(`touba-trace:${runId}`, 32);
  const resourceAttributes = otelAttributes({
    "service.name": "touba",
    "telemetry.sdk.name": "touba.inspect.otel",
    "telemetry.sdk.language": "javascript",
    "telemetry.sdk.version": "1.0.0",
    "touba.trace.protocol_version": trace.trace_protocol_version,
    "touba.run.id": runId,
    "touba.module.ref": trace.run?.module_ref,
    "touba.entry.ref": trace.run?.entry_ref,
    "touba.source.provided": Boolean(options.sourcePath),
    "gen_ai.system": "touba",
  });
  const spans = (trace.events ?? []).map((event) => toubaEventToOtelSpan(event, trace, traceId));
  return {
    resourceSpans: [
      {
        schemaUrl: OTEL_SEMCONV_SCHEMA_URL,
        resource: {
          attributes: resourceAttributes,
        },
        scopeSpans: [
          {
            schemaUrl: OTEL_SEMCONV_SCHEMA_URL,
            scope: {
              name: "touba.inspect.otel",
              version: "1.0.0",
            },
            spans,
          },
        ],
      },
    ],
  };
}

function toubaEventToOtelSpan(event, trace, traceId) {
  const startTimeUnixNano = syntheticEventTimeUnixNano(event.sequence_index ?? 0);
  const endTimeUnixNano = (BigInt(startTimeUnixNano) + 1n).toString();
  const semantic = toubaEventSemanticMapping(event, trace);
  const errorType = otelErrorType(event);
  return {
    traceId,
    spanId: stableHex(`touba-span:${event.run_id}:${event.event_id}`, 16),
    name: semantic.name,
    kind: semantic.spanKind,
    startTimeUnixNano,
    endTimeUnixNano,
    status: errorType ? { code: 2 } : undefined,
    attributes: otelAttributes({
      "touba.event.id": event.event_id,
      "touba.event.kind": event.kind,
      "touba.event.sequence_index": event.sequence_index,
      "touba.run.id": event.run_id,
      "touba.air.flow_graph_ref": event.air_ref?.flow_graph_ref,
      "touba.air.owner_ref": event.air_ref?.owner_ref,
      "touba.air.node_id": event.air_ref?.node_id,
      "gen_ai.operation.name": semantic.operationName,
      "gen_ai.provider.name": semantic.providerName,
      "gen_ai.agent.id": semantic.agentId,
      "gen_ai.agent.name": semantic.agentName,
      "gen_ai.workflow.name": semantic.workflowName,
      "gen_ai.tool.name": semantic.toolName,
      "error.type": errorType,
      ...safeOtelPayloadAttributes(event.payload),
    }),
  };
}

function toubaEventSemanticMapping(event, trace) {
  const payload = isPlainObject(event.payload) ? event.payload : {};
  const agentRef = stringOrUndefined(payload.agent_ref) ?? agentRefFromOwner(event.air_ref?.owner_ref);
  const toolName = toolNameFromEvent(event);
  if (toolName) {
    return {
      operationName: "execute_tool",
      providerName: "touba",
      spanKind: 1,
      name: `execute_tool ${toolName}`,
      toolName,
      workflowName: trace.run?.entry_ref,
    };
  }
  if (event.kind?.startsWith("agent_") || agentRef) {
    return {
      operationName: "invoke_agent",
      providerName: "touba",
      spanKind: 1,
      name: `invoke_agent ${agentRef ?? "touba.agent"}`,
      agentId: agentRef,
      agentName: agentRef ? agentRef.split("/").at(-1) : undefined,
      workflowName: trace.run?.entry_ref,
    };
  }
  return {
    operationName: "invoke_workflow",
    providerName: "touba",
    spanKind: 1,
    name: `invoke_workflow ${trace.run?.entry_ref ?? "touba.workflow"}`,
    workflowName: trace.run?.entry_ref,
  };
}

function toolNameFromEvent(event) {
  const payload = isPlainObject(event.payload) ? event.payload : {};
  const ref = stringOrUndefined(payload.tool_ref)
    ?? (event.kind?.startsWith("tool_") ? stringOrUndefined(payload.target_ref) : undefined);
  return ref ? ref.split("/").at(-1) : undefined;
}

function agentRefFromOwner(ownerRef) {
  return typeof ownerRef === "string" && ownerRef.startsWith("agent:")
    ? ownerRef
    : undefined;
}

function otelErrorType(event) {
  const payload = isPlainObject(event.payload) ? event.payload : {};
  if (typeof payload.runtime_error_code === "string") {
    return payload.runtime_error_code;
  }
  if (typeof payload.error_code === "string") {
    return payload.error_code;
  }
  if (typeof event.kind === "string" && /(failed|refused|exceeded|invalid|cancelled|timeout)/u.test(event.kind)) {
    return event.kind;
  }
  return undefined;
}

function syntheticEventTimeUnixNano(sequenceIndex) {
  return (BigInt(sequenceIndex) * 1_000_000n).toString();
}

function safeOtelPayloadAttributes(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const entries = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (SAFE_OTEL_PAYLOAD_KEYS.has(key) && isOtelScalarOrScalarArray(value)) {
      entries[`touba.payload.${key}`] = value;
    }
  }
  return entries;
}

function otelAttributes(values) {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ({
      key,
      value: otelAnyValue(value),
    }));
}

function otelAnyValue(value) {
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map((item) => otelAnyValue(item)),
      },
    };
  }
  if (Number.isInteger(value)) {
    return { intValue: String(value) };
  }
  if (typeof value === "number") {
    return { doubleValue: value };
  }
  if (typeof value === "string") {
    return { stringValue: value };
  }
  return { stringValue: JSON.stringify(value) };
}

function isOtelScalarOrScalarArray(value) {
  if (Array.isArray(value)) {
    return value.every((item) => isOtelScalarOrScalarArray(item) && !Array.isArray(item));
  }
  return ["boolean", "number", "string"].includes(typeof value);
}

function stringOrUndefined(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableHex(input, length) {
  return createHash("sha256").update(input).digest("hex").slice(0, length);
}

function summarizeArchitecture(projection) {
  return {
    present: true,
    projection_schema_version: projection.projection_schema_version,
    module_ref: projection.module?.id,
    module_name: projection.module?.name,
    test_only: Boolean(projection.test_only),
    nodes: count(projection.nodes),
    links: count(projection.links),
    unresolved_references: count(projection.unresolved_references),
  };
}

function summarizeManifest(manifest) {
  const validatedEffects = validateManifestEffectContracts(manifest).effectContracts;
  const bindings = Object.entries(manifest.bindings ?? {}).map(([toolRef, binding]) => ({
    tool_ref: toolRef,
    handler_kind: binding.handler?.kind,
    handler_command: binding.handler?.command,
    handler_args: Array.isArray(binding.handler?.args) ? binding.handler.args : [],
    handler_cwd: binding.handler?.cwd,
    grants: Array.isArray(binding.grants) ? binding.grants : [],
    secrets: Array.isArray(binding.secrets) ? binding.secrets : [],
    memories: Array.isArray(binding.memories)
      ? binding.memories.map((memory) => ({
          ref: memory.ref,
          access: memory.access,
        }))
      : [],
    timeout_ms: binding.timeout_ms,
    max_payload_bytes: binding.max_payload_bytes,
    ...(validatedEffects.has(toolRef)
      ? { effect_contract: effectContractToJson(validatedEffects.get(toolRef)) }
      : {}),
  }));
  const triggers = Object.entries(manifest.triggers ?? {}).map(([triggerRef, trigger]) => ({
    trigger_ref: triggerRef,
    enabled: trigger.enabled === true,
    source_kind: trigger.source?.kind,
    timezone: trigger.source?.timezone,
    limits: {
      max_runs_per_day: trigger.limits?.max_runs_per_day,
      timeout_ms: trigger.limits?.timeout_ms,
    },
  }));
  const runLimits = Object.entries(manifest.run_limits ?? {}).map(([kind, value]) => ({
    kind,
    value,
  }));
  return {
    present: true,
    manifest_version: manifest.manifest_version,
    bindings,
    binding_count: bindings.length,
    triggers,
    trigger_count: triggers.length,
    run_limits: runLimits,
    agent_secret_scopes: Object.entries(manifest.agent_secret_scopes ?? {}).map(
      ([agentRef, secrets]) => ({
        agent_ref: agentRef,
        secrets: Array.isArray(secrets) ? secrets : [],
      }),
    ),
  };
}

function summarizePackage(packageDocument) {
  const exportsByKind = packageDocument.exports ?? {};
  const exports = Object.entries(exportsByKind).flatMap(([kind, refs]) =>
    Array.isArray(refs)
      ? refs.map((ref) => ({
          kind,
          ref,
        }))
      : [],
  );
  return {
    present: true,
    package_schema_version: packageDocument.package_schema_version,
    name: packageDocument.name,
    version: packageDocument.version,
    root: packageDocument.root,
    air_profile: packageDocument.touba?.air_profile,
    runtime_compatibility: packageDocument.touba?.runtime_compatibility,
    export_count: exports.length,
    exports,
    provenance_kind: packageDocument.provenance?.kind,
    provenance_source: packageDocument.provenance?.source,
    contract_tests: Array.isArray(packageDocument.contract_tests)
      ? packageDocument.contract_tests
      : [],
  };
}

function summarizeBindingFragment(fragment) {
  const bindings = Object.entries(fragment.bindings ?? {}).map(([toolRef, binding]) => {
    const effectContract = Object.hasOwn(binding ?? {}, "effect_contract")
      ? normalizeEffectContract(binding.effect_contract, {
        label: `bindings.${toolRef}.effect_contract`,
      })
      : null;
    return {
      tool_ref: toolRef,
      handler_kind: binding.handler?.kind,
      handler_command: binding.handler?.command,
      handler_args: Array.isArray(binding.handler?.args) ? binding.handler.args : [],
      handler_cwd: binding.handler?.cwd,
      grants: Array.isArray(binding.grants) ? binding.grants : [],
      secrets: Array.isArray(binding.secrets) ? binding.secrets : [],
      timeout_ms: binding.timeout_ms,
      max_payload_bytes: binding.max_payload_bytes,
      payload_constraints: countPayloadConstraints(binding.payload_constraints),
      ...(effectContract === null ? {} : { effect_contract: effectContractToJson(effectContract) }),
    };
  });
  return {
    present: true,
    fragment_schema_version: fragment.fragment_schema_version,
    source_kind: fragment.source?.kind,
    source_module: fragment.source?.module,
    source_package: fragment.source?.package,
    binding_count: bindings.length,
    bindings,
  };
}

function summarizeResourceBindings(document) {
  const resources = Object.entries(document.resources ?? {}).map(([resourceRef, binding]) => ({
    resource_ref: resourceRef,
    kind: binding.kind,
    provider: binding.provider,
    active: binding.active !== false,
    grants: Array.isArray(binding.grants) ? binding.grants : [],
    secrets: Array.isArray(binding.secrets) ? binding.secrets : [],
    required_secrets: Array.isArray(binding.required_secrets) ? binding.required_secrets : [],
    max_payload_bytes: binding.limits?.max_payload_bytes,
  }));
  return {
    present: true,
    resource_bindings_schema_version: document.resource_bindings_schema_version,
    resource_count: resources.length,
    active_count: resources.filter((resource) => resource.active).length,
    inactive_count: resources.filter((resource) => !resource.active).length,
    resources,
  };
}

function summarizeRunPlan(document) {
  return {
    present: true,
    run_plan_schema_version: document.run_plan_schema_version,
    entry_ref: document.entry_ref,
    profile: document.profile,
    air: document.air,
    manifest: document.manifest,
    secrets_profile: document.secrets_profile,
    supply_chain_lock: document.supply_chain_lock,
    trigger_manifest: document.trigger_manifest,
    run_limits: Object.entries(document.run_limits ?? {}).map(([kind, value]) => ({
      kind,
      value,
    })),
    output_mode: document.outputs?.mode,
    trace_out: document.outputs?.trace_out,
  };
}

function summarizeOwnership(document) {
  const teams = Object.entries(document.teams ?? {}).map(([teamRef, metadata]) => ({
    team_ref: teamRef,
    display_name: metadata?.display_name,
  }));
  const owners = Object.entries(document.owners ?? {}).map(([targetRef, teamRefs]) => ({
    target_ref: targetRef,
    teams: Array.isArray(teamRefs) ? teamRefs : [],
  }));
  const reviewGates = Object.entries(document.review_gates ?? {}).map(([profile, gate]) => ({
    profile,
    requires_review_for: Array.isArray(gate?.requires_review_for)
      ? gate.requires_review_for
      : [],
    reviewers: Array.isArray(gate?.reviewers) ? gate.reviewers : [],
  }));
  const reviews = Array.isArray(document.reviews)
    ? document.reviews.map((review) => ({
        review_id: review.review_id,
        profile: review.profile,
        target_ref: review.target_ref,
        reviewer: review.reviewer,
        decision: review.decision,
        evidence_ref: review.evidence_ref,
      }))
    : [];
  return {
    present: true,
    ownership_schema_version: document.ownership_schema_version,
    team_count: teams.length,
    owner_count: owners.length,
    review_gate_count: reviewGates.length,
    review_count: reviews.length,
    teams,
    owners,
    review_gates: reviewGates,
    reviews,
  };
}

function summarizeWorkspacePackageSurface(document) {
  return {
    present: true,
    availability: summarizeAvailabilityGraph(document),
    authority: summarizeAuthorityGraph(document),
    responsibility: summarizeResponsibilityGraph(document),
  };
}

function summarizeAvailabilityGraph(document) {
  const modules = [];
  if (document.air?.present && document.air.module_ref) {
    modules.push({ source: "air", ref: document.air.module_ref, name: document.air.module_name });
  }
  if (document.architecture?.present && document.architecture.module_ref) {
    modules.push({
      source: "architecture",
      ref: document.architecture.module_ref,
      name: document.architecture.module_name,
    });
  }
  const packageExports = document.package?.present ? document.package.exports : [];
  return {
    present:
      modules.length > 0 ||
      document.air?.imports?.total > 0 ||
      (document.air?.present && Boolean(document.air.declarations)) ||
      packageExports.length > 0,
    modules,
    declarations: document.air?.present ? document.air.declarations : null,
    imports: document.air?.present ? document.air.imports : null,
    package_name: document.package?.present ? document.package.name : undefined,
    package_version: document.package?.present ? document.package.version : undefined,
    package_exports: packageExports,
  };
}

function summarizeAuthorityGraph(document) {
  return {
    present:
      document.air?.present ||
      document.manifest?.present ||
      document.binding_fragment?.present ||
      document.resource_bindings?.present ||
      document.run_plan?.present ||
      document.supply_chain?.present,
    air: document.air?.present
      ? {
          required_capabilities: document.air.required_capabilities,
          required_secrets: document.air.required_secrets,
          memory_accesses: document.air.memory_accesses,
          memory_scopes: document.air.memory_scopes,
          callable_by: document.air.callable_by,
        }
      : null,
    manifest: document.manifest?.present
      ? {
          bindings: document.manifest.binding_count,
          triggers: document.manifest.trigger_count,
          run_limits: document.manifest.run_limits.length,
          agent_secret_scopes: document.manifest.agent_secret_scopes.length,
        }
      : null,
    binding_fragment: document.binding_fragment?.present
      ? {
          bindings: document.binding_fragment.binding_count,
          source_kind: document.binding_fragment.source_kind,
        }
      : null,
    resource_bindings: document.resource_bindings?.present
      ? {
          resources: document.resource_bindings.resource_count,
          active: document.resource_bindings.active_count,
          inactive: document.resource_bindings.inactive_count,
        }
      : null,
    run_plan: document.run_plan?.present
      ? {
          entry_ref: document.run_plan.entry_ref,
          profile: document.run_plan.profile,
          has_manifest: Boolean(document.run_plan.manifest),
          has_secrets_profile: Boolean(document.run_plan.secrets_profile),
          has_supply_chain_lock: Boolean(document.run_plan.supply_chain_lock),
        }
      : null,
    supply_chain: document.supply_chain?.present
      ? {
          kind: document.supply_chain.artifact_kind,
          diagnostics: document.supply_chain.diagnostics,
          diagnostic_codes: document.supply_chain.diagnostic_codes,
        }
      : null,
  };
}

function summarizeResponsibilityGraph(document) {
  return {
    present: document.ownership?.present === true,
    ownership: document.ownership?.present
      ? {
          teams: document.ownership.team_count,
          owners: document.ownership.owner_count,
          review_gates: document.ownership.review_gate_count,
          reviews: document.ownership.review_count,
        }
      : null,
  };
}

function summarizeTraceAuditArtifact(artifact) {
  if (artifact.trace_audit_export_schema_version === EXPECTED_TRACE_AUDIT_EXPORT_SCHEMA_VERSION) {
    const manifest = artifact.trace_audit_manifest ?? {};
    const report = artifact.validation_report ?? {};
    return {
      present: true,
      artifact_kind: "trace_audit_export",
      schema_version: artifact.trace_audit_export_schema_version,
      run_id: manifest.run_id,
      status: report.status ?? "absent",
      retention_class: manifest.retention?.class,
      redaction_policy: manifest.redaction?.policy,
      digests: Object.keys(manifest.artifacts ?? {}),
      diagnostics: Array.isArray(report.diagnostics) ? report.diagnostics.length : 0,
      diagnostic_codes: diagnosticCodes(report.diagnostics),
      export_artifacts: Object.keys(artifact.artifacts ?? {}),
    };
  }
  if (
    artifact.trace_audit_validation_schema_version ===
    EXPECTED_TRACE_AUDIT_VALIDATION_SCHEMA_VERSION
  ) {
    return {
      present: true,
      artifact_kind: "trace_audit_validation_report",
      schema_version: artifact.trace_audit_validation_schema_version,
      run_id: artifact.run_id,
      status: artifact.status,
      retention_class: "absent",
      redaction_policy: "absent",
      digests: [],
      diagnostics: Array.isArray(artifact.diagnostics) ? artifact.diagnostics.length : 0,
      diagnostic_codes: diagnosticCodes(artifact.diagnostics),
      export_artifacts: [],
    };
  }
  if (artifact.trace_audit_schema_version === EXPECTED_TRACE_AUDIT_SCHEMA_VERSION) {
    return {
      present: true,
      artifact_kind: "trace_audit_manifest",
      schema_version: artifact.trace_audit_schema_version,
      run_id: artifact.run_id,
      status: "absent",
      retention_class: artifact.retention?.class,
      redaction_policy: artifact.redaction?.policy,
      digests: Object.keys(artifact.artifacts ?? {}),
      diagnostics: 0,
      diagnostic_codes: [],
      export_artifacts: [],
    };
  }
  return absent("trace audit artifact not provided");
}

function summarizeTraceTimelineArtifact(artifact) {
  if (artifact.schema_version !== EXPECTED_TRACE_TIMELINE_SCHEMA_VERSION) {
    return absent("trace timeline artifact not provided");
  }
  const events = Array.isArray(artifact.events) ? artifact.events : [];
  const severityCounts = { debug: 0, info: 0, warning: 0, error: 0 };
  const typeCounts = new Map();
  for (const [index, event] of events.entries()) {
    if (Object.prototype.hasOwnProperty.call(severityCounts, event?.severity)) {
      severityCounts[event.severity] += 1;
    }
    if (typeof event?.type === "string") {
      const existing = typeCounts.get(event.type);
      typeCounts.set(event.type, {
        count: (existing?.count ?? 0) + 1,
        first_index: existing?.first_index ?? index,
      });
    }
  }
  return {
    present: true,
    schema_version: artifact.schema_version,
    run_id: artifact.run_id,
    trace_ref: artifact.trace_ref,
    events: events.length,
    severity_counts: severityCounts,
    first_event_type: events[0]?.type ?? "absent",
    last_event_type: events.at(-1)?.type ?? "absent",
    top_event_types: [...typeCounts.entries()]
      .sort((left, right) => right[1].count - left[1].count || left[1].first_index - right[1].first_index)
      .slice(0, 5)
      .map(([type, value]) => ({ type, count: value.count })),
  };
}

function summarizeSupplyChainArtifact(artifact) {
  if (artifact.supply_chain_validation_schema_version === EXPECTED_SUPPLY_CHAIN_VALIDATION_SCHEMA_VERSION) {
    return {
      present: true,
      artifact_kind: "supply_chain_validation_report",
      schema_version: artifact.supply_chain_validation_schema_version,
      lock_schema_version: artifact.lock_schema_version,
      status: artifact.status,
      air_drift: artifact.artifacts?.air?.drift_status,
      manifest_drift: artifact.artifacts?.manifest?.drift_status,
      provenance: summarizeSupplyChainProvenance(artifact.provenance),
      review: summarizeSupplyChainReview(artifact.review),
      handlers: (artifact.handlers ?? []).map((handler) => ({
        tool_ref: handler.tool_ref,
        drift_status: handler.drift_status,
        sdk_status: handler.sdk_status,
        sdk_name: handler.sdk_name,
        sdk_version: handler.sdk_version,
        sdk_protocol: handler.sdk_protocol,
        handler_package_status: handler.handler_package_status,
        handler_package_kind: handler.handler_package_kind,
        handler_package_name: handler.handler_package_name,
        handler_package_version: handler.handler_package_version,
        handler_package_entrypoint: handler.handler_package_entrypoint,
        handler_package_root: handler.handler_package_root,
        handler_package_files_status: handler.handler_package_files_status,
        handler_dependency_artifacts_status: handler.handler_dependency_artifacts_status,
        diagnostics: Array.isArray(handler.diagnostics) ? handler.diagnostics.length : 0,
      })),
      diagnostics: Array.isArray(artifact.diagnostics) ? artifact.diagnostics.length : 0,
      diagnostic_codes: diagnosticCodes(artifact.diagnostics),
    };
  }

  if (
    artifact.lock_schema_version === EXPECTED_SUPPLY_CHAIN_LOCK_SCHEMA_VERSION &&
    artifact.lock_kind === "supply_chain"
  ) {
    return {
      present: true,
      artifact_kind: "supply_chain_lock",
      schema_version: artifact.lock_schema_version,
      lock_kind: artifact.lock_kind,
      generated_by: artifact.generated_by?.tool,
      generated_version: artifact.generated_by?.version,
      provenance: summarizeSupplyChainProvenanceFromLock(artifact.provenance),
      review: summarizeSupplyChainReviewFromLock(artifact.review),
      air_path: artifact.air?.path,
      air_digest: summarizeDigest(artifact.air?.digest),
      manifest_path: artifact.manifest?.path,
      manifest_digest: summarizeDigest(artifact.manifest?.digest),
      handlers: (artifact.handlers ?? []).map((handler) => ({
        tool_ref: handler.tool_ref,
        path: handler.path,
        command: handler.command,
        cwd: handler.cwd,
        args: Array.isArray(handler.args) ? handler.args : [],
        digest: summarizeDigest(handler.digest),
        sdk_name: handler.sdk?.name,
        sdk_version: handler.sdk?.version,
        sdk_protocol: handler.sdk?.protocol,
        sdk_status: handler.sdk?.status ?? "unknown",
        handler_package_kind: handler.handler_package?.kind,
        handler_package_name: handler.handler_package?.name,
        handler_package_version: handler.handler_package?.version,
        handler_package_entrypoint: handler.handler_package?.entrypoint,
        handler_package_root: handler.handler_package?.package_root,
        handler_package_files: Array.isArray(handler.handler_package?.files)
          ? handler.handler_package.files.length
          : 0,
        handler_dependency_artifacts: Array.isArray(handler.handler_package?.dependency_artifacts)
          ? handler.handler_package.dependency_artifacts.length
          : 0,
      })),
      diagnostics: 0,
      diagnostic_codes: [],
    };
  }

  return absent("supply chain artifact not provided");
}

function summarizeSupplyChainProvenance(provenance) {
  if (!provenance || provenance.status === undefined) {
    return {
      status: "unknown",
    };
  }
  return {
    status: provenance.status,
    prepared_by_kind: provenance.prepared_by_kind,
    prepared_by_id: provenance.prepared_by_id,
    prepared_at: provenance.prepared_at,
    source_kind: provenance.source_kind,
    source_ref: provenance.source_ref,
    source_commit: provenance.source_commit,
  };
}

function summarizeSupplyChainReview(review) {
  if (!review || review.status === undefined) {
    return {
      status: "unknown",
      evidence_status: "unknown",
      required: false,
    };
  }
  return {
    status: review.status,
    evidence_status: review.evidence_status ?? "unknown",
    required: Boolean(review.required),
    reviewed_at: review.reviewed_at,
    reviewers: review.reviewers ?? 0,
    evidence: review.evidence ?? 0,
  };
}

function summarizeSupplyChainProvenanceFromLock(provenance) {
  if (!provenance) {
    return {
      status: "unknown",
    };
  }
  return {
    status: "declared",
    prepared_by_kind: provenance.prepared_by?.kind,
    prepared_by_id: provenance.prepared_by?.id,
    prepared_at: provenance.prepared_at,
    source_kind: provenance.source?.kind,
    source_ref: provenance.source?.ref,
    source_commit: provenance.source?.commit,
  };
}

function summarizeSupplyChainReviewFromLock(review) {
  if (!review) {
    return {
      status: "unknown",
      evidence_status: "unknown",
      required: false,
    };
  }
  return {
    status: review.status ?? "declared",
    evidence_status: Array.isArray(review.evidence) && review.evidence.length > 0 ? "declared" : "unknown",
    required: false,
    reviewed_at: review.reviewed_at,
    reviewers: Array.isArray(review.reviewers) ? review.reviewers.length : 0,
    evidence: Array.isArray(review.evidence) ? review.evidence.length : 0,
  };
}

function summarizeTriggerStateArtifact(artifact) {
  if (artifact.trigger_state_schema_version !== EXPECTED_TRIGGER_STATE_SCHEMA_VERSION) {
    return absent("trigger state artifact not provided");
  }
  const triggers = Object.entries(artifact.triggers ?? {}).map(([triggerRef, state]) => {
    const events = Array.isArray(state.events) ? state.events : [];
    const accepted = events.filter((event) => event?.status === "accepted").length;
    const refused = events.filter((event) => event?.status === "refused").length;
    const reasons = [
      ...new Set(
        events
          .map((event) => event?.reason)
          .filter((reason) => typeof reason === "string" && reason.trim() !== ""),
      ),
    ].sort();
    return {
      trigger_ref: triggerRef,
      accepted_count: numberOrZero(state.accepted_count, accepted),
      refused_count: numberOrZero(state.refused_count, refused),
      consumed_event_count: Array.isArray(state.consumed_event_ids)
        ? state.consumed_event_ids.length
        : accepted,
      last_event_id: state.last_event_id,
      last_status: state.last_status,
      updated_at: state.updated_at,
      reasons,
    };
  });
  return {
    present: true,
    schema_version: artifact.trigger_state_schema_version,
    created_at: artifact.created_at,
    updated_at: artifact.updated_at,
    trigger_count: triggers.length,
    accepted_count: triggers.reduce((total, trigger) => total + trigger.accepted_count, 0),
    refused_count: triggers.reduce((total, trigger) => total + trigger.refused_count, 0),
    consumed_event_count: triggers.reduce((total, trigger) => total + trigger.consumed_event_count, 0),
    triggers,
  };
}

function summarizeEffectiveProject(artifact) {
  if (artifact.artifact_role !== "derived_non_authoritative") {
    throw new Error("effective project artifact_role must be derived_non_authoritative");
  }
  const expectedSections = [
    "sources",
    "air",
    "entry",
    "handlers",
    "grants",
    "secrets",
    "memory_scopes",
    "callers",
    "budgets",
    "sandbox",
    "lock",
    "triggers",
    "evidence",
  ];
  const allowedStatuses = new Set(["absent", "non_applicable", "derived", "declared", "effective"]);
  const sections = expectedSections.map((name) => {
    const section = artifact.contract?.[name];
    if (!section || !allowedStatuses.has(section.provenance?.status)) {
      throw new Error(`effective project section ${name} has invalid provenance`);
    }
    if (!Array.isArray(section.provenance.sources)
      || section.provenance.sources.some((item) => typeof item !== "string" || path.isAbsolute(item))) {
      throw new Error(`effective project section ${name} must use relative provenance sources`);
    }
    return {
      name,
      status: section.provenance.status,
      sources: [...section.provenance.sources],
    };
  });
  for (const input of artifact.inputs ?? []) {
    if (typeof input.path !== "string" || path.isAbsolute(input.path)) {
      throw new Error("effective project inputs must use relative paths");
    }
    if (!/^sha256:[0-9a-f]{64}$/u.test(input.digest_sha256 ?? "")) {
      throw new Error(`effective project input ${input.path} has an invalid digest`);
    }
    if (!["declared", "derived"].includes(input.provenance)) {
      throw new Error(`effective project input ${input.path} has invalid provenance`);
    }
  }
  const effectContracts = (artifact.contract?.handlers?.bindings ?? [])
    .filter((binding) => Object.hasOwn(binding ?? {}, "effect_contract"))
    .map((binding) => ({
      tool_ref: binding.tool_ref,
      effect_contract: effectContractToJson(normalizeEffectContract(binding.effect_contract, {
        label: `contract.handlers.bindings.${binding.tool_ref}.effect_contract`,
      })),
    }));
  assertNoEffectiveProjectSensitiveFields(artifact);
  return {
    present: true,
    schema_version: artifact.schema_version,
    artifact_role: artifact.artifact_role,
    profile: artifact.project?.profile,
    artifact_layout: artifact.project?.artifact_layout,
    input_count: (artifact.inputs ?? []).length,
    sections,
    ...(effectContracts.length > 0 ? { effect_contracts: effectContracts } : {}),
    document: artifact,
  };
}

function assertNoEffectiveProjectSensitiveFields(artifact) {
  const forbidden = new Set([
    "content",
    "memory_content",
    "payload",
    "prompt",
    "result",
    "secret_value",
    "secret_values",
    "token",
    "value",
  ]);
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.has(key)) {
        throw new Error(`effective project contains forbidden sensitive field ${key}`);
      }
      visit(child);
    }
  };
  visit(artifact);
}

function numberOrZero(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function renderAir(lines, air) {
  if (!air.present) {
    lines.push(`AIR absent: ${air.reason}`);
    return;
  }
  lines.push(`AIR ${air.schema_version}`);
  lines.push(`- module=${air.module_ref} name=${air.module_name}`);
  lines.push(
    `- declarations constants=${air.declarations.constants} types=${air.declarations.types} functions=${air.declarations.functions} tools=${air.declarations.tools} memories=${air.declarations.memories} skills=${air.declarations.skills} agents=${air.declarations.agents} strategies=${air.declarations.strategies} triggers=${air.declarations.triggers}`,
  );
  lines.push(
    `- execution_graphs=${air.execution_graphs} expressions=${air.expressions} trace_points=${air.trace_points}`,
  );
  lines.push(`- imports=${air.imports.total} resolved=${air.imports.resolved} unresolved=${air.imports.unresolved}`);
  for (const importDeclaration of air.imports.items) {
    lines.push(
      `- import ${importDeclaration.kind} ${importDeclaration.name} from=${importDeclaration.from_module} target=${importDeclaration.target_ref} status=${importDeclaration.status}`,
    );
  }
  lines.push(
    `- flow_edges=${air.flow_edges} call_arguments=${air.call_arguments} result_bindings=${air.result_bindings} local_bindings=${air.local_bindings} human_approvals=${air.human_approvals} user_interactions=${air.user_interactions} failure_paths=${air.failure_paths}`,
  );
  lines.push(
    `- required_capabilities=${air.required_capabilities} required_secrets=${air.required_secrets} memory_accesses=${air.memory_accesses} memory_scopes=${air.memory_scopes} callable_by=${air.callable_by}`,
  );
  for (const memory of air.memory_model.memories) {
    lines.push(`- memory ${memory.memory_ref} name=${memory.name}`);
  }
  for (const access of air.memory_model.tool_accesses) {
    lines.push(`- tool_memory ${access.tool_ref} ${access.access} ${access.memory_ref}`);
  }
  for (const scope of air.memory_model.owner_scopes) {
    lines.push(`- owner_memory ${scope.owner_ref} ${scope.access} ${scope.memory_ref}`);
  }
  for (const authority of air.agent_authority) {
    lines.push(
      `- agent_authority ${authority.agent_ref} callers=[${authority.callers.join(",")}]`,
    );
  }
  for (const trigger of air.triggers) {
    lines.push(
      `- trigger ${trigger.trigger_ref} event=${trigger.event_kind} target=${trigger.target_ref} limits=${formatTriggerLimits(
        trigger.limits,
      )} arguments=[${trigger.arguments.map(formatTriggerArgument).join(",")}]`,
    );
  }
  if (air.run_budgets.length > 0) {
    lines.push(`- run_budgets ${formatBudgetEntries(air.run_budgets)}`);
  }
}

function renderSource(lines, source) {
  if (!source.present) {
    lines.push(`Source absent: ${source.reason}`);
    return;
  }
  lines.push(`Source ${source.path}`);
  if (source.compiled_air_schema_version) {
    lines.push(
      `- compiled_air=${source.compiled_air_schema_version} module=${source.compiled_module_ref} name=${source.compiled_module_name}`,
    );
  }
}

function renderTrace(lines, trace) {
  if (!trace.present) {
    lines.push(`Trace absent: ${trace.reason}`);
    return;
  }
  lines.push(`Trace ${trace.protocol_version}`);
  lines.push(`- run=${trace.run_id} module=${trace.module_ref} entry=${trace.entry_ref}`);
  lines.push(`- status=${trace.status} events=${trace.events}`);
  if (trace.reason) lines.push(`- reason=${trace.reason}`);
  if (Object.values(trace.human_approvals).some(value => typeof value === "number" && value > 0)) lines.push(
    `- human_approvals requested=${trace.human_approvals.requested} paused=${trace.human_approvals.paused} approved=${trace.human_approvals.approved} rejected=${trace.human_approvals.rejected} expired=${trace.human_approvals.expired} cancelled=${trace.human_approvals.cancelled}`,
  );
  if (Object.values(trace.user_interactions).some(value => typeof value === "number" && value > 0)) lines.push(
    `- user_interactions shown=${trace.user_interactions.shown} requested=${trace.user_interactions.requested} paused=${trace.user_interactions.paused} answered=${trace.user_interactions.answered}`,
  );
  if (trace.bindings.created > 0) lines.push(`- bindings created=${trace.bindings.created}`);
  if (Object.values(trace.agent_invocations).some(value => typeof value === "number" && value > 0)) lines.push(
    `- agent_invocations authorized=${trace.agent_invocations.authorized} refused=${trace.agent_invocations.refused}`,
  );
  if (Object.values(trace.memory_accesses).some(value => typeof value === "number" && value > 0)) lines.push(
    `- memory_accesses authorized=${trace.memory_accesses.authorized} refused=${trace.memory_accesses.refused}`,
  );
  if (Object.values(trace.memory_metadata).some(value => typeof value === "number" && value > 0)) lines.push(
    `- memory_metadata provenance_observed=${trace.memory_metadata.provenance_observed} integrity_observed=${trace.memory_metadata.integrity_observed} metadata_refused=${trace.memory_metadata.metadata_refused} integrity_refused=${trace.memory_metadata.integrity_refused} evidence=[${trace.memory_metadata.evidence.join(",")}]`,
  );
  if (Object.values(trace.triggers).some(value => typeof value === "number" && value > 0)) lines.push(
    `- triggers received=${trace.triggers.received} accepted=${trace.triggers.accepted} refused=${trace.triggers.refused} rate_limited=${trace.triggers.rate_limited} started=${trace.triggers.started} completed=${trace.triggers.completed} failed=${trace.triggers.failed}`,
  );
  if (Object.values(trace.run_controls).some(value => typeof value === "number" && value > 0)) lines.push(
    `- run_controls cancel_requested=${trace.run_controls.cancel_requested} cancelled=${trace.run_controls.cancelled} timeout_exceeded=${trace.run_controls.timeout_exceeded} kill_switch_enabled=${trace.run_controls.kill_switch_enabled} kill_switch_disabled=${trace.run_controls.kill_switch_disabled} dispatch_refused_cancelled=${trace.run_controls.dispatch_refused_cancelled}`,
  );
  if (Object.values(trace.budgets).some(value => typeof value === "number" && value > 0)) lines.push(
    `- budgets checked=${trace.budgets.checked} consumed=${trace.budgets.consumed} exceeded=${trace.budgets.exceeded} dispatch_refused=${trace.budgets.dispatch_refused} kinds=[${trace.budgets.kinds.join(",")}]`,
  );
  if (trace.source_path) {
    lines.push(`- source=${trace.source_path}`);
  }
  for (const limit of trace.effective_limits ?? []) {
    lines.push(`- limit ${limit.kind}=${limit.limit} authority=${limit.authority}`);
  }
  if (trace.chronology?.length) {
    lines.push("Chronology:");
    for (const event of trace.chronology.slice(0, 100)) {
      const fields = Object.entries(event).filter(([key]) => key !== "index" && key !== "kind")
        .map(([key, value]) => `${key}=${key === "reported_reason" ? JSON.stringify(value.length > 240 ? `${value.slice(0, 240)}…` : value) : value}`).join(" ");
      lines.push(`  ${event.index} ${event.kind}${fields ? ` ${fields}` : ""}`);
    }
    if (trace.chronology.length > 100) lines.push(`  ${trace.chronology.length - 100} additional events; use --json for the full chronology.`);
  }
}

function renderArchitecture(lines, architecture) {
  if (!architecture.present) {
    lines.push(`Architecture absent: ${architecture.reason}`);
    return;
  }
  lines.push(`Architecture ${architecture.projection_schema_version}`);
  lines.push(`- module=${architecture.module_ref} name=${architecture.module_name}`);
  lines.push(
    `- test_only=${architecture.test_only} nodes=${architecture.nodes} links=${architecture.links} unresolved_references=${architecture.unresolved_references}`,
  );
}

function renderManifest(lines, manifest) {
  if (!manifest.present) {
    lines.push(`Manifest absent: ${manifest.reason}`);
    return;
  }
  lines.push(`Manifest ${manifest.manifest_version}`);
  lines.push(
    `- bindings=${manifest.binding_count} triggers=${manifest.trigger_count} run_limits=${manifest.run_limits.length} agent_secret_scopes=${manifest.agent_secret_scopes.length}`,
  );
  for (const binding of manifest.bindings) {
    lines.push(
      `- binding ${binding.tool_ref} handler=${binding.handler_kind} command=${valueOrAbsent(
        binding.handler_command,
      )} args=[${binding.handler_args.join(",")}] grants=[${binding.grants.join(",")}] secrets=[${binding.secrets.join(",")}] memories=[${formatManifestMemories(
        binding.memories,
      )}] timeout_ms=${valueOrAbsent(
        binding.timeout_ms,
      )} max_payload_bytes=${valueOrAbsent(binding.max_payload_bytes)}`,
    );
    if (binding.handler_cwd) {
      lines.push(`  cwd=${binding.handler_cwd}`);
    }
    if (binding.effect_contract) {
      lines.push(`  effect_contract=${formatEffectContract(binding.effect_contract)}`);
    }
  }
  for (const trigger of manifest.triggers) {
    lines.push(
      `- trigger ${trigger.trigger_ref} enabled=${trigger.enabled} source=${valueOrAbsent(
        trigger.source_kind,
      )} timezone=${valueOrAbsent(trigger.timezone)} limits=${formatTriggerLimits(
        trigger.limits,
      )}`,
    );
  }
  if (manifest.run_limits.length > 0) {
    lines.push(`- run_limits ${formatBudgetEntries(manifest.run_limits)}`);
  }
  for (const scope of manifest.agent_secret_scopes) {
    lines.push(`- agent_scope ${scope.agent_ref} secrets=[${scope.secrets.join(",")}]`);
  }
}

function renderPackage(lines, packageSummary) {
  if (!packageSummary.present) {
    lines.push(`Package absent: ${packageSummary.reason}`);
    return;
  }
  lines.push(`Package ${packageSummary.package_schema_version}`);
  lines.push(
    `- name=${valueOrAbsent(packageSummary.name)} version=${valueOrAbsent(
      packageSummary.version,
    )} root=${valueOrAbsent(packageSummary.root)}`,
  );
  lines.push(
    `- air_profile=${valueOrAbsent(
      packageSummary.air_profile,
    )} runtime_compatibility=${valueOrAbsent(
      packageSummary.runtime_compatibility,
    )} exports=${packageSummary.export_count} contract_tests=${packageSummary.contract_tests.length}`,
  );
  for (const exported of packageSummary.exports) {
    lines.push(`- export ${exported.kind} ${exported.ref}`);
  }
  if (packageSummary.provenance_kind || packageSummary.provenance_source) {
    lines.push(
      `- provenance kind=${valueOrAbsent(
        packageSummary.provenance_kind,
      )} source=${valueOrAbsent(packageSummary.provenance_source)}`,
    );
  }
}

function renderBindingFragment(lines, fragment) {
  if (!fragment.present) {
    lines.push(`Binding fragment absent: ${fragment.reason}`);
    return;
  }
  lines.push(`Binding fragment ${fragment.fragment_schema_version}`);
  lines.push(
    `- source_kind=${valueOrAbsent(fragment.source_kind)} source_module=${valueOrAbsent(
      fragment.source_module,
    )} source_package=${valueOrAbsent(fragment.source_package)} bindings=${fragment.binding_count}`,
  );
  for (const binding of fragment.bindings) {
    lines.push(
      `- fragment_binding ${binding.tool_ref} handler=${valueOrAbsent(
        binding.handler_kind,
      )} command=${valueOrAbsent(binding.handler_command)} args=[${binding.handler_args.join(
        ",",
      )}] grants=[${binding.grants.join(",")}] secrets=[${binding.secrets.join(
        ",",
      )}] timeout_ms=${valueOrAbsent(binding.timeout_ms)} max_payload_bytes=${valueOrAbsent(
        binding.max_payload_bytes,
      )} payload_constraints=${binding.payload_constraints}`,
    );
    if (binding.handler_cwd) {
      lines.push(`  cwd=${binding.handler_cwd}`);
    }
    if (binding.effect_contract) {
      lines.push(`  effect_contract=${formatEffectContract(binding.effect_contract)}`);
    }
  }
}

function renderResourceBindings(lines, resourceBindings) {
  if (!resourceBindings.present) {
    lines.push(`Resource bindings absent: ${resourceBindings.reason}`);
    return;
  }
  lines.push(`Resource bindings ${resourceBindings.resource_bindings_schema_version}`);
  lines.push(
    `- resources=${resourceBindings.resource_count} active=${resourceBindings.active_count} inactive=${resourceBindings.inactive_count}`,
  );
  for (const resource of resourceBindings.resources) {
    lines.push(
      `- resource ${resource.resource_ref} kind=${valueOrAbsent(
        resource.kind,
      )} provider=${valueOrAbsent(resource.provider)} active=${resource.active} grants=[${resource.grants.join(
        ",",
      )}] secrets=[${resource.secrets.join(",")}] required_secrets=[${resource.required_secrets.join(
        ",",
      )}] max_payload_bytes=${valueOrAbsent(resource.max_payload_bytes)}`,
    );
  }
}

function renderRunPlan(lines, runPlan) {
  if (!runPlan.present) {
    lines.push(`Run plan absent: ${runPlan.reason}`);
    return;
  }
  lines.push(`Run plan ${runPlan.run_plan_schema_version}`);
  lines.push(
    `- entry=${valueOrAbsent(runPlan.entry_ref)} profile=${valueOrAbsent(
      runPlan.profile,
    )} air=${valueOrAbsent(runPlan.air)} manifest=${valueOrAbsent(
      runPlan.manifest,
    )} secrets_profile=${valueOrAbsent(runPlan.secrets_profile)} supply_chain_lock=${valueOrAbsent(
      runPlan.supply_chain_lock,
    )}`,
  );
  if (runPlan.run_limits.length > 0) {
    lines.push(`- run_plan_limits ${formatBudgetEntries(runPlan.run_limits)}`);
  }
  lines.push(
    `- outputs mode=${valueOrAbsent(runPlan.output_mode)} trace_out=${valueOrAbsent(
      runPlan.trace_out,
    )} trigger_manifest=${valueOrAbsent(runPlan.trigger_manifest)}`,
  );
}

function renderOwnership(lines, ownership) {
  if (!ownership.present) {
    lines.push(`Ownership absent: ${ownership.reason}`);
    return;
  }
  lines.push(`Ownership ${ownership.ownership_schema_version}`);
  lines.push(
    `- teams=${ownership.team_count} owners=${ownership.owner_count} review_gates=${ownership.review_gate_count} reviews=${ownership.review_count}`,
  );
  for (const team of ownership.teams) {
    lines.push(
      `- team ${team.team_ref} name=${valueOrAbsent(team.display_name)}`,
    );
  }
  for (const owner of ownership.owners) {
    lines.push(`- owner ${owner.target_ref} teams=[${owner.teams.join(",")}]`);
  }
  for (const gate of ownership.review_gates) {
    lines.push(
      `- review_gate ${gate.profile} subjects=[${gate.requires_review_for.join(
        ",",
      )}] reviewers=[${gate.reviewers.join(",")}]`,
    );
  }
  for (const review of ownership.reviews) {
    lines.push(
      `- review ${review.review_id} profile=${valueOrAbsent(
        review.profile,
      )} target=${valueOrAbsent(review.target_ref)} reviewer=${valueOrAbsent(
        review.reviewer,
      )} decision=${valueOrAbsent(review.decision)} evidence=${valueOrAbsent(
        review.evidence_ref,
      )}`,
    );
  }
}

function renderWorkspacePackageSurface(lines, surface) {
  if (!surface?.present) return;
  const availability = surface.availability;
  lines.push("Availability graph");
  if (!availability.present) {
    lines.push("- absent: no AIR module, import or package export artifact provided");
  } else {
    for (const module of availability.modules) {
      lines.push(`- module source=${module.source} ref=${module.ref} name=${module.name}`);
    }
    if (availability.declarations) {
      lines.push(
        `- declarations constants=${availability.declarations.constants} types=${availability.declarations.types} functions=${availability.declarations.functions} tools=${availability.declarations.tools} memories=${availability.declarations.memories} skills=${availability.declarations.skills} agents=${availability.declarations.agents} strategies=${availability.declarations.strategies} triggers=${availability.declarations.triggers}`,
      );
    }
    if (availability.imports) {
      lines.push(
        `- imports total=${availability.imports.total} resolved=${availability.imports.resolved} unresolved=${availability.imports.unresolved}`,
      );
    }
    if (availability.package_name) {
      lines.push(
        `- package name=${availability.package_name} version=${valueOrAbsent(
          availability.package_version,
        )} exports=${availability.package_exports.length}`,
      );
      for (const exported of availability.package_exports) {
        lines.push(`- package_export ${exported.kind} ${exported.ref}`);
      }
    }
  }

  const authority = surface.authority;
  lines.push("Authority graph");
  if (!authority.present) {
    lines.push("- absent: no AIR, manifest, resource binding, run plan or lock artifact provided");
  } else {
    if (authority.air) {
      lines.push(
        `- air required_capabilities=${authority.air.required_capabilities} required_secrets=${authority.air.required_secrets} memory_accesses=${authority.air.memory_accesses} memory_scopes=${authority.air.memory_scopes} callable_by=${authority.air.callable_by}`,
      );
    }
    if (authority.manifest) {
      lines.push(
        `- manifest bindings=${authority.manifest.bindings} triggers=${authority.manifest.triggers} run_limits=${authority.manifest.run_limits} agent_secret_scopes=${authority.manifest.agent_secret_scopes}`,
      );
    }
    if (authority.binding_fragment) {
      lines.push(
        `- binding_fragment bindings=${authority.binding_fragment.bindings} source_kind=${valueOrAbsent(
          authority.binding_fragment.source_kind,
        )} status=not_runtime_authority`,
      );
    }
    if (authority.resource_bindings) {
      lines.push(
        `- resource_bindings resources=${authority.resource_bindings.resources} active=${authority.resource_bindings.active} inactive=${authority.resource_bindings.inactive}`,
      );
    }
    if (authority.run_plan) {
      lines.push(
        `- run_plan entry=${valueOrAbsent(authority.run_plan.entry_ref)} profile=${valueOrAbsent(
          authority.run_plan.profile,
        )} manifest=${authority.run_plan.has_manifest} secrets_profile=${authority.run_plan.has_secrets_profile} supply_chain_lock=${authority.run_plan.has_supply_chain_lock}`,
      );
    }
    if (authority.supply_chain) {
      lines.push(
        `- supply_chain kind=${authority.supply_chain.kind} diagnostics=${valueOrAbsent(
          authority.supply_chain.diagnostics,
        )} codes=[${authority.supply_chain.diagnostic_codes.join(",")}]`,
      );
    }
  }

  const responsibility = surface.responsibility;
  lines.push("Responsibility graph");
  if (!responsibility.present) {
    lines.push("- absent: no ownership artifact provided");
    return;
  }
  lines.push(
    `- ownership teams=${responsibility.ownership.teams} owners=${responsibility.ownership.owners} review_gates=${responsibility.ownership.review_gates} reviews=${responsibility.ownership.reviews} status=not_runtime_authority`,
  );
}

function renderTraceAudit(lines, traceAudit) {
  if (!traceAudit.present) {
    lines.push(`Trace audit absent: ${traceAudit.reason}`);
    return;
  }
  lines.push(`Trace audit ${traceAudit.schema_version}`);
  lines.push(
    `- kind=${traceAudit.artifact_kind} run=${valueOrAbsent(traceAudit.run_id)} status=${valueOrAbsent(
      traceAudit.status,
    )}`,
  );
  lines.push(
    `- retention=${valueOrAbsent(traceAudit.retention_class)} redaction=${valueOrAbsent(
      traceAudit.redaction_policy,
    )}`,
  );
  lines.push(
    `- digests=[${traceAudit.digests.join(",")}] export_artifacts=[${traceAudit.export_artifacts.join(
      ",",
    )}] diagnostics=${traceAudit.diagnostics} codes=[${traceAudit.diagnostic_codes.join(",")}]`,
  );
}

function renderTraceTimeline(lines, traceTimeline) {
  if (!traceTimeline.present) {
    lines.push(`Trace timeline absent: ${traceTimeline.reason}`);
    return;
  }
  lines.push(`Trace timeline ${traceTimeline.schema_version}`);
  lines.push(
    `- run=${valueOrAbsent(traceTimeline.run_id)} trace=${valueOrAbsent(
      traceTimeline.trace_ref,
    )} events=${traceTimeline.events}`,
  );
  lines.push(
    `- severities debug=${traceTimeline.severity_counts.debug} info=${traceTimeline.severity_counts.info} warning=${traceTimeline.severity_counts.warning} error=${traceTimeline.severity_counts.error}`,
  );
  lines.push(
    `- first=${valueOrAbsent(traceTimeline.first_event_type)} last=${valueOrAbsent(
      traceTimeline.last_event_type,
    )}`,
  );
  lines.push(
    `- top_types=[${traceTimeline.top_event_types
      .map((item) => `${item.type}:${item.count}`)
      .join(",")}]`,
  );
}

function renderSupplyChain(lines, supplyChain) {
  if (!supplyChain.present) {
    lines.push(`Supply chain absent: ${supplyChain.reason}`);
    return;
  }
  lines.push(`Supply chain ${supplyChain.schema_version}`);
  lines.push(
    `- kind=${supplyChain.artifact_kind} status=${valueOrAbsent(supplyChain.status)} diagnostics=${valueOrAbsent(
      supplyChain.diagnostics,
    )} codes=[${supplyChain.diagnostic_codes.join(",")}]`,
  );
  if (supplyChain.artifact_kind === "supply_chain_validation_report") {
    lines.push(
      `- lock=${valueOrAbsent(supplyChain.lock_schema_version)} air=${valueOrAbsent(
        supplyChain.air_drift,
      )} manifest=${valueOrAbsent(supplyChain.manifest_drift)} handlers=${supplyChain.handlers.length}`,
    );
    renderSupplyChainProvenance(lines, supplyChain.provenance);
    renderSupplyChainReview(lines, supplyChain.review);
    for (const handler of supplyChain.handlers) {
      lines.push(
        `- handler ${handler.tool_ref} drift=${valueOrAbsent(handler.drift_status)} sdk=${valueOrAbsent(
          handler.sdk_status,
        )} package=${valueOrAbsent(handler.handler_package_status)} package_files=${valueOrAbsent(
          handler.handler_package_files_status,
        )} dependencies=${valueOrAbsent(handler.handler_dependency_artifacts_status)} diagnostics=${handler.diagnostics}`,
      );
    }
    return;
  }

  lines.push(
    `- generated_by=${valueOrAbsent(supplyChain.generated_by)} version=${valueOrAbsent(
      supplyChain.generated_version,
    )}`,
  );
  renderSupplyChainProvenance(lines, supplyChain.provenance);
  renderSupplyChainReview(lines, supplyChain.review);
  lines.push(
    `- air=${valueOrAbsent(supplyChain.air_path)} digest=${formatDigest(supplyChain.air_digest)}`,
  );
  lines.push(
    `- manifest=${valueOrAbsent(supplyChain.manifest_path)} digest=${formatDigest(
      supplyChain.manifest_digest,
    )}`,
  );
  for (const handler of supplyChain.handlers) {
    lines.push(
      `- handler ${handler.tool_ref} path=${valueOrAbsent(handler.path)} command=${valueOrAbsent(
        handler.command,
      )} cwd=${valueOrAbsent(handler.cwd)} args=[${handler.args.join(",")}] digest=${formatDigest(
        handler.digest,
      )} sdk=${valueOrAbsent(handler.sdk_name)}@${valueOrAbsent(handler.sdk_version)} protocol=${valueOrAbsent(
        handler.sdk_protocol,
      )} status=${valueOrAbsent(
        handler.sdk_status,
      )} package=${valueOrAbsent(handler.handler_package_name)}@${valueOrAbsent(
        handler.handler_package_version,
      )} kind=${valueOrAbsent(handler.handler_package_kind)} entrypoint=${valueOrAbsent(
        handler.handler_package_entrypoint,
      )} package_root=${valueOrAbsent(handler.handler_package_root)} files=${valueOrAbsent(
        handler.handler_package_files,
      )} dependencies=${valueOrAbsent(
        handler.handler_dependency_artifacts,
      )}`,
    );
  }
}

function renderSupplyChainProvenance(lines, provenance) {
  lines.push(
    `- provenance status=${valueOrAbsent(provenance?.status)} prepared_by=${valueOrAbsent(
      provenance?.prepared_by_kind,
    )}:${valueOrAbsent(provenance?.prepared_by_id)} prepared_at=${valueOrAbsent(
      provenance?.prepared_at,
    )} source=${valueOrAbsent(provenance?.source_kind)}:${valueOrAbsent(
      provenance?.source_ref,
    )} commit=${valueOrAbsent(provenance?.source_commit)}`,
  );
}

function renderSupplyChainReview(lines, review) {
  lines.push(
    `- review status=${valueOrAbsent(review?.status)} evidence=${valueOrAbsent(
      review?.evidence_status,
    )} required=${review?.required ? "yes" : "no"} reviewed_at=${valueOrAbsent(
      review?.reviewed_at,
    )} reviewers=${valueOrAbsent(review?.reviewers)} evidence_items=${valueOrAbsent(review?.evidence)}`,
  );
}

function renderTriggerState(lines, triggerState) {
  if (!triggerState.present) {
    lines.push(`Trigger state absent: ${triggerState.reason}`);
    return;
  }
  lines.push(`Trigger state ${triggerState.schema_version}`);
  lines.push(
    `- triggers=${triggerState.trigger_count} accepted=${triggerState.accepted_count} refused=${triggerState.refused_count} consumed_event_ids=${triggerState.consumed_event_count}`,
  );
  lines.push(
    `- created_at=${valueOrAbsent(triggerState.created_at)} updated_at=${valueOrAbsent(triggerState.updated_at)}`,
  );
  for (const trigger of triggerState.triggers) {
    lines.push(
      `- trigger ${trigger.trigger_ref} accepted=${trigger.accepted_count} refused=${trigger.refused_count} consumed=${trigger.consumed_event_count} last_event_id=${valueOrAbsent(
        trigger.last_event_id,
      )} last_status=${valueOrAbsent(trigger.last_status)} reasons=[${trigger.reasons.join(",")}]`,
    );
  }
}

function renderEffectiveProject(lines, effectiveProject) {
  if (!effectiveProject.present) {
    lines.push(`Effective project absent: ${effectiveProject.reason}`);
    return;
  }
  lines.push(`Effective project ${effectiveProject.schema_version}`);
  lines.push(
    `- role=${effectiveProject.artifact_role} layout=${valueOrAbsent(effectiveProject.artifact_layout)} profile=${valueOrAbsent(effectiveProject.profile)} inputs=${effectiveProject.input_count}`,
  );
  for (const section of effectiveProject.sections) {
    lines.push(
      `- ${section.name} provenance=${section.status} sources=[${section.sources.join(",")}]`,
    );
  }
  for (const binding of effectiveProject.effect_contracts ?? []) {
    lines.push(
      `- effect_contract ${binding.tool_ref} ${formatEffectContract(binding.effect_contract)}`,
    );
  }
}

function renderCompatibility(lines, compatibility) {
  if (!compatibility || compatibility.diagnostics.length === 0) {
    lines.push("Compatibility ok");
    return;
  }
  lines.push("Compatibility mismatches:");
  for (const diagnostic of compatibility.diagnostics) {
    lines.push(`- ${diagnostic.code}: ${diagnostic.message}`);
  }
}

function validateCompatibility({
  source,
  air,
  trace,
  architecture,
  manifest,
  package: packageSummary,
  binding_fragment: bindingFragment,
  resource_bindings: resourceBindings,
  run_plan: runPlan,
  ownership,
  artifacts,
}) {
  const diagnostics = [];

  if (air.present && air.schema_version !== EXPECTED_AIR_SCHEMA_VERSION) {
    diagnostics.push({
      code: "AirSchemaMismatch",
      message: `expected ${EXPECTED_AIR_SCHEMA_VERSION}, got ${valueOrAbsent(air.schema_version)}`,
    });
  }
  if (trace.present && trace.protocol_version !== EXPECTED_TRACE_PROTOCOL_VERSION) {
    diagnostics.push({
      code: "TraceProtocolMismatch",
      message: `expected ${EXPECTED_TRACE_PROTOCOL_VERSION}, got ${valueOrAbsent(trace.protocol_version)}`,
    });
  }
  if (
    architecture.present &&
    architecture.projection_schema_version !== EXPECTED_ARCHITECTURE_SCHEMA_VERSION
  ) {
    diagnostics.push({
      code: "ArchitectureSchemaMismatch",
      message: `expected ${EXPECTED_ARCHITECTURE_SCHEMA_VERSION}, got ${valueOrAbsent(
        architecture.projection_schema_version,
      )}`,
    });
  }
  if (manifest.present && !SUPPORTED_MANIFEST_VERSIONS.has(manifest.manifest_version)) {
    diagnostics.push({
      code: "ManifestVersionMismatch",
      message: `expected ${[...SUPPORTED_MANIFEST_VERSIONS].join(" or ")}, got ${valueOrAbsent(
        manifest.manifest_version,
      )}`,
    });
  }
  if (
    packageSummary.present &&
    packageSummary.package_schema_version !== EXPECTED_PACKAGE_SCHEMA_VERSION
  ) {
    diagnostics.push({
      code: "PackageSchemaMismatch",
      message: `expected ${EXPECTED_PACKAGE_SCHEMA_VERSION}, got ${valueOrAbsent(
        packageSummary.package_schema_version,
      )}`,
    });
  }
  if (
    bindingFragment.present &&
    bindingFragment.fragment_schema_version !== EXPECTED_BINDING_FRAGMENT_SCHEMA_VERSION
  ) {
    diagnostics.push({
      code: "BindingFragmentSchemaMismatch",
      message: `expected ${EXPECTED_BINDING_FRAGMENT_SCHEMA_VERSION}, got ${valueOrAbsent(
        bindingFragment.fragment_schema_version,
      )}`,
    });
  }
  if (
    resourceBindings.present &&
    resourceBindings.resource_bindings_schema_version !==
      EXPECTED_RESOURCE_BINDINGS_SCHEMA_VERSION
  ) {
    diagnostics.push({
      code: "ResourceBindingsSchemaMismatch",
      message: `expected ${EXPECTED_RESOURCE_BINDINGS_SCHEMA_VERSION}, got ${valueOrAbsent(
        resourceBindings.resource_bindings_schema_version,
      )}`,
    });
  }
  if (runPlan.present && runPlan.run_plan_schema_version !== EXPECTED_RUN_PLAN_SCHEMA_VERSION) {
    diagnostics.push({
      code: "RunPlanSchemaMismatch",
      message: `expected ${EXPECTED_RUN_PLAN_SCHEMA_VERSION}, got ${valueOrAbsent(
        runPlan.run_plan_schema_version,
      )}`,
    });
  }
  if (
    ownership.present &&
    ownership.ownership_schema_version !== EXPECTED_OWNERSHIP_SCHEMA_VERSION
  ) {
    diagnostics.push({
      code: "OwnershipSchemaMismatch",
      message: `expected ${EXPECTED_OWNERSHIP_SCHEMA_VERSION}, got ${valueOrAbsent(
        ownership.ownership_schema_version,
      )}`,
    });
  }

  if (air.present && trace.present && air.module_ref !== trace.module_ref) {
    diagnostics.push({
      code: "AirTraceModuleMismatch",
      message: `AIR module ${valueOrAbsent(air.module_ref)} differs from trace module ${valueOrAbsent(
        trace.module_ref,
      )}`,
    });
  }
  if (air.present && architecture.present && air.module_ref !== architecture.module_ref) {
    diagnostics.push({
      code: "AirArchitectureModuleMismatch",
      message: `AIR module ${valueOrAbsent(
        air.module_ref,
      )} differs from architecture module ${valueOrAbsent(architecture.module_ref)}`,
    });
  }
  if (air.present && manifest.present) {
    validateAirManifestCompatibility(diagnostics, artifacts.air, artifacts.manifest);
  }
  if (air.present && resourceBindings.present) {
    validateAirResourceBindingsCompatibility(
      diagnostics,
      artifacts.air,
      artifacts.resource_bindings,
    );
  }
  if (air.present && bindingFragment.present) {
    validateAirBindingFragmentCompatibility(
      diagnostics,
      artifacts.air,
      artifacts.binding_fragment,
    );
  }
  if (air.present && runPlan.present) {
    validateAirRunPlanCompatibility(diagnostics, artifacts.air, artifacts.run_plan);
  }

  if (source.present) {
    validateSourceRefs(diagnostics, "AIR", source.path, artifacts.air);
    validateSourceRefs(diagnostics, "trace", source.path, artifacts.trace);
    validateSourceRefs(diagnostics, "architecture", source.path, artifacts.architecture);
  }

  return { diagnostics };
}

function validateAirManifestCompatibility(diagnostics, airDocument, manifestDocument) {
  const tools = airDocument?.definitions?.tools ?? [];
  const triggers = airDocument?.definitions?.triggers ?? [];
  const bindings = manifestDocument?.bindings ?? {};
  const manifestTriggers = manifestDocument?.triggers ?? {};
  const bindingRefs = new Set(Object.keys(bindings));
  const manifestTriggerRefs = new Set(Object.keys(manifestTriggers));
  const toolRefs = new Set(tools.map((tool) => tool.id));
  const triggerRefs = new Set(triggers.map((trigger) => trigger.id));
  const airRunBudgets = airDocument?.budgets?.run ?? {};
  const manifestRunLimits = manifestDocument?.run_limits ?? {};

  for (const tool of tools) {
    const binding = bindings[tool.id];
    if (!binding) {
      diagnostics.push({
        code: "MissingToolBinding",
        message: `manifest has no binding for ${tool.id}`,
      });
      continue;
    }
    const grants = new Set(binding.grants ?? []);
    for (const capability of tool.required_capabilities ?? []) {
      if (!grants.has(capability)) {
        diagnostics.push({
          code: "MissingToolGrant",
          message: `binding ${tool.id} is missing grant ${capability}`,
        });
      }
    }
    const bindingSecrets = new Set(binding.secrets ?? []);
    for (const secret of tool.required_secrets ?? []) {
      if (!bindingSecrets.has(secret)) {
        diagnostics.push({
          code: "MissingToolSecretGrant",
          message: `binding ${tool.id} is missing secret handle ${secret}`,
        });
      }
    }
    const bindingMemories = new Set(
      (binding.memories ?? []).map((memory) => memoryAccessKey(memory.ref, memory.access)),
    );
    for (const memoryAccess of tool.memory_accesses ?? []) {
      if (!bindingMemories.has(memoryAccessKey(memoryAccess.memory_ref, memoryAccess.access))) {
        diagnostics.push({
          code: "MissingToolMemoryGrant",
          message: `binding ${tool.id} is missing memory access ${memoryAccess.memory_ref}:${memoryAccess.access}`,
        });
      }
    }
  }

  for (const bindingRef of bindingRefs) {
    if (!toolRefs.has(bindingRef)) {
      diagnostics.push({
        code: "UnknownManifestBindingTool",
        message: `manifest binding ${bindingRef} has no matching AIR tool`,
      });
    }
  }

  for (const trigger of triggers) {
    const manifestTrigger = manifestTriggers[trigger.id];
    if (!manifestTrigger) {
      diagnostics.push({
        code: "MissingTriggerActivation",
        message: `manifest has no trigger entry for ${trigger.id}`,
      });
      continue;
    }
    const airSourceKind = trigger.event?.kind;
    const manifestSourceKind = manifestTrigger.source?.kind;
    if (
      typeof airSourceKind === "string" &&
      typeof manifestSourceKind === "string" &&
      airSourceKind !== manifestSourceKind
    ) {
      diagnostics.push({
        code: "TriggerSourceMismatch",
        message: `manifest trigger ${trigger.id} source ${manifestSourceKind} differs from AIR source ${airSourceKind}`,
      });
    }
    for (const limitName of ["max_runs_per_day", "timeout_ms"]) {
      const airLimit = trigger.limits?.[limitName];
      const manifestLimit = manifestTrigger.limits?.[limitName];
      if (
        typeof airLimit === "number" &&
        typeof manifestLimit === "number" &&
        manifestLimit > airLimit
      ) {
        diagnostics.push({
          code: "TriggerLimitExceeded",
          message: `manifest trigger ${trigger.id} ${limitName}=${manifestLimit} exceeds AIR limit ${airLimit}`,
        });
      }
    }
  }

  for (const triggerRef of manifestTriggerRefs) {
    if (!triggerRefs.has(triggerRef)) {
      diagnostics.push({
        code: "UnknownManifestTrigger",
        message: `manifest trigger ${triggerRef} has no matching AIR trigger`,
      });
    }
  }

  for (const [budgetKind, manifestLimit] of Object.entries(manifestRunLimits)) {
    const airLimit = airRunBudgets[budgetKind]?.value;
    if (
      typeof airLimit === "number" &&
      typeof manifestLimit === "number" &&
      manifestLimit > airLimit
    ) {
      diagnostics.push({
        code: "RunLimitExceeded",
        message: `manifest run_limits.${budgetKind}=${manifestLimit} exceeds AIR budget ${airLimit}`,
      });
    }
  }
}

function validateAirBindingFragmentCompatibility(diagnostics, airDocument, fragmentDocument) {
  const toolRefs = new Set((airDocument?.definitions?.tools ?? []).map((tool) => tool.id));
  const toolsByRef = new Map((airDocument?.definitions?.tools ?? []).map((tool) => [tool.id, tool]));
  for (const [toolRef, binding] of Object.entries(fragmentDocument?.bindings ?? {})) {
    if (!toolRefs.has(toolRef)) {
      diagnostics.push({
        code: "BindingFragmentUnknownTool",
        message: `binding fragment references unknown AIR tool ${toolRef}`,
      });
      continue;
    }
    const tool = toolsByRef.get(toolRef);
    const grants = new Set(binding.grants ?? []);
    for (const capability of tool?.required_capabilities ?? []) {
      if (!grants.has(capability)) {
        diagnostics.push({
          code: "BindingFragmentMissingGrant",
          message: `binding fragment ${toolRef} is missing grant ${capability}`,
        });
      }
    }
    const secrets = new Set(binding.secrets ?? []);
    for (const secret of tool?.required_secrets ?? []) {
      if (!secrets.has(secret)) {
        diagnostics.push({
          code: "BindingFragmentMissingSecret",
          message: `binding fragment ${toolRef} is missing secret handle ${secret}`,
        });
      }
    }
  }
}

function validateAirResourceBindingsCompatibility(diagnostics, airDocument, resourceBindingsDocument) {
  const logicalResources = collectLogicalResourceRefs(airDocument);
  const resources = resourceBindingsDocument?.resources ?? {};
  for (const [resourceRef, binding] of Object.entries(resources)) {
    if (!logicalResources.has(resourceRef)) {
      diagnostics.push({
        code: "ResourceBindingUnknownResource",
        message: `resource binding ${resourceRef} has no matching AIR resource`,
      });
      continue;
    }
    if (binding.active === false) {
      diagnostics.push({
        code: "ResourceBindingInactive",
        message: `resource binding ${resourceRef} is declared but inactive`,
      });
    }
    const requiredSecrets = binding.required_secrets ?? [];
    const secrets = new Set(binding.secrets ?? []);
    for (const secret of requiredSecrets) {
      if (!secrets.has(secret)) {
        diagnostics.push({
          code: "ResourceBindingSecretMissing",
          message: `resource binding ${resourceRef} is missing required secret handle ${secret}`,
        });
      }
    }
  }
}

function validateAirRunPlanCompatibility(diagnostics, airDocument, runPlanDocument) {
  const entryRefs = collectExecutableEntryRefs(airDocument);
  const entryRef = runPlanDocument?.entry_ref;
  if (typeof entryRef === "string" && !entryRefs.has(entryRef)) {
    diagnostics.push({
      code: "RunPlanEntryUnknown",
      message: `run plan entry_ref ${entryRef} is not an executable AIR entry`,
    });
  }
}

function collectLogicalResourceRefs(airDocument) {
  const refs = new Set();
  for (const memory of airDocument?.definitions?.memories ?? []) {
    if (typeof memory.id === "string") refs.add(memory.id);
  }
  for (const trigger of airDocument?.definitions?.triggers ?? []) {
    if (typeof trigger.id === "string") refs.add(trigger.id);
  }
  for (const agent of airDocument?.definitions?.agents ?? []) {
    if (typeof agent.id === "string") refs.add(agent.id);
  }
  return refs;
}

function collectExecutableEntryRefs(airDocument) {
  const refs = new Set();
  for (const key of ["functions", "skills", "agents", "strategies"]) {
    for (const declaration of airDocument?.definitions?.[key] ?? []) {
      if (typeof declaration.id === "string") refs.add(declaration.id);
    }
  }
  return refs;
}

function validateSourceRefs(diagnostics, label, sourcePath, artifact) {
  if (!artifact) return;
  const sourceIds = collectSourceIds(artifact);
  if (sourceIds.size === 0) return;
  const normalizedSourcePath = path.resolve(sourcePath);
  const matches = [...sourceIds].some((sourceId) => sourceIdMatchesPath(sourceId, normalizedSourcePath));
  if (!matches) {
    diagnostics.push({
      code: "SourceRefMismatch",
      message: `${label} source_ref does not reference ${normalizedSourcePath}`,
    });
  }
}

export function sourceIdMatchesPath(sourceId, normalizedSourcePath, paths = path) {
  const value = String(sourceId);
  if (!paths.isAbsolute(value) && !path.win32.isAbsolute(value)) {
    const parts = value.split("/");
    if (!parts.every(part => part && part !== "." && part !== ".." && !part.includes("\\"))) return false;
    const expected = normalizedSourcePath.split(paths.sep);
    return parts.every((part, index) => part === expected[expected.length - parts.length + index]);
  }
  if (!paths.isAbsolute(value)) return false;
  // VS Code's fsPath uses a lowercase Windows drive letter. Only that letter
  // is case-insensitive here: folders may be configured as case-sensitive.
  const identity = (candidate) => paths === path.win32
    ? candidate.replace(/^[A-Z](?=:\\)/, (letter) => letter.toLowerCase())
    : candidate;
  return identity(paths.resolve(value)) === identity(normalizedSourcePath);
}

function collectSourceIds(value, result = new Set()) {
  if (!value || typeof value !== "object") {
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSourceIds(item, result);
    }
    return result;
  }
  if (typeof value.source_ref?.source_id === "string") {
    result.add(value.source_ref.source_id);
  }
  for (const nested of Object.values(value)) {
    collectSourceIds(nested, result);
  }
  return result;
}

function compatibilityOk() {
  return { diagnostics: [] };
}

function absent(reason) {
  return { present: false, reason };
}

function count(value) {
  return Array.isArray(value) ? value.length : 0;
}

function countPayloadConstraints(payloadConstraints) {
  if (!payloadConstraints || typeof payloadConstraints !== "object") return 0;
  return Object.values(payloadConstraints).reduce((total, group) => {
    if (!group || typeof group !== "object" || Array.isArray(group)) return total;
    return total + Object.keys(group).length;
  }, 0);
}

function summarizeAirImports(air) {
  const definitionIds = collectDefinitionIds(air);
  const items = (air.imports ?? []).map((item) => {
    const resolved = definitionIds.has(item.target_ref);
    return {
      kind: item.kind,
      name: item.name,
      from_module: item.from_module,
      target_ref: item.target_ref,
      status: resolved ? "resolved" : "unresolved",
    };
  });
  return {
    total: items.length,
    resolved: items.filter((item) => item.status === "resolved").length,
    unresolved: items.filter((item) => item.status === "unresolved").length,
    items,
  };
}

function summarizeAirEntryPoints(air) {
  const definitions = air?.definitions ?? {};
  return [
    ...entrypointsFromDefinitions(air, definitions.agents, "agent"),
    ...entrypointsFromDefinitions(air, definitions.functions, "function"),
    ...entrypointsFromDefinitions(air, definitions.skills, "skill"),
    ...entrypointsFromDefinitions(air, definitions.strategies, "strategy"),
    ...entrypointsFromDefinitions(air, definitions.tools, "tool"),
    ...entrypointsFromDefinitions(air, definitions.triggers, "trigger"),
  ];
}

function entrypointsFromDefinitions(air, definitions, kind) {
  if (!Array.isArray(definitions)) {
    return [];
  }
  return definitions
    .filter((declaration) => typeof declaration?.id === "string")
    .map((declaration) => ({
      kind,
      ref: declaration.id,
      description: entrypointDescription(declaration, kind),
      ...(kind === "agent" && typeof declaration.responsibility === "string"
        ? { responsibility: declaration.responsibility }
        : {}),
      input_contract: buildAirInputContract({ air, definition: declaration, kind }),
    }));
}

function entrypointDescription(declaration, kind) {
  if (typeof declaration.description === "string" && declaration.description.trim() !== "") {
    return declaration.description;
  }
  if (kind === "trigger" && typeof declaration.target_ref === "string") {
    return `${declaration.name ?? declaration.id} targets ${declaration.target_ref}`;
  }
  return declaration.name ?? declaration.id;
}

function collectDefinitionIds(air) {
  const result = new Set();
  for (const values of Object.values(air?.definitions ?? {})) {
    if (!Array.isArray(values)) continue;
    for (const item of values) {
      if (typeof item.id === "string") {
        result.add(item.id);
      }
    }
  }
  return result;
}

function countExpressions(graphs) {
  if (!Array.isArray(graphs)) return 0;
  return graphs.reduce((total, graph) => total + count(graph.expressions), 0);
}

function countFlowEdges(graphs) {
  if (!Array.isArray(graphs)) return 0;
  return graphs.reduce((total, graph) => total + count(graph.edges), 0);
}

function countCallArguments(graphs) {
  if (!Array.isArray(graphs)) return 0;
  return graphs.reduce(
    (total, graph) =>
      total +
      (graph.nodes ?? []).reduce((nodeTotal, node) => nodeTotal + count(node.arguments), 0),
    0,
  );
}

function countResultBindings(graphs) {
  if (!Array.isArray(graphs)) return 0;
  return graphs.reduce(
    (total, graph) =>
      total + (graph.nodes ?? []).filter((node) => typeof node.result_binding === "string").length,
    0,
  );
}

function countFlowNodesByKind(graphs, kind) {
  if (!Array.isArray(graphs)) return 0;
  return graphs.reduce(
    (total, graph) => total + (graph.nodes ?? []).filter((node) => node.kind === kind).length,
    0,
  );
}

function countHumanApprovals(graphs) {
  if (!Array.isArray(graphs)) return 0;
  return graphs.reduce(
    (total, graph) =>
      total + (graph.nodes ?? []).filter((node) => node.kind === "human_approval").length,
    0,
  );
}

function countUserInteractions(graphs) {
  if (!Array.isArray(graphs)) return 0;
  return graphs.reduce(
    (total, graph) =>
      total + (graph.nodes ?? []).filter((node) => node.kind === "user_interaction").length,
    0,
  );
}

function countFailurePaths(graphs) {
  if (!Array.isArray(graphs)) return 0;
  return graphs.reduce((total, graph) => total + count(graph.failure_paths), 0);
}

function countToolRequirement(air, field) {
  return (air.definitions?.tools ?? []).reduce((total, tool) => total + count(tool[field]), 0);
}

function countCallableBy(air) {
  return (air.definitions?.agents ?? []).reduce(
    (total, agent) => total + count(agent.callable_by),
    0,
  );
}

function countMemoryScopes(air) {
  return ["skills", "agents", "strategies"].reduce(
    (total, definitionKey) =>
      total +
      (air.definitions?.[definitionKey] ?? []).reduce(
        (ownerTotal, owner) => ownerTotal + count(owner.memory_scopes),
        0,
      ),
    0,
  );
}

function summarizeMemoryModel(air) {
  const memories = (air.definitions?.memories ?? []).map((memory) => ({
    memory_ref: memory.id,
    name: memory.name,
  }));
  const toolAccesses = (air.definitions?.tools ?? []).flatMap((tool) =>
    (tool.memory_accesses ?? []).map((memoryAccess) => ({
      tool_ref: tool.id,
      memory_ref: memoryAccess.memory_ref,
      access: memoryAccess.access,
    })),
  );
  const ownerScopes = ["skills", "agents", "strategies"].flatMap((definitionKey) =>
    (air.definitions?.[definitionKey] ?? []).flatMap((owner) =>
      (owner.memory_scopes ?? []).map((scope) => ({
        owner_ref: owner.id,
        memory_ref: scope.memory_ref,
        access: scope.access,
      })),
    ),
  );
  return {
    memories,
    tool_accesses: toolAccesses,
    owner_scopes: ownerScopes,
  };
}

function summarizeAgentAuthority(air) {
  return (air.definitions?.agents ?? [])
    .filter((agent) => Array.isArray(agent.callable_by) && agent.callable_by.length > 0)
    .map((agent) => ({
      agent_ref: agent.id,
      callers: agent.callable_by.map((rule) => rule.caller_ref),
    }));
}

function summarizeAirTriggers(air) {
  return (air.definitions?.triggers ?? []).map((trigger) => ({
    trigger_ref: trigger.id,
    event_kind: trigger.event?.kind,
    event_value: trigger.event?.value,
    target_ref: trigger.target_ref,
    target_kind: trigger.target_kind,
    limits: {
      max_runs_per_day: trigger.limits?.max_runs_per_day,
      timeout_ms: trigger.limits?.timeout_ms,
    },
    arguments: (trigger.arguments ?? []).map((argument) => ({
      input: argument.input,
      value_ref: argument.value_ref,
    })),
  }));
}

function summarizeAirRunBudgets(air) {
  return Object.entries(air.budgets?.run ?? {}).map(([kind, budget]) => ({
    kind,
    value: budget?.value,
  }));
}

function summarizeHumanApprovalTrace(events) {
  const summary = {
    requested: 0,
    paused: 0,
    approved: 0,
    rejected: 0,
    expired: 0,
    cancelled: 0,
  };
  for (const event of events) {
    if (event.kind === "human_approval_requested") summary.requested += 1;
    if (event.kind === "human_approval_paused") summary.paused += 1;
    if (event.kind === "human_approval_rejected") summary.rejected += 1;
    if (event.kind === "human_approval_expired") summary.expired += 1;
    if (event.kind === "human_approval_cancelled") summary.cancelled += 1;
    if (event.kind === "human_approval_decided" && event.payload?.decision === "approved") {
      summary.approved += 1;
    }
  }
  return summary;
}

function summarizeAgentInvocationTrace(events) {
  const summary = {
    authorized: 0,
    refused: 0,
  };
  for (const event of events) {
    if (event.kind === "agent_invocation_authorized") summary.authorized += 1;
    if (event.kind === "agent_invocation_refused") summary.refused += 1;
  }
  return summary;
}

function summarizeMemoryAccessTrace(events) {
  const summary = {
    authorized: 0,
    refused: 0,
  };
  for (const event of events) {
    if (event.kind === "memory_access_authorized") summary.authorized += 1;
    if (event.kind === "memory_access_refused") summary.refused += 1;
  }
  return summary;
}

function summarizeMemoryMetadataTrace(events) {
  const summary = {
    provenance_observed: 0,
    integrity_observed: 0,
    metadata_refused: 0,
    integrity_refused: 0,
    evidence: [],
  };
  const evidence = new Set();
  for (const event of events) {
    if (event.kind === "memory_provenance_observed") summary.provenance_observed += 1;
    if (event.kind === "memory_integrity_observed") summary.integrity_observed += 1;
    if (event.kind === "memory_metadata_refused") summary.metadata_refused += 1;
    if (event.kind === "memory_integrity_refused") summary.integrity_refused += 1;
    if (
      (event.kind === "memory_integrity_observed" || event.kind === "memory_integrity_refused") &&
      typeof event.payload?.integrity_evidence === "string"
    ) {
      evidence.add(event.payload.integrity_evidence);
    }
  }
  summary.evidence = [...evidence].sort();
  return summary;
}

function summarizeTriggerTrace(events) {
  const summary = {
    received: 0,
    accepted: 0,
    refused: 0,
    rate_limited: 0,
    started: 0,
    completed: 0,
    failed: 0,
  };
  for (const event of events) {
    if (event.kind === "trigger_event_received") summary.received += 1;
    if (event.kind === "trigger_event_accepted") summary.accepted += 1;
    if (event.kind === "trigger_event_refused") summary.refused += 1;
    if (event.kind === "trigger_rate_limited") summary.rate_limited += 1;
    if (event.kind === "trigger_execution_started") summary.started += 1;
    if (event.kind === "trigger_execution_completed") summary.completed += 1;
    if (event.kind === "trigger_execution_failed") summary.failed += 1;
  }
  return summary;
}

function summarizeRunControlTrace(events) {
  const summary = {
    cancel_requested: 0,
    cancelled: 0,
    timeout_exceeded: 0,
    kill_switch_enabled: 0,
    kill_switch_disabled: 0,
    dispatch_refused_cancelled: 0,
  };
  for (const event of events) {
    if (event.kind === "run_cancel_requested") summary.cancel_requested += 1;
    if (event.kind === "run_cancelled") summary.cancelled += 1;
    if (event.kind === "run_timeout_exceeded") summary.timeout_exceeded += 1;
    if (event.kind === "kill_switch_enabled") summary.kill_switch_enabled += 1;
    if (event.kind === "kill_switch_disabled") summary.kill_switch_disabled += 1;
    if (event.kind === "dispatch_refused_cancelled") summary.dispatch_refused_cancelled += 1;
  }
  return summary;
}

function summarizeBudgetTrace(events) {
  const summary = {
    checked: 0,
    consumed: 0,
    exceeded: 0,
    dispatch_refused: 0,
    kinds: [],
  };
  const kinds = new Set();
  for (const event of events) {
    if (event.kind === "budget_limit_checked") summary.checked += 1;
    if (event.kind === "budget_consumed") summary.consumed += 1;
    if (event.kind === "budget_limit_exceeded") summary.exceeded += 1;
    if (event.kind === "dispatch_refused_budget_exceeded") summary.dispatch_refused += 1;
    if (typeof event.payload?.budget_kind === "string") {
      kinds.add(event.payload.budget_kind);
    }
  }
  summary.kinds = [...kinds].sort();
  return summary;
}

function summarizeUserInteractionTrace(events) {
  const summary = {
    shown: 0,
    requested: 0,
    paused: 0,
    answered: 0,
  };
  for (const event of events) {
    if (event.kind === "user_interaction_shown") summary.shown += 1;
    if (event.kind === "user_interaction_requested") summary.requested += 1;
    if (event.kind === "user_interaction_paused") summary.paused += 1;
    if (event.kind === "user_interaction_answered") summary.answered += 1;
  }
  return summary;
}

function summarizeBindingTrace(events) {
  return {
    created: events.filter((event) => event.kind === "binding_created").length,
  };
}

function finalRunStatus(events) {
  const completed = [...events].reverse().find((event) => event.kind === "run_completed");
  return completed?.payload?.status;
}

function usage() {
  return [
    "usage: touba-inspect <file.tb|file.air.json|file.trace.json|file.architecture.json|touba.manifest.json|touba.package.json|touba.resources.json|touba.run-plan.json|touba.effective-project.json|touba.ownership.json|trace-audit.json|touba.lock.json|touba.trigger-state.json>",
    "   or: touba-inspect [--source <file.tb>] [--air <file.air.json>] [--trace <file.trace.json>] [--architecture <file.architecture.json>] [--manifest <touba.manifest.json>] [--package <touba.package.json>] [--binding-fragment <fragment.json>] [--resource-bindings <touba.resources.json>] [--run-plan <touba.run-plan.json>] [--ownership <touba.ownership.json>] [--trace-audit <trace-audit.json>] [--supply-chain <touba.lock.json|supply-chain-report.json>] [--json] [--report-out <report.inspect.txt>] [--otel-out <trace.otel.json>]",
    "",
  ].join("\n");
}

function parseArgs(args) {
  const paths = {};
  const positional = [];
  let reportOutPath;
  let otelOutPath;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      return { mode: "help" };
    }
    if (arg === "--report-out") {
      if (reportOutPath) {
        throw new Error("duplicate option: --report-out");
      }
      const value = args[index + 1];
      if (!value) {
        throw new Error("missing value for option: --report-out");
      }
      reportOutPath = value;
      index += 1;
      continue;
    }
    if (arg === "--otel-out") {
      if (otelOutPath) {
        throw new Error("duplicate option: --otel-out");
      }
      const value = args[index + 1];
      if (!value) {
        throw new Error("missing value for option: --otel-out");
      }
      otelOutPath = value;
      index += 1;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (
      arg === "--source" ||
      arg === "--air" ||
      arg === "--trace" ||
      arg === "--architecture" ||
      arg === "--manifest" ||
      arg === "--package" ||
      arg === "--binding-fragment" ||
      arg === "--resource-bindings" ||
      arg === "--run-plan" ||
      arg === "--ownership" ||
      arg === "--trace-audit" ||
      arg === "--supply-chain"
    ) {
      const optionName = arg.slice(2).replaceAll("-", "_");
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
    if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length > 0 && Object.keys(paths).length > 0) {
    throw new Error("positional input cannot be combined with explicit artifact options");
  }
  if (positional.length === 1) {
    return { mode: "single", inputPath: positional[0], reportOutPath, otelOutPath, json };
  }
  if (positional.length > 1) {
    throw new Error("only one positional artifact path is supported");
  }
  if (Object.keys(paths).length > 0) {
    return { mode: "multi", paths, reportOutPath, otelOutPath, json };
  }
  return { mode: "usage_error", reportOutPath, otelOutPath, json };
}

function optionalResolvedPath(inputPath) {
  return inputPath ? path.resolve(inputPath) : undefined;
}

function assertExistingFile(absolutePath, options) {
  if (!fsAdapter(options).existsSync(absolutePath)) {
    throw new Error(`input not found: ${absolutePath}`);
  }
}

function fsAdapter(options) {
  return options.fs ?? defaultFs;
}

function writeInspectReport(filePath, rendered, fs = defaultFs) {
  assertReportOutputPath(filePath, INSPECT_REPORT_SUFFIX);
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, rendered, "utf8");
}

function writeOtelTraceExport(filePath, document, fs = defaultFs) {
  assertReportOutputPath(filePath, OTEL_EXPORT_SUFFIX);
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

function traceForOtelExport(parsed) {
  if (parsed.mode === "single") {
    const artifact = readJsonArtifact(path.resolve(parsed.inputPath), {});
    if (artifact.trace_protocol_version !== EXPECTED_TRACE_PROTOCOL_VERSION) {
      throw new Error("--otel-out requires a trace artifact input or --trace <file.trace.json>");
    }
    return {
      trace: artifact,
      sourcePath: undefined,
    };
  }
  if (parsed.mode === "multi" && parsed.paths.trace) {
    return {
      trace: readJsonArtifact(path.resolve(parsed.paths.trace), {}),
      sourcePath: parsed.paths.source ? path.resolve(parsed.paths.source) : undefined,
    };
  }
  throw new Error("--otel-out requires a trace artifact input or --trace <file.trace.json>");
}

function assertReportOutputPath(filePath, suffix) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new Error("--report-out requires a non-empty path");
  }
  if (!path.basename(path.resolve(filePath)).endsWith(suffix)) {
    throw new Error(`--report-out path must end with ${suffix}`);
  }
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => Boolean(entry)));
}

function renderInputPaths(inspection) {
  if (inspection.input_path) return [`Input ${inspection.input_path}`];
  return ["Input explicit_artifacts", ...Object.entries(inspection.input_paths ?? {})
    .filter(([, value]) => value).map(([key, value]) => `- ${key}=${value}`)];
}
function valueOrAbsent(value) {
  return value ?? "absent";
}

function formatTriggerLimits(limits) {
  const parts = [];
  if (typeof limits?.max_runs_per_day === "number") {
    parts.push(`max_runs_per_day=${limits.max_runs_per_day}`);
  }
  if (typeof limits?.timeout_ms === "number") {
    parts.push(`timeout_ms=${limits.timeout_ms}`);
  }
  return parts.length > 0 ? parts.join(",") : "absent";
}

function formatBudgetEntries(entries) {
  return entries.map((entry) => `${entry.kind}=${entry.value}`).join(",");
}

function formatTriggerArgument(argument) {
  if (!argument || typeof argument !== "object") {
    return String(argument);
  }
  return `${argument.input ?? "unknown"}:${argument.value_ref ?? "absent"}`;
}

function formatManifestMemories(memories) {
  return memories.map((memory) => `${memory.ref}:${memory.access}`).join(",");
}

function formatEffectContract(contract) {
  return contract.kind === "external_write"
    ? `${contract.kind}:${contract.retry_mode}${contract.compensation?.entry_ref
      ? `:compensation=${contract.compensation.entry_ref}`
      : ""}`
    : contract.kind;
}

function diagnosticCodes(diagnostics) {
  if (!Array.isArray(diagnostics)) {
    return [];
  }
  return diagnostics
    .map((diagnostic) => diagnostic?.code)
    .filter((code) => typeof code === "string");
}

function summarizeDigest(digest) {
  if (!digest || typeof digest !== "object" || Array.isArray(digest)) {
    return { kind: "absent", value: "absent" };
  }
  return {
    kind: digest.kind,
    value: digest.value,
  };
}

function formatDigest(digest) {
  if (!digest || !digest.kind || !digest.value) {
    return "absent";
  }
  return `${digest.kind}:${digest.value}`;
}

function memoryAccessKey(memoryRef, access) {
  return `${memoryRef}\u0000${access}`;
}

async function main() {
  let args = process.argv.slice(2);
  if (args[0] === "--") {
    args = args.slice(1);
  }
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(usage());
    process.exit(2);
  }
  if (parsed.mode === "help" || parsed.mode === "usage_error") {
    process.stderr.write(usage());
    process.exit(parsed.mode === "help" ? 0 : 2);
  }

  try {
    const inspection =
      parsed.mode === "single"
        ? inspectPath(parsed.inputPath)
        : inspectExplicitArtifacts(parsed.paths);
    const rendered = renderInspection(inspection);
    if (parsed.reportOutPath) {
      writeInspectReport(parsed.reportOutPath, rendered);
    }
    if (parsed.otelOutPath) {
      const { trace, sourcePath } = traceForOtelExport(parsed);
      writeOtelTraceExport(parsed.otelOutPath, exportTraceToOpenTelemetry(trace, { sourcePath }));
    }
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(projectInspectionContract(inspection), null, 2)}\n`);
    } else {
      process.stdout.write(rendered);
    }
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

if (path.resolve(process.argv[1] ?? "") === __filename) {
  await main();
}
