#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  validateSkillPacks,
} from "../../cli/touba-project/src/skill-packs.mjs";
import {
  AIR_SCHEMA_VERSION,
  executeAirDocument,
  loadSecretsFromJson,
  loadToolBindingManifestFromJson,
} from "../../runtime/touba-runtime/src/index.mjs";

const SECRET_SENTINEL = "resolved-secret-value";
const RAW_PAYLOAD_SENTINEL = "RAW_PAYLOAD_SENTINEL";
const SYSTEM_PROMPT_SENTINEL = "SYSTEM_PROMPT_SENTINEL";

const results = [];

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const root = mkdtempSync(join(tmpdir(), "touba-skills-v1-"));
  try {
    await runPositiveCases(root);
    await runNegativeCases(root);
    assertCoverage("SKILL-V1-P", 14);
    assertCoverage("SKILL-V1-N", 17);
    const covered = results.filter((result) => result.status === "covered").length;
    const reported = results.filter((result) => result.status === "reported").length;
    console.log(`skills-v1: status=success covered=${covered} reported=${reported}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function runPositiveCases(root) {
  await check("SKILL-V1-P01", "minimal skill pack descriptor is valid", () => {
    const fixture = createSkillPack(caseRoot(root, "p01"), "minimal-review");
    expectProjectValidation(fixture.root, "minimal-review");
  });

  await check("SKILL-V1-P02", "references and examples are declared and activatable", async () => {
    const fixture = createSkillPack(caseRoot(root, "p02"), "research-review", {
      resources: [
        {
          ref: "resource:research-review/reference",
          path: "resources/references/checklist.md",
          kind: "reference",
          content: "Use a source checklist.",
        },
        {
          ref: "resource:research-review/example",
          path: "resources/examples/example.md",
          kind: "example",
          content: "Example answer structure.",
        },
      ],
    });
    expectProjectValidation(fixture.root, "research-review");
    const result = await runAgentWithSkillPacks({
      skillPacks: [
        runtimePack("research-review", {
          resources: [
            {
              ref: "resource:research-review/reference",
              path: "resources/references/checklist.md",
              kind: "reference",
              content: "Use a source checklist.",
            },
            {
              ref: "resource:research-review/example",
              path: "resources/examples/example.md",
              kind: "example",
              content: "Example answer structure.",
            },
          ],
        }),
      ],
      activeSkillPackRefs: ["skill_pack:project/research-review"],
      provider: (request) => {
        assert.equal(request.model_input.active_skill_packs[0].resources.length, 3);
        return { action: "answer_directly", result: "ok" };
      },
    });
    assert.equal(eventsOf(result.trace, "skill_pack_resource_loaded").length, 3);
  });

  await check("SKILL-V1-P03", "orientation lists several packs without loading content", async () => {
    const result = await runAgentWithSkillPacks({
      skillPacks: [
        runtimePack("research-review", { content: "private procedure A" }),
        runtimePack("dataset-brief", { content: "private procedure B" }),
      ],
      provider: (request) => {
        assert.deepEqual(
          request.model_input.skill_pack_hints.map((hint) => hint.ref),
          ["skill_pack:project/research-review", "skill_pack:project/dataset-brief"],
        );
        assert.equal(request.model_input.active_skill_packs, undefined);
        assert.equal(JSON.stringify(request.model_input).includes("private procedure A"), false);
        return { action: "answer_directly", result: "ok" };
      },
    });
    assert.equal(eventOf(result.trace, "skill_pack_discovery_listed").payload.skill_pack_count, 2);
  });

  await check("SKILL-V1-P04", "active pack is traced with reason and budget", async () => {
    const result = await runAgentWithSkillPacks({
      skillPacks: [runtimePack("research-review")],
      activeSkillPackRefs: ["skill_pack:project/research-review"],
      activationReasons: {
        "skill_pack:project/research-review": "provider_requested",
      },
      provider: (request) => {
        assert.equal(request.model_input.active_skill_packs[0].ref, "skill_pack:project/research-review");
        return { action: "answer_directly", result: "ok" };
      },
    });
    const activated = eventOf(result.trace, "skill_pack_activated").payload;
    assert.equal(activated.reason, "provider_requested");
    assert.match(activated.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(typeof activated.approx_size_bytes, "number");
  });

  await check("SKILL-V1-P05", "pack can guide selection of an authorized Touba skill", async () => {
    const result = await executeAirDocument(agentSkillDocument(), {
      inputs: { topic: "governed-topic" },
      skillPacks: [runtimePack("research-review", { content: "Use Answer for direct synthesis." })],
      activeSkillPackRefs: ["skill_pack:project/research-review"],
      agentDecisionProvider: providerSelectsAnswerSkill,
    });
    assert.equal(result.status, "success");
    assert.equal(result.result, "final governed-topic");
    assert.equal(eventOf(result.trace, "agent_capability_selected").payload.selected_ref, "skill:test/Answer");
  });

  await check("SKILL-V1-P06", "pack can guide arguments for an authorized tool", async () => {
    const handlerCalls = [];
    const result = await executeAirDocument(agentToolDocument(), {
      skillPacks: [runtimePack("research-review", { content: "Query with climate dataset." })],
      activeSkillPackRefs: ["skill_pack:project/research-review"],
      agentDecisionProvider: providerSelectsSearchTool("climate dataset"),
      toolHandlers: {
        "tool:test/Search": ({ arguments: args }) => {
          handlerCalls.push(args);
          return `tool:${args.query}`;
        },
      },
      toolBindingManifest: governedToolManifest(),
    });
    assert.equal(result.status, "success");
    assert.deepEqual(handlerCalls, [{ query: "climate dataset" }]);
    assert.equal(eventOf(result.trace, "tool_binding_authorized").payload.tool_ref, "tool:test/Search");
  });

  await check("SKILL-V1-P07", "user-invoked activation is traceable", async () => {
    const result = await runAgentWithSkillPacks({
      skillPacks: [runtimePack("manual-review")],
      activeSkillPackRefs: ["skill_pack:project/manual-review"],
      activationReasons: {
        "skill_pack:project/manual-review": "user_invoked",
      },
      provider: () => ({ action: "answer_directly", result: "ok" }),
    });
    assert.equal(eventOf(result.trace, "skill_pack_activated").payload.reason, "user_invoked");
  });

  report("SKILL-V1-P08", "reported_post_v1", "skill candidate promotion remains post-V1 and requires TEAM-1 review gate");

  await check("SKILL-V1-P09", "executable Touba skill still runs without a skill pack", async () => {
    const result = await executeAirDocument(simpleSkillDocument());
    assert.equal(result.status, "success");
    assert.equal(result.result, "plain-skill-result");
    assert.equal(eventsOf(result.trace, "skill_pack_discovery_listed").length, 0);
  });

  await check("SKILL-V1-P10", "multiple packs exist but only explicit active pack is loaded", async () => {
    const result = await runAgentWithSkillPacks({
      skillPacks: [
        runtimePack("research-review", { content: "active procedure" }),
        runtimePack("dataset-brief", { content: "inactive procedure" }),
      ],
      activeSkillPackRefs: ["skill_pack:project/research-review"],
      provider: (request) => {
        assert.equal(request.model_input.skill_pack_hints.length, 2);
        assert.deepEqual(
          request.model_input.active_skill_packs.map((pack) => pack.ref),
          ["skill_pack:project/research-review"],
        );
        assert.equal(JSON.stringify(request.model_input).includes("inactive procedure"), false);
        return { action: "answer_directly", result: "ok" };
      },
    });
    assert.equal(eventsOf(result.trace, "skill_pack_activated").length, 1);
  });

  await check("SKILL-V1-P11", "standard skill pack tree with classified resources is valid", () => {
    const fixture = createSkillPack(caseRoot(root, "p11"), "standard-review", {
      resources: [
        {
          ref: "resource:standard-review/template",
          path: "resources/templates/report.md",
          kind: "template",
          content: "Template",
        },
        {
          ref: "resource:standard-review/sample",
          path: "resources/samples/sample.json",
          kind: "sample",
          content: "{}",
        },
        {
          ref: "resource:standard-review/script",
          path: "scripts/prepare.mjs",
          kind: "script",
          content: "console.log('resource only');",
          loadable_as_context: false,
        },
        {
          ref: "resource:standard-review/fixture",
          path: "tests/fixtures/minimal.json",
          kind: "fixture",
          content: "{}",
          loadable_as_context: false,
        },
      ],
    });
    expectProjectValidation(fixture.root, "standard-review");
  });

  await check("SKILL-V1-P12", "declared template is loaded with provenance trace", async () => {
    const result = await runAgentWithSkillPacks({
      skillPacks: [
        runtimePack("research-review", {
          resources: [
            {
              ref: "resource:research-review/template",
              path: "resources/templates/report.md",
              kind: "template",
              content: "Use this short template.",
            },
          ],
        }),
      ],
      activeSkillPackRefs: ["skill_pack:project/research-review"],
      provider: (request) => {
        const template = request.model_input.active_skill_packs[0].resources.find((resource) =>
          resource.ref === "resource:research-review/template"
        );
        assert.equal(template.content, "Use this short template.");
        return { action: "answer_directly", result: "ok" };
      },
    });
    assert.equal(eventOf(result.trace, "skill_pack_resource_loaded").payload.resource_ref, "resource:research-review/procedure");
    assert.equal(
      eventsOf(result.trace, "skill_pack_resource_loaded").some((event) =>
        event.payload.resource_ref === "resource:research-review/template"
      ),
      true,
    );
  });

  await check("SKILL-V1-P13", "script is listed as a non-executable resource without content", async () => {
    const scriptContent = "console.log('script should not leak');";
    const result = await runAgentWithSkillPacks({
      skillPacks: [
        runtimePack("research-review", {
          resources: [
            {
              ref: "resource:research-review/script",
              path: "scripts/prepare.mjs",
              kind: "script",
              content: scriptContent,
              loadable_as_context: false,
            },
          ],
        }),
      ],
      activeSkillPackRefs: ["skill_pack:project/research-review"],
      provider: (request) => {
        const script = request.model_input.active_skill_packs[0].resources.find((resource) =>
          resource.ref === "resource:research-review/script"
        );
        assert.equal(script.executable_by_pack, false);
        assert.equal(script.content, undefined);
        return { action: "answer_directly", result: "ok" };
      },
    });
    assert.equal(JSON.stringify(result.trace).includes(scriptContent), false);
    assert.equal(eventOf(result.trace, "skill_pack_resource_refused").payload.runtime_error_code, "SkillPackScriptExecutionForbidden");
  });

  await check("SKILL-V1-P14", "script-backed action executes only through governed Touba tool", async () => {
    const handlerCalls = [];
    const result = await executeAirDocument(agentToolDocument(), {
      skillPacks: [
        runtimePack("research-review", {
          resources: [
            {
              ref: "resource:research-review/script",
              path: "scripts/search.mjs",
              kind: "script",
              content: "console.log('resource script only');",
              loadable_as_context: false,
            },
          ],
          execution_links: [
            {
              label: "Search through governed tool",
              target_ref: "tool:test/Search",
            },
          ],
        }),
      ],
      activeSkillPackRefs: ["skill_pack:project/research-review"],
      agentDecisionProvider: providerSelectsSearchTool("governed execution"),
      toolHandlers: {
        "tool:test/Search": ({ arguments: args }) => {
          handlerCalls.push(args.query);
          return `tool:${args.query}`;
        },
      },
      toolBindingManifest: governedToolManifest(),
    });
    assert.equal(result.status, "success");
    assert.deepEqual(handlerCalls, ["governed execution"]);
    assert.equal(eventOf(result.trace, "agent_capability_selected").payload.selected_ref, "tool:test/Search");
    assert.equal(eventOf(result.trace, "tool_binding_authorized").payload.tool_ref, "tool:test/Search");
  });
}

async function runNegativeCases(root) {
  await check("SKILL-V1-N01", "unknown skill pack schema is rejected", () => {
    const fixture = createSkillPack(caseRoot(root, "n01"), "bad-schema", {
      mutateDescriptor: (descriptor) => {
        descriptor.skill_pack_schema_version = "touba-skill-pack-v9";
      },
    });
    expectProjectValidation(fixture.root, "bad-schema", ["SkillPackSchemaMismatch"]);
  });

  await check("SKILL-V1-N02", "missing or invalid skill pack ref is rejected", () => {
    const fixture = createSkillPack(caseRoot(root, "n02"), "bad-ref", {
      mutateDescriptor: (descriptor) => {
        descriptor.ref = "skillpack:bad";
      },
    });
    expectProjectValidation(fixture.root, "bad-ref", ["SkillPackRefInvalid"]);
  });

  await check("SKILL-V1-N03", "digest mismatch is rejected", () => {
    const fixture = createSkillPack(caseRoot(root, "n03"), "bad-digest", {
      mutateDescriptor: (descriptor) => {
        descriptor.resources[0].digest = sha256("different content");
      },
    });
    expectProjectValidation(fixture.root, "bad-digest", ["SkillPackDigestMismatch"]);
  });

  await check("SKILL-V1-N04", "activation budget overflow is refused", async () => {
    let providerCalled = false;
    const result = await runAgentWithSkillPacks({
      skillPacks: [runtimePack("large-review", { content: "x".repeat(512) })],
      activeSkillPackRefs: ["skill_pack:project/large-review"],
      budgets: {
        skillPackActivationMaxBytes: 64,
      },
      provider: () => {
        providerCalled = true;
        return { action: "answer_directly", result: "unreachable" };
      },
      expectFailure: true,
    });
    assert.equal(providerCalled, false);
    assertFailureCode(result, "SkillPackBudgetExceeded");
  });

  await check("SKILL-V1-N05", "secret value in active pack is refused without leaking trace", async () => {
    let providerCalled = false;
    const result = await runAgentWithSkillPacks({
      skillPacks: [runtimePack("secret-review", { content: SECRET_SENTINEL })],
      activeSkillPackRefs: ["skill_pack:project/secret-review"],
      secretStore: resolvedSecretStore(),
      provider: () => {
        providerCalled = true;
        return { action: "answer_directly", result: "unreachable" };
      },
      expectFailure: true,
    });
    assert.equal(providerCalled, false);
    assertFailureCode(result, "SkillPackSensitiveContentForbidden");
    assertTraceDoesNotContain(result.trace, [SECRET_SENTINEL]);
  });

  await check("SKILL-V1-N06", "grant declaration in a pack is rejected", () => {
    const fixture = createSkillPack(caseRoot(root, "n06"), "bad-grants", {
      mutateDescriptor: (descriptor) => {
        descriptor.grants = ["network"];
      },
    });
    expectProjectValidation(fixture.root, "bad-grants", ["SkillPackAuthorityFieldForbidden"]);
  });

  await check("SKILL-V1-N07", "callable_by declaration in a pack is rejected", () => {
    const fixture = createSkillPack(caseRoot(root, "n07"), "bad-callers", {
      mutateDescriptor: (descriptor) => {
        descriptor.callable_by = [{ caller_ref: "agent:test/Other" }];
      },
    });
    expectProjectValidation(fixture.root, "bad-callers", ["SkillPackAuthorityFieldForbidden"]);
  });

  await check("SKILL-V1-N08", "skill pack cannot be selected as executable AIR capability", async () => {
    const result = await executeAirDocument(agentSkillDocument(), {
      skillPacks: [runtimePack("research-review")],
      activeSkillPackRefs: ["skill_pack:project/research-review"],
      agentDecisionProvider: () => ({
        target_ref: "skill_pack:project/research-review",
        reason: "confuse context with capability",
      }),
    });
    assert.equal(result.status, "failure");
    assertFailureCode(result, "SkillPackExecutableConfusion");
  });

  await check("SKILL-V1-N09", "pack-guided selection outside agent uses is refused", async () => {
    const result = await executeAirDocument(agentSkillDocument(), {
      skillPacks: [runtimePack("research-review", { content: "Use Hidden." })],
      activeSkillPackRefs: ["skill_pack:project/research-review"],
      agentDecisionProvider: () => ({
        target_ref: "skill:test/Hidden",
        reason: "hidden capability from pack",
      }),
    });
    assert.equal(result.status, "failure");
    assertFailureCode(result, "AgentCapabilityNotAllowed");
  });

  await check("SKILL-V1-N10", "activation without trace is diagnosed by validation", () => {
    const diagnostic = diagnoseActivationTrace({
      activeSkillPackRefs: ["skill_pack:project/research-review"],
      trace: { events: [] },
    });
    assert.equal(diagnostic.code, "SkillPackActivationUntraced");
  });

  report("SKILL-V1-N11", "reported_post_v1", "skill candidate promotion without review is a post-V1 gate; expected diagnostic SkillCandidatePromotionMissingReview");

  await check("SKILL-V1-N12", "prompt or raw payload content with a resolved secret is refused and redacted", async () => {
    const sensitiveContent = `${SYSTEM_PROMPT_SENTINEL}\n${RAW_PAYLOAD_SENTINEL}\n${SECRET_SENTINEL}`;
    const result = await runAgentWithSkillPacks({
      skillPacks: [runtimePack("sensitive-review", { content: sensitiveContent })],
      activeSkillPackRefs: ["skill_pack:project/sensitive-review"],
      secretStore: resolvedSecretStore(),
      provider: () => ({ action: "answer_directly", result: "unreachable" }),
      expectFailure: true,
    });
    assertFailureCode(result, "SkillPackSensitiveContentForbidden");
    assertTraceDoesNotContain(result.trace, [
      SECRET_SENTINEL,
      RAW_PAYLOAD_SENTINEL,
      SYSTEM_PROMPT_SENTINEL,
    ]);
  });

  await check("SKILL-V1-N13", "absolute or escaping resource path is rejected", () => {
    const fixture = createSkillPack(caseRoot(root, "n13"), "bad-path", {
      resources: [
        {
          ref: "resource:bad-path/escape",
          path: "../escape.md",
          kind: "reference",
          content: "escape",
        },
      ],
      skipWritingInvalidResourcePaths: true,
    });
    expectProjectValidation(fixture.root, "bad-path", ["SkillPackResourcePathInvalid"]);
  });

  await check("SKILL-V1-N14", "resource file absent from skill.json is rejected", () => {
    const fixture = createSkillPack(caseRoot(root, "n14"), "undeclared-resource", {
      extraFiles: [
        {
          path: "resources/references/undeclared.md",
          content: "This file is not declared.",
        },
      ],
    });
    expectProjectValidation(fixture.root, "undeclared-resource", ["SkillPackResourceUndeclared"]);
  });

  await check("SKILL-V1-N15", "command, handler, secrets and callable_by fields are rejected", () => {
    const fixture = createSkillPack(caseRoot(root, "n15"), "bad-authority", {
      mutateDescriptor: (descriptor) => {
        descriptor.command = "node scripts/run.mjs";
        descriptor.handler = { kind: "process" };
        descriptor.secrets = ["API_TOKEN"];
        descriptor.callable_by = [{ caller_ref: "agent:test/Other" }];
      },
    });
    expectProjectValidation(fixture.root, "bad-authority", ["SkillPackAuthorityFieldForbidden"]);
  });

  await check("SKILL-V1-N16", "direct script execution by pack is rejected", () => {
    const fixture = createSkillPack(caseRoot(root, "n16"), "bad-script", {
      resources: [
        {
          ref: "resource:bad-script/script",
          path: "scripts/run.mjs",
          kind: "script",
          content: "console.log('no direct execution');",
          executable_by_pack: true,
        },
      ],
    });
    expectProjectValidation(fixture.root, "bad-script", ["SkillPackScriptExecutionForbidden"]);
  });

  await check("SKILL-V1-N17", "execution link outside agent uses is refused", async () => {
    const result = await runAgentWithSkillPacks({
      skillPacks: [
        runtimePack("research-review", {
          execution_links: [
            {
              label: "Hidden search",
              target_ref: "tool:test/HiddenSearch",
            },
          ],
        }),
      ],
      activeSkillPackRefs: ["skill_pack:project/research-review"],
      provider: () => ({ action: "answer_directly", result: "unreachable" }),
      expectFailure: true,
    });
    assertFailureCode(result, "SkillPackExecutionLinkUnauthorized");
  });
}

async function check(id, title, fn) {
  await fn();
  results.push({ id, status: "covered", title });
}

function report(id, status, reason) {
  results.push({ id, status: "reported", report_status: status, reason });
}

function assertCoverage(prefix, count) {
  const expected = Array.from({ length: count }, (_, index) =>
    `${prefix}${String(index + 1).padStart(2, "0")}`
  );
  assert.deepEqual(
    results
      .filter((result) => result.id.startsWith(prefix))
      .map((result) => result.id)
      .sort(),
    expected,
  );
}

function createSkillPack(root, skillId, options = {}) {
  const projectRoot = join(root, "project");
  const packPath = join(projectRoot, "skills", skillId);
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

  const procedure = options.procedure ?? `# ${titleFromSkillId(skillId)}\n\nUse declared resources only.\n`;
  writeFixtureFile(packPath, "SKILL.md", procedure);

  const declaredResources = [
    {
      ref: `resource:${skillId}/procedure`,
      path: "SKILL.md",
      kind: "procedure",
      content: procedure,
      loadable_as_context: true,
    },
    ...(options.resources ?? []),
  ];

  for (const resource of declaredResources.slice(1)) {
    if (options.skipWritingInvalidResourcePaths && resource.path.includes("..")) {
      continue;
    }
    writeFixtureFile(packPath, resource.path, resource.content ?? "");
  }
  for (const extraFile of options.extraFiles ?? []) {
    writeFixtureFile(packPath, extraFile.path, extraFile.content ?? "");
  }

  const descriptor = {
    skill_pack_schema_version: "touba-skill-pack-v0.1",
    ref: `skill_pack:project/${skillId}`,
    name: titleFromSkillId(skillId),
    description: `Fixture for ${skillId}.`,
    version: "0.1.0",
    tags: ["skills-v1"],
    source: "project",
    activation: {
      model_invocable: true,
      user_invocable: true,
    },
    resources: declaredResources.map((resource) => ({
      ref: resource.ref,
      path: resource.path,
      kind: resource.kind,
      loadable_as_context: resource.loadable_as_context ?? true,
      ...(resource.executable_by_pack !== undefined ? { executable_by_pack: resource.executable_by_pack } : {}),
      digest: sha256(resource.content ?? ""),
    })),
    execution_links: options.execution_links ?? [],
  };

  options.mutateDescriptor?.(descriptor);
  writeFixtureFile(packPath, "skill.json", `${JSON.stringify(descriptor, null, 2)}\n`);
  return { root: projectRoot, packPath, descriptor };
}

function expectProjectValidation(root, target, expectedCodes = []) {
  const report = validateSkillPacks({ root, target });
  const codes = report.diagnostics.map((diagnostic) => diagnostic.code);
  if (expectedCodes.length === 0) {
    assert.equal(report.status, "success", JSON.stringify(report.diagnostics, null, 2));
    assert.equal(codes.length, 0);
    return report;
  }
  assert.equal(report.status, "error");
  for (const code of expectedCodes) {
    assert.equal(codes.includes(code), true, `missing diagnostic ${code}; got ${codes.join(", ")}`);
  }
  return report;
}

async function runAgentWithSkillPacks({
  skillPacks,
  activeSkillPackRefs = [],
  activationReasons = {},
  budgets = {},
  provider,
  secretStore,
  expectFailure = false,
}) {
  const result = await executeAirDocument(agentSkillDocument(), {
    inputs: { topic: "skills-v1-topic" },
    skillPacks,
    activeSkillPackRefs,
    skillPackActivationReasons: activationReasons,
    ...budgets,
    ...(secretStore ? { secretStore } : {}),
    agentDecisionProvider: provider,
  });
  if (!expectFailure) {
    assert.equal(result.status, "success", JSON.stringify(result.trace, null, 2));
  }
  return result;
}

function providerSelectsAnswerSkill(request) {
  if (request.mode === "summary" && request.step_index === 1) {
    return {
      action: "answer_directly",
      reason: "capability result is enough",
      result: `final ${request.observations[0].value}`,
    };
  }
  if (request.mode === "summary") {
    assert.equal(request.model_input.active_skill_packs[0].ref, "skill_pack:project/research-review");
    return {
      action: "request_capabilities",
      reason: "need governed capability catalog",
    };
  }
  assert.equal(request.mode, "capabilities");
  return {
    target_ref: "skill:test/Answer",
    reason: "active pack recommends Answer",
    arguments: {
      topic: request.inputs.topic,
    },
  };
}

function providerSelectsSearchTool(query) {
  return (request) => {
    if (request.mode === "summary" && request.step_index === 1) {
      return {
        action: "answer_directly",
        reason: "tool result is enough",
        result: request.observations[0].value,
      };
    }
    if (request.mode === "summary") {
      return {
        action: "request_capabilities",
        reason: "need governed tool catalog",
      };
    }
    assert.equal(request.mode, "capabilities");
    return {
      target_ref: "tool:test/Search",
      reason: "active pack prepared a bounded query",
      arguments: {
        query,
      },
    };
  };
}

function runtimePack(skillId, {
  content = "Follow the declared procedure.",
  resources = [],
  execution_links = [],
  description = `Runtime fixture for ${skillId}.`,
} = {}) {
  return {
    ref: `skill_pack:project/${skillId}`,
    name: titleFromSkillId(skillId),
    description,
    version: "0.1.0",
    tags: ["skills-v1"],
    source: "project",
    activation: {
      model_invocable: true,
      user_invocable: true,
    },
    resources: [
      {
        ref: `resource:${skillId}/procedure`,
        path: "SKILL.md",
        kind: "procedure",
        loadable_as_context: true,
        digest: sha256(content),
        content,
      },
      ...resources.map((resource) => ({
        ref: resource.ref,
        path: resource.path,
        kind: resource.kind,
        loadable_as_context: resource.loadable_as_context ?? true,
        digest: resource.digest ?? sha256(resource.content ?? ""),
        content: resource.content,
        ...(resource.executable_by_pack !== undefined ? { executable_by_pack: resource.executable_by_pack } : {}),
      })),
    ],
    execution_links,
  };
}

function agentSkillDocument() {
  return baseDocument({
    skills: [
      skill("Search", "graph:skill:test/Search"),
      {
        ...skill("Answer", "graph:skill:test/Answer"),
        signature: {
          inputs: [parameter("topic", "builtin:Text")],
          output_type: "builtin:Text",
        },
      },
      skill("Hidden", "graph:skill:test/Hidden"),
    ],
    agents: [researcherAgent(["skill:test/Search", "skill:test/Answer"])],
    strategies: [runResearchStrategy()],
    graphs: [
      graph("graph:skill:test/Search", "skill:test/Search", [
        node("search", "give", { arguments: ["literal:string:search"] }),
      ]),
      graph("graph:skill:test/Answer", "skill:test/Answer", [
        node("answer", "give", { arguments: ["value:topic"] }),
      ]),
      graph("graph:skill:test/Hidden", "skill:test/Hidden", [
        node("hidden", "give", { arguments: ["literal:string:hidden"] }),
      ]),
      runResearchGraph(),
    ],
  });
}

function agentToolDocument() {
  return baseDocument({
    tools: [
      tool("Search", {
        signature: {
          inputs: [parameter("query", "builtin:Text")],
          output_type: "builtin:Text",
        },
      }),
    ],
    agents: [researcherAgent(["tool:test/Search"])],
    strategies: [runResearchStrategy()],
    graphs: [runResearchGraph()],
  });
}

function simpleSkillDocument() {
  return baseDocument({
    skills: [skill("Plain", "graph:skill:test/Plain")],
    graphs: [
      graph("graph:skill:test/Plain", "skill:test/Plain", [
        node("plain", "give", { arguments: ["literal:string:plain-skill-result"] }),
      ]),
    ],
  });
}

function baseDocument(overrides = {}) {
  return {
    air_schema_version: AIR_SCHEMA_VERSION,
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
    trace_points: [],
  };
}

function researcherAgent(uses) {
  return {
    id: "agent:test/Researcher",
    name: "Researcher",
    responsibility: "Researcher",
    uses,
    callable_by: [
      {
        caller_ref: "strategy:test/RunResearch",
        caller_kind: "strategy",
        source_ref: sourceRef(),
      },
    ],
    source_ref: sourceRef(),
  };
}

function runResearchStrategy() {
  return {
    id: "strategy:test/RunResearch",
    name: "RunResearch",
    uses: ["agent:test/Researcher"],
    flow_graph_ref: "graph:strategy:test/RunResearch",
    source_ref: sourceRef(),
  };
}

function runResearchGraph() {
  return graph("graph:strategy:test/RunResearch", "strategy:test/RunResearch", [
    node("run", "call_agent", { target_ref: "agent:test/Researcher" }),
  ]);
}

function tool(name, fields = {}) {
  return {
    id: `tool:test/${name}`,
    name,
    signature: {
      inputs: [],
      output_type: "builtin:Text",
    },
    source_ref: sourceRef(),
    ...fields,
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

function parameter(name, typeRef) {
  return {
    name,
    type_ref: typeRef,
    source_ref: sourceRef(),
  };
}

function graph(id, ownerRef, nodes, edges = [], failurePaths = []) {
  return {
    id,
    owner_ref: ownerRef,
    entry_node_id: nodes[0].id,
    nodes,
    edges,
    expressions: [],
    failure_paths: failurePaths,
    failure_path_refs: failurePaths.map((failurePath) => failurePath.id),
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
    source_id: "skills-v1.tb",
    start_byte: 0,
    end_byte: 0,
    start_line: 1,
    start_column: 0,
    end_line: 1,
    end_column: 0,
  };
}

function governedToolManifest() {
  return loadToolBindingManifestFromJson(JSON.stringify({
    manifest_version: "touba-manifest-v1",
    bindings: {
      "tool:test/Search": {
        handler: {
          kind: "process",
          command: "node",
          args: ["./handlers/search.handler.js"],
        },
        grants: [],
        secrets: [],
        timeout_ms: 5000,
        max_payload_bytes: 1048576,
      },
    },
  }));
}

function resolvedSecretStore() {
  return loadSecretsFromJson(JSON.stringify({
    secrets_version: "touba-secrets-v1",
    secrets: {
      SEARCH_API_KEY: {
        source: "env",
        name: "SEARCH_API_TOKEN",
      },
    },
  }), {
    env: {
      SEARCH_API_TOKEN: SECRET_SENTINEL,
    },
  });
}

function diagnoseActivationTrace({ activeSkillPackRefs, trace }) {
  const activatedRefs = new Set(
    (trace.events ?? [])
      .filter((event) => event.kind === "skill_pack_activated")
      .map((event) => event.payload?.skill_pack_ref),
  );
  const missing = activeSkillPackRefs.filter((ref) => !activatedRefs.has(ref));
  if (missing.length === 0) {
    return null;
  }
  return {
    severity: "error",
    code: "SkillPackActivationUntraced",
    skill_pack_refs: missing,
  };
}

function assertFailureCode(result, code) {
  assert.equal(result.status, "failure", JSON.stringify(result.trace, null, 2));
  assert.equal(eventOf(result.trace, "failure_detected").payload.runtime_error_code, code);
}

function assertTraceDoesNotContain(trace, forbiddenValues) {
  const serialized = JSON.stringify(trace);
  for (const value of forbiddenValues) {
    assert.equal(serialized.includes(value), false, `trace leaks ${value}`);
  }
}

function eventOf(trace, kind) {
  const event = eventsOf(trace, kind)[0];
  assert.ok(event, `missing trace event ${kind}`);
  return event;
}

function eventsOf(trace, kind) {
  return trace.events.filter((event) => event.kind === kind);
}

function caseRoot(root, id) {
  const path = join(root, id);
  mkdirSync(path, { recursive: true });
  return path;
}

function writeFixtureFile(root, relativePath, content) {
  const path = join(root, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function sha256(content) {
  const hash = crypto.createHash("sha256");
  hash.update(content);
  return `sha256:${hash.digest("hex")}`;
}

function titleFromSkillId(skillId) {
  return skillId
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
