#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadSkillPack } from "../../cli/touba-project/src/skill-packs.mjs";
import {
  AIR_CAPABILITY_PROFILE,
  AIR_JSON_PROFILE,
  AIR_SCHEMA_VERSION,
  executeAirDocument,
  loadToolBindingManifestFromJson,
} from "../../runtime/touba-runtime/src/index.mjs";

const SCRIPT_SENTINEL = "RAW_PAYLOAD_SENTINEL_FROM_SCRIPT_RESOURCE";

const skillPackDefinitions = [
  {
    skillId: "literature-review",
    description: "Plan a concise literature review from declared references.",
    procedure: [
      "# Literature Review",
      "",
      "Use the checklist before drafting a review.",
      "Do not execute scripts from this pack.",
      "",
    ].join("\n"),
    resources: [
      {
        ref: "resource:literature-review/checklist",
        path: "resources/references/review-checklist.md",
        kind: "reference",
        content: "- scope\n- evidence\n- limitations\n",
      },
      {
        ref: "resource:literature-review/example",
        path: "resources/examples/short-review.md",
        kind: "example",
        content: "A short review names the claim, evidence and limitation.",
      },
    ],
    execution_links: [],
  },
  {
    skillId: "dataset-brief",
    description: "Prepare a governed dataset brief with a reusable template.",
    procedure: [
      "# Dataset Brief",
      "",
      "Use the template and example to prepare a bounded brief.",
      "Ask for the governed Touba skill when a brief must be produced.",
      "",
    ].join("\n"),
    resources: [
      {
        ref: "resource:dataset-brief/template",
        path: "resources/templates/dataset-brief.md",
        kind: "template",
        content: "Brief: {{topic}}\nSources: declared datasets only.\n",
      },
      {
        ref: "resource:dataset-brief/example",
        path: "resources/examples/fire-safety.md",
        kind: "example",
        content: "Example topic: fire safety open data.",
      },
      {
        ref: "resource:dataset-brief/normalizer",
        path: "scripts/normalize_dataset.mjs",
        kind: "script",
        content: `console.log("${SCRIPT_SENTINEL}");\n`,
        loadable_as_context: false,
      },
    ],
    execution_links: [
      {
        label: "Build governed dataset brief",
        target_ref: "skill:test/BuildDatasetBrief",
        description: "Informative link to the Touba executable skill.",
      },
    ],
  },
  {
    skillId: "release-checklist",
    description: "Review release readiness using a compact checklist.",
    procedure: [
      "# Release Checklist",
      "",
      "Use this pack for release readiness checks, not dataset briefs.",
      "",
    ].join("\n"),
    resources: [
      {
        ref: "resource:release-checklist/template",
        path: "resources/templates/release-checklist.md",
        kind: "template",
        content: "- tests\n- docs\n- version\n",
      },
    ],
    execution_links: [],
  },
];

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), "touba-skills-first-v1-"));
  try {
    const projectRoot = materializeSkillPackProject(tempRoot);
    const skillPacks = skillPackDefinitions.map(definition => loadSkillPack(join(projectRoot, "packages/fixture.context_" + definition.skillId.replaceAll("-", "_"))));
    await validateOrientation(skillPacks);
    const positive = await validateGovernedExecution(skillPacks);
    const refusal = await validateInvalidExecutionLink(skillPacks);

    assertTraceDoesNotContain(positive.trace, [SCRIPT_SENTINEL]);
    assertTraceDoesNotContain(refusal.trace, [SCRIPT_SENTINEL]);
    console.log("skills-first-v1: status=success packs=3 active=skill_pack:fixture.context_dataset_brief/dataset-brief checks=orientation,activation,governed_skill,refusal");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function validateOrientation(skillPacks) {
  const result = await executeAirDocument(scenarioDocument(), {
    entryRef: "strategy:test/RunSkillsFirst",
    inputs: { topic: "fire safety open data" },
    skillPacks,
    agentDecisionProvider: (request) => {
      assert.equal(request.mode, "summary");
      assert.deepEqual(
        request.model_input.skill_pack_hints.map((hint) => hint.ref),
        [
          "skill_pack:fixture.context_literature_review/literature-review",
          "skill_pack:fixture.context_dataset_brief/dataset-brief",
          "skill_pack:fixture.context_release_checklist/release-checklist",
        ],
      );
      assert.equal(request.model_input.active_skill_packs, undefined);
      assert.equal(JSON.stringify(request.model_input).includes("Brief: {{topic}}"), false);
      return {
        action: "answer_directly",
        source: "skills_first_fixture",
        reason: "orientation selected dataset-brief for the user task",
        result: "activate dataset-brief",
      };
    },
  });
  assert.equal(result.status, "success");
  assert.equal(eventOf(result.trace, "skill_pack_discovery_listed").payload.skill_pack_count, 3);
  assert.equal(eventsOf(result.trace, "skill_pack_activated").length, 0);
}

async function validateGovernedExecution(skillPacks) {
  const handlerCalls = [];
  const result = await executeAirDocument(scenarioDocument(), {
    entryRef: "strategy:test/RunSkillsFirst",
    inputs: {
      topic: "fire safety open data",
    },
    skillPacks,
    activeSkillPackRefs: ["skill_pack:fixture.context_dataset_brief/dataset-brief"],
    skillPackActivationReasons: {
      "skill_pack:fixture.context_dataset_brief/dataset-brief": "user_task_dataset_brief",
    },
    agentDecisionProvider: (request) => {
      if (request.mode === "summary" && request.step_index === 1) {
        return {
          action: "answer_directly",
          source: "skills_first_fixture",
          reason: "governed skill result is sufficient",
          result: request.observations[0].value,
        };
      }
      if (request.mode === "summary") {
        assert.equal(request.model_input.skill_pack_hints.length, 3);
        assert.equal(request.model_input.active_skill_packs.length, 1);
        const activePack = request.model_input.active_skill_packs[0];
        assert.equal(activePack.ref, "skill_pack:fixture.context_dataset_brief/dataset-brief");
        assert.equal(activePack.execution_links[0].authority, "informative_only");
        const template = activePack.resources.find((resource) => resource.ref === "resource:dataset-brief/template");
        const script = activePack.resources.find((resource) => resource.ref === "resource:dataset-brief/normalizer");
        assert.equal(template.content.includes("{{topic}}"), true);
        assert.equal(script.content, undefined);
        assert.equal(script.executable_by_pack, false);
        return {
          action: "request_capabilities",
          source: "skills_first_fixture",
          reason: "need governed executable skill",
        };
      }
      assert.equal(request.mode, "capabilities");
      assert.equal(
        request.capabilities.some((capability) => capability.target_ref === "skill:test/BuildDatasetBrief"),
        true,
      );
      return {
        target_ref: "skill:test/BuildDatasetBrief",
        source: "skills_first_fixture",
        reason: "dataset-brief pack points to the governed skill",
        arguments: {
          topic: request.inputs.topic,
        },
      };
    },
    toolHandlers: {
      "tool:test/RenderDatasetBrief": ({ arguments: args, binding }) => {
        handlerCalls.push(args.topic);
        assert.deepEqual(binding.grants, ["local_process"]);
        return `brief:${args.topic}`;
      },
    },
    toolBindingManifest: governedManifest(),
  });

  assert.equal(result.status, "success", JSON.stringify(result.trace, null, 2));
  assert.equal(result.result, "brief:fire safety open data");
  assert.deepEqual(handlerCalls, ["fire safety open data"]);
  assert.equal(eventOf(result.trace, "skill_pack_activated").payload.skill_pack_ref, "skill_pack:fixture.context_dataset_brief/dataset-brief");
  assert.equal(
    eventsOf(result.trace, "skill_pack_resource_loaded").some((event) =>
      event.payload.resource_ref === "resource:dataset-brief/template"
    ),
    true,
  );
  assert.equal(eventOf(result.trace, "skill_pack_resource_refused").payload.runtime_error_code, "SkillPackScriptExecutionForbidden");
  assert.equal(eventOf(result.trace, "agent_capability_selected").payload.selected_ref, "skill:test/BuildDatasetBrief");
  assert.equal(eventOf(result.trace, "tool_binding_authorized").payload.tool_ref, "tool:test/RenderDatasetBrief");
  return result;
}

async function validateInvalidExecutionLink(skillPacks) {
  const badPacks = skillPacks.map((pack) => {
    if (pack.ref !== "skill_pack:fixture.context_dataset_brief/dataset-brief") {
      return pack;
    }
    return {
      ...pack,
      execution_links: [
        {
          label: "Hidden export",
          target_ref: "tool:test/HiddenExport",
        },
      ],
    };
  });
  let providerCalled = false;
  const result = await executeAirDocument(scenarioDocument(), {
    entryRef: "strategy:test/RunSkillsFirst",
    skillPacks: badPacks,
    inputs: { topic: "fire safety open data" },
    activeSkillPackRefs: ["skill_pack:fixture.context_dataset_brief/dataset-brief"],
    agentDecisionProvider: () => {
      providerCalled = true;
      return { action: "answer_directly", result: "unreachable" };
    },
  });

  assert.equal(result.status, "failure");
  assert.equal(providerCalled, false);
  assert.equal(
    eventsOf(result.trace, "skill_pack_resource_refused").some((event) =>
      event.payload.runtime_error_code === "SkillPackExecutionLinkUnauthorized"
    ),
    true,
  );
  assert.equal(eventOf(result.trace, "failure_detected").payload.runtime_error_code, "SkillPackExecutionLinkUnauthorized");
  return result;
}

function materializeSkillPackProject(tempRoot) {
  const projectRoot = join(tempRoot, "project");
  for (const definition of skillPackDefinitions) {
    const packPath = join(projectRoot, "packages", "fixture.context_" + definition.skillId.replaceAll("-", "_"));
    for (const relativeDir of [
      "",
      "resources",
      "resources/references",
      "resources/examples",
      "resources/templates",
      "resources/samples",
      "scripts",
      "tests",
      "tests/fixtures",
    ]) {
      mkdirSync(join(packPath, relativeDir), { recursive: true });
    }
    writeFile(packPath, "SKILL.md", definition.procedure);
    for (const resource of definition.resources) {
      writeFile(packPath, resource.path, resource.content);
    }
    writeFile(packPath, "touba.package.json", `${JSON.stringify(skillPackDescriptor(definition), null, 2)}\n`);
  }
  return projectRoot;
}

function skillPackDescriptor(definition) {
  return { package_schema_version: "touba-package-v1", name: "fixture.context_" + definition.skillId.replaceAll("-", "_"), version: "0.1.0",
    touba: { air_profile: "touba-air-json-canonical-v1", runtime_compatibility: ">=0.1.0 <0.2.0" }, exports: {},
    contexts: [{ id: definition.skillId, description: definition.description, procedure: "SKILL.md",
      resources: definition.resources.map(resource => ({ name: resource.ref.split("/").at(-1), path: resource.path,
        kind: resource.kind, description: "Fixture resource", loadable_as_context: resource.loadable_as_context ?? true })),
      execution_links: definition.execution_links }],
  };
}
function scenarioDocument() {
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
      types: [],
      constants: [],
      functions: [],
      tools: [
        {
          id: "tool:test/RenderDatasetBrief",
          name: "RenderDatasetBrief",
          description: "Render a governed dataset brief from the approved topic.",
          signature: {
            inputs: [
              {
                name: "topic",
                type_ref: "builtin:Text",
                source_ref: sourceRef(),
              },
            ],
            output_type: "builtin:Text",
          },
          required_capabilities: ["local_process"],
          source_ref: sourceRef(),
        },
      ],
      memories: [],
      skills: [
        {
          id: "skill:test/BuildDatasetBrief",
          name: "BuildDatasetBrief",
          description: "Build a governed dataset brief with the authorized renderer.",
          signature: {
            inputs: [
              {
                name: "topic",
                type_ref: "builtin:Text",
                source_ref: sourceRef(),
              },
            ],
            output_type: "builtin:Text",
          },
          uses: ["tool:test/RenderDatasetBrief"],
          flow_graph_ref: "graph:skill:test/BuildDatasetBrief",
          source_ref: sourceRef(),
        },
      ],
      agents: [
        {
          id: "agent:test/Researcher",
          name: "Researcher",
          responsibility: "Prepare governed dataset briefs from selected skill packs.",
          signature: { inputs: [{ name: "topic", type_ref: "builtin:Text", source_ref: sourceRef() }], output_type: "builtin:Text" },
          uses: ["skill:test/BuildDatasetBrief"],
          callable_by: [
            {
              caller_ref: "strategy:test/RunSkillsFirst",
              caller_kind: "strategy",
              source_ref: sourceRef(),
            },
          ],
          source_ref: sourceRef(),
        },
      ],
      strategies: [
        {
          id: "strategy:test/RunSkillsFirst",
          name: "RunSkillsFirst",
          signature: { inputs: [{ name: "topic", type_ref: "builtin:Text", source_ref: sourceRef() }], output_type: "builtin:Text" },
          uses: ["agent:test/Researcher"],
          flow_graph_ref: "graph:strategy:test/RunSkillsFirst",
          source_ref: sourceRef(),
        },
      ],
      triggers: [],
    },
    execution_graphs: [
      {
        id: "graph:skill:test/BuildDatasetBrief",
        owner_ref: "skill:test/BuildDatasetBrief",
        entry_node_id: "render",
        nodes: [
          {
            id: "render",
            kind: "call_tool",
            target_ref: "tool:test/RenderDatasetBrief",
            arguments: ["value:topic"],
            result_binding: "brief",
            trace_point_refs: [],
            source_ref: sourceRef(),
          },
          {
            id: "done",
            kind: "give",
            arguments: ["value:brief"],
            trace_point_refs: [],
            source_ref: sourceRef(),
          },
        ],
        edges: [
          {
            from_node_id: "render",
            to_node_id: "done",
            role: "next",
          },
        ],
        expressions: [],
        failure_paths: [],
        failure_path_refs: [],
        source_ref: sourceRef(),
      },
      {
        id: "graph:strategy:test/RunSkillsFirst",
        owner_ref: "strategy:test/RunSkillsFirst",
        entry_node_id: "run",
        nodes: [
          {
            id: "run",
            kind: "call_agent",
            target_ref: "agent:test/Researcher",
            arguments: ["value:topic"],
            trace_point_refs: [],
            source_ref: sourceRef(),
          },
        ],
        edges: [],
        expressions: [],
        failure_paths: [],
        failure_path_refs: [],
        source_ref: sourceRef(),
      },
    ],
    trace_points: [],
  };
}

function governedManifest() {
  return loadToolBindingManifestFromJson(JSON.stringify({
    manifest_version: "touba-manifest-v1",
    bindings: {
      "tool:test/RenderDatasetBrief": {
        effect_contract: { kind: "none" }, handler: {
          kind: "process",
          command: "node",
          args: ["./handlers/render_dataset_brief.handler.js"],
        },
        grants: ["local_process"],
        secrets: [],
        timeout_ms: 5000,
        max_payload_bytes: 1048576,
      },
    },
  }));
}

function writeFile(root, relativePath, content) {
  const path = join(root, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function eventOf(trace, kind) {
  const event = eventsOf(trace, kind)[0];
  assert.ok(event, `missing trace event ${kind}`);
  return event;
}

function eventsOf(trace, kind) {
  return trace.events.filter((event) => event.kind === kind);
}

function assertTraceDoesNotContain(trace, values) {
  const serialized = JSON.stringify(trace);
  for (const value of values) {
    assert.equal(serialized.includes(value), false, `trace leaks ${value}`);
  }
}

function sourceRef() {
  return {
    source_id: "skills-first-v1.tb",
    start_byte: 0,
    end_byte: 0,
    start_line: 1,
    start_column: 0,
    end_line: 1,
    end_column: 0,
  };
}
