import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AIR_CAPABILITY_PROFILE, AIR_JSON_PROFILE, AIR_SCHEMA_VERSION,
  validateTraceMachineContract,
} from "../contracts/machine/contracts.mjs";

import {
  executeTriggerEvent,
  loadToolBindingManifestFromJson,
} from "../runtime/touba-runtime/src/index.mjs";

const implementationDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = join(implementationDir, "tests/traces/triggers-anneau-2");
const checkOnly = process.argv.includes("--check");

const FIXTURES = [
  {
    id: "trigger-schedule-accepted",
    expectedStatus: "success",
    event: triggerEvent(),
    manifest: triggerManifestDocument(),
    expectedKinds: [
      "run_started",
      "trigger_event_received",
      "trigger_event_accepted",
      "trigger_execution_started",
      "scope_entered",
      "scope_exited",
      "trigger_execution_completed",
      "run_completed",
    ],
  },
  {
    id: "trigger-schedule-refused-source-mismatch",
    expectedStatus: "failure",
    event: triggerEvent({ source_kind: "request" }),
    manifest: triggerManifestDocument(),
    expectedKinds: [
      "run_started",
      "trigger_event_received",
      "trigger_event_refused",
      "failure_detected",
      "run_completed",
    ],
  },
  {
    id: "trigger-schedule-rate-limited",
    expectedStatus: "failure",
    event: triggerEvent(),
    manifest: triggerManifestDocument(),
    triggerRunCounts: {
      "trigger:test/DailyRun": 1,
    },
    expectedKinds: [
      "run_started",
      "trigger_event_received",
      "trigger_rate_limited",
      "trigger_event_refused",
      "failure_detected",
      "run_completed",
    ],
  },
];

mkdirSync(outputDir, { recursive: true });

let allPassed = true;
for (const fixture of FIXTURES) {
  const outputPath = join(outputDir, `${fixture.id}.trace.json`);
  const result = await executeTriggerEvent(triggerDocument(), fixture.event, {
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(fixture.manifest)),
    triggerRunCounts: fixture.triggerRunCounts,
  });
  validateTraceMachineContract(result.trace);

  const errors = validateFixture(fixture, result);
  if (errors.length > 0) {
    allPassed = false;
    console.error(`FAIL [${fixture.id}]:`);
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    continue;
  }

  const serialized = `${JSON.stringify(result.trace, null, 2)}\n`;
  if (checkOnly) {
    let current;
    try {
      current = readFileSync(outputPath, "utf8");
    } catch {
      allPassed = false;
      console.error(`FAIL [${fixture.id}] trigger trace fixture missing: ${outputPath}`);
      continue;
    }
    if (current !== serialized) {
      allPassed = false;
      console.error(`FAIL [${fixture.id}] trigger trace fixture is stale: ${outputPath}`);
      continue;
    }
    console.log(`pass [${fixture.id}] trigger trace fixture current`);
  } else {
    writeFileSync(outputPath, serialized, "utf8");
    console.log(`wrote ${outputPath}`);
  }
}

process.exit(allPassed ? 0 : 1);

function validateFixture(fixture, result) {
  const errors = [];
  if (result.status !== fixture.expectedStatus) {
    errors.push(`status ${result.status} != ${fixture.expectedStatus}`);
  }
  const kinds = result.trace.events.map((event) => event.kind);
  if (JSON.stringify(kinds) !== JSON.stringify(fixture.expectedKinds)) {
    errors.push(`event kinds ${JSON.stringify(kinds)} != ${JSON.stringify(fixture.expectedKinds)}`);
  }
  const serialized = JSON.stringify(result.trace);
  if (serialized.includes("raw-secret-payload")) {
    errors.push("trace includes raw trigger payload");
  }
  if (result.trace.run.entry_ref !== "trigger:test/DailyRun") {
    errors.push(`entry_ref ${result.trace.run.entry_ref} != trigger:test/DailyRun`);
  }
  return errors;
}

function triggerManifestDocument({
  enabled = true,
  sourceKind = "schedule",
  limits = {
    max_runs_per_day: 1,
    timeout_ms: 30000,
  },
} = {}) {
  return {
    manifest_version: "touba-manifest-v1",
    bindings: {},
    triggers: {
      "trigger:test/DailyRun": {
        enabled,
        source: {
          kind: sourceKind,
          timezone: "America/Montreal",
        },
        limits,
      },
    },
  };
}

function triggerEvent(fields = {}) {
  return {
    trigger_ref: "trigger:test/DailyRun",
    event_id: "evt-001",
    source_kind: "schedule",
    payload: {
      raw: "raw-secret-payload",
    },
    ...fields,
  };
}

function triggerDocument() {
  return {
    air_schema_version: AIR_SCHEMA_VERSION,
    air_capability_profile: AIR_CAPABILITY_PROFILE,
    air_json_profile: AIR_JSON_PROFILE,
    module: {
      id: "module:test.triggers",
      name: "test.triggers",
      source_ref: sourceRef(),
    },
    definitions: {
      types: [],
      constants: [],
      functions: [],
      tools: [],
      memories: [],
      skills: [],
      agents: [],
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
    },
    execution_graphs: [
      {
        id: "graph:strategy:test/RunDaily",
        owner_ref: "strategy:test/RunDaily",
        entry_node_id: "n1",
        nodes: [
          {
            id: "n1",
            kind: "give",
            arguments: ["literal:string:triggered"],
            source_ref: sourceRef(),
          },
        ],
        edges: [],
        source_ref: sourceRef(),
      },
    ],
    trace_points: [],
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
