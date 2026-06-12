import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AIR_SCHEMA_VERSION,
  TRACE_PROTOCOL_VERSION,
  executeAirDocument,
  loadSecretsFromJson,
  loadToolBindingManifestFromJson,
} from "../src/index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(__dirname, "../../../tests/tool-binding-v1");

test("executes the tool binding V1 fixture through a bounded process handler", async () => {
  const previousLeak = process.env.TOUBA_SHOULD_NOT_LEAK;
  process.env.TOUBA_SHOULD_NOT_LEAK = "host-only";

  try {
    const result = await executeAirDocument(fixtureAirDocument(), {
      entryRef: "skill:examples.v1_process_binding/BuildSource",
      inputs: {
        request: { query: "source-a" },
      },
      runId: "tool-binding-fixture",
      toolBindingManifest: fixtureManifest("touba.manifest.positive.json"),
      secretStore: fixtureSecrets({ SEARCH_API_TOKEN: "fixture-secret-value" }),
    });

    assert.equal(result.status, "success");
    assert.deepEqual(result.result, {
      body: "fixture:source-a",
      inherited_env_visible: false,
      secret_value_in_stdin: false,
    });
    assert.equal(JSON.stringify(result.trace).includes("fixture-secret-value"), false);
    assertTraceShape(result.trace);
  } finally {
    if (previousLeak === undefined) {
      delete process.env.TOUBA_SHOULD_NOT_LEAK;
    } else {
      process.env.TOUBA_SHOULD_NOT_LEAK = previousLeak;
    }
  }
});

test("refuses negative tool binding V1 fixture manifests before or during handler dispatch", async () => {
  const cases = [
    {
      name: "binding absent",
      manifest: "touba.manifest.missing-binding.json",
      expectedMessage: /missing manifest binding/,
    },
    {
      name: "grant missing",
      manifest: "touba.manifest.missing-network-grant.json",
      expectedMessage: /missing required capabilities network/,
    },
    {
      name: "secret not authorized by binding",
      manifest: "touba.manifest.missing-secret-grant.json",
      expectedMessage: /missing required secret handles SEARCH_API_KEY/,
    },
    {
      name: "handler controlled error",
      manifest: "touba.manifest.handler-error.json",
      expectedMessage: /FixtureFailure.*fixture handler failed intentionally/,
    },
  ];

  for (const fixture of cases) {
    const result = await executeAirDocument(fixtureAirDocument(), {
      entryRef: "skill:examples.v1_process_binding/BuildSource",
      inputs: {
        request: { query: "source-a" },
      },
      toolBindingManifest: fixtureManifest(fixture.manifest),
      secretStore: fixtureSecrets({ SEARCH_API_TOKEN: "fixture-secret-value" }),
    });

    assert.equal(result.status, "failure", fixture.name);
    assert.match(eventOf(result.trace, "failure_detected").message, fixture.expectedMessage, fixture.name);
    assert.equal(JSON.stringify(result.trace).includes("fixture-secret-value"), false, fixture.name);
  }
});

function fixtureManifest(fileName) {
  const raw = readFileSync(resolve(fixtureRoot, "manifests", fileName), "utf8")
    .replaceAll("__NODE_EXECUTABLE_SET_BY_TEST__", process.execPath)
    .replaceAll("__FIXTURE_ROOT_SET_BY_TEST__", fixtureRoot);
  return loadToolBindingManifestFromJson(raw);
}

function fixtureSecrets(env) {
  const raw = readFileSync(resolve(fixtureRoot, "secrets/touba.secrets.env.json"), "utf8");
  return loadSecretsFromJson(raw, { env });
}

function fixtureAirDocument() {
  return {
    air_schema_version: AIR_SCHEMA_VERSION,
    module: {
      id: "module:examples.v1_process_binding",
      name: "examples.v1_process_binding",
      source_ref: sourceRef(),
    },
    definitions: {
      types: [
        typeDef("SourceRequest", [
          field("query", "builtin:Text"),
        ]),
        typeDef("SourceText", [
          field("body", "builtin:Text"),
          field("inherited_env_visible", "builtin:Boolean"),
          field("secret_value_in_stdin", "builtin:Boolean"),
        ]),
      ],
      functions: [],
      tools: [
        {
          id: "tool:examples.v1_process_binding/FetchSource",
          name: "FetchSource",
          signature: {
            inputs: [parameter("request", "type:examples.v1_process_binding/SourceRequest")],
            output_type: "type:examples.v1_process_binding/SourceText",
          },
          required_capabilities: ["network", "secret_read"],
          required_secrets: ["SEARCH_API_KEY"],
          source_ref: sourceRef(),
        },
      ],
      skills: [
        {
          id: "skill:examples.v1_process_binding/BuildSource",
          name: "BuildSource",
          signature: {
            inputs: [parameter("request", "type:examples.v1_process_binding/SourceRequest")],
            output_type: "type:examples.v1_process_binding/SourceText",
          },
          uses: ["tool:examples.v1_process_binding/FetchSource"],
          flow_graph_ref: "graph:skill:examples.v1_process_binding/BuildSource",
          source_ref: sourceRef(),
        },
      ],
      agents: [],
      strategies: [],
    },
    execution_graphs: [
      {
        id: "graph:skill:examples.v1_process_binding/BuildSource",
        owner_ref: "skill:examples.v1_process_binding/BuildSource",
        entry_node_id: "n1",
        nodes: [
          node("n1", "call_tool", {
            target_ref: "tool:examples.v1_process_binding/FetchSource",
            arguments: ["value:request"],
            result_binding: "source",
          }),
          node("n2", "give", { arguments: ["value:source"] }),
        ],
        edges: [
          {
            from_node_id: "n1",
            to_node_id: "n2",
            role: "next",
          },
        ],
        expressions: [],
        failure_paths: [],
        failure_path_refs: [],
        source_ref: sourceRef(),
      },
    ],
    trace_points: [],
  };
}

function typeDef(name, fields) {
  return {
    id: `type:examples.v1_process_binding/${name}`,
    name,
    fields,
    source_ref: sourceRef(),
  };
}

function field(name, typeRef) {
  return {
    name,
    type_ref: typeRef,
    source_ref: sourceRef(),
  };
}

function parameter(name, typeRef) {
  return {
    name,
    type_ref: typeRef,
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

function sourceRef() {
  return {
    source_id: resolve(fixtureRoot, "source/tb-v1-p01-process-fetch-source.tb"),
    start_byte: 0,
    end_byte: 0,
    start_line: 1,
    start_column: 0,
    end_line: 1,
    end_column: 0,
  };
}

function assertTraceShape(trace) {
  assert.equal(trace.trace_protocol_version, TRACE_PROTOCOL_VERSION);
  assert.equal(trace.run.entry_ref, "skill:examples.v1_process_binding/BuildSource");
  assert.equal(trace.events[0].kind, "run_started");
  assert.equal(trace.events.at(-1).kind, "run_completed");
}

function eventOf(trace, kind) {
  return trace.events.find((event) => event.kind === kind);
}
