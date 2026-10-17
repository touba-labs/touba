import { structuredModelObject } from "./model-output.fixture.mjs";
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAiSdkDecisionProvider, createMemoryDecisionHistoryStore } from "../src/index.mjs";
import { nativeCapabilityName } from "../src/native-decision.mjs";
import {
  EFFECT_JOURNAL_SCHEMA_VERSION,
  executeAirDocument,
  loadSecretsFromJson,
  loadToolBindingManifestFromJson,
} from "../../touba-runtime/src/index.mjs";

const implementation = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ref = (kind, name) => `${kind}:tests.native_provider/${name}`;
const reviewName = "touba_request_human_review";
const entryRef = ref("strategy", "Run");
const agentRef = ref("agent", "Worker");
const approvalRef = (step) => `approval:${agentRef}:step-${step}:human-review`;
const source = `module tests.native_provider

memory Notes

tool Fetch
    description "Read the requested source through the authorized host binding."
    takes topic as Text
    gives Text

tool ReadNotes
    description "Read the scoped notes through the authorized host binding."
    takes topic as Text
    gives Text
    uses memory Notes read
    requires memory_read

agent Worker
    takes user_goal as Text
    gives Text
    responsibility "Use the authorized sources and request human review when needed."
    uses Fetch
    uses ReadNotes
    memory Notes read
    callable_by strategy Run

strategy Run
    takes user_goal as Text
    gives Text
    uses Worker
    do
        Worker
            with user_goal as user_goal
            into result
        give result
`;
const delegatedSource = `module tests.native_delegation

skill SpecialistAnswer
    description "Return the bounded specialist result."
    gives Text
    do
        give "specialist"

agent Coordinator
    description "Delegate specialist work only through the declared agent capability."
    gives Text
    responsibility "Coordinate the task and integrate the authorized specialist result."
    uses Specialist
    callable_by strategy Run

agent Specialist
    description "Complete the delegated work through the declared bounded skill."
    gives Text
    responsibility "Produce the specialist result through the authorized skill."
    uses SpecialistAnswer
    callable_by agent Coordinator

strategy Run
    gives Text
    uses Coordinator
    do
        Coordinator
            into result
        give result
`;
const effectSource = `module tests.native_effect

tool Create
    description "Create one external record through the governed effect binding."
    takes request as Text
    gives Text

agent Writer
    description "Create the requested record through the single authorized effect capability."
    takes request as Text
    gives Text
    responsibility "Create the requested record through the governed runtime effect."
    uses Create
    callable_by strategy Run

strategy Run
    takes request as Text
    gives Text
    uses Writer
    do
        Writer
            with request as request
            into result
        give result
`;
let air;
let noMemoryScopeAir;
let requiredApprovalAir;
let delegatedAir;
let unauthorizedDelegatedAir;
let secretAir;
let effectAir;

function compile(sourceText, expectedError = null) {
  const directory = mkdtempSync(path.join(tmpdir(), "native-provider-runtime-"));
  try {
    const filename = path.join(directory, "source.tb");
    writeFileSync(filename, sourceText, { flag: "wx" });
    const compiled = spawnSync("cargo", ["run", "-p", "touba-cli", "--bin", "touba-compile", "--quiet", "--", filename], {
      cwd: implementation, encoding: "utf8", timeout: 60000,
    });
    if (compiled.error) throw compiled.error;
    if (expectedError) {
      assert.notEqual(compiled.status, 0);
      assert.ok(compiled.stderr.includes(expectedError), compiled.stderr);
      return null;
    }
    assert.equal(compiled.status, 0, compiled.stderr);
    return JSON.parse(compiled.stdout);
  } finally { rmSync(directory, { recursive: true }); }
}

before(() => {
  air = compile(source);
  compile(source.replace("    memory Notes read\n", ""), "OwnerMemoryScopeMissing");
  noMemoryScopeAir = structuredClone(air);
  noMemoryScopeAir.definitions.agents[0].memory_scopes = [];
  requiredApprovalAir = compile(source.replace("    do\n        Worker", "    do\n        human.approve\n            with context as user_goal\n            into approval\n        Worker"));
  delegatedAir = compile(delegatedSource);
  compile(delegatedSource.replace(
    "    callable_by agent Coordinator\n",
    "    callable_by strategy Run\n",
  ), "AgentCallerNotAllowed");
  unauthorizedDelegatedAir = structuredClone(delegatedAir);
  unauthorizedDelegatedAir.definitions.agents.find(agent => agent.name === "Specialist").callable_by = [];
  secretAir = compile(source.replace(
    "    gives Text\n\ntool ReadNotes",
    "    gives Text\n    requires secret_read\n    secrets FETCH_API_KEY\n\ntool ReadNotes",
  ));
  effectAir = compile(effectSource);
});

function nativeCall(toolName, input) {
  const call = { toolCallId: "selected_by_fixture", toolName, input };
  return { finishReason: "tool-calls", toolCalls: [call],
    response: { messages: [{ role: "assistant", content: [{ type: "tool-call", ...call }] }] } };
}
function select(name, input = { topic: "source-17" }) { return nativeCall(nativeCapabilityName(ref("tool", name)), input); }
function review() { return nativeCall(reviewName, { review_prompt: "Please review the current source." }); }
function answer(result = "done") {
  return { finishReason: "stop", object: structuredModelObject({ action: "answer_directly", source: "tests", reason: "Assigned work is complete.", result }) };
}
function catalogue() {
  return { finishReason: "stop", object: structuredModelObject({ action: "request_capabilities", source: "tests", reason: "An authorized operation or review is needed.", result: "" }) };
}

// Only model output is scripted. Parsing, source compilation, provider mapping,
// runtime authority, effects, human decisions and checkpoints remain real.
async function execute({ document = air, options = {}, decide, providerOptions = {} }) {
  const calls = [];
  const runtimeRequests = [];
  let currentRequest;
  const provider = createAiSdkDecisionProvider({
    model: "fixture", source: "tests", decisionInterface: "native", jsonSchema: (schema) => schema,
    ...providerOptions,
    generateText: async (modelOptions) => {
      calls.push({ kind: "native", options: structuredClone(modelOptions) });
      return decide(currentRequest, modelOptions);
    },
    generateObject: async (modelOptions) => {
      calls.push({ kind: "structured", options: structuredClone(modelOptions) });
      return decide(currentRequest, modelOptions);
    },
  });
  const result = await executeAirDocument(document, {
    entryRef, inputs: options.humanApprovalResumeCheckpoint ? {} : { user_goal: "Handle the requested source." },
    agentDecisionProviderInitialMode: "capabilities", agentDecisionProviderContentMode: "inline",
    ...options,
    agentDecisionProvider: async (request) => {
      currentRequest = request;
      runtimeRequests.push(structuredClone(request));
      return provider(request);
    },
  });
  return { result, calls, runtimeRequests };
}

function parts(options) {
  return (options.messages ?? []).flatMap((message) => Array.isArray(message.content) ? message.content : []);
}
function systemText(options) {
  return JSON.stringify([options.system, ...(options.messages ?? []).filter((message) => message.role === "system")]);
}
function userText(options) {
  return JSON.stringify((options.messages ?? []).filter((message) => message.role === "user"));
}
function runtimeContext(options) {
  return JSON.parse(options.system.split("\n\nRuntime context: ").at(-1));
}
function failureCode(result) {
  return result.trace.events.findLast((event) => event.kind === "failure_detected")?.payload.runtime_error_code;
}
function failureDiagnostic(result) {
  return JSON.stringify(result.trace.events.filter((event) => ["failure_detected", "agent_decision_provider_failed"].includes(event.kind)));
}

test("untyped completed prose is a schema failure, not a provider outage", async () => {
  let dispatches = 0;
  const run = await execute({
    options: { toolHandlers: { [ref("tool", "Fetch")]: () => { dispatches++; return "unused"; } } },
    decide: () => ({ finishReason: "stop", text: "The work is complete.", toolCalls: [],
      response: { messages: [{ role: "assistant", content: "The work is complete." }] } }),
  });
  assert.equal(run.result.status, "failure");
  assert.equal(failureCode(run.result), "AgentDecisionProviderSchemaViolation");
  assert.match(failureDiagnostic(run.result), /InvalidModelDecision/);
  assert.equal(dispatches, 0);
  const unavailable = await execute({ decide: () => { throw new Error("Simulated transport unavailable"); } });
  assert.equal(failureCode(unavailable.result), "AgentDecisionProviderUnavailable");
});

test("successive identical agent calls have separate identities and conversations", async () => {
  const twice = compile(source.replace("            into result\n        give result", `            into first
        Worker
            with user_goal as user_goal
            into result
        give result`));
  let dispatches = 0;
  const run = await execute({ document: twice,
    options: { toolHandlers: { [ref("tool", "Fetch")]: () => `receipt-${++dispatches}` } },
    decide: request => request.step_index === 0 ? select("Fetch") : answer("The source was read."),
  });
  assert.equal(run.result.status, "success", failureDiagnostic(run.result));
  assert.equal(dispatches, 2);
  const identities = run.runtimeRequests.map(request => request.invocation_id);
  assert.equal(new Set(identities).size, 2);
  assert.equal(identities[0], identities[1]);
  assert.equal(identities[2], identities[3]);
  const second = run.calls[2].options;
  assert.equal(parts(second).filter(part => part.type === "tool-call").length, 0);
  assert(!JSON.stringify(second).includes("receipt-1"));
});

test("typed catalogue completion preserves repeated calls and never creates an extra effect", async () => {
  let dispatches = 0;
  const run = await execute({
    options: { toolHandlers: { [ref("tool", "Fetch")]: () => `receipt-${++dispatches}` } },
    decide: request => {
      if (request.mode === "summary") return catalogue();
      if (request.step_index < 2) return select("Fetch", { topic: "same source" });
      return nativeCall("touba_finish", { reason: "Two authorized reads returned their receipts.", result: "Read twice." });
    },
  });
  assert.equal(run.result.status, "success", failureDiagnostic(run.result));
  assert.equal(run.result.result, "Read twice.");
  assert.equal(dispatches, 2);
  assert.equal(run.calls.length, 5);
  assert(run.runtimeRequests.at(-1).model_input.allowed_actions.includes("answer_directly"));
  assert.equal(run.calls.at(-1).kind, "native");
  assert.equal(run.result.trace.events.filter(event => event.kind === "agent_direct_answer_returned").length, 1);
});

test("native opaque projection selects a real capability without manufacturing opaque call history", async () => {
  const argumentMarker = "OPAQUE_ARGUMENT_MUST_STAY_PRIVATE";
  const resultMarker = "OPAQUE_RESULT_MUST_STAY_PRIVATE";
  let dispatches = 0;
  const opaqueAir = compile(source
    .replaceAll("    takes user_goal as Text\n", "    takes user_goal as Text\n    takes attachment as Text\n")
    .replace("            with user_goal as user_goal\n", "            with user_goal as user_goal\n            with attachment as attachment\n"));
  const run = await execute({
    document: opaqueAir,
    options: {
      agentDecisionProviderContentMode: "opaque_refs",
      inputs: { user_goal: "Read the approved source.", attachment: "OPAQUE_INPUT_MUST_STAY_PRIVATE" },
      toolHandlers: { [ref("tool", "Fetch")]: ({ arguments: args }) => { dispatches++; assert.equal(args.topic, argumentMarker); return resultMarker; } },
    },
    decide: (request) => request.step_index === 0 ? select("Fetch", { topic: argumentMarker }) : answer("Only references were received."),
  });
  assert.equal(run.result.status, "success", failureDiagnostic(run.result));
  assert.equal(dispatches, 1);
  assert.equal(run.calls[0].kind, "native");
  assert(Object.hasOwn(run.calls[0].options.tools, nativeCapabilityName(ref("tool", "Fetch"))));
  const allInputs = JSON.stringify(run.calls.map((call) => call.options));
  for (const marker of [argumentMarker, resultMarker, "OPAQUE_INPUT_MUST_STAY_PRIVATE"]) assert(!allInputs.includes(marker));
  assert(allInputs.includes("Read the approved source."));
  const last = run.calls.at(-1).options;
  assert.equal(parts(last).filter((part) => ["tool-call", "tool-result"].includes(part.type)).length, 0);
  assert(userText(last).includes("opaque:runtime_observation/0"));
  assert(userText(last).includes("opaque:runtime_observation/0/arguments"));
  assert.equal(runtimeContext(last).external_content_access.full_content_request_policy, "not_supported");
  assert.equal(runtimeContext(last).external_content_access.raw_content_in_provider_request, false);
});

test("native human review links the original call to the actual host decision", async () => {
  for (const decision of ["approved", "rejected"]) {
    let dispatches = 0;
    const run = await execute({
      options: { humanApprovalDecisions: { [approvalRef(0)]: decision }, toolHandlers: { [ref("tool", "Fetch")]: () => { dispatches++; return "unexpected"; } } },
      decide: (request) => request.step_index === 0 ? review() : answer("The human decision was received."),
    });
    assert.equal(run.result.status, decision === "approved" ? "success" : "stopped", failureDiagnostic(run.result));
    assert.equal(dispatches, 0);
    assert.equal(run.result.trace.events.some((event) => event.kind === "agent_human_review_requested"), true);
    assert.equal(run.calls.length, decision === "approved" ? 2 : 1);
    assert.deepEqual(runtimeContext(run.calls[0].options).human_interaction, {
      request_present: false, review_available: true, review_access: "direct_catalog_action", available_actions: ["request_human_review"],
    });
    if (decision === "approved") {
      const options = run.calls.at(-1).options;
      assert.equal(parts(options).filter((part) => ["tool-call", "tool-result"].includes(part.type)).length, 2);
      assert.equal(parts(options).find(part => part.type === "tool-call").toolCallId, "selected_by_fixture");
      assert(userText(options).includes(approvalRef(0)));
      assert(userText(options).includes("approved"));
      assert(userText(options).includes("human_review_decision"));
      assert.equal(runtimeContext(options).human_interaction.review_access, "request_capabilities_first");
    }
  }
});

test("native review policy and mandatory source approval cannot be bypassed by model output", async () => {
  const disabled = await execute({ providerOptions: { allowHumanReview: false }, decide: (_, options) => {
    assert.equal(Object.hasOwn(options.tools, reviewName), false);
    return review();
  } });
  assert.equal(disabled.calls[0].kind, "native");
  assert.equal(disabled.result.status, "failure");
  assert.equal(disabled.result.trace.events.some((event) => event.kind === "agent_human_review_requested"), false);
  const required = await execute({ document: requiredApprovalAir, decide: () => answer("must not run") });
  assert.equal(required.result.status, "stopped");
  assert.equal(required.calls.length, 0);
  assert.equal(required.result.trace.events.some((event) => event.kind === "human_approval_paused"), true);
});

async function pausedAfterEffect(maxProviderCalls = 4) {
  const history = { store: createMemoryDecisionHistoryStore(), namespace: "resume-test" };
  let dispatches = 0;
  const toolHandlers = { [ref("tool", "Fetch")]: ({ arguments: args }) => { dispatches++; assert.deepEqual(args, { topic: "source-17" }); return "observed source"; } };
  const paused = await execute({
    providerOptions: { history },
    options: { durableHumanApprovals: true, toolHandlers, runLimits: { max_provider_calls: maxProviderCalls, max_tool_calls: 1 } },
    decide: (request) => request.step_index === 0 ? select("Fetch") : request.mode === "summary" ? catalogue() : review(),
  });
  assert.equal(paused.result.status, "stopped", failureDiagnostic(paused.result));
  assert.equal(dispatches, 1);
  assert.equal(paused.result.checkpoint.kind, "agent_human_review");
  assert.equal(paused.result.checkpoint.budget_counters.provider_calls, 3);
  return { ...paused, history, toolHandlers, dispatches: () => dispatches };
}

test("native resume restores invocation history and human evidence without redispatching or resetting quotas", async () => {
  const paused = await pausedAfterEffect();
  const checkpoint = JSON.parse(JSON.stringify(paused.result.checkpoint));
  const resumed = await execute({
    providerOptions: { history: paused.history },
    options: { humanApprovalResumeCheckpoint: checkpoint, humanApprovalDecisions: { [approvalRef(1)]: "approved" }, toolHandlers: paused.toolHandlers,
      runLimits: { max_provider_calls: 4, max_tool_calls: 1 } },
    decide: (request) => { assert.equal(request.step_index, 2); return answer("Reviewed source."); },
  });
  assert.equal(resumed.result.status, "success");
  assert.equal(paused.dispatches(), 1);
  assert.equal(resumed.calls.length, 1);
  const history = parts(resumed.calls[0].options);
  const calls = history.filter((part) => part.type === "tool-call");
  const results = history.filter((part) => part.type === "tool-result");
  assert.equal(calls.length, 2);
  assert.equal(results.length, 2, JSON.stringify(history));
  assert.deepEqual(calls[0].input, { topic: "source-17" });
  assert.equal(calls[0].toolName, nativeCapabilityName(ref("tool", "Fetch")));
  assert.equal(results[0].toolCallId, calls[0].toolCallId);
  assert.equal(results[0].output.value, "observed source");
  assert(userText(resumed.calls[0].options).includes(approvalRef(1)));
  const exhausted = await execute({
    options: { humanApprovalResumeCheckpoint: checkpoint, humanApprovalDecisions: { [approvalRef(1)]: "approved" }, toolHandlers: paused.toolHandlers,
      runLimits: { max_provider_calls: 3, max_tool_calls: 1 } },
    decide: () => assert.fail("restored quota must refuse before a model call"),
  });
  assert.equal(exhausted.result.status, "failure");
  assert.equal(failureCode(exhausted.result), "AgentDecisionProviderBudgetExceeded");
  assert.equal(exhausted.calls.length, 0);
  assert.equal(paused.dispatches(), 1);
  const widened = await execute({
    options: { humanApprovalResumeCheckpoint: checkpoint, humanApprovalDecisions: { [approvalRef(1)]: "approved" }, toolHandlers: paused.toolHandlers,
      runLimits: { max_provider_calls: 8, max_tool_calls: 1 } },
    decide: (request) => request.mode === "summary" ? catalogue() : select("Fetch"),
  });
  assert.equal(failureCode(widened.result), "AgentDecisionProviderBudgetExceeded");
  assert.equal(widened.calls.length, 1);
  assert.equal(paused.dispatches(), 1);
  // The tool ceiling needs a separate run with enough provider allowance from
  // the start. Raising it only at resume must not widen the previous ceiling.
  const enoughProviderCalls = await pausedAfterEffect(8);
  const exhaustedTools = await execute({
    options: { humanApprovalResumeCheckpoint: enoughProviderCalls.result.checkpoint,
      humanApprovalDecisions: { [approvalRef(1)]: "approved" }, toolHandlers: enoughProviderCalls.toolHandlers,
      runLimits: { max_provider_calls: 8, max_tool_calls: 1 } },
    decide: (request) => request.mode === "summary" ? catalogue() : select("Fetch"),
  });
  assert.equal(exhaustedTools.result.status, "failure");
  assert.equal(failureCode(exhaustedTools.result), "ToolCallBudgetExceeded");
  assert.equal(exhaustedTools.calls.length, 2);
  assert.equal(enoughProviderCalls.dispatches(), 1);
});

test("native resume refuses incomplete historical observations before provider or handler execution", async () => {
  const paused = await pausedAfterEffect();
  const checkpoint = JSON.parse(JSON.stringify(paused.result.checkpoint));
  // Current V1 checkpoints must contain complete invocation evidence.
  // Do not infer omitted arguments or silently accept an obsolete shape.
  delete checkpoint.agent_loop_state.observations[0].arguments;
  const resumed = await execute({
    options: { humanApprovalResumeCheckpoint: checkpoint, humanApprovalDecisions: { [approvalRef(1)]: "approved" }, toolHandlers: paused.toolHandlers },
    decide: () => answer("Historical evidence received."),
  });
  assert.equal(resumed.result.status, "failure");
  assert.equal(failureCode(resumed.result), "InvalidHumanApprovalCheckpoint");
  assert.equal(paused.dispatches(), 1);
  assert.equal(resumed.calls.length, 0);
});

function skillPack() {
  const resources = [
    { ref: "resource:native-notes/procedure", path: "SKILL.md", kind: "procedure", content: "PACK_PROCEDURE_DATA_MARKER" },
    { ref: "resource:native-notes/script", path: "scripts/notes.mjs", kind: "script", content: "PACK_SCRIPT_MUST_NOT_BE_LOADED" },
  ].map((resource) => ({ ...resource, loadable_as_context: true, digest: `sha256:${createHash("sha256").update(resource.content).digest("hex")}` }));
  return { ref: "skill_pack:project/native-notes", name: "Native notes", description: "PACK_HINT_DATA_MARKER", version: "0.1.0", tags: ["test"], source: "project",
    activation: { model_invocable: true, user_invocable: true }, resources, execution_links: [] };
}

test("native skill pack hints, procedures and script metadata remain non-executable resource data", async () => {
  for (const active of [false, true]) {
    const run = await execute({
      options: { skillPacks: [skillPack()], ...(active ? { activeSkillPackRefs: ["skill_pack:project/native-notes"] } : {}),
        toolHandlers: { [ref("tool", "Fetch")]: () => "source" } },
      decide: (request) => request.step_index === 0 ? select("Fetch") : answer("Received resource context."),
    });
    assert.equal(run.result.status, "success", failureDiagnostic(run.result));
    const options = run.calls[0].options;
    assert(!systemText(options).includes("PACK_HINT_DATA_MARKER"));
    assert(!systemText(options).includes("PACK_PROCEDURE_DATA_MARKER"));
    assert(userText(options).includes("PACK_HINT_DATA_MARKER"));
    assert.equal(userText(options).includes("PACK_PROCEDURE_DATA_MARKER"), active);
    assert(!JSON.stringify(run.calls).includes("PACK_SCRIPT_MUST_NOT_BE_LOADED"));
    assert.deepEqual(Object.keys(options.tools).sort(), [nativeCapabilityName(ref("tool", "Fetch")), nativeCapabilityName(ref("tool", "ReadNotes")), "touba_finish", reviewName].sort());
    if (active) assert(run.result.trace.events.some((event) => event.kind === "skill_pack_resource_refused"));
  }
});

function memoryManifest(grants = ["memory_read"]) {
  return loadToolBindingManifestFromJson(JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: {
    [ref("tool", "ReadNotes")]: { effect_contract: { kind: "none" }, handler: { kind: "process", command: "node", args: ["unused-by-in-process-test.mjs"] },
      grants, memories: [{ ref: ref("memory", "Notes"), access: "read" }], timeout_ms: 5000, max_payload_bytes: 1048576 },
  } }));
}

test("native capability selection does not grant memory access absent a source scope or manifest grant", async () => {
  for (const scenario of [
    { document: air, grants: ["memory_read"], status: "success" },
    { document: noMemoryScopeAir, grants: ["memory_read"], status: "failure", code: "MemoryNotGrantedToOwner" },
    { document: air, grants: [], status: "failure", code: "MemoryGrantMissing" },
  ]) {
    let dispatches = 0;
    const run = await execute({
      document: scenario.document,
      options: { toolBindingManifest: memoryManifest(scenario.grants), toolHandlers: { [ref("tool", "ReadNotes")]: () => { dispatches++; return "scoped notes"; } } },
      decide: (request) => request.step_index === 0 ? select("ReadNotes") : answer("Read scoped notes."),
    });
    assert.equal(run.result.status, scenario.status, failureDiagnostic(run.result));
    assert.equal(dispatches, scenario.status === "success" ? 1 : 0);
    assert(Object.hasOwn(run.calls[0].options.tools, nativeCapabilityName(ref("tool", "ReadNotes"))));
    if (scenario.code) assert.equal(failureCode(run.result), scenario.code);
    else assert(run.result.trace.events.some((event) => event.kind === "memory_access_authorized"));
  }
});

test("native agent proposals preserve callable_by authority for authorized and refused delegation", async () => {
  const coordinatorRef = "agent:tests.native_delegation/Coordinator";
  const specialistRef = "agent:tests.native_delegation/Specialist";
  const specialistAnswerRef = "skill:tests.native_delegation/SpecialistAnswer";
  const runRef = "strategy:tests.native_delegation/Run";
  const authorized = await execute({
    document: delegatedAir,
    options: { entryRef: runRef, inputs: {} },
    decide: (request, modelOptions) => {
      if (request.agent_ref === coordinatorRef && request.step_index === 0) {
        assert.deepEqual(request.capability_refs, [specialistRef]);
        assert.deepEqual(Object.keys(modelOptions.tools).sort(), [
          nativeCapabilityName(specialistRef),
          "touba_finish",
          reviewName,
        ].sort());
        return nativeCall(nativeCapabilityName(specialistRef), {});
      }
      if (request.agent_ref === specialistRef && request.step_index === 0) {
        assert.deepEqual(request.capability_refs, [specialistAnswerRef]);
        return nativeCall(nativeCapabilityName(specialistAnswerRef), {});
      }
      if (request.agent_ref === specialistRef) return answer(request.observations[0].value);
      if (request.agent_ref === coordinatorRef) return answer(`coordinator ${request.observations[0].value}`);
      assert.fail(`unexpected agent ${request.agent_ref}`);
    },
  });
  assert.equal(authorized.result.status, "success", failureDiagnostic(authorized.result));
  assert.equal(authorized.result.result, "coordinator specialist");
  assert.deepEqual(
    authorized.result.trace.events
      .filter((event) => event.kind === "agent_invocation_authorized")
      .map((event) => [event.payload.caller_ref, event.payload.agent_ref]),
    [[runRef, coordinatorRef], [coordinatorRef, specialistRef]],
  );

  const refused = await execute({
    document: unauthorizedDelegatedAir,
    options: { entryRef: runRef, inputs: {} },
    decide: (request) => {
      assert.equal(request.agent_ref, coordinatorRef);
      return nativeCall(nativeCapabilityName(specialistRef), {});
    },
  });
  assert.equal(refused.result.status, "failure");
  assert.equal(failureCode(refused.result), "UnauthorizedAgentInvocation");
  assert.equal(
    refused.result.trace.events.some((event) => event.kind === "agent_invocation_refused"
      && event.payload.caller_ref === coordinatorRef
      && event.payload.agent_ref === specialistRef),
    true,
  );
});

test("native multi-agent review resumes with one specialist result and no repeated selection", async () => {
  const providerOptions = { history: { store: createMemoryDecisionHistoryStore(), namespace: "delegated-resume" } };
  const coordinator = "agent:tests.native_delegation/Coordinator";
  const specialist = "agent:tests.native_delegation/Specialist";
  const options = { entryRef: "strategy:tests.native_delegation/Run", inputs: {}, durableHumanApprovals: true };
  const paused = await execute({ document: delegatedAir, options, providerOptions, decide: request => {
    return request.agent_ref === coordinator ? nativeCall(nativeCapabilityName(specialist), {})
      : nativeCall(reviewName, { review_prompt: "Approve this specialist result." });
  } });
  assert.equal(paused.result.reason, "human_approval_pending", failureDiagnostic(paused.result));
  const checkpoint = paused.result.checkpoint;
  const seen = [];
  const resumed = await execute({ document: delegatedAir, providerOptions,
    options: { ...options, humanApprovalResumeCheckpoint: structuredClone(checkpoint),
      humanApprovalDecisions: { [checkpoint.approval_ref]: "approved" } },
    decide: (request, modelOptions) => {
      seen.push([request.agent_ref, request.step_index]);
      if (request.agent_ref === specialist) {
        assert.equal(request.observations[0].value.decision, "approved");
        return answer("reviewed specialist");
      }
      const history = parts(modelOptions);
      assert.equal(history.filter(part => part.type === "tool-call").length, 1);
      assert.equal(history.filter(part => part.type === "tool-result").length, 1, JSON.stringify(history));
      assert.equal(request.observations[0].target_ref, specialist);
      assert.equal(request.observations[0].value, "reviewed specialist");
      return answer("coordinated " + request.observations[0].value);
    },
  });
  assert.equal(resumed.result.status, "success", failureDiagnostic(resumed.result));
  assert.equal(resumed.result.result, "coordinated reviewed specialist");
  assert.deepEqual(seen, [[specialist, 1], [coordinator, 1]]);
});

function secretManifest() {
  return loadToolBindingManifestFromJson(JSON.stringify({
    manifest_version: "touba-manifest-v1",
    agent_secret_scopes: { [agentRef]: ["FETCH_API_KEY"] },
    bindings: {
      [ref("tool", "Fetch")]: {
        effect_contract: { kind: "none" }, handler: { kind: "process", command: "node", args: ["unused-by-in-process-test.mjs"] },
        grants: ["secret_read"],
        secrets: ["FETCH_API_KEY"],
        timeout_ms: 5000,
        max_payload_bytes: 1048576,
      },
    },
  }));
}

function secretStore(value) {
  return loadSecretsFromJson(JSON.stringify({
    secrets_version: "touba-secrets-v1",
    secrets: { FETCH_API_KEY: { source: "env", name: "FETCH_API_TOKEN" } },
  }), { env: { FETCH_API_TOKEN: value } });
}

test("native proposals expose secret handles only to runtime bindings and never secret values to the model", async () => {
  const secretValue = "native-secret-value-must-not-reach-provider";
  let dispatches = 0;
  const guardedOptions = {
    toolBindingManifest: secretManifest(),
    secretStore: secretStore(secretValue),
    toolHandlers: {
      [ref("tool", "Fetch")]: ({ binding }) => {
        dispatches++;
        assert.deepEqual(binding.secretHandles, ["FETCH_API_KEY"]);
        return "authorized source";
      },
    },
  };
  const authorized = await execute({
    document: secretAir,
    options: guardedOptions,
    decide: (request) => request.step_index === 0 ? select("Fetch") : answer("authorized source"),
  });
  assert.equal(authorized.result.status, "success", failureDiagnostic(authorized.result));
  assert.equal(dispatches, 1);
  assert.equal(JSON.stringify(authorized.calls).includes(secretValue), false);
  assert.equal(JSON.stringify(authorized.result.trace).includes(secretValue), false);
  assert.equal(
    authorized.result.trace.events.some((event) => event.kind === "secret_handle_authorized"
      && event.payload.secret_handle === "FETCH_API_KEY"),
    true,
  );

  const refused = await execute({
    document: secretAir,
    options: { ...guardedOptions, inputs: { user_goal: secretValue } },
    decide: () => assert.fail("a resolved secret must be refused before the native provider call"),
  });
  assert.equal(refused.result.status, "failure");
  assert.equal(failureCode(refused.result), "SecretValueInAgentDecisionRequest");
  assert.equal(refused.calls.length, 0);
  assert.equal(dispatches, 1);
  assert.equal(JSON.stringify(refused.result.trace).includes(secretValue), false);
});

function effectManifest() {
  const script = `
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const request = JSON.parse(input);
      process.stdout.write(JSON.stringify({
        ok: true,
        value: \`created:\${request.arguments.request}\`,
        effect_receipt: {
          effect_id: request.effect.effect_id,
          request_digest: request.effect.request_digest,
          outcome: "applied",
          receipt_ref: "opaque:native-governance:created"
        }
      }));
    });
  `;
  return loadToolBindingManifestFromJson(JSON.stringify({
    manifest_version: "touba-manifest-v1",
    bindings: {
      "tool:tests.native_effect/Create": {
        handler: { kind: "process", command: process.execPath, args: ["-e", script] },
        grants: [],
        secrets: [],
        timeout_ms: 1000,
        max_payload_bytes: 16384,
        effect_contract: { kind: "external_write", retry_mode: "idempotency_key" },
      },
    },
  }));
}

function effectJournal() {
  const entries = new Map();
  const transitions = [];
  return {
    entries,
    transitions,
    adapter: {
      schemaVersion: EFFECT_JOURNAL_SCHEMA_VERSION,
      readEntry: (effectId) => entries.has(effectId) ? structuredClone(entries.get(effectId)) : null,
      writeEntry: (entry) => {
        entries.set(entry.effect_id, structuredClone(entry));
        transitions.push(entry.state);
      },
    },
  };
}

test("native selection keeps external effects behind runtime identity, journal and replay", async () => {
  const createRef = "tool:tests.native_effect/Create";
  const journal = effectJournal();
  const run = async (runId) => execute({
    document: effectAir,
    options: {
      entryRef: "strategy:tests.native_effect/Run",
      inputs: { request: "record-17" },
      runId,
      toolBindingManifest: effectManifest(),
      effectScopeId: "native-governance:record-17",
      effectJournal: journal.adapter,
    },
    decide: (request, modelOptions) => {
      if (request.step_index === 0) {
        assert.equal(modelOptions.tools[nativeCapabilityName(createRef)].execute, undefined);
        return nativeCall(nativeCapabilityName(createRef), { request: "record-17" });
      }
      return answer(request.observations[0].value);
    },
  });

  const first = await run("run:native-effect:first");
  assert.equal(first.result.status, "success", failureDiagnostic(first.result));
  assert.equal(first.result.result, "created:record-17");
  assert.deepEqual(journal.transitions, ["prepared", "dispatched", "applied"]);
  const [effectId, applied] = [...journal.entries.entries()][0];
  assert.match(effectId, /^effect:sha256:[a-f0-9]{64}$/u);
  assert.equal(applied.state, "applied");
  assert.equal(applied.attempt_count, 1);

  const replay = await run("run:native-effect:replay");
  assert.equal(replay.result.status, "success", failureDiagnostic(replay.result));
  assert.equal(replay.result.result, first.result.result);
  assert.deepEqual(journal.transitions, ["prepared", "dispatched", "applied"]);
  assert.equal(journal.entries.get(effectId).attempt_count, 1);
});
