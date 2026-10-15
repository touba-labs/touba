import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  exportTraceToOpenTelemetry,
  implementationDir,
  inspectExplicitArtifacts,
  inspectPath,
  projectInspectionContract,
  renderInspection,
} from "../src/inspect.mjs";

test("inspects a Touba source by compiling it to AIR without attaching unprovided traces", () => {
  const sourcePath = path.join(
    implementationDir,
    "grammar/tree-sitter-touba/examples/tb-v01-001-linear-skill.tb",
  );

  const inspection = inspectPath(sourcePath);
  const rendered = renderInspection(inspection);

  assert.equal(inspection.artifact_kind, "touba_source");
  assert.equal(inspection.source.present, true);
  assert.equal(inspection.air.present, true);
  assert.equal(inspection.air.module_ref, "module:examples.linear_skill");
  assert.equal(inspection.trace.present, false);
  assert.match(rendered, /Touba Inspect touba-inspect-v1/);
  assert.match(rendered, /Source .*tb-v01-001-linear-skill\.tb/);
  assert.match(rendered, /AIR touba-air-v1/);
  assert.doesNotMatch(rendered, /Trace absent: trace artifact not provided/);
  assert.doesNotMatch(rendered, /Architecture absent:/);
  assert.doesNotMatch(rendered, /Artifact scope excludes|Absent data/);
  assert.doesNotMatch(rendered, /cost=/);
  assert.doesNotMatch(rendered, /confidence=/);
});

test("inspects an AIR fixture and reports existing declarations only from the provided file", () => {
  const airPath = path.join(implementationDir, "tests/air/tb-v01-005-strategy-agents.air.json");
  const inspection = inspectPath(airPath);

  assert.equal(inspection.artifact_kind, "air");
  assert.equal(inspection.air.declarations.agents, 2);
  assert.equal(inspection.air.declarations.strategies, 1);
  assert.equal(inspection.trace.present, false);
});

test("projects AIR inspection to touba-project-inspection-v1", () => {
  const airPath = path.join(implementationDir, "tests/air/tb-v01-005-strategy-agents.air.json");
  const inspection = inspectPath(airPath);
  const project = projectInspectionContract(inspection, {
    generatedAt: "2026-06-22T00:00:00Z",
    root: "/workspace/example",
  });

  assert.equal(project.schema_version, "touba-project-inspection-v1");
  assert.equal(project.generated_at, "2026-06-22T00:00:00Z");
  assert.equal(project.project.root, "/workspace/example");
  assert.equal(project.project.name, "examples.strategy_agents");
  assert.equal(project.project.host_language, "unknown");
  assert.equal(project.artifacts.some((artifact) => artifact.kind === "air" && artifact.status === "present"), true);
  assert.equal(
    project.entrypoints.some((entrypoint) => entrypoint.ref === "strategy:examples.strategy_agents/RunChange"),
    true,
  );
  assert.equal(
    project.entrypoints.some((entrypoint) => entrypoint.ref === "agent:examples.strategy_agents/Engineer"),
    true,
  );
  const agentEntrypoint = project.entrypoints.find((entrypoint) => entrypoint.ref === "agent:examples.strategy_agents/Engineer");
  assert.equal(
    agentEntrypoint.responsibility,
    "Apply the requested change and return the recorded result.",
  );
  assert.equal(agentEntrypoint.input_contract.mode, "declared");
  assert.equal(agentEntrypoint.input_contract.fields[0].type_ref, "type:examples.strategy_agents/ChangeRequest");
  assert.equal(agentEntrypoint.input_contract.types[0].name, "ChangeRequest");
  const skillEntrypoint = project.entrypoints.find((entrypoint) => entrypoint.ref === "skill:examples.strategy_agents/MakeChange");
  assert.equal(skillEntrypoint.input_contract.mode, "declared");
  assert.equal(skillEntrypoint.input_contract.fields[0].type_ref, "type:examples.strategy_agents/ChangeRequest");
  assert.equal(skillEntrypoint.input_contract.types[0].name, "ChangeRequest");
  const toolEntrypoint = project.entrypoints.find((entrypoint) => entrypoint.ref === "tool:examples.strategy_agents/ApplyChange");
  assert.equal(toolEntrypoint.kind, "tool");
  assert.equal(toolEntrypoint.input_contract.mode, "declared");
  assert.deepEqual(project.diagnostics, []);
});

test("projects an explicit agent signature without inferring it from uses", () => {
  const sourcePath = path.join(
    implementationDir,
    "grammar/tree-sitter-touba/examples/agent-interface-v1/positive/tb-agent-interface-p01-strategy-call.tb",
  );
  const inspection = inspectPath(sourcePath);
  const project = projectInspectionContract(inspection);
  const agentEntrypoint = project.entrypoints.find(
    (entrypoint) => entrypoint.ref === "agent:examples.agent_interface/Reviewer",
  );

  assert.equal(agentEntrypoint.input_contract.mode, "declared");
  assert.deepEqual(agentEntrypoint.input_contract.fields, [
    {
      name: "request",
      type_ref: "type:examples.agent_interface/ReviewRequest",
      required: true,
    },
  ]);
  assert.equal(agentEntrypoint.input_contract.types[0].name, "ReviewRequest");
});

test("inspects the effective project from one model in text and JSON without sensitive fields", () => {
  const root = mkdtempSync(path.join(tmpdir(), "touba-inspect-effective-"));
  const artifactPath = path.join(root, "touba.effective-project.json");
  try {
    const artifact = effectiveProjectFixture();
    writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    const inspection = inspectPath(artifactPath);
    const rendered = renderInspection(inspection);
    assert.equal(inspection.artifact_kind, "effective_project");
    assert.equal(inspection.effective_project.input_count, 2);
    assert.match(rendered, /Effective project touba-effective-project-v1/);
    assert.match(rendered, /entry provenance=effective/);
    assert.match(rendered, /sandbox provenance=absent/);
    assert.deepEqual(projectInspectionContract(inspection), artifact);

    const cli = spawnSync(process.execPath, [
      new URL("../src/inspect.mjs", import.meta.url).pathname,
      artifactPath,
      "--json",
    ], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout), artifact);

    artifact.contract.secrets.secret_value = "must-not-leak";
    writeFileSync(artifactPath, `${JSON.stringify(artifact)}\n`, "utf8");
    assert.throws(() => inspectPath(artifactPath), /forbidden sensitive field secret_value/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inspects effect contracts projected by the effective project without creating authority", () => {
  const root = mkdtempSync(path.join(tmpdir(), "touba-inspect-effective-effects-"));
  const artifactPath = path.join(root, "touba.effective-project.json");
  try {
    const artifact = effectiveProjectFixture();
    artifact.contract.handlers = {
      provenance: { status: "effective", sources: [".touba/build/dev/touba.manifest.json"] },
      bindings: [{
        tool_ref: "tool:examples.effects/CreateOrder",
        kind: "process",
        effect_contract: { kind: "external_write", retry_mode: "reconcile" },
      }],
    };
    writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

    const inspection = inspectPath(artifactPath);
    const rendered = renderInspection(inspection);
    assert.deepEqual(inspection.effective_project.effect_contracts, [{
      tool_ref: "tool:examples.effects/CreateOrder",
      effect_contract: { kind: "external_write", retry_mode: "reconcile" },
    }]);
    assert.match(rendered, /effect_contract tool:examples\.effects\/CreateOrder external_write:reconcile/);
    assert.equal(inspection.effective_project.document.artifact_role, "derived_non_authoritative");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inspects AIR callable_by authority without deriving policy", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-agent-authority-"));
  try {
    const airPath = path.join(tempRoot, "authority.air.json");
    writeFileSync(airPath, JSON.stringify(agentAuthorityAirFixture()), "utf8");

    const inspection = inspectPath(airPath);
    const rendered = renderInspection(inspection);

    assert.equal(inspection.air.callable_by, 1);
    assert.deepEqual(inspection.air.agent_authority, [
      {
        agent_ref: "agent:examples.authority/Builder",
        callers: ["strategy:examples.authority/RunBuild"],
      },
    ]);
    assert.match(rendered, /callable_by=1/);
    assert.match(
      rendered,
      /agent_authority agent:examples\.authority\/Builder callers=\[strategy:examples\.authority\/RunBuild\]/,
    );
    assert.doesNotMatch(rendered, /policy lens|\.env|secret value/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("inspects AIR memory declarations, scopes and tool accesses without reading backends", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-memory-air-"));
  try {
    const airPath = path.join(tempRoot, "memory.air.json");
    writeFileSync(airPath, JSON.stringify(memoryAirFixture()), "utf8");

    const inspection = inspectPath(airPath);
    const rendered = renderInspection(inspection);

    assert.equal(inspection.air.declarations.memories, 1);
    assert.equal(inspection.air.memory_accesses, 1);
    assert.equal(inspection.air.memory_scopes, 2);
    assert.match(rendered, /memories=1/);
    assert.match(rendered, /memory memory:examples\.memory\/ProjectKnowledge name=ProjectKnowledge/);
    assert.match(
      rendered,
      /tool_memory tool:examples\.memory\/ReadProjectKnowledge read memory:examples\.memory\/ProjectKnowledge/,
    );
    assert.match(
      rendered,
      /owner_memory skill:examples\.memory\/ReadKnowledgeFlow read memory:examples\.memory\/ProjectKnowledge/,
    );
    assert.doesNotMatch(rendered, /postgres|DATABASE_URL|knowledge row|secret value/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("inspects AIR triggers without inventing scheduler state", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-trigger-air-"));
  try {
    const airPath = path.join(tempRoot, "trigger.air.json");
    writeFileSync(airPath, JSON.stringify(triggerAirFixture()), "utf8");

    const inspection = inspectPath(airPath);
    const rendered = renderInspection(inspection);

    assert.equal(inspection.air.declarations.triggers, 1);
    assert.deepEqual(inspection.air.triggers, [
      {
        trigger_ref: "trigger:examples.trigger/DailyRun",
        event_kind: "schedule",
        event_value: "0 8 * * *",
        target_ref: "strategy:examples.trigger/RunDaily",
        target_kind: "strategy",
        limits: {
          max_runs_per_day: 1,
          timeout_ms: 30000,
        },
        arguments: [
          {
            input: "topic",
            value_ref: "literal:string:transport",
          },
        ],
      },
    ]);
    assert.match(rendered, /triggers=1/);
    assert.match(
      rendered,
      /trigger trigger:examples\.trigger\/DailyRun event=schedule target=strategy:examples\.trigger\/RunDaily limits=max_runs_per_day=1,timeout_ms=30000 arguments=\[topic:literal:string:transport\]/,
    );
    assert.doesNotMatch(rendered, /scheduler|daemon|payload raw|secret value/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("inspects AIR IM-1 imports without deriving runtime bindings", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-imports-air-"));
  try {
    const airPath = path.join(tempRoot, "imports.air.json");
    writeFileSync(airPath, JSON.stringify(importsAirFixture()), "utf8");

    const inspection = inspectPath(airPath);
    const rendered = renderInspection(inspection);

    assert.equal(inspection.air.imports.total, 1);
    assert.equal(inspection.air.imports.resolved, 1);
    assert.equal(inspection.air.imports.unresolved, 0);
    assert.match(rendered, /imports=1 resolved=1 unresolved=0/);
    assert.match(
      rendered,
      /import function NormalizeQuery from=examples\.common target=function:examples\.common\/NormalizeQuery status=resolved/,
    );
    assert.doesNotMatch(rendered, /handler|grant|secret value|auto-discovery/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("inspects AIR IM-2A imported tools without deriving runtime bindings", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-imported-tool-air-"));
  try {
    const airPath = path.join(tempRoot, "imported-tool.air.json");
    writeFileSync(airPath, JSON.stringify(importedToolAirFixture()), "utf8");

    const inspection = inspectPath(airPath);
    const rendered = renderInspection(inspection);

    assert.equal(inspection.air.imports.total, 1);
    assert.equal(inspection.air.imports.resolved, 1);
    assert.equal(inspection.air.declarations.tools, 1);
    assert.match(rendered, /imports=1 resolved=1 unresolved=0/);
    assert.match(
      rendered,
      /import tool SearchDatasets from=examples\.data_tools target=tool:examples\.data_tools\/SearchDatasets status=resolved/,
    );
    assert.match(rendered, /tools=1/);
    assert.doesNotMatch(rendered, /handler|grant widened|secret value|auto-discovery/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("inspects expression AIR without evaluating expressions in inspect", () => {
  const sourcePath = path.join(
    implementationDir,
    "grammar/tree-sitter-touba/examples/expressions-v1/positive/tb-expr1-p01-int-arithmetic.tb",
  );
  const inspection = inspectPath(sourcePath);
  const rendered = renderInspection(inspection);

  assert.equal(inspection.artifact_kind, "touba_source");
  assert.ok(inspection.air.expressions > 0);
  assert.match(rendered, /expressions=2/);
  assert.doesNotMatch(rendered, /result=/);
});

test("inspects bind define AIR without resolving computed values", () => {
  const sourcePath = path.join(
    implementationDir,
    "grammar/tree-sitter-touba/examples/bind-define-v1/positive/tb-binddefine-v1-p01-local-bind-function.tb",
  );
  const inspection = inspectPath(sourcePath);
  const rendered = renderInspection(inspection);

  assert.equal(inspection.artifact_kind, "touba_source");
  assert.equal(inspection.air.declarations.constants, 3);
  assert.equal(inspection.air.local_bindings, 2);
  assert.match(rendered, /constants=3/);
  assert.match(rendered, /local_bindings=2/);
  assert.doesNotMatch(rendered, /process\.env|secret value|value=true/i);
});

test("inspects anneau 1 AIR arguments and bindings without resolving values", () => {
  const sourcePath = path.join(
    implementationDir,
    "grammar/tree-sitter-touba/examples/anneau-1/positive/tb-a1-p03-skill-composition-binding.tb",
  );
  const inspection = inspectPath(sourcePath);
  const rendered = renderInspection(inspection);

  assert.equal(inspection.artifact_kind, "touba_source");
  assert.ok(inspection.air.call_arguments > 0);
  assert.ok(inspection.air.result_bindings > 0);
  assert.match(rendered, /call_arguments=\d+ result_bindings=\d+/);
  assert.doesNotMatch(rendered, /value=/);
});

test("inspects human approval AIR without inventing approval decisions", () => {
  const sourcePath = path.join(
    implementationDir,
    "grammar/tree-sitter-touba/examples/human-approval-v1/positive/tb-human-v1-p01-required-approval.tb",
  );
  const inspection = inspectPath(sourcePath);
  const rendered = renderInspection(inspection);

  assert.equal(inspection.artifact_kind, "touba_source");
  assert.ok(inspection.air.human_approvals > 0);
  assert.match(rendered, /human_approvals=\d+/);
  assert.doesNotMatch(rendered, /status=approved|decision=approved|status=Verified|status=Unverified/);
});

test("inspects user interaction AIR without inventing answers", () => {
  const sourcePath = path.join(
    implementationDir,
    "grammar/tree-sitter-touba/examples/user-interaction-v1/positive/tb-user-v1-p01-show-ask.tb",
  );
  const inspection = inspectPath(sourcePath);
  const rendered = renderInspection(inspection);

  assert.equal(inspection.artifact_kind, "touba_source");
  assert.ok(inspection.air.user_interactions > 0);
  assert.match(rendered, /user_interactions=\d+/);
  assert.doesNotMatch(rendered, /answer=|secret value|stdin/i);
});

test("inspects a trace fixture without inventing AIR context", () => {
  const tracePath = path.join(implementationDir, "tests/traces/tb-v01-002-fallback.trace.json");
  const rendered = renderInspection(inspectPath(tracePath));

  assert.match(rendered, /Artifact trace/);
  assert.doesNotMatch(rendered, /AIR absent: AIR artifact not provided/);
  assert.match(rendered, /Trace touba-trace-v1/);
  assert.match(rendered, /status=stopped/);
});

test("exports a Touba trace to an OpenTelemetry JSON projection", () => {
  const tracePath = path.join(implementationDir, "tests/traces/tb-v01-002-fallback.trace.json");
  const trace = JSON.parse(readFileSync(tracePath, "utf8"));
  const otel = exportTraceToOpenTelemetry(trace, { sourcePath: "source.tb" });

  assert.equal(otel.resourceSpans.length, 1);
  assert.equal(
    otel.resourceSpans[0].resource.attributes.find((attribute) => attribute.key === "service.name")
      .value.stringValue,
    "touba",
  );
  const spans = otel.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, trace.events.length);
  assert.match(spans[0].name, /^invoke_workflow /);
  assert.equal(spans[0].traceId.length, 32);
  assert.equal(spans[0].spanId.length, 16);
  assert.ok(
    spans[0].attributes.some(
      (attribute) =>
        attribute.key === "touba.event.kind" &&
        attribute.value.stringValue === trace.events[0].kind,
    ),
  );
  assert.ok(
    spans[0].attributes.some(
      (attribute) =>
        attribute.key === "gen_ai.operation.name" &&
        attribute.value.stringValue === "invoke_workflow",
    ),
  );
  assert.equal(
    otel.resourceSpans[0].resource.attributes.find((attribute) => attribute.key === "touba.source.provided")
      .value.boolValue,
    true,
  );
  assert.equal(JSON.stringify(otel).includes("source.tb"), false);
});

test("writes an OpenTelemetry JSON projection from the inspect CLI", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-otel-out-"));
  try {
    const inspectScript = path.join(implementationDir, "cli/touba-inspect/src/inspect.mjs");
    const tracePath = path.join(implementationDir, "tests/traces/tb-v01-002-fallback.trace.json");
    const otelPath = path.join(tempRoot, "trace.otel.json");
    const result = spawnSync(process.execPath, [inspectScript, tracePath, "--otel-out", otelPath], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const document = JSON.parse(readFileSync(otelPath, "utf8"));
    assert.equal(document.resourceSpans[0].scopeSpans[0].scope.name, "touba.inspect.otel");
    assert.ok(document.resourceSpans[0].scopeSpans[0].spans.length > 0);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("maps Touba agent and tool events to GenAI span operations", () => {
  const trace = {
    trace_protocol_version: "touba-trace-v1",
    run: {
      run_id: "run-otel-agent",
      module_ref: "module:examples.otel",
      entry_ref: "strategy:examples.otel/Research",
    },
    events: [
      {
        event_id: "event:run-otel-agent:1",
        run_id: "run-otel-agent",
        sequence_index: 0,
        kind: "agent_decision_recorded",
        payload: {
          agent_ref: "agent:examples.otel/Researcher",
          target_ref: "tool:examples.otel/Search",
          action: "select_capability",
        },
      },
      {
        event_id: "event:run-otel-agent:2",
        run_id: "run-otel-agent",
        sequence_index: 1,
        kind: "tool_dispatch_started",
        payload: {
          tool_ref: "tool:examples.otel/Search",
          runtime_error_code: "ToolDispatchRefused",
        },
      },
    ],
  };

  const spans = exportTraceToOpenTelemetry(trace).resourceSpans[0].scopeSpans[0].spans;

  assert.equal(attributeString(spans[0], "gen_ai.operation.name"), "invoke_agent");
  assert.equal(attributeString(spans[0], "gen_ai.agent.id"), "agent:examples.otel/Researcher");
  assert.equal(attributeString(spans[0], "touba.payload.target_ref"), "tool:examples.otel/Search");
  assert.equal(attributeString(spans[1], "gen_ai.operation.name"), "execute_tool");
  assert.equal(attributeString(spans[1], "gen_ai.tool.name"), "Search");
  assert.equal(attributeString(spans[1], "error.type"), "ToolDispatchRefused");
  assert.equal(spans[1].status.code, 2);
});

test("keeps OpenTelemetry export free of raw prompts, secrets and payload content", () => {
  const trace = {
    trace_protocol_version: "touba-trace-v1",
    run: {
      run_id: "run-otel-redaction",
      module_ref: "module:examples.otel",
      entry_ref: "strategy:examples.otel/Research",
    },
    events: [
      {
        event_id: "event:run-otel-redaction:1",
        run_id: "run-otel-redaction",
        sequence_index: 0,
        kind: "agent_observations_budget_refused",
        payload: {
          agent_ref: "agent:examples.otel/Researcher",
          target_ref: "skill:examples.otel/Summarize",
          runtime_error_code: "AgentProviderObservationsBudgetExceeded",
          raw_prompt: "PROMPT_SHOULD_NOT_EXPORT",
          secret_value: "TOUBA_SHOULD_NOT_LEAK",
          observation: "RAW_OBSERVATION_SHOULD_NOT_EXPORT",
          result: "RAW_RESULT_SHOULD_NOT_EXPORT",
          value: "RAW_VALUE_SHOULD_NOT_EXPORT",
        },
      },
    ],
  };

  const serialized = JSON.stringify(exportTraceToOpenTelemetry(trace));

  assert.match(serialized, /AgentProviderObservationsBudgetExceeded/);
  assert.match(serialized, /skill:examples\.otel\/Summarize/);
  assert.doesNotMatch(
    serialized,
    /PROMPT_SHOULD_NOT_EXPORT|TOUBA_SHOULD_NOT_LEAK|RAW_OBSERVATION_SHOULD_NOT_EXPORT|RAW_RESULT_SHOULD_NOT_EXPORT|RAW_VALUE_SHOULD_NOT_EXPORT/,
  );
});

function attributeString(span, key) {
  const attribute = span.attributes.find((entry) => entry.key === key);
  assert.ok(attribute, `missing span attribute ${key}`);
  return attribute.value.stringValue;
}

test("inspects human approval trace states from events only", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-human-trace-"));
  try {
    const tracePath = path.join(tempRoot, "human.trace.json");
    writeFileSync(tracePath, JSON.stringify(humanApprovalTraceFixture()), "utf8");
    const rendered = renderInspection(inspectPath(tracePath));

    assert.match(rendered, /Artifact trace/);
    assert.match(
      rendered,
      /human_approvals requested=1 paused=1 approved=1 rejected=0 expired=0 cancelled=0/,
    );
    assert.doesNotMatch(rendered, /secret value|prompt/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("inspects user interaction trace states from events only", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-user-trace-"));
  try {
    const tracePath = path.join(tempRoot, "user.trace.json");
    writeFileSync(tracePath, JSON.stringify(userInteractionTraceFixture()), "utf8");
    const rendered = renderInspection(inspectPath(tracePath));

    assert.match(rendered, /Artifact trace/);
    assert.match(rendered, /user_interactions shown=1 requested=1 paused=1 answered=1/);
    assert.doesNotMatch(rendered, /parks|sk-live|secret value/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("inspects cancel and kill switch trace states from events only", () => {
  const timeoutTracePath = path.join(
    implementationDir,
    "tests/traces/cancel-v1/global-timeout-before-second-tool.trace.json",
  );
  const killSwitchTracePath = path.join(
    implementationDir,
    "tests/traces/cancel-v1/kill-switch-trigger-refused.trace.json",
  );

  const timeout = renderInspection(inspectPath(timeoutTracePath));
  const killSwitch = renderInspection(inspectPath(killSwitchTracePath));

  assert.match(timeout, /Artifact trace/);
  assert.match(timeout, /status=cancelled/);
  assert.match(
    timeout,
    /run_controls cancel_requested=1 cancelled=1 timeout_exceeded=1 kill_switch_enabled=0 kill_switch_disabled=0 dispatch_refused_cancelled=1/,
  );
  assert.match(killSwitch, /status=cancelled/);
  assert.match(
    killSwitch,
    /run_controls cancel_requested=1 cancelled=1 timeout_exceeded=0 kill_switch_enabled=1 kill_switch_disabled=0 dispatch_refused_cancelled=0/,
  );
  assert.match(killSwitch, /triggers received=1 accepted=0 refused=1/);
  assert.doesNotMatch(`${timeout}\n${killSwitch}`, /hard kill|control plane|secret value|raw payload/i);
});

test("inspects BQ-1 budget trace states from events only", () => {
  const tracePath = path.join(
    implementationDir,
    "tests/traces/budgets-bq1/max-tool-calls-refused.trace.json",
  );
  const rendered = renderInspection(inspectPath(tracePath));

  assert.match(rendered, /Artifact trace/);
  assert.match(rendered, /status=failure/);
  assert.match(
    rendered,
    /budgets checked=1 consumed=1 exceeded=1 dispatch_refused=1 kinds=\[max_tool_calls\]/,
  );
  assert.doesNotMatch(rendered, /cost=|token=|provider budget|secret value|raw payload/i);
  assert.match(rendered, /Chronology:/);
  assert.match(rendered, /limit max_tool_calls=1 authority=/);
  const inspected = inspectPath(tracePath);
  assert.ok(inspected.trace.chronology.some(event => event.kind === "budget_limit_exceeded"));
  assert.equal(inspected.trace.chronology.some(event => event.kind === "agent_decision_recorded"), false,
    "do not invent model decisions for a deterministic trace");
  assert.doesNotMatch(rendered, /Architecture absent|Trace absent|providers returned=0/);
});

test("inspects agent invocation trace states from events only", () => {
  const tracePath = path.join(
    implementationDir,
    "tests/traces/agent-authority-anneau-2/agent-invocation-refused.trace.json",
  );
  const rendered = renderInspection(inspectPath(tracePath));

  assert.match(rendered, /Artifact trace/);
  assert.match(rendered, /agent_invocations authorized=0 refused=1/);
  assert.match(rendered, /status=failure/);
  assert.doesNotMatch(rendered, /policy lens|\.env|secret value/i);
});

test("inspects memory access trace states from events only", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-memory-trace-"));
  try {
    const tracePath = path.join(tempRoot, "memory.trace.json");
    writeFileSync(tracePath, JSON.stringify(memoryTraceFixture()), "utf8");
    const rendered = renderInspection(inspectPath(tracePath));

    assert.match(rendered, /Artifact trace/);
    assert.match(rendered, /memory_accesses authorized=1 refused=1/);
    assert.match(
      rendered,
      /memory_metadata provenance_observed=1 integrity_observed=1 metadata_refused=1 integrity_refused=0 evidence=\[digest_reported\]/,
    );
    assert.doesNotMatch(rendered, /knowledge row|DATABASE_URL|secret value/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("inspects an architecture projection fixture", () => {
  const architecturePath = path.join(
    implementationDir,
    "tests/architecture/tb-v01-003-branch.architecture.json",
  );
  const rendered = renderInspection(inspectPath(architecturePath));

  assert.match(rendered, /Artifact architecture_projection/);
  assert.match(rendered, /Architecture architecture-projection-v1/);
  assert.match(rendered, /test_only=true/);
  assert.doesNotMatch(rendered, /Trace absent: trace artifact not provided/);
});

test("inspects a tool binding manifest without reading handlers or secret values", () => {
  const manifestPath = path.join(
    implementationDir,
    "tests/tool-binding-v1/manifests/touba.manifest.positive.json",
  );
  const inspection = inspectPath(manifestPath);
  const rendered = renderInspection(inspection);

  assert.equal(inspection.artifact_kind, "tool_binding_manifest");
  assert.equal(inspection.manifest.present, true);
  assert.equal(inspection.manifest.binding_count, 1);
  assert.match(rendered, /Manifest touba-manifest-v1/);
  assert.match(rendered, /binding tool:examples\.v1_process_binding\/FetchSource/);
  assert.match(rendered, /grants=\[network,secret_read\]/);
  assert.match(rendered, /secrets=\[SEARCH_API_KEY\]/);
  assert.doesNotMatch(rendered, /process\.env/);
});

test("inspects effect contracts and rejects incompatible manifest declarations", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-effect-contract-"));
  const manifestPath = path.join(tempRoot, "touba.manifest.json");
  try {
    const manifest = {
      manifest_version: "touba-manifest-v1",
      bindings: {
        "tool:examples.effects/CreateOrder": {
          handler: { kind: "process", command: "node", args: ["handlers/create_order.mjs"] },
          grants: ["network"],
          timeout_ms: 5000,
          max_payload_bytes: 1048576,
          effect_contract: { kind: "external_write", retry_mode: "idempotency_key" },
        },
      },
    };
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

    const inspection = inspectPath(manifestPath);
    const rendered = renderInspection(inspection);
    assert.deepEqual(inspection.manifest.bindings[0].effect_contract, {
      kind: "external_write",
      retry_mode: "idempotency_key",
    });
    assert.match(rendered, /effect_contract=external_write:idempotency_key/);

    manifest.manifest_version = "touba-manifest-v1";
    manifest.bindings["tool:examples.effects/CreateOrder"].effect_contract.compensation = {
      entry_ref: "strategy:examples.effects/CancelOrder",
    };
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
    const compensationInspection = inspectPath(manifestPath);
    const compensationRendered = renderInspection(compensationInspection);
    assert.deepEqual(compensationInspection.manifest.bindings[0].effect_contract.compensation, {
      entry_ref: "strategy:examples.effects/CancelOrder",
    });
    assert.match(compensationRendered, /compensation=strategy:examples\.effects\/CancelOrder/);

    manifest.bindings["tool:examples.effects/CreateOrder"].effect_contract.vendor = "example";
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
    assert.throws(() => inspectPath(manifestPath), /contains unknown fields/);

    manifest.manifest_version = "touba-manifest-v1";
    delete manifest.bindings["tool:examples.effects/CreateOrder"].effect_contract.vendor;
    delete manifest.bindings["tool:examples.effects/CreateOrder"].effect_contract.compensation;
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
    delete manifest.bindings["tool:examples.effects/CreateOrder"].effect_contract;
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
    assert.throws(() => inspectPath(manifestPath), /must declare effect_contract/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("inspects manifest memory bindings without reading memory backends", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-memory-manifest-"));
  try {
    const manifestPath = path.join(tempRoot, "touba.manifest.json");
    writeFileSync(manifestPath, JSON.stringify(memoryManifestFixture()), "utf8");

    const rendered = renderInspection(inspectPath(manifestPath));

    assert.match(rendered, /Manifest touba-manifest-v1/);
    assert.match(rendered, /memories=\[memory:examples\.memory\/ProjectKnowledge:read\]/);
    assert.doesNotMatch(rendered, /postgres|DATABASE_URL|knowledge row|secret value/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("inspects trigger manifest entries and diagnoses AIR mismatches", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-trigger-manifest-"));
  try {
    const airPath = path.join(tempRoot, "trigger.air.json");
    const manifestPath = path.join(tempRoot, "touba.manifest.json");
    const manifest = triggerManifestFixture();
    manifest.triggers["trigger:examples.trigger/DailyRun"].source.kind = "request";
    manifest.triggers["trigger:examples.trigger/DailyRun"].limits.max_runs_per_day = 2;
    manifest.triggers["trigger:examples.trigger/Unknown"] = {
      enabled: true,
      source: { kind: "schedule" },
      limits: { max_runs_per_day: 1, timeout_ms: 1000 },
    };
    writeFileSync(airPath, JSON.stringify(triggerAirFixture()), "utf8");
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

    const rendered = renderInspection(
      inspectExplicitArtifacts({
        air: airPath,
        manifest: manifestPath,
      }),
    );

    assert.match(rendered, /Manifest touba-manifest-v1/);
    assert.match(rendered, /triggers=2/);
    assert.match(
      rendered,
      /trigger trigger:examples\.trigger\/DailyRun enabled=true source=request .*limits=max_runs_per_day=2,timeout_ms=30000/,
    );
    assert.match(rendered, /Compatibility mismatches:/);
    assert.match(rendered, /TriggerSourceMismatch/);
    assert.match(rendered, /TriggerLimitExceeded/);
    assert.match(rendered, /UnknownManifestTrigger/);
    assert.doesNotMatch(rendered, /payload raw|secret value|\.env/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("inspects AIR and manifest run budgets without deriving cost semantics", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-budget-manifest-"));
  try {
    const airPath = path.join(tempRoot, "budget.air.json");
    const manifestPath = path.join(tempRoot, "touba.manifest.json");
    writeFileSync(airPath, JSON.stringify(budgetAirFixture()), "utf8");
    writeFileSync(manifestPath, JSON.stringify(budgetManifestFixture()), "utf8");

    const rendered = renderInspection(
      inspectExplicitArtifacts({
        air: airPath,
        manifest: manifestPath,
      }),
    );

    assert.match(rendered, /run_budgets max_steps=1,max_tool_calls=3/);
    assert.match(rendered, /run_limits=2/);
    assert.match(rendered, /run_limits max_steps=2,max_tool_calls=2/);
    assert.match(rendered, /Compatibility mismatches:/);
    assert.match(rendered, /RunLimitExceeded/);
    assert.doesNotMatch(rendered, /cost=|token=|provider budget|secret value|\.env/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("inspects manifest agent secret scopes without loading secrets files", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-agent-scopes-"));
  try {
    const manifestPath = path.join(tempRoot, "touba.manifest.json");
    const manifest = JSON.parse(
      readFileSync(
        path.join(implementationDir, "tests/tool-binding-v1/manifests/touba.manifest.positive.json"),
        "utf8",
      ),
    );
    manifest.agent_secret_scopes = {
      "agent:examples.v1_process_binding/Researcher": ["SEARCH_API_KEY"],
    };
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

    const reads = [];
    const fs = {
      existsSync(filePath) {
        assert.equal(filePath, manifestPath);
        return true;
      },
      readFileSync(filePath, encoding) {
        assert.equal(filePath, manifestPath);
        reads.push(filePath);
        return readFileSync(filePath, encoding);
      },
    };

    const rendered = renderInspection(inspectPath(manifestPath, { fs }));

    assert.deepEqual(reads, [manifestPath]);
    assert.match(rendered, /agent_secret_scopes=1/);
    assert.match(
      rendered,
      /agent_scope agent:examples\.v1_process_binding\/Researcher secrets=\[SEARCH_API_KEY\]/,
    );
    assert.doesNotMatch(rendered, /SEARCH_API_TOKEN|\.env|secret value/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("renders availability and authority graphs from explicit workspace package artifacts", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-workspace-surface-"));
  try {
    const airPath = path.join(tempRoot, "memory.air.json");
    const manifestPath = path.join(tempRoot, "touba.manifest.json");
    const packagePath = path.join(tempRoot, "touba.package.json");
    const bindingFragmentPath = path.join(tempRoot, "memory.fragment.json");
    const resourceBindingsPath = path.join(tempRoot, "touba.resources.json");
    const runPlanPath = path.join(tempRoot, "touba.run-plan.json");
    writeFileSync(airPath, JSON.stringify(memoryAirFixture()), "utf8");
    writeFileSync(manifestPath, JSON.stringify(memoryManifestFixture()), "utf8");
    writeFileSync(packagePath, JSON.stringify(memoryPackageFixture()), "utf8");
    writeFileSync(bindingFragmentPath, JSON.stringify(memoryBindingFragmentFixture()), "utf8");
    writeFileSync(resourceBindingsPath, JSON.stringify(memoryResourceBindingsFixture()), "utf8");
    writeFileSync(runPlanPath, JSON.stringify(memoryRunPlanFixture()), "utf8");

    const inspection = inspectExplicitArtifacts({
      air: airPath,
      manifest: manifestPath,
      package: packagePath,
      binding_fragment: bindingFragmentPath,
      resource_bindings: resourceBindingsPath,
      run_plan: runPlanPath,
    });
    const rendered = renderInspection(inspection);

    assert.equal(inspection.package.export_count, 3);
    assert.equal(inspection.resource_bindings.resource_count, 1);
    assert.equal(inspection.run_plan.entry_ref, "skill:examples.memory/ReadKnowledgeFlow");
    assert.match(rendered, /Availability graph/);
    assert.match(rendered, /package_export tools tool:examples\.memory\/ReadProjectKnowledge/);
    assert.match(rendered, /Authority graph/);
    assert.match(rendered, /manifest bindings=1 triggers=0 run_limits=0 agent_secret_scopes=0/);
    assert.match(rendered, /binding_fragment bindings=1 source_kind=module status=not_runtime_authority/);
    assert.match(rendered, /resource_bindings resources=1 active=1 inactive=0/);
    assert.match(
      rendered,
      /run_plan entry=skill:examples\.memory\/ReadKnowledgeFlow profile=dev manifest=true secrets_profile=false supply_chain_lock=false/,
    );
    assert.doesNotMatch(rendered, /workspace scan|auto-discovery|secret value|Verified|Unverified/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("inspects TEAM-1 ownership without deriving runtime authority", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-ownership-"));
  try {
    const ownershipPath = path.join(tempRoot, "touba.ownership.json");
    writeFileSync(ownershipPath, JSON.stringify(ownershipFixture()), "utf8");

    const inspection = inspectPath(ownershipPath);
    const rendered = renderInspection(inspection);

    assert.equal(inspection.artifact_kind, "ownership");
    assert.equal(inspection.ownership.present, true);
    assert.equal(inspection.ownership.team_count, 2);
    assert.equal(inspection.ownership.owner_count, 1);
    assert.equal(inspection.ownership.review_gate_count, 1);
    assert.equal(inspection.ownership.review_count, 1);
    assert.match(rendered, /Ownership touba-ownership-v1/);
    assert.match(rendered, /owner tool:examples\.data_app\/Search teams=\[team:platform\]/);
    assert.match(rendered, /review_gate prod subjects=\[tool_binding,required_capability\] reviewers=\[team:security\]/);
    assert.match(rendered, /Responsibility graph/);
    assert.match(rendered, /status=not_runtime_authority/);
    assert.doesNotMatch(rendered, /grant added|secret value|Verified|Unverified|compliant/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("renders responsibility graph with explicit ownership in workspace package surface", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-workspace-ownership-"));
  try {
    const airPath = path.join(tempRoot, "memory.air.json");
    const ownershipPath = path.join(tempRoot, "touba.ownership.json");
    writeFileSync(airPath, JSON.stringify(memoryAirFixture()), "utf8");
    writeFileSync(ownershipPath, JSON.stringify(ownershipFixture({
      owners: {
        "memory:examples.memory/ProjectKnowledge": ["team:platform"],
      },
      reviews: [
        {
          review_id: "review:memory/security-001",
          profile: "prod",
          target_ref: "memory:examples.memory/ProjectKnowledge",
          reviewer: "team:security",
          decision: "approved",
        },
      ],
    })), "utf8");

    const inspection = inspectExplicitArtifacts({
      air: airPath,
      ownership: ownershipPath,
    });
    const rendered = renderInspection(inspection);

    assert.equal(inspection.artifact_kind, "multi_artifacts");
    assert.equal(inspection.ownership.owner_count, 1);
    assert.match(rendered, /Availability graph/);
    assert.match(rendered, /Authority graph/);
    assert.match(rendered, /Responsibility graph/);
    assert.match(rendered, /ownership teams=2 owners=1 review_gates=1 reviews=1 status=not_runtime_authority/);
    assert.match(rendered, /ownership=.*touba\.ownership\.json/);
    assert.doesNotMatch(rendered, /workspace scan|quick fix|secret value|Verified|Unverified/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnoses workspace package artifact authority mismatches without mutating authority", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-workspace-mismatch-"));
  try {
    const airPath = path.join(tempRoot, "memory.air.json");
    const resourceBindingsPath = path.join(tempRoot, "touba.resources.json");
    const runPlanPath = path.join(tempRoot, "touba.run-plan.json");
    const resources = memoryResourceBindingsFixture();
    resources.resources["memory:examples.memory/ProjectKnowledge"].active = false;
    resources.resources["memory:examples.memory/Unknown"] = {
      kind: "memory_backend",
      provider: "host.memory",
      grants: ["memory.read"],
      secrets: [],
    };
    const runPlan = memoryRunPlanFixture();
    runPlan.entry_ref = "strategy:examples.memory/Missing";
    writeFileSync(airPath, JSON.stringify(memoryAirFixture()), "utf8");
    writeFileSync(resourceBindingsPath, JSON.stringify(resources), "utf8");
    writeFileSync(runPlanPath, JSON.stringify(runPlan), "utf8");

    const rendered = renderInspection(
      inspectExplicitArtifacts({
        air: airPath,
        resource_bindings: resourceBindingsPath,
        run_plan: runPlanPath,
      }),
    );

    assert.match(rendered, /Compatibility mismatches:/);
    assert.match(rendered, /ResourceBindingInactive/);
    assert.match(rendered, /ResourceBindingUnknownResource/);
    assert.match(rendered, /RunPlanEntryUnknown/);
    assert.doesNotMatch(rendered, /quick fix|grant added|secret value|workspace scan/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("inspects explicit source, AIR, trace and architecture artifacts together", () => {
  const sourcePath = path.join(
    implementationDir,
    "grammar/tree-sitter-touba/examples/tb-v01-001-linear-skill.tb",
  );
  const airPath = path.join(implementationDir, "tests/air/tb-v01-001-linear-skill.air.json");
  const tracePath = path.join(
    implementationDir,
    "tests/traces/tb-v01-001-linear-skill.trace.json",
  );
  const architecturePath = path.join(
    implementationDir,
    "tests/architecture/tb-v01-001-linear-skill.architecture.json",
  );

  const inspection = inspectExplicitArtifacts({
    source: sourcePath,
    air: airPath,
    trace: tracePath,
    architecture: architecturePath,
  });
  const rendered = renderInspection(inspection);

  assert.equal(inspection.artifact_kind, "multi_artifacts");
  assert.equal(inspection.source.present, true);
  assert.equal(inspection.air.module_ref, "module:examples.linear_skill");
  assert.equal(inspection.trace.module_ref, "module:examples.linear_skill");
  assert.equal(inspection.architecture.module_ref, "module:examples.linear_skill");
  assert.deepEqual(inspection.compatibility.diagnostics, []);
  assert.match(rendered, /Input explicit_artifacts/);
  assert.match(rendered, /Compatibility ok/);
});

test("diagnoses explicit AIR and manifest binding mismatches", () => {
  const manifestPath = path.join(
    implementationDir,
    "tests/tool-binding-v1/manifests/touba.manifest.missing-network-grant.json",
  );
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-manifest-"));
  try {
    const airPath = path.join(tempRoot, "tool-binding.air.json");
    writeFileSync(airPath, JSON.stringify(toolBindingAirFixture()), "utf8");

    const rendered = renderInspection(
      inspectExplicitArtifacts({
        air: airPath,
        manifest: manifestPath,
      }),
    );

    assert.match(rendered, /Manifest touba-manifest-v1/);
    assert.match(rendered, /Compatibility mismatches:/);
    assert.match(rendered, /MissingToolGrant/);
    assert.doesNotMatch(rendered, /env_value|secret value/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnoses explicit AIR and manifest memory access mismatches", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-memory-mismatch-"));
  try {
    const airPath = path.join(tempRoot, "memory.air.json");
    const manifestPath = path.join(tempRoot, "touba.manifest.json");
    const manifest = memoryManifestFixture();
    manifest.bindings["tool:examples.memory/ReadProjectKnowledge"].memories = [];
    writeFileSync(airPath, JSON.stringify(memoryAirFixture()), "utf8");
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

    const rendered = renderInspection(
      inspectExplicitArtifacts({
        air: airPath,
        manifest: manifestPath,
      }),
    );

    assert.match(rendered, /Compatibility mismatches:/);
    assert.match(rendered, /MissingToolMemoryGrant/);
    assert.doesNotMatch(rendered, /knowledge row|DATABASE_URL|secret value/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnoses explicit multi-artifact module and schema mismatches", () => {
  const airPath = path.join(implementationDir, "tests/air/tb-v01-001-linear-skill.air.json");
  const trace = JSON.parse(
    readFileSync(
      path.join(implementationDir, "tests/traces/tb-v01-001-linear-skill.trace.json"),
      "utf8",
    ),
  );
  trace.trace_protocol_version = "trace-minimal-v9";
  trace.run.module_ref = "module:examples.other";
  const architecture = JSON.parse(
    readFileSync(
      path.join(
        implementationDir,
        "tests/architecture/tb-v01-001-linear-skill.architecture.json",
      ),
      "utf8",
    ),
  );
  architecture.module.id = "module:examples.architecture_other";

  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-mismatch-"));
  try {
    const tracePath = path.join(tempRoot, "mismatch.trace.json");
    const architecturePath = path.join(tempRoot, "mismatch.architecture.json");
    writeFileSync(tracePath, JSON.stringify(trace), "utf8");
    writeFileSync(architecturePath, JSON.stringify(architecture), "utf8");

    const rendered = renderInspection(
      inspectExplicitArtifacts({
        air: airPath,
        trace: tracePath,
        architecture: architecturePath,
      }),
    );

    assert.match(rendered, /Compatibility mismatches:/);
    assert.match(rendered, /TraceProtocolMismatch/);
    assert.match(rendered, /AirTraceModuleMismatch/);
    assert.match(rendered, /AirArchitectureModuleMismatch/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("explicit multi-artifact inspect reads only provided artifact paths", () => {
  const airPath = path.join(implementationDir, "tests/air/tb-v01-001-linear-skill.air.json");
  const tracePath = path.join(
    implementationDir,
    "tests/traces/tb-v01-001-linear-skill.trace.json",
  );
  const architecturePath = path.join(
    implementationDir,
    "tests/architecture/tb-v01-001-linear-skill.architecture.json",
  );
  const allowed = new Set([airPath, tracePath, architecturePath]);
  const reads = [];
  const fs = {
    existsSync(filePath) {
      assert.ok(allowed.has(filePath), `unexpected exists check: ${filePath}`);
      return true;
    },
    readFileSync(filePath, encoding) {
      assert.ok(allowed.has(filePath), `unexpected read: ${filePath}`);
      reads.push(filePath);
      return readFileSync(filePath, encoding);
    },
  };

  inspectExplicitArtifacts(
    {
      air: airPath,
      trace: tracePath,
      architecture: architecturePath,
    },
    { fs },
  );

  assert.deepEqual(reads, [airPath, tracePath, architecturePath]);
});

test("CLI accepts explicit multi-artifact options", () => {
  const inspectScript = path.join(implementationDir, "cli/touba-inspect/src/inspect.mjs");
  const airPath = path.join(implementationDir, "tests/air/tb-v01-001-linear-skill.air.json");
  const tracePath = path.join(
    implementationDir,
    "tests/traces/tb-v01-001-linear-skill.trace.json",
  );
  const architecturePath = path.join(
    implementationDir,
    "tests/architecture/tb-v01-001-linear-skill.architecture.json",
  );

  const result = spawnSync(
    process.execPath,
    [inspectScript, "--air", airPath, "--trace", tracePath, "--architecture", architecturePath],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Artifact multi_artifacts/);
  assert.match(result.stdout, /Compatibility ok/);
});

test("CLI writes an explicit inspect report with the canonical suffix", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-report-out-"));
  try {
    const inspectScript = path.join(implementationDir, "cli/touba-inspect/src/inspect.mjs");
    const airPath = path.join(implementationDir, "tests/air/tb-v01-001-linear-skill.air.json");
    const reportPath = path.join(tempRoot, "linear.inspect.txt");

    const result = spawnSync(
      process.execPath,
      [inspectScript, airPath, "--report-out", reportPath],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Artifact air/);
    const report = readFileSync(reportPath, "utf8");
    assert.match(report, /Touba Inspect touba-inspect-v1/);
    assert.match(report, /Artifact air/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("CLI refuses ambiguous inspect report output suffixes", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-report-out-invalid-"));
  try {
    const inspectScript = path.join(implementationDir, "cli/touba-inspect/src/inspect.mjs");
    const airPath = path.join(implementationDir, "tests/air/tb-v01-001-linear-skill.air.json");
    const reportPath = path.join(tempRoot, "linear.txt");

    const result = spawnSync(
      process.execPath,
      [inspectScript, airPath, "--report-out", reportPath],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--report-out path must end with \.inspect\.txt/);
    assert.throws(() => readFileSync(reportPath, "utf8"));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("CLI accepts explicit manifest option", () => {
  const inspectScript = path.join(implementationDir, "cli/touba-inspect/src/inspect.mjs");
  const manifestPath = path.join(
    implementationDir,
    "tests/tool-binding-v1/manifests/touba.manifest.positive.json",
  );

  const result = spawnSync(process.execPath, [inspectScript, "--manifest", manifestPath], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Artifact multi_artifacts/);
  assert.match(result.stdout, /Manifest touba-manifest-v1/);
});

test("CLI accepts explicit workspace package surface options", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-cli-workspace-"));
  try {
    const inspectScript = path.join(implementationDir, "cli/touba-inspect/src/inspect.mjs");
    const airPath = path.join(tempRoot, "memory.air.json");
    const packagePath = path.join(tempRoot, "touba.package.json");
    const resourceBindingsPath = path.join(tempRoot, "touba.resources.json");
    const runPlanPath = path.join(tempRoot, "touba.run-plan.json");
    writeFileSync(airPath, JSON.stringify(memoryAirFixture()), "utf8");
    writeFileSync(packagePath, JSON.stringify(memoryPackageFixture()), "utf8");
    writeFileSync(resourceBindingsPath, JSON.stringify(memoryResourceBindingsFixture()), "utf8");
    writeFileSync(runPlanPath, JSON.stringify(memoryRunPlanFixture()), "utf8");

    const result = spawnSync(
      process.execPath,
      [
        inspectScript,
        "--air",
        airPath,
        "--package",
        packagePath,
        "--resource-bindings",
        resourceBindingsPath,
        "--run-plan",
        runPlanPath,
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Artifact multi_artifacts/);
    assert.match(result.stdout, /Availability graph/);
    assert.match(result.stdout, /Authority graph/);
    assert.match(result.stdout, /resource_bindings=.*touba\.resources\.json/);
    assert.doesNotMatch(result.stdout, /workspace scan|secret value|auto-discovery/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("CLI accepts explicit ownership option", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-cli-ownership-"));
  try {
    const inspectScript = path.join(implementationDir, "cli/touba-inspect/src/inspect.mjs");
    const ownershipPath = path.join(tempRoot, "touba.ownership.json");
    writeFileSync(ownershipPath, JSON.stringify(ownershipFixture()), "utf8");

    const result = spawnSync(process.execPath, [inspectScript, "--ownership", ownershipPath], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Artifact multi_artifacts/);
    assert.match(result.stdout, /Ownership touba-ownership-v1/);
    assert.match(result.stdout, /Responsibility graph/);
    assert.doesNotMatch(result.stdout, /secret value|Verified|Unverified|compliant/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("inspects a TA-1 trace audit manifest without deriving compliance state", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-trace-audit-manifest-"));
  try {
    const auditPath = path.join(tempRoot, "trace-audit.json");
    writeFileSync(auditPath, JSON.stringify(traceAuditManifestFixture()), "utf8");

    const inspection = inspectPath(auditPath);
    const rendered = renderInspection(inspection);

    assert.equal(inspection.artifact_kind, "trace_audit_manifest");
    assert.equal(inspection.trace_audit.present, true);
    assert.equal(inspection.trace_audit.run_id, "run-ta1");
    assert.deepEqual(inspection.trace_audit.digests, ["trace_digest", "air_digest"]);
    assert.match(rendered, /Trace audit trace-audit-v1/);
    assert.match(rendered, /retention=project_audit/);
    assert.match(rendered, /redaction=no_secrets_no_raw_prompts_no_memory_content/);
    assert.match(rendered, /digests=\[trace_digest,air_digest\]/);
    assert.doesNotMatch(rendered, /compliant|Verified|signature|legal timestamp|secret value/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("inspects a TA-1 validation report without copying diagnostic payloads", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-trace-audit-report-"));
  try {
    const reportPath = path.join(tempRoot, "trace-audit.report.json");
    writeFileSync(reportPath, JSON.stringify(traceAuditReportFixture()), "utf8");

    const inspection = inspectPath(reportPath);
    const rendered = renderInspection(inspection);

    assert.equal(inspection.artifact_kind, "trace_audit_validation_report");
    assert.equal(inspection.trace_audit.status, "failed");
    assert.deepEqual(inspection.trace_audit.diagnostic_codes, [
      "TraceAuditDigestMismatch",
      "TraceAuditRawPromptLeak",
    ]);
    assert.match(rendered, /diagnostics=2/);
    assert.match(rendered, /codes=\[TraceAuditDigestMismatch,TraceAuditRawPromptLeak\]/);
    assert.doesNotMatch(rendered, /sk-live|prompt content|secret value|compliant|Verified/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("inspects a TA-1 export and accepts explicit trace-audit option", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-trace-audit-export-"));
  try {
    const inspectScript = path.join(implementationDir, "cli/touba-inspect/src/inspect.mjs");
    const exportPath = path.join(tempRoot, "trace-audit.export.json");
    writeFileSync(exportPath, JSON.stringify(traceAuditExportFixture()), "utf8");

    const inspection = inspectPath(exportPath);
    const rendered = renderInspection(inspection);
    const result = spawnSync(process.execPath, [inspectScript, "--trace-audit", exportPath], {
      encoding: "utf8",
    });

    assert.equal(inspection.artifact_kind, "trace_audit_export");
    assert.equal(inspection.trace_audit.status, "ok");
    assert.deepEqual(inspection.trace_audit.export_artifacts, ["trace", "air", "source"]);
    assert.match(rendered, /Trace audit trace-audit-export-v1-local/);
    assert.match(rendered, /export_artifacts=\[trace,air,source\]/);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Artifact multi_artifacts/);
    assert.match(result.stdout, /trace_audit=.*trace-audit\.export\.json/);
    assert.match(result.stdout, /Trace audit trace-audit-export-v1-local/);
    assert.doesNotMatch(`${rendered}\n${result.stdout}`, /compliant|Verified|signature/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("inspects a trace timeline product surface without reading event payloads", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-trace-timeline-"));
  try {
    const timelinePath = path.join(tempRoot, "trace.timeline.json");
    writeFileSync(timelinePath, JSON.stringify(traceTimelineFixture()), "utf8");

    const inspection = inspectPath(timelinePath);
    const rendered = renderInspection(inspection);

    assert.equal(inspection.artifact_kind, "trace_timeline");
    assert.equal(inspection.trace_timeline.present, true);
    assert.equal(inspection.trace_timeline.schema_version, "touba-trace-timeline-v1");
    assert.equal(inspection.trace_timeline.run_id, "run-ta1");
    assert.equal(inspection.trace_timeline.events, 3);
    assert.equal(inspection.trace_timeline.severity_counts.info, 2);
    assert.equal(inspection.trace_timeline.severity_counts.warning, 1);
    assert.match(rendered, /Trace timeline touba-trace-timeline-v1/);
    assert.match(rendered, /events=3/);
    assert.match(rendered, /severities debug=0 info=2 warning=1 error=0/);
    assert.match(rendered, /top_types=\[run.started:1,trigger.event.accepted:1,human.approval.paused:1\]/);
    assert.doesNotMatch(rendered, /raw prompt|secret value|payload_sha256|compliant|Verified/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("inspects a SC-1 supply chain lock without reading handler content", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-sc1-lock-"));
  try {
    const lockPath = path.join(tempRoot, "touba.lock.json");
    writeFileSync(lockPath, JSON.stringify(supplyChainLockFixture()), "utf8");

    const inspection = inspectPath(lockPath);
    const rendered = renderInspection(inspection);

    assert.equal(inspection.artifact_kind, "supply_chain_lock");
    assert.equal(inspection.supply_chain.present, true);
    assert.equal(inspection.supply_chain.handlers.length, 1);
    assert.equal(inspection.supply_chain.handlers[0].sdk_status, "ok");
    assert.equal(inspection.supply_chain.handlers[0].sdk_protocol, "touba-tool-handler-v1");
    assert.equal(inspection.supply_chain.handlers[0].handler_package_name, "examples.sc1.handlers");
    assert.equal(inspection.supply_chain.handlers[0].handler_package_entrypoint, "handlers/search.handler.mjs");
    assert.equal(inspection.supply_chain.handlers[0].handler_package_root, "handlers");
    assert.equal(inspection.supply_chain.handlers[0].handler_package_files, 2);
    assert.equal(inspection.supply_chain.handlers[0].handler_dependency_artifacts, 1);
    assert.equal(inspection.supply_chain.provenance.status, "declared");
    assert.equal(inspection.supply_chain.provenance.prepared_by_kind, "ci");
    assert.equal(inspection.supply_chain.review.status, "approved");
    assert.equal(inspection.supply_chain.review.evidence_status, "declared");
    assert.equal(inspection.supply_chain.review.reviewers, 1);
    assert.match(rendered, /Supply chain touba-lock-v1/);
    assert.match(rendered, /kind=supply_chain_lock/);
    assert.match(rendered, /provenance status=declared prepared_by=ci:ci:touba-fixture/);
    assert.match(rendered, /review status=approved evidence=declared required=no/);
    assert.match(rendered, /handler tool:examples\.sc1\/Search/);
    assert.match(rendered, /protocol=touba-tool-handler-v1/);
    assert.match(rendered, /digest=sha256:cccc/);
    assert.match(rendered, /sdk=@touba\/sdk@0\.1\.0 protocol=touba-tool-handler-v1 status=ok/);
    assert.match(rendered, /package=examples\.sc1\.handlers@0\.1\.0 kind=local entrypoint=handlers\/search\.handler\.mjs package_root=handlers files=2 dependencies=1/);
    assert.doesNotMatch(rendered, /raw handler|secret value|compliant|Verified|risk score/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("inspects a SC-1 validation report and accepts explicit supply-chain option", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-sc1-report-"));
  try {
    const inspectScript = path.join(implementationDir, "cli/touba-inspect/src/inspect.mjs");
    const reportPath = path.join(tempRoot, "supply-chain.report.json");
    writeFileSync(reportPath, JSON.stringify(supplyChainReportFixture()), "utf8");

    const inspection = inspectPath(reportPath);
    const rendered = renderInspection(inspection);
    const explicitInspection = inspectExplicitArtifacts({ supply_chain: reportPath });
    const result = spawnSync(process.execPath, [inspectScript, "--supply-chain", reportPath], {
      encoding: "utf8",
    });

    assert.equal(inspection.artifact_kind, "supply_chain_validation_report");
    assert.equal(inspection.supply_chain.status, "warning");
    assert.equal(inspection.supply_chain.provenance.status, "ok");
    assert.equal(inspection.supply_chain.review.status, "pending");
    assert.equal(inspection.supply_chain.review.evidence_status, "ok");
    assert.deepEqual(inspection.supply_chain.diagnostic_codes, ["HandlerSdkUnknown"]);
    assert.equal(explicitInspection.artifact_kind, "multi_artifacts");
    assert.equal(result.status, 0, result.stderr);
    assert.match(rendered, /Supply chain touba-supply-chain-validation-v1/);
    assert.match(rendered, /air=ok manifest=changed handlers=1/);
    assert.match(rendered, /provenance status=ok prepared_by=ci:ci:touba-fixture/);
    assert.match(rendered, /review status=pending evidence=ok required=no/);
    assert.match(
      rendered,
      /handler tool:examples\.sc1\/Search drift=unknown sdk=unknown package=unknown package_files=unknown dependencies=unknown diagnostics=1/,
    );
    assert.match(result.stdout, /supply_chain=.*supply-chain\.report\.json/);
    assert.doesNotMatch(`${rendered}\n${result.stdout}`, /TOUBA_SHOULD_NOT_LEAK|raw handler|compliant|Verified/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("inspects a TD-1 trigger state artifact without inventing daemon state", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-trigger-state-"));
  try {
    const statePath = path.join(tempRoot, "touba.trigger-state.json");
    writeFileSync(statePath, JSON.stringify(triggerStateFixture()), "utf8");

    const inspection = inspectPath(statePath);
    const rendered = renderInspection(inspection);

    assert.equal(inspection.artifact_kind, "trigger_state");
    assert.equal(inspection.trigger_state.schema_version, "touba-trigger-state-v1");
    assert.equal(inspection.trigger_state.accepted_count, 1);
    assert.equal(inspection.trigger_state.refused_count, 2);
    assert.equal(inspection.trigger_state.consumed_event_count, 1);
    assert.match(rendered, /Trigger state touba-trigger-state-v1/);
    assert.match(rendered, /triggers=1 accepted=1 refused=2 consumed_event_ids=1/);
    assert.match(rendered, /reasons=\[event_replay,max_runs_per_day_reached\]/);
    assert.doesNotMatch(rendered, /raw-secret-payload|scheduler permanent|daemon|payload content|Verified/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("rejects unsupported artifacts", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-inspect-unsupported-"));
  try {
    const unsupportedPath = path.join(tempRoot, "unsupported.txt");
    writeFileSync(unsupportedPath, "not a Touba source or JSON artifact", "utf8");

    assert.throws(() => inspectPath(unsupportedPath), /non-JSON input is only allowed for \.tb sources/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function triggerStateFixture() {
  return {
    trigger_state_schema_version: "touba-trigger-state-v1",
    created_at: "2026-06-07T10:00:00.000Z",
    updated_at: "2026-06-07T10:02:00.000Z",
    triggers: {
      "trigger:examples.cli_trigger/DailyRun": {
        accepted_count: 1,
        refused_count: 2,
        consumed_event_ids: ["evt-cli-001"],
        last_event_id: "evt-cli-002",
        last_status: "refused",
        updated_at: "2026-06-07T10:02:00.000Z",
        events: [
          {
            event_id: "evt-cli-001",
            source_kind: "schedule",
            status: "accepted",
            observed_at: "2026-06-07T10:00:00.000Z",
            run_id: "run-1",
          },
          {
            event_id: "evt-cli-001",
            source_kind: "schedule",
            status: "refused",
            reason: "event_replay",
            observed_at: "2026-06-07T10:01:00.000Z",
            run_id: "run-2",
          },
          {
            event_id: "evt-cli-002",
            source_kind: "schedule",
            status: "refused",
            reason: "max_runs_per_day_reached",
            observed_at: "2026-06-07T10:02:00.000Z",
            run_id: "run-3",
          },
        ],
      },
    },
  };
}

function ownershipFixture(options = {}) {
  return {
    ownership_schema_version: "touba-ownership-v1",
    teams: {
      "team:platform": {
        display_name: "Platform",
      },
      "team:security": {
        display_name: "Security",
      },
    },
    owners: options.owners ?? {
      "tool:examples.data_app/Search": ["team:platform"],
    },
    review_gates: options.review_gates ?? {
      prod: {
        requires_review_for: ["tool_binding", "required_capability"],
        reviewers: ["team:security"],
      },
    },
    reviews: options.reviews ?? [
      {
        review_id: "review:data-app/security-001",
        profile: "prod",
        target_ref: "tool:examples.data_app/Search",
        reviewer: "team:security",
        decision: "approved",
        evidence_ref: "reviews/security-001.md",
      },
    ],
  };
}

function toolBindingAirFixture() {
  return {
    air_schema_version: "touba-air-v1",
    module: {
      id: "module:examples.v1_process_binding",
      name: "examples.v1_process_binding",
      source_ref: sourceRef(0),
    },
    definitions: {
      types: [],
      functions: [],
      tools: [
        {
          id: "tool:examples.v1_process_binding/FetchSource",
          name: "FetchSource",
          signature: { inputs: [], output_type: null },
          required_capabilities: ["network", "secret_read"],
          required_secrets: ["SEARCH_API_KEY"],
          source_ref: sourceRef(2),
        },
      ],
      skills: [],
      agents: [],
      strategies: [],
    },
    execution_graphs: [],
    trace_points: [],
  };
}

function agentAuthorityAirFixture() {
  return {
    air_schema_version: "touba-air-v1",
    module: {
      id: "module:examples.authority",
      name: "examples.authority",
      source_ref: sourceRef(0),
    },
    definitions: {
      types: [],
      functions: [],
      tools: [],
      skills: [],
      agents: [
        {
          id: "agent:examples.authority/Builder",
          name: "Builder",
          responsibility: "Builder",
          uses: [],
          callable_by: [
            {
              caller_ref: "strategy:examples.authority/RunBuild",
              caller_kind: "strategy",
              source_ref: sourceRef(5),
            },
          ],
          source_ref: sourceRef(3),
        },
      ],
      strategies: [
        {
          id: "strategy:examples.authority/RunBuild",
          name: "RunBuild",
          uses: ["agent:examples.authority/Builder"],
          flow_graph_ref: "graph:strategy:examples.authority/RunBuild",
          source_ref: sourceRef(7),
        },
      ],
    },
    execution_graphs: [],
    trace_points: [],
  };
}

function triggerAirFixture() {
  return {
    air_schema_version: "touba-air-v1",
    module: {
      id: "module:examples.trigger",
      name: "examples.trigger",
      source_ref: sourceRef(0),
    },
    definitions: {
      types: [],
      functions: [],
      tools: [],
      memories: [],
      skills: [],
      agents: [],
      strategies: [
        {
          id: "strategy:examples.trigger/RunDaily",
          name: "RunDaily",
          signature: {
            inputs: [{ name: "topic", type_ref: "builtin:Text", source_ref: sourceRef(2) }],
            output_type: null,
          },
          flow_graph_ref: "graph:strategy:examples.trigger/RunDaily",
          source_ref: sourceRef(1),
        },
      ],
      triggers: [
        {
          id: "trigger:examples.trigger/DailyRun",
          name: "DailyRun",
          event: {
            kind: "schedule",
            value: "0 8 * * *",
            source_ref: sourceRef(7),
          },
          target_ref: "strategy:examples.trigger/RunDaily",
          target_kind: "strategy",
          arguments: [
            {
              input: "topic",
              value_ref: "literal:string:transport",
            },
          ],
          limits: {
            max_runs_per_day: 1,
            timeout_ms: 30000,
            source_ref: sourceRef(10),
          },
          source_ref: sourceRef(6),
        },
      ],
    },
    execution_graphs: [
      {
        id: "graph:strategy:examples.trigger/RunDaily",
        owner_ref: "strategy:examples.trigger/RunDaily",
        nodes: [],
        edges: [],
        failure_paths: [],
      },
    ],
    trace_points: [],
  };
}

function importsAirFixture() {
  return {
    air_schema_version: "touba-air-v1",
    module: {
      id: "module:examples.search",
      name: "examples.search",
      source_ref: sourceRef(0),
    },
    imports: [
      {
        kind: "function",
        name: "NormalizeQuery",
        from_module: "examples.common",
        target_ref: "function:examples.common/NormalizeQuery",
        source_ref: sourceRef(2),
      },
    ],
    definitions: {
      constants: [],
      types: [],
      functions: [
        {
          id: "function:examples.common/NormalizeQuery",
          name: "NormalizeQuery",
          source_ref: sourceRef(10),
        },
      ],
      tools: [],
      memories: [],
      skills: [],
      agents: [],
      strategies: [],
      triggers: [],
    },
    execution_graphs: [],
    trace_points: [],
  };
}

function importedToolAirFixture() {
  return {
    air_schema_version: "touba-air-v1",
    module: {
      id: "module:examples.research_app",
      name: "examples.research_app",
      source_ref: sourceRef(0),
    },
    imports: [
      {
        kind: "tool",
        name: "SearchDatasets",
        from_module: "examples.data_tools",
        target_ref: "tool:examples.data_tools/SearchDatasets",
        source_ref: sourceRef(2),
      },
    ],
    definitions: {
      constants: [],
      types: [
        {
          id: "type:examples.data_tools/DatasetSearchRequest",
          name: "DatasetSearchRequest",
          source_ref: sourceRef(4),
        },
        {
          id: "type:examples.data_tools/DatasetSearchResult",
          name: "DatasetSearchResult",
          source_ref: sourceRef(8),
        },
      ],
      functions: [],
      tools: [
        {
          id: "tool:examples.data_tools/SearchDatasets",
          name: "SearchDatasets",
          signature: {
            inputs: [
              {
                name: "request",
                type_ref: "type:examples.data_tools/DatasetSearchRequest",
              },
            ],
            output_type: "type:examples.data_tools/DatasetSearchResult",
          },
          required_capabilities: ["network", "secret_read"],
          required_secrets: ["API_KEY"],
          source_ref: sourceRef(12),
        },
      ],
      memories: [],
      skills: [],
      agents: [],
      strategies: [],
      triggers: [],
    },
    execution_graphs: [],
    trace_points: [],
  };
}

function triggerManifestFixture() {
  return {
    manifest_version: "touba-manifest-v1",
    bindings: {},
    triggers: {
      "trigger:examples.trigger/DailyRun": {
        enabled: true,
        source: {
          kind: "schedule",
          timezone: "America/Montreal",
        },
        limits: {
          max_runs_per_day: 1,
          timeout_ms: 30000,
        },
      },
    },
  };
}

function budgetAirFixture() {
  return {
    air_schema_version: "touba-air-v1",
    module: {
      id: "module:examples.budget",
      name: "examples.budget",
      source_ref: sourceRef(0),
    },
    budgets: {
      run: {
        max_steps: {
          value: 1,
          source_ref: sourceRef(1),
        },
        max_tool_calls: {
          value: 3,
          source_ref: sourceRef(2),
        },
      },
    },
    definitions: {
      types: [],
      constants: [],
      functions: [],
      tools: [],
      memories: [],
      skills: [],
      agents: [],
      strategies: [],
      triggers: [],
    },
    execution_graphs: [],
    trace_points: [],
  };
}

function budgetManifestFixture() {
  return {
    manifest_version: "touba-manifest-v1",
    bindings: {},
    run_limits: {
      max_steps: 2,
      max_tool_calls: 2,
    },
  };
}

function memoryAirFixture() {
  return {
    air_schema_version: "touba-air-v1",
    module: {
      id: "module:examples.memory",
      name: "examples.memory",
      source_ref: sourceRef(0),
    },
    definitions: {
      types: [],
      functions: [],
      tools: [
        {
          id: "tool:examples.memory/ReadProjectKnowledge",
          name: "ReadProjectKnowledge",
          signature: { inputs: [], output_type: null },
          required_capabilities: ["memory_read"],
          memory_accesses: [
            {
              memory_ref: "memory:examples.memory/ProjectKnowledge",
              access: "read",
              source_ref: sourceRef(5),
            },
          ],
          source_ref: sourceRef(4),
        },
      ],
      memories: [
        {
          id: "memory:examples.memory/ProjectKnowledge",
          name: "ProjectKnowledge",
          source_ref: sourceRef(2),
        },
      ],
      skills: [
        {
          id: "skill:examples.memory/ReadKnowledgeFlow",
          name: "ReadKnowledgeFlow",
          signature: { inputs: [], output_type: null },
          uses: ["tool:examples.memory/ReadProjectKnowledge"],
          memory_scopes: [
            {
              memory_ref: "memory:examples.memory/ProjectKnowledge",
              access: "read",
              source_ref: sourceRef(9),
            },
          ],
          flow_graph_ref: "graph:skill:examples.memory/ReadKnowledgeFlow",
          source_ref: sourceRef(8),
        },
      ],
      agents: [
        {
          id: "agent:examples.memory/Researcher",
          name: "Researcher",
          responsibility: "Researcher",
          uses: ["skill:examples.memory/ReadKnowledgeFlow"],
          memory_scopes: [
            {
              memory_ref: "memory:examples.memory/ProjectKnowledge",
              access: "read",
              source_ref: sourceRef(14),
            },
          ],
          source_ref: sourceRef(12),
        },
      ],
      strategies: [],
    },
    execution_graphs: [],
    trace_points: [],
  };
}

function memoryManifestFixture() {
  return {
    manifest_version: "touba-manifest-v1",
    bindings: {
      "tool:examples.memory/ReadProjectKnowledge": {
        effect_contract: { kind: "none" }, handler: {
          kind: "process",
          command: "node",
          args: ["./handlers/read_project_knowledge.handler.js"],
        },
        grants: ["memory_read"],
        memories: [
          {
            ref: "memory:examples.memory/ProjectKnowledge",
            access: "read",
          },
        ],
        timeout_ms: 5000,
        max_payload_bytes: 1048576,
      },
    },
  };
}

function memoryPackageFixture() {
  return {
    package_schema_version: "touba-package-v1",
    name: "examples.memory",
    version: "0.1.0",
    root: "../packages/memory",
    touba: {
      air_profile: "touba-air-json-canonical-v1",
      runtime_compatibility: ">=0.1 <0.2",
    },
    exports: {
      tools: ["tool:examples.memory/ReadProjectKnowledge"],
      skills: ["skill:examples.memory/ReadKnowledgeFlow"],
      memories: ["memory:examples.memory/ProjectKnowledge"],
    },
    provenance: {
      kind: "local_path",
      source: "../packages/memory",
    },
    contract_tests: ["validation/package/memory/package-contract.md"],
  };
}

function memoryBindingFragmentFixture() {
  return {
    fragment_schema_version: "touba-binding-fragment-v1",
    source: {
      kind: "module",
      module: "examples.memory",
    },
    bindings: {
      "tool:examples.memory/ReadProjectKnowledge": {
        effect_contract: { kind: "none" }, handler: {
          kind: "process",
          command: "node",
          args: ["handlers/read_project_knowledge.handler.mjs"],
          cwd: ".",
        },
        grants: ["memory_read"],
        secrets: [],
        timeout_ms: 5000,
        max_payload_bytes: 1048576,
      },
    },
  };
}

function memoryResourceBindingsFixture() {
  return {
    resource_bindings_schema_version: "touba-resource-bindings-v1",
    resources: {
      "memory:examples.memory/ProjectKnowledge": {
        kind: "memory_backend",
        provider: "host.memory",
        active: true,
        grants: ["memory.read"],
        secrets: [],
        limits: {
          max_payload_bytes: 1048576,
        },
      },
    },
  };
}

function memoryRunPlanFixture() {
  return {
    run_plan_schema_version: "touba-run-plan-v1",
    entry_ref: "skill:examples.memory/ReadKnowledgeFlow",
    air: "build/touba/project.air.json",
    manifest: "build/touba/touba.manifest.json",
    profile: "dev",
    run_limits: {
      max_tool_calls: 3,
    },
    outputs: {
      mode: "trace",
      trace_out: "runs/latest.trace.json",
    },
  };
}

function memoryTraceFixture() {
  return {
    trace_protocol_version: "touba-trace-v1",
    run: {
      run_id: "run-memory",
      module_ref: "module:examples.memory",
      entry_ref: "skill:examples.memory/ReadKnowledgeFlow",
    },
    events: [
      {
        event_id: "event:1",
        run_id: "run-memory",
        sequence_index: 0,
        kind: "run_started",
        payload: { entry_ref: "skill:examples.memory/ReadKnowledgeFlow" },
      },
      {
        event_id: "event:2",
        run_id: "run-memory",
        sequence_index: 1,
        kind: "memory_access_authorized",
        payload: {
          owner_ref: "skill:examples.memory/ReadKnowledgeFlow",
          tool_ref: "tool:examples.memory/ReadProjectKnowledge",
          memory_ref: "memory:examples.memory/ProjectKnowledge",
          access: "read",
          authority_source: "memory_scope",
        },
      },
      {
        event_id: "event:3",
        run_id: "run-memory",
        sequence_index: 2,
        kind: "memory_access_refused",
        payload: {
          owner_ref: "skill:examples.memory/ReadKnowledgeFlow",
          tool_ref: "tool:examples.memory/ReadProjectKnowledge",
          memory_ref: "memory:examples.memory/ProjectKnowledge",
          access: "write",
          reason: "owner_scope_missing",
        },
      },
      {
        event_id: "event:4",
        run_id: "run-memory",
        sequence_index: 3,
        kind: "memory_provenance_observed",
        payload: {
          tool_ref: "tool:examples.memory/ReadProjectKnowledge",
          memory_ref: "memory:examples.memory/ProjectKnowledge",
          operation: "read",
          source_kind: "tool_result",
          source_ref: "source:examples.memory/project_knowledge",
          writer_ref: "tool:examples.memory/ReadProjectKnowledge",
          written_at: "2026-05-10T12:00:00.000Z",
          observed_at: "2026-05-10T12:00:00.010Z",
          schema_ref: "type:examples.memory/ProjectKnowledgeEntry",
          version_ref: "memory-version:project-knowledge:1",
        },
      },
      {
        event_id: "event:5",
        run_id: "run-memory",
        sequence_index: 4,
        kind: "memory_integrity_observed",
        payload: {
          tool_ref: "tool:examples.memory/ReadProjectKnowledge",
          memory_ref: "memory:examples.memory/ProjectKnowledge",
          operation: "read",
          digest_kind: "sha256",
          digest: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
          integrity_evidence: "digest_reported",
        },
      },
      {
        event_id: "event:6",
        run_id: "run-memory",
        sequence_index: 5,
        kind: "memory_metadata_refused",
        payload: {
          tool_ref: "tool:examples.memory/ReadProjectKnowledge",
          memory_ref: "memory:examples.memory/ProjectKnowledge",
          operation: "read",
          field: "content",
          integrity_evidence: "none",
        },
      },
      {
        event_id: "event:7",
        run_id: "run-memory",
        sequence_index: 6,
        kind: "run_completed",
        payload: { status: "failure" },
      },
    ],
  };
}

function traceAuditManifestFixture() {
  return {
    trace_audit_schema_version: "trace-audit-v1",
    trace_ref: "trace:run-ta1",
    run_id: "run-ta1",
    created_at: "2026-06-05T00:00:00.000Z",
    runtime: {
      name: "touba-audit",
      version: "0.1.0",
    },
    artifacts: {
      trace_digest: {
        kind: "sha256",
        value: "a".repeat(64),
      },
      air_digest: {
        kind: "sha256",
        value: "b".repeat(64),
      },
    },
    retention: {
      class: "project_audit",
      delete_after: null,
    },
    redaction: {
      policy: "no_secrets_no_raw_prompts_no_memory_content",
    },
  };
}

function traceAuditReportFixture() {
  return {
    trace_audit_validation_schema_version: "trace-audit-validation-v1",
    trace_audit_schema_version: "trace-audit-v1",
    status: "failed",
    checked: {
      trace: true,
      air: true,
      source: false,
      manifest: false,
    },
    diagnostics: [
      {
        severity: "error",
        code: "TraceAuditDigestMismatch",
        message: "artifact digest does not match",
        artifact: "trace",
      },
      {
        severity: "error",
        code: "TraceAuditRawPromptLeak",
        message: "raw prompt field is not allowed in a trace audit artifact",
        artifact: "trace",
      },
    ],
  };
}

function traceAuditExportFixture() {
  return {
    trace_audit_export_schema_version: "trace-audit-export-v1-local",
    trace_audit_manifest: traceAuditManifestFixture(),
    validation_report: {
      trace_audit_validation_schema_version: "trace-audit-validation-v1",
      status: "ok",
      diagnostics: [],
    },
    artifacts: {
      trace: {
        trace_protocol_version: "touba-trace-v1",
        run: {
          run_id: "run-ta1",
          module_ref: "module:examples.ta1",
          entry_ref: "strategy:examples.ta1/Run",
        },
        events: [],
      },
      air: {
        air_schema_version: "touba-air-v1",
        module: {
          id: "module:examples.ta1",
          name: "examples.ta1",
        },
        definitions: {},
        execution_graphs: [],
      },
      source: {
        source_id: "program.tb",
      },
    },
  };
}

function traceTimelineFixture() {
  return {
    schema_version: "touba-trace-timeline-v1",
    run_id: "run-ta1",
    trace_ref: "trace:run-ta1",
    events: [
      {
        index: 0,
        type: "run.started",
        timestamp: "sequence:0",
        severity: "info",
        summary: "Run started for strategy:examples.ta1/Run.",
        source_ref: "strategy:examples.ta1/Run",
        redaction: "none",
      },
      {
        index: 1,
        type: "trigger.event.accepted",
        timestamp: "2026-06-22T12:00:00.000Z",
        severity: "info",
        summary: "Trigger event accepted for trigger:examples.ta1/Nightly.",
        source_ref: "trigger:examples.ta1/Nightly",
        redaction: "payload_minimized",
      },
      {
        index: 2,
        type: "human.approval.paused",
        timestamp: "sequence:2",
        severity: "warning",
        summary: "Run paused for human review.",
        source_ref: "agent:examples.ta1/Auditor",
        redaction: "secrets_redacted",
      },
    ],
  };
}

function humanApprovalTraceFixture() {
  return {
    trace_protocol_version: "touba-trace-v1",
    run: {
      run_id: "run-human",
      module_ref: "module:examples.human",
      entry_ref: "skill:examples.human/Review",
    },
    events: [
      {
        event_id: "event:1",
        run_id: "run-human",
        sequence_index: 0,
        kind: "run_started",
        payload: { entry_ref: "skill:examples.human/Review" },
      },
      {
        event_id: "event:2",
        run_id: "run-human",
        sequence_index: 1,
        kind: "human_approval_requested",
        payload: {
          approval_ref: "approval:examples.human:required",
          mode: "required_approval",
          context_refs: ["value:change"],
        },
      },
      {
        event_id: "event:3",
        run_id: "run-human",
        sequence_index: 2,
        kind: "human_approval_paused",
        payload: {
          approval_ref: "approval:examples.human:required",
          resume_target_ref: "n2",
        },
      },
      {
        event_id: "event:4",
        run_id: "run-human",
        sequence_index: 3,
        kind: "human_approval_decided",
        payload: {
          approval_ref: "approval:examples.human:required",
          decision: "approved",
        },
      },
      {
        event_id: "event:5",
        run_id: "run-human",
        sequence_index: 4,
        kind: "human_approval_resumed",
        payload: {
          approval_ref: "approval:examples.human:required",
          resume_target_ref: "n2",
          decision_binding: "approval",
        },
      },
      {
        event_id: "event:6",
        run_id: "run-human",
        sequence_index: 5,
        kind: "run_completed",
        payload: { status: "success" },
      },
    ],
  };
}

function userInteractionTraceFixture() {
  return {
    trace_protocol_version: "touba-trace-v1",
    run: {
      run_id: "run-user",
      module_ref: "module:examples.user",
      entry_ref: "strategy:examples.user/RunInteraction",
    },
    events: [
      {
        event_id: "event:1",
        run_id: "run-user",
        sequence_index: 0,
        kind: "run_started",
        payload: { entry_ref: "strategy:examples.user/RunInteraction" },
      },
      {
        event_id: "event:2",
        run_id: "run-user",
        sequence_index: 1,
        kind: "user_interaction_shown",
        payload: {
          interaction_ref: "interaction:examples.user:show",
          mode: "show",
          message_ref: "expr:message",
          message: "Touba ready",
        },
      },
      {
        event_id: "event:3",
        run_id: "run-user",
        sequence_index: 2,
        kind: "user_interaction_requested",
        payload: {
          interaction_ref: "interaction:examples.user:ask",
          mode: "ask",
          prompt_ref: "expr:prompt",
          prompt: "Search query?",
        },
      },
      {
        event_id: "event:4",
        run_id: "run-user",
        sequence_index: 3,
        kind: "user_interaction_paused",
        payload: {
          interaction_ref: "interaction:examples.user:ask",
          mode: "ask",
          resume_target_ref: "n2",
        },
      },
      {
        event_id: "event:5",
        run_id: "run-user",
        sequence_index: 4,
        kind: "user_interaction_answered",
        payload: {
          interaction_ref: "interaction:examples.user:ask",
          mode: "ask",
          result_binding: "query",
        },
      },
      {
        event_id: "event:6",
        run_id: "run-user",
        sequence_index: 5,
        kind: "run_completed",
        payload: { status: "success" },
      },
    ],
  };
}

function supplyChainLockFixture() {
  return {
    lock_schema_version: "touba-lock-v1",
    lock_kind: "supply_chain",
    generated_at: "2026-06-05T12:00:00Z",
    generated_by: {
      tool: "touba prepare",
      version: "0.1.0",
    },
    provenance: {
      prepared_by: {
        kind: "ci",
        id: "ci:touba-fixture",
      },
      prepared_at: "2026-06-05T12:00:00Z",
      source: {
        kind: "git",
        ref: "refs/heads/main",
        commit: "0123456789abcdef",
      },
    },
    review: {
      status: "approved",
      reviewed_at: "2026-06-05T12:30:00Z",
      reviewers: [
        {
          kind: "human",
          id: "reviewer:security",
          role: "security",
        },
      ],
      evidence: [
        {
          kind: "review_note",
          path: "review-note.txt",
          digest: {
            kind: "sha256",
            value: "f".repeat(64),
          },
        },
      ],
    },
    air: {
      path: "program.air.json",
      digest: {
        kind: "sha256",
        value: "a".repeat(64),
      },
    },
    manifest: {
      path: "touba.manifest.json",
      digest: {
        kind: "sha256",
        value: "b".repeat(64),
      },
    },
    handlers: [
      {
        tool_ref: "tool:examples.sc1/Search",
        path: "handlers/search.handler.mjs",
        command: "node",
        cwd: ".",
        args: ["handlers/search.handler.mjs"],
        digest: {
          kind: "sha256",
          value: "c".repeat(64),
        },
        sdk: {
          name: "@touba/sdk",
          version: "0.1.0",
          protocol: "touba-tool-handler-v1",
          status: "ok",
        },
        handler_package: {
          kind: "local",
          name: "examples.sc1.handlers",
          version: "0.1.0",
          entrypoint: "handlers/search.handler.mjs",
          package_root: "handlers",
          files: [
            {
              path: "search.handler.mjs",
              digest: {
                kind: "sha256",
                value: "c".repeat(64),
              },
            },
            {
              path: "package.json",
              digest: {
                kind: "sha256",
                value: "d".repeat(64),
              },
            },
          ],
          dependency_artifacts: [
            {
              path: "pnpm-lock.yaml",
              digest: {
                kind: "sha256",
                value: "e".repeat(64),
              },
            },
          ],
        },
      },
    ],
  };
}

function supplyChainReportFixture() {
  return {
    supply_chain_validation_schema_version: "touba-supply-chain-validation-v1",
    lock_schema_version: "touba-lock-v1",
    status: "warning",
    checked: {
      air_digest: true,
      manifest_digest: true,
      handler_digests: true,
      handler_commands: true,
      sdk_metadata: true,
      handler_packages: true,
      handler_package_files: false,
      handler_dependency_artifacts: false,
      provenance_metadata: true,
      review_metadata: true,
      review_evidence: true,
      review_required: false,
      redaction: true,
    },
    artifacts: {
      air: {
        drift_status: "ok",
      },
      manifest: {
        drift_status: "changed",
      },
    },
    provenance: {
      status: "ok",
      prepared_by_kind: "ci",
      prepared_by_id: "ci:touba-fixture",
      prepared_at: "2026-06-05T12:00:00Z",
      source_kind: "git",
      source_ref: "refs/heads/main",
      source_commit: "0123456789abcdef",
    },
    review: {
      status: "pending",
      evidence_status: "ok",
      required: false,
      reviewed_at: "2026-06-05T12:30:00Z",
      reviewers: 1,
      evidence: 1,
    },
    handlers: [
      {
        tool_ref: "tool:examples.sc1/Search",
        drift_status: "unknown",
        sdk_status: "unknown",
        handler_package_status: "unknown",
        handler_package_files_status: "unknown",
        handler_dependency_artifacts_status: "unknown",
        diagnostics: [
          {
            severity: "warning",
            code: "HandlerSdkUnknown",
            message: "handler SDK metadata unknown",
          },
        ],
      },
    ],
    diagnostics: [
      {
        severity: "warning",
        code: "HandlerSdkUnknown",
        message: "handler SDK metadata unknown",
      },
    ],
  };
}

function sourceRef(line) {
  return {
    source_id: "fixture.tb",
    start_line: line,
    start_column: 0,
    end_line: line + 1,
    end_column: 0,
  };
}

function effectiveProjectFixture() {
  const section = (status, sources = [], details = {}) => ({
    provenance: { status, sources },
    ...details,
  });
  return {
    schema_version: "touba-effective-project-v1",
    artifact_role: "derived_non_authoritative",
    project: {
      artifact_layout: "touba-artifacts-v1",
      profile: "dev",
    },
    inputs: [
      {
        kind: "project",
        path: "touba.project.json",
        digest_sha256: `sha256:${"a".repeat(64)}`,
        provenance: "declared",
      },
      {
        kind: "air",
        path: ".touba/build/dev/air/examples/app.air.json",
        digest_sha256: `sha256:${"b".repeat(64)}`,
        provenance: "derived",
      },
    ],
    contract: {
      sources: section("declared", ["src/examples/app.tb"], { modules: ["examples.app"], paths: ["src/examples/app.tb"] }),
      air: section("derived", ["src/examples/app.tb"], { modules: ["examples.app"], paths: [".touba/build/dev/air/examples/app.air.json"] }),
      entry: section("effective", [".touba/build/dev/touba.run-plan.json"], { ref: "strategy:examples.app/Run" }),
      handlers: section("non_applicable", [], { reason: "the prepared AIR declares no tool" }),
      grants: section("non_applicable", [], { reason: "the prepared AIR declares no tool" }),
      secrets: section("non_applicable", [], { reason: "no secret handle is required" }),
      memory_scopes: section("non_applicable", [], { reason: "no memory scope is declared" }),
      callers: section("non_applicable", [], { reason: "no agent is declared" }),
      budgets: section("absent", [], { reason: "no run budget is declared" }),
      sandbox: section("absent", [], { reason: "no project sandbox contract is declared in V1" }),
      lock: section("non_applicable", [], { reason: "profile does not require a supply-chain lock" }),
      triggers: section("non_applicable", [], { reason: "no trigger is declared" }),
      evidence: section("absent", [], { reason: "no local evidence artifact is available" }),
    },
  };
}
