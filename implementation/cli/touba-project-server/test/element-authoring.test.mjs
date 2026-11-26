import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { compileProposedSources } from "../src/source-validation.mjs";
import { buildAuthorityGraph, buildElementAuthoringPreview, proposeProjectChange, applyProjectChange, getProjectChangeDetail } from "../src/serve.mjs";
import { initProject, prepareProject } from "../../touba-project/src/project.mjs";
import { createProjectActivityGate } from '../src/project-activity.mjs';

import {
  buildElementAuthoringChangeSet,
  normalizeElementAuthoringRequest,
  readElementSource,
} from "../src/element-authoring.mjs";

const MODULE_REF = "demo.authoring";

test('reviewed local removal uses compiler spans and rejects remaining callers or stale source', () => {
  const project=createProject();
  try {
    const path=join(project.root,'src/main.tb');
    // Unicode before the declaration exercises compiler byte offsets.
    writeFileSync(path,BASE_SOURCE+'\n# Échéance à retirer\ntrigger Obsolete\n    on schedule "every 1h"\n    runs strategy ExistingStrategy\n    with request as "ok"\n    limits\n        max_runs_per_day as 2\n        timeout_ms as 30000\n');
    const source=readElementSource({projectRoot:project.root,elementRef:`trigger:${MODULE_REF}/Obsolete`});
    const request={...requestFor({kind:'trigger',name:'Obsolete',description:''}),source_remove:{base_digest:source.base_digest}};
    const preview=buildElementAuthoringPreview({projectRoot:project.root,request});
    assert.equal(preview.status,'ready');assert.match(preview.changes[0].diff,/-trigger Obsolete/);
    const changes=buildElementAuthoringChangeSet({projectRoot:project.root,request}).changes;
    assert.match(changes[0].content,/# Échéance à retirer/);
    assert.equal(readFileSync(path,'utf8'),source.content,'preview never writes');
    const tool=readElementSource({projectRoot:project.root,elementRef:`tool:${MODULE_REF}/ExistingTool`});
    assert.throws(()=>buildElementAuthoringPreview({projectRoot:project.root,request:{...requestFor({kind:'tool',name:'ExistingTool',description:''}),source_remove:{base_digest:tool.base_digest}}}),{code:'ToubaServeChangeValidationFailed'});
    writeFileSync(path,source.content+'\n');
    assert.throws(()=>buildElementAuthoringChangeSet({projectRoot:project.root,request}),{code:'ToubaServeElementPreviewStale'});
  } finally {project.dispose();}
});

test('fragment review only accepts declared project fragments with the binding contract', () => {
  const project=createProject();
  try {
    const fragment={fragment_schema_version:'touba-binding-fragment-v1',source:{kind:'project'},bindings:{}};
    writeFileSync(join(project.root,'touba.project.json'),JSON.stringify({configuration:{binding_fragments:['adapter.json','.touba/private.json']}}));
    writeFileSync(join(project.root,'adapter.json'),JSON.stringify(fragment));
    const proposal={schema_version:'touba-project-change-proposal-v1',proposal_id:'fragment',action:'write_text_file',
      target:{path:'adapter.json'},content:JSON.stringify(fragment),requested_by:{kind:'user',id:'reviewer'},reason:'Review selected fragment'};
    const options={projectRoot:project.root,changeProposalsPath:join(project.root,'.touba/changes.sqlite')};
    assert.doesNotThrow(()=>proposeProjectChange({...options,proposal}));
    for (const path of ['other.json','.touba/private.json','../outside.json']) {
      assert.throws(()=>proposeProjectChange({...options,proposal:{...proposal,proposal_id:'invalid-'+path,target:{path}}}));
    }
    assert.throws(()=>proposeProjectChange({...options,proposal:{...proposal,proposal_id:'malformed',content:'{"credentials":"never accept"}'}}),{code:'ToubaServeChangeValidationFailed'});
    if (process.platform !== 'win32') {
      rmSync(join(project.root,'adapter.json'));
      symlinkSync(join(project.root,'touba.project.json'),join(project.root,'adapter.json'));
      assert.throws(()=>proposeProjectChange({...options,proposal:{...proposal,proposal_id:'linked-fragment'}}),{code:'ToubaServeChangeTargetRejected'});
      rmSync(join(project.root,'adapter.json'));
      writeFileSync(join(project.root,'adapter.json'),JSON.stringify(fragment));
      const config=readFileSync(join(project.root,'touba.project.json'));
      writeFileSync(join(project.root,'linked-config.json'),config);
      rmSync(join(project.root,'touba.project.json'));
      symlinkSync(join(project.root,'linked-config.json'),join(project.root,'touba.project.json'));
      assert.throws(()=>proposeProjectChange({...options,proposal:{...proposal,proposal_id:'linked-config'}}),{code:'ToubaServeChangeTargetRejected'});
    }
  } finally {project.dispose();}
});

test('source editor preview derives approval prerequisites from compiled tools', () => {
  const project = createProject();
  try {
    const source = readElementSource({ projectRoot: project.root, elementRef: `tool:${MODULE_REF}/ExistingTool` });
    const content = source.content.replace('    requires filesystem_read',
      '    requires filesystem_read\n    human.approve\n        with role as "controller"\n        with timeout_ms as 60000\n        with distinct_from as "initiator"');
    const request = { ...requestFor({ kind: 'tool', name: 'ExistingTool', description: '' }),
      source_update: { content, base_digest: source.base_digest } };
    const gate = createProjectActivityGate(() => []);
    const preview = buildElementAuthoringPreview({ projectRoot: project.root, request, runtimeReadiness: { gate } });
    assert.deepEqual(preview.validations.filter(item => item.severity === 'warning').map(item => item.code),
      ['ToubaServeApprovalHostRequired', 'HumanApprovalInitiatorRequired']);
    const host = { humanApprovalAuthority: () => { throw new Error('must not be invoked'); }, humanApprovalInitiator: 'trusted-initiator' };
    const ready = buildElementAuthoringPreview({ projectRoot: project.root, request, runtimeReadiness: { gate, host } });
    assert.equal(ready.validations.filter(item => item.severity === 'warning').length, 0);
    assert.equal(ready.preview_digest, preview.preview_digest, 'host readiness does not rewrite the reviewed file diff');
    assert.equal(readFileSync(join(project.root, source.path), 'utf8'), source.content);
  } finally { project.dispose(); }
});

test('existing source edits compile the whole project, retain reviewed diffs and refuse stale source', () => {
  const { root, dispose } = createProject();
  try {
    const source = readElementSource({ projectRoot: root, elementRef: `strategy:${MODULE_REF}/ExistingStrategy` });
    const manifest = readFileSync(join(root, 'touba.manifest.json'));
    const content = source.content.replace('give request', 'give "edited"');
    const request = { ...requestFor({ kind: 'strategy', name: 'ExistingStrategy', description: '' }),
      source_update: { content, base_digest: source.base_digest } };
    const draft = buildElementAuthoringChangeSet({ projectRoot: root, request });
    assert.equal(draft.changes.length, 1, 'editing never regenerates a handler or changes host grants');
    const preview = buildElementAuthoringPreview({ projectRoot: root, request });
    assert.equal(preview.status, 'ready'); assert.match(preview.changes[0].diff, /\+.*give "edited"/);
    assert.equal(readFileSync(join(root, source.path), 'utf8'), source.content, 'preview is read only');
    assert.throws(() => buildElementAuthoringPreview({ projectRoot: root, request: { ...request,
      source_update: { ...request.source_update, content: content.replace('give "edited"', 'give UnknownName') } } }), { code: 'ToubaServeChangeValidationFailed' });
    const path = join(root, '.touba/project-change-proposals.sqlite');
    proposeProjectChange({ projectRoot: root, changeProposalsPath: path, proposal: {
      schema_version: 'touba-project-change-proposal-v1', proposal_id: 'source-edit', action: 'write_text_file',
      target: { path: source.path }, content, requested_by: request.requested_by, reason: 'Edit reviewed source',
    } });
    const before = getProjectChangeDetail({ projectRoot: root, changeProposalsPath: path, proposalId: 'source-edit' });
    applyProjectChange({ projectRoot: root, changeProposalsPath: path, applyRequest: {
      schema_version: 'touba-project-change-apply-v1', proposal_id: 'source-edit', decision: 'apply', decided_by: 'user:reviewer', reason: 'Reviewed',
    } });
    const after = getProjectChangeDetail({ projectRoot: root, changeProposalsPath: path, proposalId: 'source-edit' });
    assert.deepEqual(after.change.diffs, before.change.diffs);
    assert.equal(after.change.diffs[0].diff, preview.changes[0].diff);
    assert.deepEqual(readFileSync(join(root, 'touba.manifest.json')), manifest);
    assert.throws(() => buildElementAuthoringChangeSet({ projectRoot: root, request }), { code: 'ToubaServeElementPreviewStale' });
    assert.throws(() => readElementSource({ projectRoot: root, elementRef: '../private.txt' }), { code: 'ToubaServeElementReferenceInvalid' });
    assert.throws(() => readElementSource({ projectRoot: root, elementRef: `tool:${MODULE_REF}/Missing` }), { code: 'ToubaServeElementReferenceInvalid' });
  } finally { dispose(); }
});
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
      requirements: ["network"], handler: { effect_contract: { kind: "none" }, sandbox_required: false },
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
    assert.equal(binding.handler.command, process.platform === 'win32' ? './.venv/Scripts/python.exe' : './.venv/bin/python');
    assert.deepEqual(binding.handler.args, [stub.path]);
    assertCompiles(project.root, result.changes[0].content);
    const before = readFileSync(join(project.root, 'touba.project.json'), 'utf8');
    assert.throws(() => buildElementAuthoringChangeSet({ projectRoot: project.root, request: requestFor({
      kind: 'tool', name: 'ConfinedPython', description: 'Read a local synthetic record.', takes: [], gives: 'Text', requirements: [],
      handler: { effect_contract: { kind: 'none' }, sandbox_required: true },
    }) }), { code: 'ToubaServeElementSandboxInventoryRequired' });
    assert.equal(readFileSync(join(project.root, 'touba.project.json'), 'utf8'), before);
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
    requested_by: { kind: "studio", id: "example-client" },
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
