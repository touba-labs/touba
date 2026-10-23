import "./fixture-clock.mjs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AIR_CAPABILITY_PROFILE, AIR_JSON_PROFILE, validateTraceMachineContract,
} from "../contracts/machine/contracts.mjs";
import {
  AIR_SCHEMA_VERSION,
  executeAirDocument,
  loadToolBindingManifestFromJson,
} from "../runtime/touba-runtime/src/index.mjs";

const checkOnly = process.argv.includes("--check");
const implementationDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = join(implementationDir, "tests/traces/budgets-bq1");

mkdirSync(outputDir, { recursive: true });

const fixtures = [
  {
    id: "max-tool-calls-refused",
    run: () => executeAirDocument(twoToolDispatchDocument(), {
      entryRef: "skill:test/TwoTools",
      toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument({
        runLimits: {
          max_tool_calls: 1,
        },
        bindings: {
          "tool:test/First": toolBindingEntry({ grants: [] }),
          "tool:test/Second": toolBindingEntry({ grants: [] }),
        },
      }))),
      toolHandlers: {
        "tool:test/First": () => "first",
        "tool:test/Second": () => "second",
      },
    }),
  },
  {
    id: "max-steps-refused",
    run: () => executeAirDocument(bindThenGiveDocument(), {
      entryRef: "skill:test/BindThenGive",
      runLimits: {
        max_steps: 1,
      },
    }),
  },
  {
    id: "manifest-run-limit-widening-refused",
    run: () => executeAirDocument(bindThenGiveDocument({
      budgets: {
        run: {
          max_steps: {
            value: 1,
            source_ref: sourceRef(),
          },
        },
      },
    }), {
      entryRef: "skill:test/BindThenGive",
      toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument({
        runLimits: {
          max_steps: 2,
        },
        bindings: {},
      }))),
    }),
  },
];

let allPassed = true;

for (const fixture of fixtures) {
  const result = await fixture.run();
  validateTraceMachineContract(result.trace);
  validateBudgetTrace(fixture.id, result);
  const outputPath = join(outputDir, `${fixture.id}.trace.json`);
  const serialized = `${JSON.stringify(result.trace, null, 2)}\n`;

  if (checkOnly) {
    let current;
    try {
      current = readFileSync(outputPath, "utf8");
    } catch {
      console.error(`FAIL [${fixture.id}] trace fixture missing: ${outputPath}`);
      allPassed = false;
      continue;
    }
    if (current !== serialized) {
      console.error(`FAIL [${fixture.id}] trace fixture is stale: ${outputPath}`);
      allPassed = false;
      continue;
    }
    console.log(`pass [${fixture.id}] budget trace fixture current`);
  } else {
    writeFileSync(outputPath, serialized, "utf8");
    console.log(`wrote ${outputPath}`);
  }
}

process.exit(allPassed ? 0 : 1);

function validateBudgetTrace(id, result) {
  if (result.status !== "failure") {
    throw new Error(`${id} expected failure status`);
  }
  const kinds = result.trace.events.map((event) => event.kind);
  for (const required of ["run_started", "budget_limit_checked", "budget_limit_exceeded", "run_completed"]) {
    if (!kinds.includes(required)) {
      throw new Error(`${id} missing ${required}`);
    }
  }
  if (id === "max-tool-calls-refused" && !kinds.includes("dispatch_refused_budget_exceeded")) {
    throw new Error(`${id} missing dispatch_refused_budget_exceeded`);
  }
  if (result.trace.events.at(-1)?.payload?.status !== "failure") {
    throw new Error(`${id} terminal status is not failure`);
  }
  const serialized = JSON.stringify(result.trace);
  if (serialized.includes("fixture-secret-value") || serialized.includes("raw-secret-payload")) {
    throw new Error(`${id} contains forbidden sensitive marker`);
  }
}

function bindThenGiveDocument(overrides = {}) {
  return baseDocument({
    budgets: overrides.budgets,
    skills: [skill("BindThenGive", "graph:skill:test/BindThenGive")],
    graphs: [
      graph("graph:skill:test/BindThenGive", "skill:test/BindThenGive", [
        node("n1", "bind", {
          arguments: ["literal:string:budget"],
          result_binding: "topic",
        }),
        node("n2", "give", { arguments: ["value:topic"] }),
      ], [
        edge("n1", "n2", "next"),
      ]),
    ],
  });
}

function twoToolDispatchDocument() {
  return baseDocument({
    tools: [
      tool("First"),
      tool("Second"),
    ],
    skills: [skill("TwoTools", "graph:skill:test/TwoTools", [
      "tool:test/First",
      "tool:test/Second",
    ])],
    graphs: [
      graph("graph:skill:test/TwoTools", "skill:test/TwoTools", [
        node("n1", "call_tool", { target_ref: "tool:test/First", result_binding: "first" }),
        node("n2", "call_tool", { target_ref: "tool:test/Second", result_binding: "second" }),
        node("n3", "give", { arguments: ["value:second"] }),
      ], [
        edge("n1", "n2", "next"),
        edge("n2", "n3", "next"),
      ]),
    ],
  });
}

function baseDocument(overrides = {}) {
  return {
    air_schema_version: AIR_SCHEMA_VERSION,
    air_capability_profile: AIR_CAPABILITY_PROFILE,
    air_json_profile: AIR_JSON_PROFILE,
    module: {
      id: "module:test",
      name: "test",
      source_ref: sourceRef(),
    },
    ...(overrides.budgets ? { budgets: overrides.budgets } : {}),
    definitions: {
      types: overrides.types ?? [],
      constants: overrides.constants ?? [],
      functions: overrides.functions ?? [],
      tools: overrides.tools ?? [],
      memories: overrides.memories ?? [],
      skills: overrides.skills ?? [],
      agents: overrides.agents ?? [],
      strategies: overrides.strategies ?? [],
      triggers: overrides.triggers ?? [],
    },
    execution_graphs: overrides.graphs ?? [],
    trace_points: overrides.tracePoints ?? [],
  };
}

function sourceRef() {
  return {
    source_id: "test.tb",
    start_byte: 0,
    end_byte: 0,
    start_line: 1,
    start_column: 0,
    end_line: 1,
    end_column: 0,
  };
}

function tool(name, signature = {}) {
  return {
    id: `tool:test/${name}`,
    name,
    signature: {
      inputs: signature.inputs ?? [],
      output_type: signature.outputType ?? "builtin:Text",
    },
    required_capabilities: [],
    required_secrets: [],
    memory_accesses: [],
    source_ref: sourceRef(),
  };
}

function skill(name, flowGraphRef, uses = []) {
  return {
    id: `skill:test/${name}`,
    name,
    signature: {
      inputs: [],
      output_type: "builtin:Text",
    },
    uses,
    flow_graph_ref: flowGraphRef,
    source_ref: sourceRef(),
  };
}

function graph(id, ownerRef, nodes, edges = []) {
  return {
    id,
    owner_ref: ownerRef,
    entry_node_id: nodes[0].id,
    nodes,
    edges,
    failure_paths: [],
    failure_path_refs: [],
    source_ref: sourceRef(),
  };
}

function node(id, kind, fields = {}) {
  return {
    id,
    kind,
    arguments: [],
    trace_point_refs: [],
    source_ref: sourceRef(),
    ...fields,
  };
}

function edge(fromNodeId, toNodeId, role) {
  return {
    from_node_id: fromNodeId,
    to_node_id: toNodeId,
    role,
  };
}

function bindingManifestDocument({
  bindings = {},
  runLimits,
} = {}) {
  return {
    manifest_version: "touba-manifest-v1",
    ...(runLimits ? { run_limits: runLimits } : {}),
    bindings,
  };
}

function toolBindingEntry({
  command = "node",
  args = ["./handlers/test.handler.js"],
  grants = [],
  secrets = [],
  timeoutMs = 5000,
  maxPayloadBytes = 1048576,
} = {}) {
  return {
    effect_contract: { kind: "none" },
    handler: {
      kind: "process",
      command,
      args,
    },
    grants,
    secrets,
    timeout_ms: timeoutMs,
    max_payload_bytes: maxPayloadBytes,
  };
}
