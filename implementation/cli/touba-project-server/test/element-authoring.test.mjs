import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { compileProposedSources } from "../src/source-validation.mjs";
import { buildAuthorityGraph } from "../src/serve.mjs";
import { initProject, prepareProject } from "../../touba-project/src/project.mjs";

import {
  buildElementAuthoringChangeSet,
  normalizeElementAuthoringRequest,
} from "../src/element-authoring.mjs";

const MODULE_REF = "demo.authoring";
const BASE_SOURCE = [
  `module ${MODULE_REF}`,
  "",
  "memory ProjectNotes",
  "",
  "tool ExistingTool",
  '    description "Reads one existing governed project record."',
  "    takes request as Text",
  "    gives Text",
  "    requires filesystem_read",
  "",
  "skill ExistingSkill",
  '    description "Returns the existing governed project record."',
  "    takes request as Text",
  "    gives Text",
  "    uses ExistingTool",
  "    do",
  "        give request",
  "",
  "agent ExistingAgent",
  '    description "Selects the existing governed project capability."',
  '    responsibility "Select only the existing capability authorized by the enclosing strategy."',
  "    uses ExistingSkill",
  "    callable_by strategy ExistingStrategy",
  "",
  "strategy ExistingStrategy",
  '    description "Runs the existing governed project capability."',
  "    takes request as Text",
  "    gives Text",
  "    uses ExistingAgent",
  "    do",
  "        give request",
  "",
].join("\n");

test("element authoring normalizes bounded semantic input and rejects source-shaped fields", () => {
  const normalized = normalizeElementAuthoringRequest(requestFor({
    kind: "function",
    name: "FormatResult",
    description: "Formats a governed result for the project.",
    takes: [{ name: "value", type_ref: "Text" }],
    gives: "Text",
  }));
  assert.equal(normalized.element.name, "FormatResult");
  assert.equal(Object.hasOwn(normalized.element, "content"), false);
  assert.throws(
    () => normalizeElementAuthoringRequest({
      ...requestFor({
        kind: "memory",
        name: "OtherMemory",
        description: "Project memory.",
      }),
      element: {
        ...requestFor({
          kind: "memory",
          name: "OtherMemory",
          description: "Project memory.",
        }).element,
        source: "tool Unsafe",
      },
    }),
    /source/u,
  );
});

test("element authoring produces compilable source drafts for every Touba primitive", () => {
  const cases = [
    {
      kind: "memory",
      name: "NewMemory",
      description: "Stores governed test evidence.",
    },
    {
      kind: "function",
      name: "FormatResult",
      description: "Formats a governed result for the project.",
      takes: [{ name: "value", type_ref: "Text" }],
      gives: "Text",
    },
    {
      kind: "tool",
      name: "LookupRecord",
      description: "Reads one governed record from the declared service.",
      takes: [{ name: "request", type_ref: "Text" }],
      gives: "Text",
      requirements: ["network", "secret_read"],
      secrets: ["SERVICE_API_TOKEN"],
      handler: {
        effect_contract: { kind: "none" },
        timeout_ms: 7000,
        max_payload_bytes: 65536,
        sandbox_required: true,
      },
    },
    {
      kind: "skill",
      name: "PrepareRecord",
      description: "Prepares one governed record for project review.",
      takes: [{ name: "request", type_ref: "Text" }],
      gives: "Text",
      uses: [`tool:${MODULE_REF}/ExistingTool`],
    },
    {
      kind: "agent",
      name: "ReviewAgent",
      takes: [{ name: "request", type_ref: "List of Optional of Text" }],
      gives: "List of Optional of Text",
      description: "Selects a governed review capability for the request.",
      responsibility: "Review the request using only the explicitly declared capability.",
      uses: [`skill:${MODULE_REF}/ExistingSkill`],
      callable_by: [`strategy:${MODULE_REF}/ExistingStrategy`],
      memories: [{ ref: `memory:${MODULE_REF}/ProjectNotes`, access: "read" }],
    },
    {
      kind: "agent",
      name: "DirectAnswer",
      description: "Answers directly without external capabilities.",
      responsibility: "Provide the answer without external effects.",
      gives: "Text",
      uses: [],
      callable_by: [`strategy:${MODULE_REF}/ExistingStrategy`],
    },
    {
      kind: "strategy",
      name: "FormatStrategy",
      description: "Runs a bounded governed formatting operation.",
      takes: [{ name: "request", type_ref: "Text" }],
      gives: "Text",
      uses: [`agent:${MODULE_REF}/ExistingAgent`],
    },
    {
      kind: "trigger",
      name: "ReviewWebhook",
      description: "Receives one governed project review request.",
      trigger: {
        event_kind: "request",
        method: "POST",
        path: "/review",
        target_ref: `strategy:${MODULE_REF}/ExistingStrategy`,
        payload_map: { request: "$.request" },
        max_runs_per_day: 25,
        timeout_ms: 30000,
      },
    },
  ];

  for (const element of cases) {
    const project = createProject();
    try {
      const result = buildElementAuthoringChangeSet({
        projectRoot: project.root,
        request: requestFor(element),
      });
      assert.equal(result.element_ref, `${element.kind}:${MODULE_REF}/${element.name}`);
      assert.match(result.changes[0].content, new RegExp(`^${element.kind} ${element.name}$`, "mu"));
      assert.equal(result.changes.some((item) => item.path === "touba.manifest.json"), ["tool", "trigger"].includes(element.kind));
      assert.equal(result.changes.some((item) => item.role === "handler_stub"), element.kind === "tool");
      assertCompiles(project.root, result.changes[0].content);
    } finally {
      project.dispose();
    }
  }
});

test("tool authoring refuses an unspecified effect contract", () => {
  assert.throws(() => normalizeElementAuthoringRequest(requestFor({
    kind: "tool", name: "ReadRecord", description: "Reads one explicitly authorized record.",
    takes: [], gives: "Text", requirements: ["network"],
  })), (error) => error.code === "ToubaServeElementEffectContractRequired");
});

test("tool authoring creates a disabled-by-code stub and a sandboxed manifest binding", () => {
  const project = createProject();
  try {
    const result = buildElementAuthoringChangeSet({
      projectRoot: project.root,
      request: requestFor({
        kind: "tool",
        name: "LookupRecord",
        description: "Reads one governed record from the declared service.",
        takes: [{ name: "request", type_ref: "Text" }],
        gives: "Text",
        requirements: ["network", "secret_read"],
        secrets: ["SERVICE_API_TOKEN"],
        handler: { effect_contract: { kind: "none" } },
      }),
    });
    const manifest = JSON.parse(result.changes.find((item) => item.role === "manifest").content);
    const binding = manifest.bindings[`tool:${MODULE_REF}/LookupRecord`];
    assert.deepEqual(binding.grants, ["network", "secret_read"]);
    assert.deepEqual(binding.secrets, ["SERVICE_API_TOKEN"]);
    assert.deepEqual(binding.sandbox, { required: true });
    assert.deepEqual(binding.effect_contract, { kind: "none" });
    const stub = result.changes.find((item) => item.role === "handler_stub");
    assert.match(stub.content, /HandlerNotImplemented/u);
    assert.match(stub.content, /from "@touba\/sdk"/u);
    assert.match(stub.content, /"type_ref": "builtin:Text"/u);
    assert.match(stub.content, /OUTPUT_TYPE = "builtin:Text"/u);
    assert.doesNotMatch(stub.content, /process\.env|fetch\s*\(/u);
  } finally {
    project.dispose();
  }
});

test("tool authoring uses the canonical Python SDK and project interpreter", () => {
  const project = createProject();
  try {
    writeFileSync(join(project.root, "touba.project.json"), JSON.stringify({ project_version: "touba-project-v1", language: "python", sdk: "touba-sdk", artifact_layout: "touba-artifacts-v1" }));
    const result = buildElementAuthoringChangeSet({ projectRoot: project.root, request: requestFor({
      kind: "tool", name: "PythonLookup", description: "Reads the selected record.", takes: [{ name: "request", type_ref: "Text" }], gives: "Text",
      requirements: ["network"], handler: { effect_contract: { kind: "none" } },
    }) });
    const stub = result.changes.find(item => item.role === "handler_stub");
    assert.ok(stub.path.endsWith(".py"));
    assert.match(stub.content, /from touba_sdk import/);
    const inputLiteral = stub.content.match(/^INPUT_SIGNATURE = json.loads\((.*)\)$/mu)[1];
    assert.deepEqual(JSON.parse(JSON.parse(inputLiteral)), [{ name: "request", type_ref: "builtin:Text" }]);
    assert.match(stub.content, /HandlerNotImplemented/);
    const manifest = JSON.parse(result.changes.find(item => item.role === "manifest").content);
    const binding = manifest.bindings[`tool:${MODULE_REF}/PythonLookup`];
    assert.match(binding.handler.command, /python/);
    assert.deepEqual(binding.handler.args, [stub.path]);
    assertCompiles(project.root, result.changes[0].content);
  } finally { project.dispose(); }
});

test("element authoring rejects duplicates, cross-module references and missing authority", () => {
  const project = createProject();
  try {
    assert.throws(
      () => normalizeElementAuthoringRequest(requestFor({
        kind: "agent",
        name: "MissingResponsibility",
        description: "Selects one declared capability for a governed request.",
        uses: [`skill:${MODULE_REF}/ExistingSkill`],
        callable_by: [`strategy:${MODULE_REF}/ExistingStrategy`],
      })),
      /responsibility/u,
    );
    assert.throws(
      () => buildElementAuthoringChangeSet({
        projectRoot: project.root,
        request: requestFor({
          kind: "skill",
          name: "ExistingSkill",
          description: "Duplicates the existing governed project skill.",
          takes: [{ name: "request", type_ref: "Text" }],
          gives: "Text",
        }),
      }),
      /already exists/u,
    );
    assert.throws(
      () => buildElementAuthoringChangeSet({
        projectRoot: project.root,
        request: requestFor({
          kind: "agent",
          name: "CrossModuleAgent",
          description: "Selects a capability declared in another module.",
          responsibility: "Select only capabilities declared and authorized for this module.",
          uses: ["skill:other.module/ForeignSkill"],
          callable_by: [`strategy:${MODULE_REF}/ExistingStrategy`],
        }),
      }),
      /not declared or imported/u,
    );
    assert.throws(
      () => normalizeElementAuthoringRequest(requestFor({
        kind: "agent",
        name: "UncallableAgent",
        description: "Has no declared strategy authority in the project.",
        responsibility: "Use only the declared project capability when called by an authorized strategy.",
        uses: [`skill:${MODULE_REF}/ExistingSkill`],
      })),
      /callable_by/u,
    );
  } finally {
    project.dispose();
  }
});

test("an empty module stays discoverable and explicitly imported capabilities can be authored", () => {
  const project = createProject();
  try {
    writeFileSync(join(project.root, "src/empty.tb"), "module empty\n");
    const graph = buildAuthorityGraph({ projectRoot: project.root });
    assert.ok(graph.nodes.some(node => node.ref === "module:empty" && node.kind === "module"));
    writeFileSync(join(project.root, "src/lib.tb"), 'module lib\nskill Echo\n    takes request as Text\n    gives Text\n    do\n        give request\n');
    writeFileSync(join(project.root, "src/main.tb"), BASE_SOURCE.replace(`module ${MODULE_REF}`, `module ${MODULE_REF}\nimport skill Echo from lib`));
    const request = requestFor({ kind: "agent", name: "ImportedAgent", description: "Uses the imported echo capability.",
      responsibility: "Answer using the authorized imported capability.", takes: [{ name: "request", type_ref: "Text" }], gives: "Text",
      uses: ["skill:lib/Echo"], callable_by: [`strategy:${MODULE_REF}/ExistingStrategy`] });
    const result = buildElementAuthoringChangeSet({ projectRoot: project.root, request });
    assert.deepEqual(compileProposedSources({ projectRoot: project.root, targets: result.changes }).diagnostics, []);
    assert.match(result.changes[0].content, /uses Echo/);
    assert.throws(() => buildElementAuthoringChangeSet({ projectRoot: project.root,
      request: { ...request, element: { ...request.element, uses: ["skill:secret/Echo"] } } }), { code: "ToubaServeElementReferenceUnknown" });
  } finally { project.dispose(); }
});

function requestFor(element) {
  return {
    schema_version: "touba-element-authoring-request-v1",
    proposal_id: `proposal_${element.kind}_${element.name}`,
    module_ref: MODULE_REF,
    element,
    requested_by: { kind: "studio", id: "touba-studio" },
    reason: `Add ${element.name}.`,
  };
}

test("low-code construction compiles a new module, records, enums and explicit bodies without applying them", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-authoring-empty-"));
  try {
    initProject({ root, language: "javascript" });
    const author = element => buildElementAuthoringChangeSet({ projectRoot: root, request: { ...requestFor(element), module_ref: "fresh.main" } });
    const apply = result => { for (const item of result.changes) { mkdirSync(dirname(join(root, item.path)), { recursive: true }); writeFileSync(join(root, item.path), item.content); } };
    const module = author({ kind: "module", name: "main", description: "" });
    assert.equal(module.element_ref, "module:fresh.main");
    assert.deepEqual(compileProposedSources({ projectRoot: root, targets: module.changes }).diagnostics, []);
    apply(module);
    assert.throws(() => author({ kind: "module", name: "main" }), { code: "ToubaServeElementAlreadyExists" });
    for (const element of [
      { kind: "enum", name: "Status", variants: ["pending", "done"] },
      { kind: "type", name: "Invoice", fields: [{ name: "amount", type_ref: "Int" }, { name: "status", type_ref: "Status" }] },
      { kind: "function", name: "Seven", description: "Produce a constant numeric result.", takes: [], gives: "Int", body: ["give 7"], entrypoint: true },
      { kind: "strategy", name: "Daily", description: "Return the supplied daily request.", takes: [{ name: "request", type_ref: "Text" }], gives: "Text", body: ["give request"], entrypoint: true },
      { kind: "trigger", name: "Schedule", trigger: { event_kind: "schedule", schedule: "every 1h", target_ref: "strategy:fresh.main/Daily", arguments: { request: "daily" }, max_runs_per_day: 24, timeout_ms: 30000 }, entrypoint: true },
    ]) {
      const change = author(element);
      assert.deepEqual(compileProposedSources({ projectRoot: root, targets: change.changes }).diagnostics, [], element.name);
      apply(change);
    }
    const prepared = await prepareProject({ root, mode: "write" });
    assert.equal(prepared.status, "success", JSON.stringify(prepared.diagnostics));
    const checked = await prepareProject({ root, mode: "check" });
    assert.equal(checked.status, "success", JSON.stringify(checked.diagnostics));
    const config = JSON.parse(readFileSync(join(root, "touba.project.json")));
    assert.ok(config.entrypoints.includes("trigger:fresh.main/Schedule"));
    const invalid = author({ kind: "function", name: "Invalid", description: "Reject mismatched result types.", gives: "Int", body: ['give "not an integer"'] });
    assert.ok(compileProposedSources({ projectRoot: root, targets: invalid.changes }).diagnostics.some(row => row.severity === "error"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("authoring compiles tool memory scopes and operation-bound approval", () => {
  const project = createProject();
  try {
    const change = buildElementAuthoringChangeSet({ projectRoot: project.root, request: requestFor({
      kind: "tool", name: "ApprovedRead", description: "Read the authorized memory after approval.",
      takes: [{ name: "request", type_ref: "Text" }], gives: "Text", requirements: ["memory_read"],
      memories: [{ ref: `memory:${MODULE_REF}/ProjectNotes`, access: "read" }],
      handler: { effect_contract: { kind: "none" } },
      approval_policy: { role: "controller", timeout_ms: 3600000, distinct_from: "initiator" },
    }) });
    const compiled = compileProposedSources({ projectRoot: project.root, targets: change.changes });
    assert.deepEqual(compiled.diagnostics, []);
    const tool = compiled.air.definitions.tools.find(item => item.id.endsWith("/ApprovedRead"));
    assert.equal(tool.approval_policy.role, "controller");
    assert.match(change.changes[0].content, /uses memory ProjectNotes read/);
  } finally { project.dispose(); }
});

test("authoring rejects escaped bodies, malformed data declarations and misplaced approval", () => {
  for (const element of [
    { kind: "function", body: ["give 1\nstrategy Inject"] }, { kind: "function", body: ["\tgive 1"] },
    { kind: "tool", body: ["give 1"], handler: { effect_contract: { kind: "none" } } },
    { kind: "type", fields: [] }, { kind: "enum", variants: ["same", "same"] },
    { kind: "memory", approval_policy: { role: "controller", timeout_ms: 1000 } },
    { kind: "agent", entrypoint: true, callable_by: [`strategy:${MODULE_REF}/ExistingStrategy`], responsibility: "Answer the explicit user request." },
  ]) assert.throws(() => normalizeElementAuthoringRequest(requestFor({ name: "Rejected", description: "Invalid declaration must be rejected.", ...element })));
});

function createProject() {
  const root = mkdtempSync(join(tmpdir(), "touba-element-authoring-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "main.tb"), BASE_SOURCE, "utf8");
  writeFileSync(join(root, "touba.manifest.json"), `${JSON.stringify({
    manifest_version: "touba-manifest-v1",
    bindings: {
      [`tool:${MODULE_REF}/ExistingTool`]: {
        effect_contract: { kind: "none" }, handler: {
          kind: "process",
          command: "node",
          args: ["handlers/existing.handler.mjs"],
          cwd: ".",
        },
        grants: ["filesystem_read"],
        timeout_ms: 5000,
        max_payload_bytes: 1048576,
      },
    },
    triggers: {},
  }, null, 2)}\n`, "utf8");
  return {
    root,
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function assertCompiles(projectRoot, content) {
  const sourcePath = join(projectRoot, "generated.tb");
  writeFileSync(sourcePath, content, "utf8");
  const compiler = new URL("../../touba-project/src/main.mjs", import.meta.url).pathname;
  const result = spawnSync(process.execPath, [compiler, "compile", sourcePath, "--stdout"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, String(result.stderr || result.stdout));
  assert.equal(JSON.parse(result.stdout).air_schema_version, "touba-air-v1");
}
