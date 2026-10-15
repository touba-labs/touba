import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateManifestFromAirDocument } from "../../../cli/touba-manifest/src/generate.mjs";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const implementationRoot = path.resolve(fixtureRoot, "../../..");
const sourcePath = path.join(fixtureRoot, "source/donnees-quebec-live.tb");
const tmpRoot = mkdtempSync(path.join(tmpdir(), "touba-donnees-quebec-live-"));
const airPath = path.join(tmpRoot, "donnees-quebec-live.air.json");
const manifestPath = path.join(tmpRoot, "touba.manifest.json");
const cargo = process.env.CARGO ?? "cargo";
const liveMode = process.argv.includes("--live");
const dryRunMode = process.argv.includes("--dry-run") || !liveMode;

if (liveMode && process.argv.includes("--dry-run")) {
  throw new Error("use either --live or --dry-run, not both");
}

try {
  compileSourceToAir();
  materializeManifestFromAir();
  const run = runAir();
  assertTrace(run.trace, run.messages);
  console.log(
    `tool-binding:donnees-quebec mode=${liveMode ? "live" : "dry_run"} status=success endpoint=package_search`,
  );
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

function materializeManifestFromAir() {
  const airDocument = JSON.parse(readFileSync(airPath, "utf8"));
  const manifest = generateManifestFromAirDocument(airDocument, {
    handlerCommand: process.execPath,
    handlerRoot: "handlers",
    handlerCwd: fixtureRoot,
    timeoutMs: 10000,
    maxPayloadBytes: 1048576,
  });
  const binding = manifest.bindings["tool:examples.donnees_quebec_live/SearchDatasets"];
  binding.handler.args = ["handlers/search_datasets.handler.mjs"];
  binding.grants = ["network"];
  binding.effect_contract = { kind: "none" };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function compileSourceToAir() {
  const compileResult = spawnSync(
    cargo,
    ["run", "-p", "touba-cli", "--bin", "touba-compile", "--quiet", "--", sourcePath],
    {
      cwd: implementationRoot,
      encoding: "utf8",
    },
  );
  assertSuccess("compile", compileResult);
  writeFileSync(airPath, compileResult.stdout, "utf8");
}

function runAir() {
  const runResult = spawnSync(
    process.execPath,
    [
      path.join(implementationRoot, "cli/touba-run/src/run.mjs"),
      airPath,
      "--manifest",
      manifestPath,
      "--inputs-json",
      JSON.stringify({
        request: {
          query: "pompier",
          rows: 1,
          dry_run: dryRunMode,
        },
      }),
      "--output",
      "json",
    ],
    {
      cwd: implementationRoot,
      encoding: "utf8",
    },
  );
  assertSuccess("run", runResult);
  return JSON.parse(runResult.stdout);
}

function assertTrace(trace, messages) {
  const completed = trace.events?.find((event) => event.kind === "run_completed");
  if (completed?.payload?.status !== "success") {
    throw new Error(`expected trace status success, got ${completed?.payload?.status}`);
  }

  const bindingEvent = trace.events.find((event) => event.kind === "tool_binding_authorized");
  if (!bindingEvent) {
    throw new Error("expected tool_binding_authorized event");
  }
  if (bindingEvent.payload.tool_ref !== "tool:examples.donnees_quebec_live/SearchDatasets") {
    throw new Error(`unexpected tool_ref ${bindingEvent.payload.tool_ref}`);
  }
  if (!bindingEvent.payload.granted_capabilities.includes("network")) {
    throw new Error("expected network grant in trace");
  }

  if (!messages.some(message => message.text.startsWith("First dataset: "))) {
    throw new Error("expected a structured show message with dataset title");
  }
  if (trace.events.some(event => event.payload?.message || event.payload?.prompt)) throw new Error("interaction content leaked into trace");
}

function assertSuccess(label, result) {
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${label} failed with code ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}
