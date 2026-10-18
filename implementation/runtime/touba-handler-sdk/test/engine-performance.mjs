// Local engineering measurements, not scientific benchmark results.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { ToubaEngine } from "../src/index.mjs";

const root = await mkdtemp(join(tmpdir(), "touba-engine-performance-"));
const samples = 20;
const metrics = { platform: `${process.platform}-${process.arch}`, node: process.version,
  samples, units: "milliseconds", note: "Local overhead probe; CPU and RSS below describe the driver, not child processes." };
const cpu = process.cpuUsage();
const start = performance.now();
const engine = new ToubaEngine({ projectRoot: root, command: process.execPath,
  commandArgs: [fileURLToPath(new URL("../../../cli/touba-project/src/main.mjs", import.meta.url))],
  ...(process.env.TOUBA_ENGINE_MODE ? { executionMode: process.env.TOUBA_ENGINE_MODE } : {}) });
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = q => Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)].toFixed(2));
  return { n: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99) };
}
async function measure(operation, count = samples) {
  const values = [];
  for (let i = 0; i < count; i++) { const t = performance.now(); await operation(i); values.push(performance.now() - t); }
  return distribution(values);
}
try {
  await writeFile(join(root, "source.tb"), `module overhead
strategy Echo
    takes value as Text
    gives Text
    do
        give value
`);
  const compileStart = performance.now();
  const { airJson } = await engine.compile({ source: "source.tb" });
  metrics.compile_first = Number((performance.now() - compileStart).toFixed(2));
  metrics.node_start = await measure(() => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.on("error", reject); child.on("close", code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
  }));
  for (const size of [64, 65536]) {
    const value = "a".repeat(size);
    const options = { airJson, inputs: { value }, entryRef: "strategy:overhead/Echo" };
    const run = async () => assert.equal((await engine.run(options)).result, value);
    const cold = performance.now(); await run();
    metrics[`air_${size}_first`] = Number((performance.now() - cold).toFixed(2));
    metrics[`air_${size}_sequential`] = await measure(run);
    metrics[`air_${size}_eight_concurrent`] = await measure(() => Promise.all(Array.from({ length: 8 }, run)), 5);
  }
  metrics.source_compile_and_run = await measure(async () => {
    const result = await engine.run({ source: "source.tb", entryRef: "strategy:overhead/Echo", inputs: { value: "source" } });
    assert.equal(result.result, "source");
  }, 5);
  metrics.driver_cpu_us = process.cpuUsage(cpu);
  metrics.driver_rss_bytes = process.memoryUsage().rss;
  metrics.worker = engine.workerMetrics;
  metrics.wall_ms = Number((performance.now() - start).toFixed(2));
  process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
} finally {
  await engine.close?.();
  await rm(root, { recursive: true, force: true });
}
