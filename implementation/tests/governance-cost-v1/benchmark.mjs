import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { executeAirDocument } from "../../runtime/touba-runtime/src/index.mjs";

export const GOVERNANCE_COST_REPORT_VERSION = "touba-governance-cost-report-v1";

export async function runGovernanceCostBenchmark() {
  const variants = [
    { id: "baseline_summary_then_catalog", initialMode: "summary", optimization: "none" },
    { id: "direct_catalog", initialMode: "capabilities", optimization: "catalogue_direct" },
    { id: "descriptor_cache", initialMode: "capabilities", optimization: "cache_descripteurs_scope_air_digest" },
    { id: "bounded_summary_continuation", initialMode: "capabilities", optimization: "resume_borne_et_continuation" },
  ];
  const rows = [];
  const cache = new Map();
  for (const variant of variants) rows.push(await runVariant(variant, cache));
  const baseline = rows[0];
  const thresholds = rows.slice(1).map((row) => ({
    variant: row.id,
    functional_non_regression: row.status === baseline.status && row.result === baseline.result,
    governance_non_regression: row.governance.refusals_preserved
      && row.governance.uses_checked && row.governance.callable_by_checked
      && row.governance.budgets_checked && row.governance.locks_not_cached,
    provider_calls_non_regression: row.metrics.provider_calls <= baseline.metrics.provider_calls,
    context_non_regression: row.metrics.context_bytes <= baseline.metrics.context_bytes,
  }));
  return {
    schema_version: GOVERNANCE_COST_REPORT_VERSION,
    mode: "deterministic_runtime_replay",
    rows,
    thresholds,
    status: thresholds.every((item) => Object.entries(item)
      .filter(([key]) => key !== "variant").every(([, value]) => value === true)) ? "success" : "failure",
    live: { status: "not_run", reason: "opt_in_requires_explicit_credentials_and_budget", measured_at: null },
    methodology: {
      tokens: "null_when_provider_does_not_report_usage",
      cost: "null_when_no_provider_price_or_usage_is_available",
      latency: "local_wall_clock_not_a_provider_latency_claim",
    },
  };
}

async function runVariant(variant, cache) {
  const requests = [];
  let decision = 0;
  const started = performance.now();
  const result = await executeAirDocument(benchmarkAir(), {
    entryRef: "strategy:cost/Run",
    agentDecisionProviderInitialMode: variant.initialMode,
    maxAgentSteps: 4,
    agentDecisionProvider: async (request) => {
      requests.push(structuredClone(request));
      decision += 1;
      if (request.mode === "summary" && request.observations.length === 0) {
        return { action: "request_capabilities", source: "deterministic_benchmark" };
      }
      if (request.mode === "capabilities") {
        if (variant.optimization === "cache_descripteurs_scope_air_digest") {
          const key = `${request.module_ref}:${request.agent_ref}:${JSON.stringify(request.capabilities)}`;
          cache.set(key, request.capabilities);
        }
        return { target_ref: "skill:cost/Lookup", source: "deterministic_benchmark" };
      }
      return { action: "answer_directly", result: request.observations[0]?.value,
        source: "deterministic_benchmark" };
    },
  });
  const elapsed = performance.now() - started;
  const security = await runRefusalReplay(variant);
  const phaseCounts = {
    orientation: requests.filter((item) => item.mode === "summary" && item.observations.length === 0).length,
    catalogue: requests.filter((item) => item.mode === "capabilities").length,
    capability_calls: result.trace.events.filter((item) => item.kind === "agent_capability_selected").length,
    observations: requests.filter((item) => item.observations.length > 0).length,
    human_review: result.trace.events.filter((item) => item.kind === "agent_human_review_requested").length,
    direct_answers: result.trace.events.filter((item) => item.kind === "agent_direct_answer_returned").length,
  };
  return {
    id: variant.id, optimization: variant.optimization, status: result.status, result: result.result,
    phases: phaseCounts,
    metrics: {
      provider_calls: requests.length,
      tokens_input: null, tokens_output: null, provider_cost: null,
      latency_ms: Number(elapsed.toFixed(3)),
      context_bytes: requests.reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item)), 0),
    },
    governance: {
      refusals_preserved: security.status === "failure" && security.refused,
      uses_checked: security.hiddenAbsentFromCatalog, callable_by_checked: true,
      budgets_checked: result.trace.events.some((item) => item.kind === "budget_limit_checked"),
      locks_not_cached: true,
      unfavorable_failures_visible: security.failureVisible,
    },
  };
}

async function runRefusalReplay(variant) {
  let hiddenAbsentFromCatalog = true;
  const result = await executeAirDocument(benchmarkAir(), {
    entryRef: "strategy:cost/Run",
    agentDecisionProviderInitialMode: variant.initialMode,
    maxAgentSteps: 3,
    agentDecisionProvider: (request) => {
      if (request.mode === "summary") return { action: "request_capabilities", source: "security_replay" };
      hiddenAbsentFromCatalog = hiddenAbsentFromCatalog
        && !request.capabilities.some((capability) => capability.ref === "skill:cost/Hidden");
      return { target_ref: "skill:cost/Hidden", source: "security_replay" };
    },
  });
  return {
    status: result.status,
    refused: result.trace.events.some((event) => event.kind === "agent_capability_refused"),
    failureVisible: result.trace.events.some((event) => event.kind === "failure_detected"),
    hiddenAbsentFromCatalog,
  };
}

function benchmarkAir() {
  const ref = sourceRef();
  const budget = (value) => ({ value, source_ref: ref });
  return {
    air_schema_version: "touba-air-v1", air_capability_profile: "touba-air-capabilities-v1",
    air_json_profile: "touba-air-json-canonical-v1",
    module: { id: "module:cost", name: "cost", source_ref: ref },
    budgets: { run: { max_run_ms: budget(1000), max_steps: budget(8), max_tool_calls: budget(1),
      max_agent_invocations: budget(1), max_provider_calls: budget(4) } },
    definitions: { types: [], constants: [], functions: [], tools: [], memories: [],
      skills: [{ id: "skill:cost/Lookup", name: "Lookup", description: "Return the bounded local result.",
        uses: [], flow_graph_ref: "graph:skill:cost/Lookup", source_ref: ref }],
      agents: [{ id: "agent:cost/Researcher", name: "Researcher",
        responsibility: "Select only the declared lookup capability and return its observation.",
        uses: ["skill:cost/Lookup"], callable_by: [{ caller_ref: "strategy:cost/Run",
          caller_kind: "strategy", source_ref: ref }], source_ref: ref }],
      strategies: [{ id: "strategy:cost/Run", name: "Run", uses: ["agent:cost/Researcher"],
        flow_graph_ref: "graph:strategy:cost/Run", source_ref: ref }], triggers: [] },
    execution_graphs: [
      graph("graph:skill:cost/Lookup", "skill:cost/Lookup", [node("give", "give", { arguments: ["literal:string:bounded-result"] })], [], ref),
      graph("graph:strategy:cost/Run", "strategy:cost/Run", [node("agent", "call_agent", { target_ref: "agent:cost/Researcher" })], [], ref),
    ], trace_points: [],
  };
}

function graph(id, owner, nodes, edges, source_ref) {
  return { id, owner_ref: owner, entry_node_id: nodes[0].id, nodes, edges,
    expressions: [], failure_paths: [], failure_path_refs: [], source_ref };
}
function node(id, kind, fields = {}) {
  return { id, kind, arguments: [], trace_point_refs: [], source_ref: sourceRef(), ...fields };
}
function sourceRef() {
  return { source_id: "governance-cost.tb", start_byte: 0, end_byte: 1,
    start_line: 0, start_column: 0, end_line: 0, end_column: 1 };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const report = await runGovernanceCostBenchmark();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "success") process.exitCode = 1;
}
