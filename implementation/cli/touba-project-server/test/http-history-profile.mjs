// Isolated HTTP load worker. All projects and identities are test fixtures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createToubaProjectServer } from "../src/serve.mjs";
import { fileURLToPath } from "node:url";


const { root, concurrency, history, repetition } = JSON.parse(process.argv[2]);
assert.ok([1, 8, 32].includes(concurrency));
const contractsRoot = fileURLToPath(new URL("../../../contracts/product-surfaces/", import.meta.url));
const target = "strategy:demo.approval/RunSentinel";
const requestedBy = { kind: "studio", id: "http-history-qualification" };
const deadlineMs = 60000;
function io() {
  if (process.platform !== "linux") return null;
  const values = Object.fromEntries(readFileSync("/proc/self/io", "utf8").trim().split("\n").map(line => {
    const [name, value] = line.split(":"); return [name, Number(value.trim())];
  }));
  return Object.fromEntries(["read_bytes", "write_bytes", "rchar", "wchar"].map(key => [key, values[key]]));
}
function delta(before, after) {
  return before ? Object.fromEntries(Object.keys(before).map(key => [key, after[key] - before[key]])) : null;
}
function quantiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return Object.fromEntries([50, 95, 99].map(p => [`p${p}_ms`, sorted[Math.ceil(sorted.length * p / 100) - 1]]));
}
let base;
let transportFailures = [];
async function request(path, expected, body) {
  let response, value, phase = "headers";
  try {
    response = await fetch(base + path, { signal: AbortSignal.timeout(deadlineMs),
      ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    phase = "body";
    value = await response.json();
  } catch (error) {
    if (transportFailures.length < 64) transportFailures.push({
      method: body === undefined ? "GET" : "POST", path: path.split("?")[0], phase,
      code: error.cause?.code ?? error.code ?? error.name,
      outcome_unknown: body !== undefined,
      ...(path === '/runs/sandbox/resume' && typeof body?.request_id === 'string'
        ? { request_id: body.request_id } : {}),
    });
    throw error;
  }
  assert.equal(response.status, expected, JSON.stringify({ path, value }));
  return value;
}
async function wait(session, operation, status) {
  const deadline = performance.now() + deadlineMs;
  do {
    const value = await request(`/interactions/sessions/${session}/operations/${operation}`, 200);
    if (value.status === status) return value;
    assert.ok(!["failed", "cancelled", "interrupted"].includes(value.status), JSON.stringify(value));
    await new Promise(resolve => setTimeout(resolve, 5));
  } while (performance.now() < deadline);
  throw new Error(`operation did not reach ${status}`);
}
async function flow(index) {
  const timings = {}, started = performance.now();
  async function timed(name, operation) {
    const at = performance.now(), value = await operation(); timings[name] = performance.now() - at; return value;
  }
  const session = await timed("create", () => request("/interactions/sessions", 201, {
    schema_version: "touba-interaction-session-create-v1", target_ref: target, target_kind: "strategy",
    presentation: "workflow", effect_policy: "allow_declared_external_effects", requested_by: requestedBy,
  }));
  const operation = await timed("message", () => request(`/interactions/sessions/${session.session_id}/messages`, 202, {
    schema_version: "touba-interaction-message-request-v1", message_id: `profile-${index}`,
    display_text: "Qualify durable execution.", inputs: {}, requested_by: requestedBy,
  }));
  const paused = await timed("pause", () => wait(session.session_id, operation.operation_id, "awaiting_human"));
  const pending = await request(`/approvals/pending/current?run_id=${encodeURIComponent(paused.run_id)}`, 200);
  assert.equal(pending.run_id, paused.run_id);
  await timed("decision", () => request("/decisions", 202, {
    schema_version: "touba-approval-decision-v1", request_id: pending.request_id, run_id: pending.run_id,
    trace_ref: pending.trace_ref, user_ref: "user:test-reviewer", device_ref: "device:test-suite",
    decision: "approve", decided_by: "user:test-reviewer", decided_at: new Date().toISOString(),
    comment: null, client_ref: "http-history-qualification",
  }));
  const resumed = await timed("resume", () => request("/runs/sandbox/resume", 200, { request_id: pending.request_id }));
  assert.equal(resumed.status, "success", JSON.stringify(resumed));
  await wait(session.session_id, operation.operation_id, "succeeded");
  timings.total = performance.now() - started;
  return timings;
}

const started = performance.now();
const service = createToubaProjectServer({ projectRoot: root, contractsRoot, port: 0, quiet: true });
try {
  await service.start();
  base = `http://127.0.0.1:${service.server.address().port}`;
  process.stdout.write(JSON.stringify({ kind: "startup", history, concurrency, repetition,
    milliseconds: performance.now() - started, rss_bytes: process.memoryUsage().rss }) + "\n");
  // Both waves finish their approvals. The second wave has exactly C more
  // completed records; report that difference instead of hiding it as N.
  for (const [wave, phase] of ["first_wave", "warm_wave"].entries()) {
    transportFailures = [];
    let peakRss = process.memoryUsage().rss;
    const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);
    const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
    const cpu = process.cpuUsage(), beforeIo = io(), at = performance.now();
    let samples, error;
    try {
      const results = await Promise.allSettled(Array.from({ length: concurrency }, (_, i) => flow(`${phase}-${i}`)));
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
      samples = results.map(result => result.value);
    }
    catch (failure) { error = failure; }
    finally { clearInterval(sampler); lag.disable(); }
    const elapsed = performance.now() - at;
    const usage = process.cpuUsage(cpu);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    process.stdout.write(JSON.stringify({ kind: "wave", history_before: history + wave * concurrency, concurrency,
      repetition, phase, elapsed_ms: elapsed, throughput_per_second: error ? null : concurrency * 1000 / elapsed,
      peak_rss_bytes: peakRss, cpu_microseconds: usage, process_io: delta(beforeIo, io()),
      lag_mean_ms: lag.mean / 1e6, lag_max_ms: lag.max / 1e6,
      errors: error ? [error.message] : [], transport_failures: transportFailures, samples: samples ?? [],
      quantiles: samples ? Object.fromEntries(Object.keys(samples[0]).map(key => [key, quantiles(samples.map(s => s[key]))])) : {},
    }) + "\n");
    if (error) throw error;
  }
} finally { await service.stop(); }
