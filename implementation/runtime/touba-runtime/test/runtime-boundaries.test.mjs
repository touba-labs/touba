import test from "node:test";
import assert from "node:assert/strict";

import {
  AIR_SCHEMA_VERSION,
  ToubaRuntimeError,
  executeAirDocument,
  loadAirFromJson,
  loadSecretsFromJson,
  loadToolBindingManifestFromJson,
} from "../src/index.mjs";
import {
  indexAirDocument,
  validateAirBudgets,
  validateAirDefinitionCollections,
  validateAirDocument,
} from "../src/air-runtime-profile.mjs";
import {
  HUMAN_APPROVAL_CHECKPOINT_VERSION,
  airDocumentDigest,
  assertCheckpointHasNoResolvedSecret,
  checkpointJsonClone,
  checkpointObjectFromMap,
  mapFromCheckpointObject,
  normalizeOptionalHumanApprovalCheckpoint,
  validateHumanApprovalCheckpointCompatibility,
} from "../src/human-approval-checkpoints.mjs";
import {
  RUN_BUDGET_ERROR_CODES,
  createBudgetState,
  normalizeRunLimitMap,
} from "../src/runtime-budgets.mjs";
import { RuntimeCancelled } from "../src/runtime-errors.mjs";
import {
  normalizeAgentDecisionProvider,
  normalizeAgentDecisionProviderContentMode,
  normalizeSkillPackActivationReasons,
  normalizeSkillPackBudgets,
  normalizeSkillPacks,
  normalizeStringSet,
  validateActiveSkillPackRefs,
} from "../src/runtime-options.mjs";
import {
  assertRunCanDispatch,
  initializeRunControls,
  observeRunTimeout,
} from "../src/run-controls.mjs";
import {
  TRACE_PROTOCOL_VERSION,
  TraceBuilder,
  compactPayload,
  sha256Json,
} from "../src/trace-builder.mjs";

test("builds trace documents with stable sequencing and compact payloads", () => {
  const trace = new TraceBuilder(
    {
      air_schema_version: AIR_SCHEMA_VERSION,
      module: { id: "module:test" },
    },
    "skill:test/Noop",
    "run-trace-test",
  );

  const first = trace.push("run_started", {
    payload: compactPayload({
      kept: "value",
      omittedNull: null,
      omittedUndefined: undefined,
    }),
  });
  const second = trace.push("run_completed", { message: "ok" });
  const document = trace.document();

  assert.equal(first.event_id, "event:run-trace-test:1");
  assert.equal(second.sequence_index, 1);
  assert.equal(document.trace_protocol_version, TRACE_PROTOCOL_VERSION);
  assert.equal(document.run.module_ref, "module:test");
  assert.deepEqual(document.events[0].payload, { kept: "value" });
  assert.equal(
    sha256Json({ ref: "skill_pack:project/research-review" }),
    "9526c9ca8b9bde7ada330e272b124c8c664acd7969da3127720cf3aa641a0af7",
  );
});

test("validates and indexes the AIR runtime profile at a typed boundary", () => {
  const document = minimalDocument();

  validateAirDocument(document);
  const indexes = indexAirDocument(document);

  assert.equal(indexes.skills.get("skill:test/Noop")?.id, "skill:test/Noop");
  assert.equal(indexes.graphs.get("graph:skill:test/Noop")?.owner_ref, "skill:test/Noop");
  assert.equal(indexes.tracePoints.size, 0);

  assert.throws(
    () => validateAirDefinitionCollections({ skills: {} }),
    (error) =>
      error instanceof ToubaRuntimeError
      && error.code === "InvalidAirDocument"
      && error.details.collection === "skills",
  );
  assert.throws(
    () => validateAirBudgets({ network: {} }),
    (error) =>
      error instanceof ToubaRuntimeError
      && error.code === "InvalidAirDocument"
      && error.details.unknownBudgetSections.includes("network"),
  );
  assert.throws(
    () => validateAirBudgets({ run: { max_steps: { value: 0, source_ref: sourceRef() } } }),
    (error) => error instanceof ToubaRuntimeError && error.code === "InvalidAirDocument",
  );

  const duplicate = cloneJson(document);
  duplicate.definitions.skills.push({ ...duplicate.definitions.skills[0] });
  assert.throws(
    () => indexAirDocument(duplicate),
    (error) =>
      error instanceof ToubaRuntimeError
      && error.code === "InvalidAirDocument"
      && /duplicate AIR id skill:test\/Noop/.test(error.message),
  );

  const missingId = cloneJson(document);
  delete missingId.execution_graphs[0].id;
  assert.throws(
    () => indexAirDocument(missingId),
    (error) =>
      error instanceof ToubaRuntimeError
      && error.code === "InvalidAirDocument"
      && /AIR item without id/.test(error.message),
  );
});

test("normalizes and validates human approval checkpoints at a typed boundary", () => {
  const airDocument = minimalDocument();
  const checkpoint = {
    checkpoint_schema_version: HUMAN_APPROVAL_CHECKPOINT_VERSION,
    air_schema_version: airDocument.air_schema_version,
    module_ref: airDocument.module.id,
    entry_ref: "skill:test/Noop",
    air_digest: airDocumentDigest(airDocument),
    scope: "entry_graph",
    approval_ref: "approval:test/review",
  };

  assert.equal(normalizeOptionalHumanApprovalCheckpoint(null), null);
  assert.equal(normalizeOptionalHumanApprovalCheckpoint(checkpoint), checkpoint);
  validateHumanApprovalCheckpointCompatibility(airDocument, "skill:test/Noop", checkpoint, {
    expectedScope: "entry_graph",
  });

  assert.throws(
    () => normalizeOptionalHumanApprovalCheckpoint({ checkpoint_schema_version: "wrong" }),
    (error) => error instanceof ToubaRuntimeError && error.code === "InvalidHumanApprovalCheckpoint",
  );
  assert.throws(
    () => validateHumanApprovalCheckpointCompatibility(
      airDocument,
      "skill:test/Other",
      checkpoint,
      { expectedScope: "entry_graph" },
    ),
    (error) =>
      error instanceof ToubaRuntimeError
      && error.code === "HumanApprovalCheckpointIncompatible"
      && error.details.compatibilityErrors.includes("entry_ref"),
  );
});

test("serializes checkpoint values as portable JSON without resolved secrets", () => {
  const values = new Map([
    ["value:answer", { text: "ok", rows: [1, 2] }],
  ]);
  const checkpointObject = checkpointObjectFromMap(values, "values");
  assert.deepEqual(checkpointObject, {
    "value:answer": { text: "ok", rows: [1, 2] },
  });
  assert.deepEqual(
    [...mapFromCheckpointObject(checkpointObject, "values").entries()],
    [...values.entries()],
  );
  assert.deepEqual(checkpointJsonClone({ stable: true }, "root"), { stable: true });

  assert.throws(
    () => checkpointJsonClone({ bad: undefined }, "values"),
    (error) =>
      error instanceof ToubaRuntimeError
      && error.code === "HumanApprovalCheckpointValueNotPortable",
  );
  assert.throws(
    () => checkpointJsonClone(Number.NaN, "value"),
    (error) =>
      error instanceof ToubaRuntimeError
      && error.code === "HumanApprovalCheckpointValueNotPortable",
  );
  assert.throws(
    () => assertCheckpointHasNoResolvedSecret(
      { leaked: "resolved-secret-value" },
      {
        secretStore: {
          resolvedSecretEntries: () => [
            { handle: "SEARCH_API_KEY", value: "resolved-secret-value" },
          ],
        },
      },
      "approval:test/review",
    ),
    (error) =>
      error instanceof ToubaRuntimeError
      && error.code === "SecretValueInHumanApprovalCheckpoint"
      && error.details.secretHandlesRefused.includes("SEARCH_API_KEY"),
  );
});

test("computes effective run budgets without widening AIR authority", () => {
  const document = {
    budgets: {
      run: {
        max_steps: {
          value: 5,
          source_ref: { module_ref: "module:test" },
        },
        max_provider_calls: {
          value: 3,
          source_ref: { module_ref: "module:test" },
        },
      },
    },
  };
  const manifest = {
    runLimits: new Map([
      ["max_steps", { value: 8, authoritySource: "manifest" }],
      ["max_provider_calls", { value: 2, authoritySource: "manifest" }],
    ]),
  };
  const budgetState = createBudgetState(document, manifest, {
    runLimits: { max_tool_calls: 4 },
    runtimeDefaultRunLimits: { max_run_ms: 1000 },
  });

  assert.equal(budgetState.counters.steps, 0);
  assert.deepEqual(budgetState.manifestWideningErrors, [
    {
      budgetKind: "max_steps",
      airValue: 5,
      manifestValue: 8,
    },
  ]);
  assert.equal(budgetState.effectiveLimits.get("max_steps").value, 5);
  assert.equal(budgetState.effectiveLimits.get("max_provider_calls").value, 2);
  assert.equal(budgetState.effectiveLimits.get("max_tool_calls").authoritySource, "host_policy");
  assert.equal(budgetState.effectiveLimits.get("max_run_ms").authoritySource, "runtime_default");
  assert.equal(RUN_BUDGET_ERROR_CODES.max_provider_calls, "AgentDecisionProviderBudgetExceeded");

  assert.throws(
    () => normalizeRunLimitMap({ max_tokens: 10 }, "runLimits", "host_policy"),
    (error) => error instanceof ToubaRuntimeError && error.code === "InvalidRuntimeOption",
  );
});

test("initializes run controls with kill switch cancellation trace", () => {
  const context = runControlContext({
    killSwitchInitiallyEnabled: true,
  });
  let budgetInitializations = 0;

  initializeRunControls(context, {
    initializeBudgetControls: () => {
      budgetInitializations += 1;
    },
  });

  assert.equal(budgetInitializations, 1);
  assert.equal(context.runState.status, "cancel_requested");
  assert.equal(context.runState.cancelRequested, true);
  assert.equal(context.runState.cancelAuthoritySource, "kill_switch");
  assert.equal(context.runState.cancelReason, "kill_switch_enabled");
  assert.deepEqual(
    context.trace.document().events.map((event) => event.kind),
    ["kill_switch_enabled", "run_cancel_requested"],
  );
  assert.deepEqual(context.trace.document().events[0].payload, {
    scope: "runtime",
    authority_source: "host",
    reason: "kill_switch_enabled",
  });
});

test("observes run timeout as cancellation without dispatching", () => {
  const context = runControlContext({
    runTimeoutMs: 10,
    now: () => 15,
  });

  observeRunTimeout(context);

  assert.equal(context.runState.timeoutExceeded, true);
  assert.equal(context.runState.cancelRequested, true);
  assert.equal(context.runState.cancelAuthoritySource, "timeout");
  assert.deepEqual(
    context.trace.document().events.map((event) => event.kind),
    ["run_timeout_exceeded", "run_cancel_requested"],
  );
  assert.deepEqual(context.trace.document().events[0].payload, {
    timeout_ms: 10,
    authority_source: "timeout",
    elapsed_ms: 15,
    scope: "runtime",
    reason: "global_timeout_exceeded",
  });
});

test("refuses dispatch after cancellation with stable trace payload", () => {
  const context = runControlContext({
    cancelRequested: true,
    cancelAuthoritySource: "host",
    cancelReason: "cancel_requested",
  });
  context.activeCallerRef = "skill:test/Search";
  context.activeAgentRef = "agent:test/Researcher";

  assert.throws(
    () => assertRunCanDispatch(context, {
      targetRef: "tool:test/Search",
      airRef: { node_id: "n1" },
    }),
    (error) =>
      error instanceof RuntimeCancelled
      && error.details.targetRef === "tool:test/Search"
      && error.details.authoritySource === "host",
  );

  assert.deepEqual(context.trace.document().events[0], {
    event_id: "event:run-control-test:1",
    run_id: "run-control-test",
    sequence_index: 0,
    kind: "dispatch_refused_cancelled",
    air_ref: { node_id: "n1" },
    payload: {
      target_ref: "tool:test/Search",
      reason: "cancel_requested",
      tool_ref: "tool:test/Search",
      caller_ref: "skill:test/Search",
      agent_ref: "agent:test/Researcher",
    },
  });
});

test("normalizes agent decision provider options at a typed runtime boundary", () => {
  const functionProvider = () => ({ target_ref: "skill:test/Noop" });
  functionProvider.metadata = {
    provider_kind: "fixture",
    model_id: "local-test",
  };

  const normalizedFunctionProvider = normalizeAgentDecisionProvider(functionProvider);
  assert.equal(normalizedFunctionProvider.decide, functionProvider);
  assert.deepEqual(normalizedFunctionProvider.metadata, {
    provider_kind: "fixture",
    model_id: "local-test",
  });
  assert.equal(normalizeAgentDecisionProviderContentMode("opaque_refs"), "opaque_refs");

  const boundProvider = {
    prefix: "bound",
    provider_metadata: { provider_name: "object-provider" },
    decideAgentCapability() {
      return { source: this.prefix, target_ref: "tool:test/Search" };
    },
  };
  assert.deepEqual(normalizeAgentDecisionProvider(boundProvider).decide(), {
    source: "bound",
    target_ref: "tool:test/Search",
  });

  assert.throws(
    () => normalizeAgentDecisionProvider({ decide: () => ({}), metadata: { unsupported: "field" } }),
    (error) => error instanceof ToubaRuntimeError && error.code === "InvalidAgentDecisionProvider",
  );
  assert.throws(
    () => normalizeAgentDecisionProviderContentMode("semantic"),
    (error) => error instanceof ToubaRuntimeError && error.code === "InvalidRuntimeOption",
  );
});

test("normalizes skill pack declarations before model disclosure", () => {
  const skillPacks = normalizeSkillPacks([
    {
      ref: "skill_pack:project/research-review",
      name: "Research review",
      description: "Review evidence before synthesis.",
      version: "1.2.0",
      tags: ["research", "review"],
      resources: [
        {
          ref: "resource:research-review/checklist",
          path: "resources/checklists/review.md",
          kind: "procedure",
          content: "check source credibility",
          loadable_as_context: true,
        },
      ],
      executionLinks: [
        {
          label: "Search",
          targetRef: "tool:test/Search",
        },
      ],
    },
  ]);
  const [pack] = skillPacks;

  assert.equal(pack.ref, "skill_pack:project/research-review");
  assert.match(pack.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(pack.resources[0].loadableAsContext, true);
  assert.equal(pack.executionLinks[0].target_ref, "tool:test/Search");

  const activeRefs = normalizeStringSet(["skill_pack:project/research-review"], "activeSkillPackRefs");
  validateActiveSkillPackRefs(skillPacks, activeRefs);
  assert.deepEqual(
    normalizeSkillPackActivationReasons({
      "skill_pack:project/research-review": "host_policy",
    }),
    new Map([["skill_pack:project/research-review", "host_policy"]]),
  );
  assert.deepEqual(
    normalizeSkillPackBudgets({
      skillPackDiscoveryMaxBytes: 100,
      skill_pack_activation_max_bytes: 200,
      agent_model_input_max_bytes: 300,
    }),
    {
      discoveryMaxBytes: 100,
      activationMaxBytes: 200,
      modelInputMaxBytes: 300,
    },
  );

  assert.throws(
    () => validateActiveSkillPackRefs(skillPacks, new Set(["skill_pack:project/missing"])),
    (error) => error instanceof ToubaRuntimeError && error.code === "InvalidRuntimeOption",
  );
  assert.throws(
    () => normalizeSkillPacks([
      {
        ref: "skill_pack:project/bad",
        name: "Bad",
        description: "Bad",
        resources: [
          {
            ref: "resource:bad/script",
            path: "scripts/bad.mjs",
            kind: "script",
            executable_by_pack: true,
          },
        ],
      },
    ]),
    (error) => error instanceof ToubaRuntimeError && error.code === "InvalidRuntimeOption",
  );
});

test("fuzzes AIR JSON boundary with deterministic invalid documents", async () => {
  const loaded = loadAirFromJson(JSON.stringify(minimalDocument()));
  const validResult = await executeAirDocument(loaded, {
    entryRef: "skill:test/Noop",
  });
  assert.equal(validResult.status, "success");
  assert.equal(validResult.result, "ok");

  const fixtures = [
    { name: "invalid json", json: "{", expectedCode: "InvalidAirDocument" },
    { name: "top-level array", document: [], expectedCode: "InvalidAirDocument" },
    { name: "missing module id", document: { ...minimalDocument(), module: {} }, expectedCode: "InvalidAirDocument" },
    {
      name: "unknown schema",
      document: { ...minimalDocument(), air_schema_version: "air-minimal-v9" },
      expectedCode: "UnsupportedAirSchemaVersion",
    },
    {
      name: "definitions array",
      document: { ...minimalDocument(), definitions: [] },
      expectedCode: "InvalidAirDocument",
    },
  ];

  for (const fixture of fixtures) {
    assertRejectsToubaAir(fixture.name, fixture.json ?? JSON.stringify(fixture.document), fixture.expectedCode);
  }

  const rng = seededRng(0x0522);
  const definitionCollections = [
    "types",
    "constants",
    "functions",
    "tools",
    "memories",
    "skills",
    "agents",
    "strategies",
    "triggers",
  ];
  const invalidValues = [null, {}, "not-an-array", 42, true];

  for (let index = 0; index < 72; index += 1) {
    const document = cloneJson(minimalDocument());
    const collection = pick(definitionCollections, rng);
    document.definitions[collection] = pick(invalidValues, rng);
    assertRejectsToubaAir(`definitions.${collection} mutation ${index}`, JSON.stringify(document), "InvalidAirDocument");
  }
});

test("fuzzes process handler stdout protocol without leaking resolved secrets", async () => {
  const cases = [
    {
      name: "empty stdout",
      script: "",
      expectedCode: "ToolHandlerInvalidJson",
      expectedMessage: /invalid JSON/,
    },
    {
      name: "array response",
      script: "process.stdout.write(JSON.stringify([]));",
      expectedCode: "ToolHandlerInvalidResponse",
      expectedMessage: /response must be an object/,
    },
    {
      name: "success missing value",
      script: "process.stdout.write(JSON.stringify({ ok: true }));",
      expectedCode: "ToolHandlerInvalidResponse",
      expectedMessage: /missing value/,
    },
    {
      name: "ok not boolean",
      script: "process.stdout.write(JSON.stringify({ ok: 'true', value: 'x' }));",
      expectedCode: "ToolHandlerInvalidResponse",
      expectedMessage: /ok must be boolean/,
    },
    {
      name: "controlled error containing secret",
      script:
        "process.stdout.write(JSON.stringify({ ok: false, error: { code: 'Denied', message: process.env.SEARCH_API_KEY } }));",
      expectedCode: "ToolHandlerReportedError",
      expectedMessage: /\[redacted-secret\]/,
    },
    {
      name: "non-zero stderr containing secret",
      script: "process.stderr.write(process.env.SEARCH_API_KEY); process.exit(2);",
      expectedCode: "ToolHandlerNonZeroExit",
      expectedMessage: /\[redacted-secret\]/,
    },
  ];

  for (const fixture of cases) {
    const result = await executeAirDocument(processToolDocument(), {
      entryRef: "skill:test/SearchFlow",
      inputs: {
        query: "touba",
      },
      toolBindingManifest: loadToolBindingManifestFromJson(
        JSON.stringify(processBindingManifestDocument(fixture.script)),
      ),
      secretStore: loadSecretsFromJson(JSON.stringify(secretsDocument()), {
        env: { SEARCH_API_TOKEN: "resolved-secret-value" },
      }),
    });

    const failure = eventOf(result.trace, "failure_detected");
    assert.equal(result.status, "failure", fixture.name);
    assert.equal(failure.payload.runtime_error_code, fixture.expectedCode, fixture.name);
    assert.match(failure.message, fixture.expectedMessage, fixture.name);
    assert.equal(JSON.stringify(result.trace).includes("resolved-secret-value"), false, fixture.name);
  }
});

test("does not over-redact ordinary errors when a resolved secret is empty", async () => {
  const result = await executeAirDocument(processToolDocument(), {
    entryRef: "skill:test/SearchFlow",
    inputs: {
      query: "touba",
    },
    toolBindingManifest: loadToolBindingManifestFromJson(
      JSON.stringify(processBindingManifestDocument("process.stdout.write('{}');")),
    ),
    secretStore: loadSecretsFromJson(JSON.stringify(secretsDocument()), {
      env: { SEARCH_API_TOKEN: "" },
    }),
    toolHandlers: {
      "tool:test/Search": () => {
        throw new Error("ordinary handler failure");
      },
    },
  });

  const failure = eventOf(result.trace, "failure_detected");
  assert.equal(result.status, "failure");
  assert.equal(failure.payload.runtime_error_code, "RuntimeFailure");
  assert.match(failure.message, /ordinary handler failure/);
  assert.equal(failure.message.includes("[redacted-secret]"), false);
});

test("fuzzes payload constraints before handler dispatch", async () => {
  const rng = seededRng(0x160522);
  let validCases = 0;
  let invalidCases = 0;

  for (let index = 0; index < 96; index += 1) {
    const request = payloadConstraintCase(rng);
    const shouldPass =
      request.query.trim().length > 0
      && request.query.length <= 8
      && request.rows >= 1
      && request.rows <= 5
      && request.tags.length >= 1
      && request.tags.length <= 3;
    let handlerCalls = 0;

    const result = await executeAirDocument(payloadConstraintDocument(), {
      entryRef: "skill:test/SearchFlow",
      inputs: { request },
      toolBindingManifest: loadToolBindingManifestFromJson(
        JSON.stringify(payloadConstraintManifestDocument()),
      ),
      toolHandlers: {
        "tool:test/Search": ({ arguments: args }) => {
          handlerCalls += 1;
          return {
            title: args.request.query,
            score: args.request.rows,
          };
        },
      },
    });

    if (shouldPass) {
      validCases += 1;
      assert.equal(result.status, "success", JSON.stringify(request));
      assert.equal(handlerCalls, 1, JSON.stringify(request));
      assert.deepEqual(result.result, {
        title: request.query,
        score: request.rows,
      });
    } else {
      invalidCases += 1;
      assert.equal(result.status, "failure", JSON.stringify(request));
      assert.equal(handlerCalls, 0, JSON.stringify(request));
      assert.equal(
        eventOf(result.trace, "failure_detected").payload.runtime_error_code,
        "ToolPayloadConstraintViolation",
        JSON.stringify(request),
      );
    }
  }

  assert.ok(validCases > 0);
  assert.ok(invalidCases > 0);
});

function assertRejectsToubaAir(name, json, expectedCode) {
  assert.throws(
    () => loadAirFromJson(json),
    (error) =>
      error instanceof ToubaRuntimeError
      && error.code === expectedCode,
    name,
  );
}

function runControlContext(overrides = {}) {
  return {
    trace: new TraceBuilder(
      {
        air_schema_version: AIR_SCHEMA_VERSION,
        module: { id: "module:test" },
      },
      "skill:test/Noop",
      "run-control-test",
    ),
    activeCallerRef: null,
    activeAgentRef: null,
    runState: {
      initialized: false,
      status: "created",
      cancelRequested: false,
      cancelCompleted: false,
      cancelAuthoritySource: null,
      cancelReason: null,
      cancelEventId: null,
      timeoutExceeded: false,
      runTimeoutMs: null,
      startedAtMs: 0,
      now: () => 0,
      initialCancelRequested: false,
      initialCancelAuthoritySource: "host",
      cancelOnPause: false,
      killSwitchInitiallyEnabled: false,
      killSwitchScope: "runtime",
      ...overrides,
    },
  };
}

function seededRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick(values, rng) {
  return values[Math.floor(rng() * values.length)];
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function payloadConstraintCase(rng) {
  const query = pick(["", "   ", "ok", "touba", "abcdefgh", "abcdefghi"], rng);
  const rows = Math.floor(rng() * 7);
  const tagCount = Math.floor(rng() * 5);
  return {
    query,
    rows,
    tags: Array.from({ length: tagCount }, (_, index) => `tag-${index}`),
  };
}

function minimalDocument() {
  return baseDocument({
    skills: [skill("Noop", "graph:skill:test/Noop")],
    graphs: [
      graph("graph:skill:test/Noop", "skill:test/Noop", [
        node("n1", "give", { arguments: ["literal:string:ok"] }),
      ]),
    ],
  });
}

function processToolDocument() {
  return baseDocument({
    tools: [
      tool("Search", {
        signature: {
          inputs: [parameter("query", "builtin:Text")],
          output_type: "builtin:Text",
        },
        required_capabilities: ["network", "secret_read"],
        required_secrets: ["SEARCH_API_KEY"],
      }),
    ],
    skills: [skill("SearchFlow", "graph:skill:test/SearchFlow", ["tool:test/Search"])],
    graphs: [
      graph("graph:skill:test/SearchFlow", "skill:test/SearchFlow", [
        node("n1", "call_tool", {
          target_ref: "tool:test/Search",
          arguments: ["value:query"],
          result_binding: "result",
        }),
        node("n2", "give", { arguments: ["value:result"] }),
      ], [
        edge("n1", "n2", "next"),
      ]),
    ],
  });
}

function payloadConstraintDocument() {
  return baseDocument({
    types: [
      {
        id: "type:test/SearchRequest",
        name: "SearchRequest",
        fields: [
          parameter("query", "builtin:Text"),
          parameter("rows", "builtin:Int"),
          parameter("tags", "list:builtin:Text"),
        ],
        source_ref: sourceRef(),
      },
      {
        id: "type:test/SearchResult",
        name: "SearchResult",
        fields: [
          parameter("title", "builtin:Text"),
          parameter("score", "builtin:Float"),
        ],
        source_ref: sourceRef(),
      },
    ],
    tools: [
      tool("Search", {
        signature: {
          inputs: [parameter("request", "type:test/SearchRequest")],
          output_type: "type:test/SearchResult",
        },
      }),
    ],
    skills: [skill("SearchFlow", "graph:skill:test/SearchFlow", ["tool:test/Search"])],
    graphs: [
      graph("graph:skill:test/SearchFlow", "skill:test/SearchFlow", [
        node("n1", "call_tool", {
          target_ref: "tool:test/Search",
          arguments: ["value:request"],
          result_binding: "result",
        }),
        node("n2", "give", { arguments: ["value:result"] }),
      ], [
        edge("n1", "n2", "next"),
      ]),
    ],
  });
}

function processBindingManifestDocument(script) {
  return bindingManifestDocument({
    bindings: {
      "tool:test/Search": {
        handler: {
          kind: "process",
          command: process.execPath,
          args: ["-e", script],
        },
        grants: ["network", "secret_read"],
        secrets: ["SEARCH_API_KEY"],
        timeout_ms: 5000,
        max_payload_bytes: 1048576,
      },
    },
  });
}

function payloadConstraintManifestDocument() {
  return bindingManifestDocument({
    bindings: {
      "tool:test/Search": {
        handler: {
          kind: "process",
          command: process.execPath,
          args: ["-e", ""],
        },
        grants: [],
        timeout_ms: 5000,
        max_payload_bytes: 4096,
        payload_constraints: {
          input: {
            "request.query": {
              non_empty: true,
              max_length: 8,
            },
            "request.rows": {
              min: 1,
              max: 5,
              allowed_values: [1, 2, 3, 4, 5],
            },
            "request.tags": {
              min_items: 1,
              max_items: 3,
            },
          },
        },
      },
    },
  });
}

function bindingManifestDocument({ bindings }) {
  return {
    manifest_version: "touba-manifest-v1",
    bindings,
  };
}

function secretsDocument() {
  return {
    secrets_version: "touba-secrets-v1",
    secrets: {
      SEARCH_API_KEY: {
        source: "env",
        name: "SEARCH_API_TOKEN",
      },
    },
  };
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

function graph(id, ownerRef, nodes, edges = []) {
  return {
    id,
    owner_ref: ownerRef,
    entry_node_id: nodes[0].id,
    nodes,
    edges,
    expressions: [],
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

function eventOf(trace, kind) {
  return trace.events.find((event) => event.kind === kind);
}
