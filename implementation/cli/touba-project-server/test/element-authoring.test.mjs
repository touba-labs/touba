import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
      description: "Selects a governed review capability for the request.",
      uses: [`skill:${MODULE_REF}/ExistingSkill`],
      callable_by: [`strategy:${MODULE_REF}/ExistingStrategy`],
      memories: [{ ref: `memory:${MODULE_REF}/ProjectNotes`, access: "read" }],
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
      }),
    });
    const manifest = JSON.parse(result.changes.find((item) => item.role === "manifest").content);
    const binding = manifest.bindings[`tool:${MODULE_REF}/LookupRecord`];
    assert.deepEqual(binding.grants, ["network", "secret_read"]);
    assert.deepEqual(binding.secrets, ["SERVICE_API_TOKEN"]);
    assert.deepEqual(binding.sandbox, { required: true });
    const stub = result.changes.find((item) => item.role === "handler_stub");
    assert.match(stub.content, /HandlerStubNotImplemented/u);
    assert.doesNotMatch(stub.content, /process\.env|fetch\s*\(/u);
  } finally {
    project.dispose();
  }
});

test("element authoring rejects duplicates, cross-module references and missing authority", () => {
  const project = createProject();
  try {
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
          uses: ["skill:other.module/ForeignSkill"],
          callable_by: [`strategy:${MODULE_REF}/ExistingStrategy`],
        }),
      }),
      /edited module only/u,
    );
    assert.throws(
      () => normalizeElementAuthoringRequest(requestFor({
        kind: "agent",
        name: "UncallableAgent",
        description: "Has no declared strategy authority in the project.",
        uses: [`skill:${MODULE_REF}/ExistingSkill`],
      })),
      /callable_by/u,
    );
  } finally {
    project.dispose();
  }
});

function requestFor(element) {
  return {
    schema_version: "touba-element-authoring-request-v0.1",
    proposal_id: `proposal_${element.kind}_${element.name}`,
    module_ref: MODULE_REF,
    element,
    requested_by: { kind: "studio", id: "touba-studio" },
    reason: `Add ${element.name}.`,
  };
}

function createProject() {
  const root = mkdtempSync(join(tmpdir(), "touba-element-authoring-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "main.tb"), BASE_SOURCE, "utf8");
  writeFileSync(join(root, "touba.manifest.json"), `${JSON.stringify({
    manifest_version: "touba-manifest-v1",
    bindings: {
      [`tool:${MODULE_REF}/ExistingTool`]: {
        handler: {
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
  assert.equal(JSON.parse(result.stdout).air_schema_version, "air-minimal-v0.1");
}
