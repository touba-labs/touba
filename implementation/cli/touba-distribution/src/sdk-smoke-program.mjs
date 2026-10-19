// Executed only after npm installs the distributed tarball in a clean project.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { defineTool, ToubaEngine, toubaSdkMetadata, createOpenAiDecisionProvider, createOllamaDecisionProvider } from "@touba/sdk";
import { assertRunSucceeded, assertRunRefused, assertTraceEvents } from "@touba/sdk/testing";
import { createSqliteDecisionHistoryStore } from "@touba/sdk/history/sqlite";
import { createProviderContextFetch } from "@touba/sdk";
import { createSqliteProviderBudget } from "@touba/sdk/budget/sqlite";

const historyStore = createSqliteDecisionHistoryStore({ filename: ":memory:" });
await historyStore.transact("archive-check", async () => ({ record: { retained: true }, result: true }));
assert.deepEqual(historyStore.read("archive-check"), { retained: true });
await historyStore.transact("archive-check", async record => {
  assert.equal(record.retained, true); return { record };
});
historyStore.close();

const contextFetch = createProviderContextFetch({ provider: "openai", contextWindowTokens: 1000,
  countFetch: async () => Response.json({ input_tokens: 900 }),
  fetch: () => assert.fail("an over-budget installed request must not generate") });
await assert.rejects(contextFetch("https://api.openai.com/v1/responses", {
  body: JSON.stringify({ model: "fixture", input: "Read.", max_output_tokens: 100 }),
}), { code: "ProviderContextWindowExceeded" });

assert.equal(typeof defineTool, "function");
assert.equal(toubaSdkMetadata().name, "@touba/sdk");
assert.ok(import.meta.resolve("@touba/sdk").includes("node_modules/@touba/sdk/"));
const sdkRequire = createRequire(import.meta.resolve("@touba/sdk"));
for (const name of ["ai", "@ai-sdk/openai", "zod"]) assert.ok(sdkRequire.resolve(name));

writeFileSync("hello.tb", 'module distribution.hello\nstrategy Hello\n    gives Text\n    do\n        give "installed-sdk-ok"\n');
const engine = new ToubaEngine({ command: process.execPath, commandArgs: [process.argv[2]] });
const run = await engine.run({ source: "hello.tb" });
assert.equal(run.status, "success");
assert.equal(run.result, "installed-sdk-ok");
assertRunSucceeded(run, "installed-sdk-ok");
assertTraceEvents(run.trace, { kind: "run_completed", count: 1 });
await checkInstalledProviderAccounting(engine);

async function checkInstalledProviderAccounting(installedEngine) {
  const received = [], filename = join(process.cwd(), "installed-budget.sqlite");
  const budget = createSqliteProviderBudget({ filename, budgetId: "installed-check", currency: "USD", limitMicros: 1000n });
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); received.push(body);
    assert.equal(budget.snapshot().attempts.pending, 1, "reserve before each actual dispatch");
    const native = body.tools?.some(tool => tool.name === "touba_finish");
    const output = native ? [{ type: "function_call", id: "fc_local", call_id: "call_local", name: "touba_finish",
      arguments: JSON.stringify({ reason: "Complete.", result: "done" }), status: "completed" }]
      : [{ type: "message", id: "msg_local", role: "assistant", status: "completed", content: [{ type: "output_text", annotations: [],
        text: JSON.stringify({ decision: { action: "answer_directly", source: "offline_fixture", result: "done" } }) }] }];
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_local", created_at: 1, model: "fixture-model", status: "completed", output,
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    writeFileSync("accounting.tb", `module installed.accounting
agent Worker
    gives Text
    responsibility "Return the requested result."
    callable_by strategy Run
strategy Run
    gives Text
    uses Worker
    do
        Worker
            into result
        give result
`);
    const provider = (mode, limit) => writeFileSync("accounting.provider.mjs", `
import {createOpenAiDecisionProvider,createProviderTokenCostAdapter} from '@touba/sdk';
import {createSqliteProviderBudget} from '@touba/sdk/budget/sqlite';
process.env.TOUBA_INSTALLED_COST_FIXTURE='offline-fixture-not-a-key';
const budget=createSqliteProviderBudget({filename:${JSON.stringify(filename)},budgetId:'installed-check',currency:'USD',limitMicros:${limit}n});
const tariff={id:'offline-fixture',date:'2026-10-19',currency:'USD',rates:{input:1000000n,output:1000000n}};
const adapter=createProviderTokenCostAdapter({protocol:'openai-responses',model:'fixture-model',tariff,inputTokenBound:()=>({basis:'upper_bound',tokens:100})});
export default createOpenAiDecisionProvider({model:'fixture-model',decisionInterface:${JSON.stringify(mode)},history:false,maxRetries:0,maxOutputTokens:64,
 apiKeyEnvNames:['TOUBA_INSTALLED_COST_FIXTURE'],baseURL:'http://127.0.0.1:${server.address().port}/v1',cost:{budget,...adapter}});
`);
    const options = { source: "accounting.tb", entryRef: "strategy:installed.accounting/Run",
      agentDecisionProvider: "accounting.provider.mjs", agentDecisionProviderInitialMode: "capabilities" };
    for (const mode of ["structured", "native"]) {
      provider(mode, 1000);
      const result = await installedEngine.run(options);
      assertRunSucceeded(result, "done");
      const evidence = result.trace.events.filter(event => event.kind === "provider_cost_recorded");
      assert.deepEqual(evidence.map(event => event.payload.status), ["pending", "reported"]);
      assert.equal(evidence[1].payload.cost_micros, "3");
      const attempt = budget.listAttempts().find(value => value.id === evidence[0].payload.attempt_id);
      assert.equal(attempt.context.invocation_id, evidence[0].payload.invocation_id);
      assert.equal(JSON.stringify(result.trace).includes("offline-fixture-not-a-key"), false);
    }
    assert.equal(budget.snapshot().committedMicros, 6n);
    provider("native", 6); // fresh process, same durable ledger, tightened ceiling
    await assertRunRefused(() => installedEngine.run(options), "ProviderCostBudgetExceeded");
    assert.equal(received.length, 2, "refusal must precede a third HTTP request");
    assert.equal(budget.snapshot().committedMicros, 6n);
  } finally {
    server.closeAllConnections(); await new Promise(done => server.close(done)); budget.close();
  }
}

const persistent = new ToubaEngine({ command: process.execPath, commandArgs: [process.argv[2]], executionMode: "persistent" });
try {
  const { airJson } = await persistent.compile({ source: "hello.tb" });
  assertRunSucceeded(await persistent.run({ airJson }), "installed-sdk-ok");
  const pid = persistent.workerPid;
  assertRunSucceeded(await persistent.run({ airJson }), "installed-sdk-ok");
  assert.equal(persistent.workerPid, pid);
} finally { await persistent.close(); }

// Scripted decisions drive the installed runtime; the handler is a real child
// process. Its test-only invocation journal is checked independently of traces.
writeFileSync("testing.tb", `module archive_testing
tool NormalizeTicket
    description "Normalize the supplied ticket text."
    takes ticket as Text
    gives Text
tool Forbidden
    description "An operation outside the agent responsibility."
    takes ticket as Text
    gives Text
agent Reviewer
    responsibility "Normalize the ticket using the authorized tool."
    takes ticket as Text
    gives Text
    uses NormalizeTicket
    callable_by strategy Review
strategy Review
    takes ticket as Text
    gives Text
    uses Reviewer
    do
        Reviewer
            with ticket as ticket
            into reviewed
        give reviewed
`);
const testingHandler = body => `import { defineTool } from "@touba/sdk";
import { appendFileSync } from "node:fs";
await defineTool({ toolRef: "tool:archive_testing/NormalizeTicket", inputSignature: [{name:"ticket",type_ref:"builtin:Text"}],
  outputType: "builtin:Text", run: async ({request}) => { appendFileSync("testing-calls.log", "invoked\\n"); ${body} } });`;
writeFileSync("testing.handler.mjs", testingHandler("return request.trim();"));
writeFileSync("testing-calls.log", "");
writeFileSync("testing.manifest.json", JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: {
  "tool:archive_testing/NormalizeTicket": { handler: { kind: "process", command: process.execPath, args: [join(process.cwd(), "testing.handler.mjs")] },
    grants: [], secrets: [], timeout_ms: 5000, max_payload_bytes: 16384, effect_contract: { kind: "none" } },
} }));
const writeTestProvider = target => writeFileSync("testing.provider.mjs", `import { createScriptedDecisionProvider } from "@touba/sdk/testing";
export default createScriptedDecisionProvider([
  { expect: {mode:"capabilities", agent_ref:"agent:archive_testing/Reviewer", step_index:0},
    decision: {action:"select_capability", target_ref:${JSON.stringify(target)}, arguments:{ticket:"  T-1  "}, source:"scripted-test"} },
  { expect: {mode:"summary", agent_ref:"agent:archive_testing/Reviewer", step_index:1},
    decision: {action:"answer_directly", result:"T-1", source:"scripted-test"} }
]);`);
const testingOptions = { source: "testing.tb", entryRef: "strategy:archive_testing/Review", inputs: { ticket: "  T-1  " },
  manifest: "testing.manifest.json", agentDecisionProvider: "testing.provider.mjs", agentDecisionProviderInitialMode: "capabilities" };
writeTestProvider("tool:archive_testing/NormalizeTicket");
assertRunSucceeded(await engine.run(testingOptions), "T-1");
assert.equal(readFileSync("testing-calls.log", "utf8"), "invoked\n");
writeTestProvider("tool:archive_testing/Forbidden");
await assertRunRefused(() => engine.run(testingOptions), "AgentCapabilityNotAllowed");
assert.equal(readFileSync("testing-calls.log", "utf8"), "invoked\n", "refusal must not call the handler");
writeTestProvider("tool:archive_testing/NormalizeTicket");
writeFileSync("testing.handler.mjs", testingHandler("return request.ticket.trim();"));
await assertRunRefused(() => engine.run(testingOptions), "ToolHandlerReportedError");
writeFileSync("testing.air.json", (await engine.compile({ source: "testing.tb" })).airJson);
writeFileSync("testing.run-plan.json", JSON.stringify({ run_plan_schema_version: "touba-run-plan-v1",
  profile: "dev", entry_ref: testingOptions.entryRef, air: "testing.air.json", manifest: "testing.manifest.json" }));
const diagnosticPath = `testing.diagnostics.${process.pid}.jsonl`;
const diagnosed = spawnSync(process.execPath, [process.argv[2], "run", "--run-plan", "testing.run-plan.json",
  "--agent-decision-provider", "testing.provider.mjs", "--agent-decision-provider-initial-mode", "capabilities",
  "--inputs-json", '{"ticket":"T-1"}', "--output", "json", "--handler-diagnostics", diagnosticPath], { encoding: "utf8" });
assert.equal(diagnosed.status, 1, diagnosed.stdout + diagnosed.stderr);
assert.equal(JSON.parse(diagnosed.stdout).reason, "ToolHandlerReportedError");
const diagnostic = JSON.parse(readFileSync(diagnosticPath, "utf8"));
assert.equal(diagnostic.error_class, "TypeError");
assert.ok(diagnostic.line > 0);
assert.equal(diagnosed.stdout.includes("handler_arg_index"), false);
writeFileSync("testing.handler.mjs", testingHandler("return request.trim();"));

writeFileSync("enum.tb", `module archive_enums
enum Priority
    low
    high
define DefaultPriority as Priority = Priority.high
function IsUrgent
    takes priority as Priority
    gives Boolean
    do
        give priority == DefaultPriority
`);
assert.equal((await engine.run({ source: "enum.tb", entryRef: "function:archive_enums/IsUrgent",
  inputs: { priority: "high" } })).result, true);
await assert.rejects(engine.run({ source: "enum.tb", entryRef: "function:archive_enums/IsUrgent",
  inputs: { priority: "unknown" } }));

writeFileSync("optional.tb", `module archive_optional
function Label
    takes value as Optional of Text
    gives Text
    do
        if present value as label
            give label
        else
            give "Absent"
`);
for (const [value, result] of [[{ present: true, value: "" }, ""], [{ present: false }, "Absent"]]) {
  assert.equal((await engine.run({ source: "optional.tb", entryRef: "function:archive_optional/Label", inputs: { value } })).result, result);
}
await assert.rejects(engine.run({ source: "optional.tb", entryRef: "function:archive_optional/Label", inputs: { value: null } }));

// Keep the generator's exports and signature; change only business code.
command(["init", "--root", process.cwd()]);
mkdirSync("src/distribution", { recursive: true });
writeFileSync("src/distribution/handlers.tb", `module distribution.handlers
tool Echo
    takes request as Text
    gives Text
    requires network
tool Decorate
    takes request as Text
    gives Text
skill Work
    takes request as Text
    gives Text
    uses Echo
    uses Decorate
    do
        Echo
            with request as request
            into echoed
        Decorate
            with request as echoed
            into decorated
        give decorated
`);
const packageBefore = readFileSync("package.json", "utf8");
const lockBefore = readFileSync("package-lock.json", "utf8");
const previouslyPrepared = existsSync(".touba/build/dev/touba.manifest.json");
const prepared = JSON.parse(command(["prepare", "--root", process.cwd(), "--mode", "write", "--json"]));
assert.equal(prepared.status, previouslyPrepared ? "success" : "needs_changes");
assert.equal(prepared.sdk_dependency.status, "ready");
let manifest = JSON.parse(readFileSync(prepared.manifest_path, "utf8"));
const hostDecisions = { bindings: Object.fromEntries(Object.keys(manifest.bindings).map(ref => [ref, {
  effect_contract: { kind: "none" }, grants: ref.endsWith("/Echo") ? ["network"] : [],
}])) };
const hostArgs = ["prepare", "--root", process.cwd(), "--host-decisions-json", JSON.stringify(hostDecisions), "--json"];
const beforeHostPlan = readFileSync(prepared.manifest_path, "utf8");
command([...hostArgs, "--mode", "plan"]);
assert.equal(readFileSync(prepared.manifest_path, "utf8"), beforeHostPlan);
assert.equal(JSON.parse(command([...hostArgs, "--mode", "write"])).status, "success");
const repeatedHostPlan = JSON.parse(command([...hostArgs, "--mode", "write"]));
assert.equal(repeatedHostPlan.actions.some(action => action.kind === "apply_host_decision"), false);
assert.equal(JSON.parse(command([...hostArgs, "--mode", "check"])).status, "success");
manifest = JSON.parse(readFileSync(prepared.manifest_path, "utf8"));
const contracts = [];
const originalHandlers = new Map();
for (const [ref, binding] of Object.entries(manifest.bindings)) {
  const file = binding.handler.args[0];
  const original = readFileSync(file, "utf8");
  originalHandlers.set(file, original);
  const replaced = original.replace(/export async function run\(\{ request, context \}\) \{[\s\S]*?\n\}/u,
    `export async function run({ request, context }) {\n  void context;\n  return ${ref.endsWith("/Decorate") ? '"[" + request + "]"' : "request"};\n}`);
  assert.match(original, /export async function run\(\{ request, context \}\)/u);
  if (original.includes("HandlerNotImplemented")) assert.notEqual(replaced, original);
  writeFileSync(file, replaced);
  contracts.push(file.replace(/\.handler\.mjs$/u, ".handler.contract.test.mjs"));
}
const contractRun = spawnSync(process.execPath, ["--test", ...contracts], { encoding: "utf8" });
assert.equal(contractRun.status, 0, contractRun.stdout + contractRun.stderr);
const output = await engine.run({ source: "src/distribution/handlers.tb", entryRef: "skill:distribution.handlers/Work",
  manifest: prepared.manifest_path, inputs: { request: "two handlers" } });
assert.equal(output.result, "[two handlers]");
const air = await engine.compile({ source: "src/distribution/handlers.tb" });
writeFileSync("handlers.air.json", air.airJson);
assert.equal(JSON.parse(command(["run", "handlers.air.json", "--entry", "skill:distribution.handlers/Work",
  "--manifest", prepared.manifest_path, "--inputs-json", '{"request":"CLI"}', "--output", "result"])), "[CLI]");
assert.equal(readFileSync("package.json", "utf8"), packageBefore);
assert.equal(readFileSync("package-lock.json", "utf8"), lockBefore);

// A damaged installation must be diagnosed, never silently resolved from the CLI.
const sdkRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@touba/sdk"))));
const sdkPackagePath = join(sdkRoot, "package.json");
const sdkPackageBytes = readFileSync(sdkPackagePath);
const sdkPackage = JSON.parse(sdkPackageBytes);
const sdkCheck = code => {
  const report = JSON.parse(command(["prepare", "--root", process.cwd(), "--mode", "plan", "--json"]));
  assert.equal(report.sdk_dependency.status, "unavailable");
  assert.equal(report.sdk_dependency.code, code);
  const refused = spawnSync(process.execPath, [process.argv[2], "run", "handlers.air.json", "--entry",
    "skill:distribution.handlers/Work", "--manifest", prepared.manifest_path,
    "--inputs-json", '{"request":"must refuse"}', "--output", "json"], { encoding: "utf8" });
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.equal(JSON.parse(refused.stdout).status, "failure");
};
renameSync(sdkRoot, sdkRoot + ".unavailable");
try { sdkCheck("HandlerSdkMissing"); } finally { renameSync(sdkRoot + ".unavailable", sdkRoot); }
writeFileSync(sdkPackagePath, JSON.stringify({ ...sdkPackage, version: "0.0.0-incompatible" }));
try {
  const report = JSON.parse(command(["prepare", "--root", process.cwd(), "--mode", "plan", "--json"]));
  assert.equal(report.sdk_dependency.code, "HandlerSdkIncompatible");
} finally { writeFileSync(sdkPackagePath, sdkPackageBytes); }
const aiRoot = join(sdkRoot, "node_modules/ai");
renameSync(aiRoot, aiRoot + ".unavailable");
try {
  const report = JSON.parse(command(["prepare", "--root", process.cwd(), "--mode", "plan", "--json"]));
  assert.equal(report.sdk_dependency.code, "HandlerSdkDependencyMissing");
  const missing = spawnSync(process.execPath, ["--input-type=module", "-e",
    "import {createRequire} from 'node:module'; await import(createRequire(import.meta.resolve('@touba/sdk')).resolve('ai'));"], { encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/);
} finally { renameSync(aiRoot + ".unavailable", aiRoot); }
for (const [file, stub] of originalHandlers) {
  if (!stub.includes("HandlerNotImplemented")) continue; // Reinstallation exercises completed handlers.
  const completed = readFileSync(file);
  writeFileSync(file, stub);
  try {
    await assert.rejects(engine.run({ air: "handlers.air.json", entryRef: "skill:distribution.handlers/Work",
      manifest: prepared.manifest_path, inputs: { request: "unimplemented" } }), error => {
      assert.equal(error.details.exitCode, 1);
      assert.match(JSON.stringify(error.details.trace), /HandlerNotImplemented/);
      return true;
    });
  } finally { writeFileSync(file, completed); }
}
writeFileSync("invalid.manifest.json", JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: { bad: {} } }));
await assert.rejects(engine.run({ air: "handlers.air.json", manifest: "invalid.manifest.json" }), error => {
  assert.equal(error.details.exitCode, 1);
  assert.equal(error.details.status, "failure");
  assert.equal(error.details.trace.events.some(event => event.kind === "call_completed"), false);
  return true;
});
const denied = structuredClone(manifest);
denied.bindings["tool:distribution.handlers/Echo"].grants = [];
const deniedPath = join(dirname(prepared.manifest_path), "denied.manifest.json");
writeFileSync(deniedPath, JSON.stringify(denied));
await assert.rejects(engine.run({ air: "handlers.air.json", entryRef: "skill:distribution.handlers/Work",
  manifest: deniedPath, inputs: { request: "denied" } }), error => {
  assert.ok(error.details.trace.events.some(event => event.payload?.runtime_error_code === "ToolCapabilityNotGranted"), JSON.stringify(error.details.trace));
  assert.equal(error.details.trace.events.some(event => event.kind === "call_completed"), false);
  return true;
});

process.env.TOUBA_DISTRIBUTION_TEST_KEY = "synthetic-not-a-credential";
const decision = { action: "answer_directly", source: "archive-test", reason: "The requested work is complete.", result: "done" };
// Real installed AI SDK response parsing, only the HTTP boundary is substituted.
for (const factory of [createOpenAiDecisionProvider, createOllamaDecisionProvider]) {
  for (const decisionInterface of ["structured", "native"]) {
    let calls = 0;
    const provider = factory({ model: "offline-response-fixture", source: "archive-test", decisionInterface,
      allowHumanReview: false, apiKeyEnvNames: ["TOUBA_DISTRIBUTION_TEST_KEY"], maxRetries: 0,
      fetch: async () => {
        calls++;
        return new Response(JSON.stringify({ object: "response", id: "resp_archive", created_at: 1,
          model: "offline-response-fixture", status: "completed", error: null, incomplete_details: null,
          output: [{ type: "message", id: "msg_archive", role: "assistant", status: "completed",
            content: [{ type: "output_text", text: JSON.stringify({ decision }), annotations: [] }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }), { headers: { "Content-Type": "application/json" } });
      } });
    const result = await provider({ protocol: "touba-agent-decision-v1", mode: "summary", content_mode: "inline",
      run_id: "archive-run", invocation_id: randomUUID(), step_index: 0,
      agent_ref: "agent:distribution/Worker", agent_signature: { output_type: "builtin:Text" },
      capability_refs: [], capabilities: [], model_input: { protocol: "touba-agent-model-input-v1",
        user_input: { value: {} }, allowed_actions: ["answer_directly"], agent_state: {} } });
    assert.equal(result.result, "done"); assert.equal(calls, 1);
  }
}
// Exercise the installed SDK, not the checkout or a CLI fallback. This catches
// an archive that documents triggerEvent but silently drops it at invocation.
const triggerRoot = join(process.cwd(), "trigger-archive-check");
mkdirSync(triggerRoot, { recursive: true });
writeFileSync(join(triggerRoot, "program.tb"), `module archive.trigger
strategy Run
    takes message as Text
    gives Text
    do
        give message
trigger Receive
    on request POST "/receive"
    runs strategy Run
    with message as payload.message
    limits
        max_runs_per_day as 5
        timeout_ms as 30000
`);
const triggerRef = "trigger:archive.trigger/Receive";
writeFileSync(join(triggerRoot, "touba.manifest.json"), JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: {},
  triggers: { [triggerRef]: { enabled: true, source: { kind: "request" },
    payload: { format: "json", content_types: ["application/json"], max_bytes: 4096, map: { message: "$.message" } },
    limits: { max_runs_per_day: 5, timeout_ms: 30000 } } } }));
const triggerEngine = new ToubaEngine({ projectRoot: triggerRoot, command: process.execPath, commandArgs: [process.argv[2]] });
const triggerOptions = { source: "program.tb", manifest: "touba.manifest.json", triggerState: "archive.trigger-state.json",
  triggerEvent: { trigger_ref: triggerRef, source_kind: "request", event_id: `archive-request-${randomUUID()}`, arguments: { message: "Archived SDK\nverified" } } };
assert.equal((await triggerEngine.run(triggerOptions)).result, "Archived SDK\nverified");
await assert.rejects(triggerEngine.run(triggerOptions), error => error.details.reason === "TriggerReplayRejected");
console.log("SDK_ARCHIVE_TRIGGER_OK");
console.log("SDK_ARCHIVE_OK");

function command(args) {
  const result = spawnSync(process.execPath, [process.argv[2], ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}
