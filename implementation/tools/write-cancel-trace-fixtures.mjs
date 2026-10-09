import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AIR_CAPABILITY_PROFILE, AIR_JSON_PROFILE, validateTraceMachineContract,
} from "../contracts/machine/contracts.mjs";
import {
  AIR_SCHEMA_VERSION,
  executeAirDocument,
  executeTriggerEvent,
  loadToolBindingManifestFromJson,
} from "../runtime/touba-runtime/src/index.mjs";

const checkOnly = process.argv.includes("--check");
const implementationDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = join(implementationDir, "tests/traces/cancel-v1");

mkdirSync(outputDir, { recursive: true });

const fixtures = [
  {
    id: "cancel-before-dispatch",
    run: () => executeAirDocument(cancelBeforeDispatchDocument(), {
      entryRef: "skill:test/Build",
      cancelRequested: true,
    }),
  },
  {
    id: "global-timeout-before-second-tool",
    run: () => {
      let currentTimeMs = 0;
      return executeAirDocument(twoToolDispatchDocument(), {
        entryRef: "skill:test/TwoTools",
        runTimeoutMs: 5,
        now: () => currentTimeMs,
        toolHandlers: {
          "tool:test/First": () => {
            currentTimeMs = 10;
            return "first";
          },
          "tool:test/Second": () => "second",
        },
      });
    },
  },
  {
    id: "kill-switch-trigger-refused",
    run: () => executeTriggerEvent(triggerDocument(), triggerEvent(), {
      toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(triggerManifestDocument())),
      killSwitchEnabled: true,
    }),
  },
];

let allPassed = true;

for (const fixture of fixtures) {
  const result = await fixture.run();
  const trace = result.trace;
  validateTraceMachineContract(trace);
  validateCancelTrace(fixture.id, result);
  const outputPath = join(outputDir, `${fixture.id}.trace.json`);
  const serialized = `${JSON.stringify(trace, null, 2)}\n`;

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
    console.log(`pass [${fixture.id}] cancel trace fixture current`);
  } else {
    writeFileSync(outputPath, serialized, "utf8");
    console.log(`wrote ${outputPath}`);
  }
}

process.exit(allPassed ? 0 : 1);

function validateCancelTrace(id, result) {
  const kinds = result.trace.events.map((event) => event.kind);
  if (result.status !== "cancelled") {
    throw new Error(`${id} expected cancelled status`);
  }
  for (const required of ["run_started", "run_cancel_requested", "run_cancelled", "run_completed"]) {
    if (!kinds.includes(required)) {
      throw new Error(`${id} missing ${required}`);
    }
  }
  if (result.trace.events.at(-1)?.payload?.status !== "cancelled") {
    throw new Error(`${id} terminal status is not cancelled`);
  }
  if (JSON.stringify(result.trace).includes("secret")) {
    throw new Error(`${id} contains forbidden secret marker`);
  }
}

function cancelBeforeDispatchDocument() {
  return baseDocument({
    skills: [skill("Build", "graph:skill:test/Build")],
    graphs: [
      graph("graph:skill:test/Build", "skill:test/Build", [
        node("n1", "give", { arguments: ["literal:string:unused"] }),
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

function triggerDocument() {
  return baseDocument({
    triggers: [
      {
        id: "trigger:test/DailyRun",
        name: "DailyRun",
        event: {
          kind: "schedule",
          value: "0 8 * * *",
          source_ref: sourceRef(),
        },
        target_ref: "strategy:test/RunDaily",
        target_kind: "strategy",
        arguments: [],
        limits: {
          max_runs_per_day: 1,
          timeout_ms: 30000,
          source_ref: sourceRef(),
        },
        source_ref: sourceRef(),
      },
    ],
    strategies: [
      {
        id: "strategy:test/RunDaily",
        name: "RunDaily",
        signature: {
          inputs: [],
          output_type: "builtin:Text",
        },
        flow_graph_ref: "graph:strategy:test/RunDaily",
        source_ref: sourceRef(),
      },
    ],
    graphs: [
      graph("graph:strategy:test/RunDaily", "strategy:test/RunDaily", [
        node("n1", "give", { arguments: ["literal:string:triggered"] }),
      ]),
    ],
  });
}

function triggerEvent() {
  return {
    trigger_ref: "trigger:test/DailyRun",
    event_id: "evt-001",
    source_kind: "schedule",
  };
}

function triggerManifestDocument() {
  return {
    manifest_version: "touba-manifest-v1",
    bindings: {},
    triggers: {
      "trigger:test/DailyRun": {
        enabled: true,
        source: {
          kind: "schedule",
        },
        limits: {
          max_runs_per_day: 1,
          timeout_ms: 30000,
        },
      },
    },
  };
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

function tool(name) {
  return {
    id: `tool:test/${name}`,
    name,
    signature: {
      inputs: [],
      output_type: "builtin:Text",
    },
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
    entry_node_id: nodes[0]?.id,
    nodes,
    edges,
    failure_paths: [],
    source_ref: sourceRef(),
  };
}

function node(id, kind, fields = {}) {
  return {
    id,
    kind,
    source_ref: sourceRef(),
    ...fields,
  };
}

function edge(from, to, role) {
  return {
    from_node_id: from,
    to_node_id: to,
    role,
  };
}
