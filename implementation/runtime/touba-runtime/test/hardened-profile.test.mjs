import test from "node:test";
import assert from "node:assert/strict";

import {
  enforceHardenedExecutionProfile,
  executeAirDocument,
} from "../src/index.mjs";

test("hardening is explicit and does not alter the development default", async () => {
  const document = pureDocument();
  const development = await executeAirDocument(document);
  assert.equal(development.status, "success");
  const hardened = await executeAirDocument(document, {
    hardenedExecutionProfile: hardenedProfile(),
    supplyChainValidated: true,
    redactionEnabled: true,
    durableHumanApprovals: true,
  });
  assert.equal(hardened.status, "success");
});

test("requires locks, budgets, redaction and durable checkpoints before execution", () => {
  const base = evidence();
  for (const [code, mutate] of [
    ["HardenedSupplyChainEvidenceRequired", (document, options) => { options.supplyChainValidated = false; }],
    ["HardenedRedactionEvidenceRequired", (document, options) => { options.redactionEnabled = false; }],
    ["HardenedDurableCheckpointRequired", (document, options) => { options.durableHumanApprovals = false; }],
    ["HardenedBudgetRequired", (document) => { delete document.budgets.run.max_steps; }],
  ]) {
    const document = pureDocument();
    const options = structuredClone(base);
    mutate(document, options);
    assert.throws(() => enforceHardenedExecutionProfile(document, options), { code });
  }
});

test("requires every effect binding to request a sandbox", () => {
  const document = effectDocument();
  const options = evidence({ toolBindingManifest: manifest(false) });
  assert.throws(() => enforceHardenedExecutionProfile(document, options), {
    code: "HardenedSandboxBindingRequired",
  });
});

test("checks Linux macOS and Windows sandbox availability and useful version", () => {
  for (const [platform, mechanism, version] of [
    ["linux", "bubblewrap", "0.8.0"],
    ["darwin", "sandbox-exec", "1"],
    ["win32", "sandboxie-plus", "1.0"],
  ]) {
    const options = evidence({
      platform,
      toolBindingManifest: manifest(true),
      hardenedSandboxProbe: () => ({ available: true, platform, mechanism, version }),
    });
    const result = enforceHardenedExecutionProfile(effectDocument(), options);
    assert.equal(result.agentDecisionProviderContentMode, "opaque_refs");
  }
  assert.throws(() => enforceHardenedExecutionProfile(effectDocument(), evidence({
    toolBindingManifest: manifest(true),
    hardenedSandboxProbe: () => ({ available: false, platform: "linux", mechanism: "bubblewrap", version: "0" }),
  })), { code: "HardenedSandboxUnavailable" });
  assert.throws(() => enforceHardenedExecutionProfile(effectDocument(), evidence({
    toolBindingManifest: manifest(true),
    hardenedSandboxProbe: () => ({ available: true, platform: "linux", mechanism: "bubblewrap", version: "0.7.0" }),
  })), { code: "HardenedSandboxVersionUnsupported" });
});

test("refuses profile weakening and unknown controls", () => {
  const weak = hardenedProfile(); weak.controls.provider_content_mode = "inline";
  assert.throws(() => enforceHardenedExecutionProfile(pureDocument(), evidence({ hardenedExecutionProfile: weak })), {
    code: "HardenedProviderModeInvalid",
  });
  const extended = hardenedProfile(); extended.controls.trust_environment_name = true;
  assert.throws(() => enforceHardenedExecutionProfile(pureDocument(), evidence({ hardenedExecutionProfile: extended })), {
    code: "HardenedProfileExtensionUnknown",
  });
});

function evidence(overrides = {}) {
  return {
    hardenedExecutionProfile: hardenedProfile(), supplyChainValidated: true,
    redactionEnabled: true, durableHumanApprovals: true, ...overrides,
  };
}

function hardenedProfile() {
  return {
    schema_version: "touba-hardened-execution-profile-v1",
    controls: {
      sandbox: { required: true, minimum_versions: {
        bubblewrap: "0.8.0", "sandbox-exec": "1", "sandboxie-plus": "1.0",
      } },
      provider_content_mode: "opaque_refs",
      require_supply_chain_lock: true,
      require_budgets: ["max_run_ms", "max_steps", "max_tool_calls", "max_agent_invocations"],
      require_redaction: true,
      require_durable_checkpoints: true,
      secrets_policy: "handles_only",
    },
  };
}

function pureDocument() {
  const ref = sourceRef();
  const budget = (value) => ({ value, source_ref: ref });
  return {
    air_schema_version: "touba-air-v1", air_capability_profile: "touba-air-capabilities-v1",
    air_json_profile: "touba-air-json-canonical-v1",
    module: { id: "module:hardened", name: "hardened", source_ref: ref },
    budgets: { run: { max_run_ms: budget(1000), max_steps: budget(8),
      max_tool_calls: budget(1), max_agent_invocations: budget(1) } },
    definitions: { types: [], constants: [], functions: [], tools: [], memories: [],
      skills: [{ id: "skill:hardened/Run", name: "Run", uses: [],
        flow_graph_ref: "graph:skill:hardened/Run", source_ref: ref }],
      agents: [], strategies: [], triggers: [] },
    execution_graphs: [{ id: "graph:skill:hardened/Run", owner_ref: "skill:hardened/Run",
      entry_node_id: "give", nodes: [{ id: "give", kind: "give",
        arguments: ["literal:string:ok"], source_ref: ref }], edges: [], source_ref: ref }],
    trace_points: [],
  };
}

function effectDocument() {
  const document = pureDocument();
  document.definitions.tools.push({ id: "tool:hardened/Effect", name: "Effect", source_ref: sourceRef() });
  document.definitions.skills[0].uses = ["tool:hardened/Effect"];
  return document;
}

function manifest(required) {
  return { bindings: { "tool:hardened/Effect": { sandbox: { required } } } };
}

function sourceRef() {
  return { source_id: "hardened.tb", start_byte: 0, end_byte: 1,
    start_line: 0, start_column: 0, end_line: 0, end_column: 1 };
}
