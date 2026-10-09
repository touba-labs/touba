import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateManifestFromAirDocument } from "../../../cli/touba-manifest/src/generate.mjs";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const implementationRoot = path.resolve(fixtureRoot, "../../..");
const sourcePath = path.join(fixtureRoot, "source/donnees-quebec-agent-live.tb");
const decisionProviderPath = path.join(fixtureRoot, "providers/donnees-quebec-researcher.provider.mjs");
const defaultSecretsPath = path.join(fixtureRoot, "secrets/secret-handles.env.fixture.json");
const secretsPath = argValue("--secrets") ?? defaultSecretsPath;
const traceOutPath = argValue("--trace-out");
const evidenceOutPath = argValue("--evidence-out");
const tmpRoot = mkdtempSync(path.join(tmpdir(), "touba-donnees-quebec-agent-live-"));
const airPath = path.join(tmpRoot, "donnees-quebec-agent-live.air.json");
const manifestPath = path.join(tmpRoot, "touba.manifest.json");
const cargo = process.env.CARGO ?? "cargo";
const liveMode = process.argv.includes("--live");
const dryRunMode = process.argv.includes("--dry-run") || !liveMode;
const openAiModel = process.env.TOUBA_OPENAI_MODEL ?? "gpt-4.1-nano";
const request = Object.freeze({
  query: "pompier",
  rows: 1,
  dry_run: dryRunMode,
  llm_model: openAiModel,
  goal: "Find a public dataset, then produce a brief summary in French.",
});

if (liveMode && process.argv.includes("--dry-run")) {
  throw new Error("use either --live or --dry-run, not both");
}
const missingEnvSecrets = liveMode ? missingEnvSecretsFor(secretsPath) : [];
if (missingEnvSecrets.length > 0) {
  throw new Error(`${missingEnvSecrets.join(", ")} must be available in the environment for --live with ${secretsPath}`);
}

try {
  compileSourceToAir();
  materializeManifestFromAir();
  const trace = runAir();
  assertTrace(trace);
  const evidence = buildEvidence(trace);
  if (traceOutPath) {
    writeJsonArtifact(traceOutPath, trace);
  }
  if (evidenceOutPath) {
    writeJsonArtifact(evidenceOutPath, evidence);
  }
  console.log(renderEvidence(evidence));
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

function materializeManifestFromAir() {
  const airDocument = JSON.parse(readFileSync(airPath, "utf8"));
  const manifest = generateManifestFromAirDocument(airDocument, {
    handlerCommand: process.execPath,
    handlerRoot: "handlers",
    handlerCwd: fixtureRoot,
    timeoutMs: liveMode ? 30000 : 10000,
    maxPayloadBytes: 1048576,
  });

  manifest.bindings["tool:examples.donnees_quebec_agent_live/SearchDatasets"].handler.args = [
    "handlers/search_agent_datasets.handler.mjs",
  ];
  manifest.bindings["tool:examples.donnees_quebec_agent_live/SummarizeDatasets"].handler.args = [
    "handlers/summarize_datasets.handler.mjs",
  ];
  manifest.agent_secret_scopes = {
    "agent:examples.donnees_quebec_agent_live/Researcher": ["OPENAI_API_KEY"],
  };

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function compileSourceToAir() {
  const compileResult = spawnSync(
    cargo,
    ["run", "-p", "touba-cli", "--bin", "touba-compile", "--quiet", "--", sourcePath],
    {
      cwd: implementationRoot,
      encoding: "utf8",
    },
  );
  assertSuccess("compile", compileResult);
  writeFileSync(airPath, compileResult.stdout, "utf8");
}

function runAir() {
  const env = {
    ...process.env,
    ...(dryRunMode
      ? {
        OPENAI_API_KEY: "touba-dry-run-openai-key",
        TOUBA_AGENT_DECISION_OPENAI_API_KEY: "touba-dry-run-openai-key",
      }
      : {
        TOUBA_AGENT_DECISION_OPENAI_API_KEY: openAiKeyForDecisionProvider(secretsPath, process.env),
      }),
  };
  const runResult = spawnSync(
    process.execPath,
    [
      path.join(implementationRoot, "cli/touba-run/src/run.mjs"),
      airPath,
      "--manifest",
      manifestPath,
      "--secrets",
      secretsPath,
      "--inputs-json",
      JSON.stringify({ request }),
      "--agent-decision-provider",
      decisionProviderPath,
      "--agent-decision-provider-timeout-ms",
      "30000",
      "--agent-decision-provider-max-retries",
      "1",
      "--max-provider-calls",
      "4",
      "--output",
      "trace",
    ],
    {
      cwd: implementationRoot,
      encoding: "utf8",
      env,
    },
  );
  assertSuccess("run", runResult);
  const trace = JSON.parse(runResult.stdout);
  for (const leakCandidate of secretLeakCandidatesFor(secretsPath, env)) {
    if (leakCandidate && runResult.stdout.includes(leakCandidate)) {
      throw new Error("trace includes OPENAI_API_KEY value");
    }
  }
  return trace;
}

function argValue(name) {
  const prefix = `${name}=`;
  for (let index = 0; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === name) {
      return process.argv[index + 1];
    }
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return undefined;
}

function missingEnvSecretsFor(pathToSecrets) {
  const document = JSON.parse(readFileSync(pathToSecrets, "utf8"));
  const missing = [];
  for (const record of Object.values(document.secrets ?? {})) {
    if (record?.source !== "env") {
      continue;
    }
    if (typeof record.name !== "string" || !process.env[record.name]) {
      missing.push(record.name ?? "<missing-name>");
    }
  }
  return missing;
}

function secretLeakCandidatesFor(pathToSecrets, env) {
  if (dryRunMode) {
    return [env.OPENAI_API_KEY];
  }
  const document = JSON.parse(readFileSync(pathToSecrets, "utf8"));
  const baseDir = path.dirname(path.resolve(pathToSecrets));
  const candidates = [];
  for (const record of Object.values(document.secrets ?? {})) {
    if (record?.source === "env" && typeof record.name === "string" && env[record.name]) {
      candidates.push(env[record.name]);
    }
    if (record?.source === "dotenv" && typeof record.path === "string" && typeof record.name === "string") {
      const dotenvPath = resolveSecretPath(baseDir, record.path);
      if (existsSync(dotenvPath)) {
        const entries = parseDotenvEntries(readFileSync(dotenvPath, "utf8"));
        if (entries.has(record.name)) {
          candidates.push(entries.get(record.name));
        }
      }
    }
    if (record?.source === "touba_store" && typeof record.path === "string" && typeof record.name === "string") {
      const storePath = resolveSecretPath(baseDir, record.path);
      if (existsSync(storePath)) {
        const store = JSON.parse(readFileSync(storePath, "utf8"));
        if (typeof store.secrets?.[record.name] === "string") {
          candidates.push(store.secrets[record.name]);
        }
      }
    }
  }
  return candidates.filter((candidate) => typeof candidate === "string" && candidate.length > 0);
}

function resolveSecretPath(baseDir, secretPath) {
  return path.isAbsolute(secretPath) ? secretPath : path.resolve(baseDir, secretPath);
}

function parseDotenvEntries(raw) {
  const entries = new Map();
  for (const rawLine of raw.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const name = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries.set(name, value);
  }
  return entries;
}

function buildEvidence(trace) {
  const authorizedAgent = trace.events.find((event) => event.kind === "agent_invocation_authorized");
  const listedCapabilities = trace.events.find((event) => event.kind === "agent_capabilities_listed");
  const selectedCapability = trace.events.find((event) => event.kind === "agent_capability_selected");
  const catalogRequest = trace.events.find((event) => event.kind === "agent_decision_catalog_requested");
  const toolEvents = trace.events.filter((event) => event.kind === "tool_binding_authorized");
  const searchEvent = toolEvents.find(
    (event) => event.payload.tool_ref === "tool:examples.donnees_quebec_agent_live/SearchDatasets",
  );
  const summarizeEvent = toolEvents.find(
    (event) => event.payload.tool_ref === "tool:examples.donnees_quebec_agent_live/SummarizeDatasets",
  );
  const showMessages = trace.events
    .filter((event) => event.kind === "user_interaction_shown")
    .map((event) => event.payload?.message)
    .filter((message) => typeof message === "string");
  const firstDatasetMessage = showMessages.find((message) => message.startsWith("First dataset: "));
  const summary = showMessages.find((message) => !message.startsWith("First dataset: ")) ?? "";

  return {
    evidence_schema_version: "touba-live-agent-evidence-v1",
    mode: liveMode ? "live_openai" : "dry_run",
    status: "success",
    endpoint: "package_search",
    request,
    strategy_ref: authorizedAgent.payload.caller_ref,
    agent_ref: authorizedAgent.payload.agent_ref,
    authority_source: authorizedAgent.payload.authority_source,
    capability_refs: listedCapabilities.payload.capability_refs,
    catalog_requested: catalogRequest?.payload?.capability_count ?? 0,
    selected_capability_ref: selectedCapability.payload.selected_ref,
    selection_authority_source: selectedCapability.payload.authority_source,
    decision_source: selectedCapability.payload.decision_source,
    model_input_protocol: decisionRequestsProtocol(trace),
    model_input_modes: decisionRequestsModes(trace),
    provider_metadata: decisionRequestsProviderMetadata(trace),
    provider_request_digests: decisionRequestsDigests(trace),
    tools: [
      evidenceTool(searchEvent),
      evidenceTool(summarizeEvent),
    ],
    first_dataset_title: firstDatasetMessage?.slice("First dataset: ".length) ?? "",
    summary,
    trace_event_count: trace.events.length,
  };
}

function evidenceTool(event) {
  return {
    tool_ref: event.payload.tool_ref,
    caller_ref: event.payload.caller_ref,
    agent_ref: event.payload.agent_ref,
    granted_capabilities: event.payload.granted_capabilities,
    secret_handles_used: event.payload.secret_handles_used,
  };
}

function renderEvidence(evidence) {
  return [
    `agent:donnees-quebec mode=${evidence.mode} status=${evidence.status} endpoint=${evidence.endpoint}`,
    `agent-work: strategy=${evidence.strategy_ref}`,
    `agent-work: agent=${evidence.agent_ref} authority=${evidence.authority_source}`,
    `agent-work: capabilities=${evidence.capability_refs.join(",")}`,
    `agent-work: model_input=${evidence.model_input_protocol} modes=${evidence.model_input_modes.join(",")}`,
    `agent-work: selected=${evidence.selected_capability_ref} authority=${evidence.selection_authority_source} decision=${evidence.decision_source}`,
    ...evidence.tools.map((tool) => [
      "agent-work: tool=",
      tool.tool_ref,
      ` grants=${tool.granted_capabilities.join(",") || "none"}`,
      ` secret_handles=${tool.secret_handles_used.join(",") || "none"}`,
    ].join("")),
    `agent-work: first_dataset_title=${compactText(evidence.first_dataset_title)}`,
    `agent-work: summary=${compactText(evidence.summary)}`,
    `agent-work: trace_events=${evidence.trace_event_count}`,
  ].join("\n");
}

function writeJsonArtifact(outputPath, value) {
  writeFileSync(path.resolve(outputPath), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function compactText(value) {
  return String(value).replace(/\s+/gu, " ").trim();
}

function assertTrace(trace) {
  const completed = trace.events?.find((event) => event.kind === "run_completed");
  if (completed?.payload?.status !== "success") {
    throw new Error(`expected trace status success, got ${completed?.payload?.status}`);
  }

  const authorizedAgent = trace.events.find((event) => event.kind === "agent_invocation_authorized");
  if (!authorizedAgent) {
    throw new Error("expected agent_invocation_authorized event");
  }
  if (authorizedAgent.payload.caller_ref !== "strategy:examples.donnees_quebec_agent_live/RunDatasetResearch") {
    throw new Error(`unexpected agent caller ${authorizedAgent.payload.caller_ref}`);
  }
  if (authorizedAgent.payload.agent_ref !== "agent:examples.donnees_quebec_agent_live/Researcher") {
    throw new Error(`unexpected agent ref ${authorizedAgent.payload.agent_ref}`);
  }

  const listedCapabilities = trace.events.find((event) => event.kind === "agent_capabilities_listed");
  if (!listedCapabilities) {
    throw new Error("expected agent_capabilities_listed event");
  }
  assertJsonEqual(listedCapabilities.payload.capability_refs, [
    "skill:examples.donnees_quebec_agent_live/SearchDatasetOnly",
    "skill:examples.donnees_quebec_agent_live/BuildDatasetBrief",
  ], "agent capability refs");

  const decisionRequests = trace.events.filter((event) => event.kind === "agent_decision_requested");
  if (decisionRequests.length !== 3) {
    throw new Error(`expected summary, catalog and final summary decision requests, got ${decisionRequests.length}`);
  }
  for (const requestEvent of decisionRequests) {
    if (!/^[a-f0-9]{64}$/.test(requestEvent.payload.request_digest)) {
      throw new Error(`expected ADP-1 request digest, got ${requestEvent.payload.request_digest}`);
    }
    if (
      requestEvent.payload.provider_metadata?.provider_name !== "donnees-quebec-researcher"
      || requestEvent.payload.provider_metadata?.decision_schema_version !== "touba-agent-decision-v1"
    ) {
      throw new Error(`unexpected ADP-1 provider metadata ${JSON.stringify(requestEvent.payload.provider_metadata)}`);
    }
  }
  const providerBudget = trace.events
    .filter((event) => event.kind === "budget_consumed")
    .filter((event) => event.payload?.budget_kind === "max_provider_calls");
  if (providerBudget.length !== 3) {
    throw new Error(`expected three provider budget consumptions, got ${providerBudget.length}`);
  }
  if (decisionRequests[0].payload.mode !== "summary" || decisionRequests[0].payload.catalog_presented === true) {
    throw new Error("expected first agent decision request to be summary-only");
  }
  if (
    decisionRequests[0].payload.model_input_protocol !== "touba-agent-model-input-v1"
    || decisionRequests[0].payload.model_input_mode !== "orientation"
  ) {
    throw new Error("expected first model input to be orientation");
  }
  if (decisionRequests[1].payload.mode !== "capabilities" || decisionRequests[1].payload.catalog_presented !== true) {
    throw new Error("expected second agent decision request to present the catalog");
  }
  if (
    decisionRequests[1].payload.model_input_protocol !== "touba-agent-model-input-v1"
    || decisionRequests[1].payload.model_input_mode !== "capability_catalog"
  ) {
    throw new Error("expected second model input to be capability catalog");
  }
  if (
    decisionRequests[2].payload.mode !== "summary"
    || decisionRequests[2].payload.model_input_mode !== "orientation"
    || decisionRequests[2].payload.observation_count !== 1
  ) {
    throw new Error("expected final summary decision request with one runtime observation");
  }

  const selectedCapability = trace.events.find((event) => event.kind === "agent_capability_selected");
  if (selectedCapability?.payload?.selected_ref !== "skill:examples.donnees_quebec_agent_live/BuildDatasetBrief") {
    throw new Error(`unexpected selected capability ${selectedCapability?.payload?.selected_ref}`);
  }
  if (selectedCapability.payload.authority_source !== "uses") {
    throw new Error(`unexpected selected authority ${selectedCapability.payload.authority_source}`);
  }
  const expectedDecisionSource = liveMode ? "openai_structured_output" : "fixture_dry_run";
  if (selectedCapability.payload.decision_source !== expectedDecisionSource) {
    throw new Error(
      `expected decision source ${expectedDecisionSource}, got ${selectedCapability.payload.decision_source}`,
    );
  }

  const toolEvents = trace.events.filter((event) => event.kind === "tool_binding_authorized");
  const searchEvent = toolEvents.find(
    (event) => event.payload.tool_ref === "tool:examples.donnees_quebec_agent_live/SearchDatasets",
  );
  const summarizeEvent = toolEvents.find(
    (event) => event.payload.tool_ref === "tool:examples.donnees_quebec_agent_live/SummarizeDatasets",
  );
  if (!searchEvent || !summarizeEvent) {
    throw new Error("expected SearchDatasets and SummarizeDatasets tool binding events");
  }
  if (summarizeEvent.payload.agent_ref !== "agent:examples.donnees_quebec_agent_live/Researcher") {
    throw new Error(`unexpected summarize agent ref ${summarizeEvent.payload.agent_ref}`);
  }
  if (!summarizeEvent.payload.granted_capabilities.includes("secret_read")) {
    throw new Error("expected secret_read grant for SummarizeDatasets");
  }
  if (!summarizeEvent.payload.secret_handles_used.includes("OPENAI_API_KEY")) {
    throw new Error("expected OPENAI_API_KEY handle in trace");
  }

  const showEvents = trace.events.filter((event) => event.kind === "user_interaction_shown");
  if (!showEvents.some((event) => event.payload?.message?.startsWith("First dataset: "))) {
    throw new Error("expected dataset title show event");
  }
  if (showEvents.length < 2) {
    throw new Error("expected dataset title and summary show events");
  }
}

function openAiKeyForDecisionProvider(pathToSecrets, env) {
  const document = JSON.parse(readFileSync(pathToSecrets, "utf8"));
  const baseDir = path.dirname(path.resolve(pathToSecrets));
  const record = document.secrets?.OPENAI_API_KEY;
  const value = secretValueFromRecord(record, baseDir, env);
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.length > 0) {
    return env.OPENAI_API_KEY;
  }
  throw new Error("OPENAI_API_KEY could not be resolved for the live agent decision provider");
}

function secretValueFromRecord(record, baseDir, env) {
  if (record?.source === "env" && typeof record.name === "string") {
    return env[record.name];
  }
  if (record?.source === "dotenv" && typeof record.path === "string" && typeof record.name === "string") {
    const dotenvPath = resolveSecretPath(baseDir, record.path);
    if (existsSync(dotenvPath)) {
      return parseDotenvEntries(readFileSync(dotenvPath, "utf8")).get(record.name);
    }
  }
  if (record?.source === "touba_store" && typeof record.path === "string" && typeof record.name === "string") {
    const storePath = resolveSecretPath(baseDir, record.path);
    if (existsSync(storePath)) {
      const store = JSON.parse(readFileSync(storePath, "utf8"));
      return store.secrets?.[record.name];
    }
  }
  return undefined;
}

function decisionRequestsProtocol(trace) {
  return trace.events.find((event) => event.kind === "agent_decision_requested")
    ?.payload?.model_input_protocol ?? "";
}

function decisionRequestsModes(trace) {
  return trace.events
    .filter((event) => event.kind === "agent_decision_requested")
    .map((event) => event.payload?.model_input_mode)
    .filter((mode) => typeof mode === "string");
}

function decisionRequestsProviderMetadata(trace) {
  return trace.events.find((event) => event.kind === "agent_decision_requested")
    ?.payload?.provider_metadata ?? null;
}

function decisionRequestsDigests(trace) {
  return trace.events
    .filter((event) => event.kind === "agent_decision_requested")
    .map((event) => event.payload?.request_digest)
    .filter((digest) => typeof digest === "string");
}

function assertJsonEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
}

function assertSuccess(label, result) {
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${label} failed with code ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}
