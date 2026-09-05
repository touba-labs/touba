#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  MachineContractError,
  validateAirMachineContract,
  validateTraceMachineContract,
} from "../machine/contracts.mjs";
import { CONFORMANCE_CORPUS_VERSION, conformanceCases } from "./corpus.mjs";

export async function runConformance({ runtimeAdapter } = {}) {
  const results = [];
  for (const testCase of conformanceCases()) {
    let observed = "accept";
    let code = null;
    try {
      if (testCase.kind === "air") validateAirMachineContract(testCase.value);
      else validateTraceMachineContract(testCase.value);
    } catch (error) {
      observed = "reject";
      code = error instanceof MachineContractError ? error.code : "UnexpectedError";
    }
    let passed = observed === testCase.expectation
      && (observed === "accept" || code === testCase.expected_code);
    let runtime = null;
    if (passed && observed === "accept" && testCase.kind === "air" && runtimeAdapter) {
      runtime = await runtimeAdapter.runCase(structuredClone(testCase.value), "skill:conformance/Run");
      passed = runtime.status === "success" && runtime.result === "conformant";
    }
    results.push({ id: testCase.id, expectation: testCase.expectation, observed, code, passed, runtime });
  }
  return {
    schema_version: "touba-conformance-report-v1",
    corpus_version: CONFORMANCE_CORPUS_VERSION,
    adapter: runtimeAdapter?.name ?? "contract-only",
    status: results.every((item) => item.passed) ? "success" : "failure",
    summary: { total: results.length, passed: results.filter((item) => item.passed).length },
    results,
  };
}

async function main() {
  const adapterArg = process.argv.indexOf("--adapter");
  const adapter = adapterArg >= 0
    ? (await import(pathToFileURL(process.argv[adapterArg + 1]).href)).default
    : undefined;
  const report = await runConformance({ runtimeAdapter: adapter });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "success") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
