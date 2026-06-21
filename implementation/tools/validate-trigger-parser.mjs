#!/usr/bin/env node
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dir = dirname(fileURLToPath(import.meta.url));
const implementationRoot = resolve(__dir, "..");
const grammarRoot = join(implementationRoot, "grammar/tree-sitter-touba");
const treeSitterBin = join(implementationRoot, "node_modules/.bin/tree-sitter");
const buildDir = mkdtempSync(join(tmpdir(), "touba-tree-sitter-"));
const libPath = join(buildDir, `tree-sitter-touba.${sharedLibraryExtension()}`);

const triggerFixtures = [
  "examples/triggers-anneau-2/positive/tb-a2-trigger-p01-schedule-strategy-minimal.tb",
  "examples/triggers-anneau-2/positive/tb-a2-trigger-p02-schedule-strategy-with-literal.tb",
  "examples/triggers-anneau-2/positive/tb-a2-trigger-p03-schedule-strategy-with-define.tb",
  "examples/triggers-anneau-2/positive/tb-a2-trigger-p05-request-strategy-webhook.tb",
  "examples/triggers-anneau-2/negative/semantic/tb-a2-trigger-n01-runs-agent-rejected.tb",
  "examples/triggers-anneau-2/negative/semantic/tb-a2-trigger-n02-request-method-rejected.tb",
  "examples/triggers-anneau-2/negative/semantic/tb-a2-trigger-n03-missing-limits.tb",
  "examples/triggers-anneau-2/negative/semantic/tb-a2-trigger-n04-missing-timeout.tb",
  "examples/triggers-anneau-2/negative/semantic/tb-a2-trigger-n05-non-positive-max-runs.tb",
  "examples/triggers-anneau-2/negative/semantic/tb-a2-trigger-n06-non-positive-timeout.tb",
  "examples/triggers-anneau-2/negative/semantic/tb-a2-trigger-n07-duplicate-trigger.tb",
  "examples/triggers-anneau-2/negative/semantic/tb-a2-trigger-n08-target-strategy-missing.tb",
  "examples/triggers-anneau-2/negative/semantic/tb-a2-trigger-n09-duplicate-limit.tb",
  "examples/triggers-anneau-2/negative/semantic/tb-a2-trigger-n10-host-input-rejected.tb",
];

run(treeSitterBin, ["generate"], { cwd: grammarRoot });
run(
  "cc",
  ["-fPIC", "-I./src", "-shared", "src/parser.c", "src/scanner.c", "-o", libPath],
  { cwd: grammarRoot },
);
run(
  treeSitterBin,
  [
    "parse",
    "--config-path",
    "./tree-sitter-cli.config.json",
    "--lib-path",
    libPath,
    "--lang-name",
    "touba",
    "-q",
    ...triggerFixtures,
  ],
  { cwd: grammarRoot },
);

console.log(`trigger-parser: status=success checked=${triggerFixtures.length}`);

function run(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function sharedLibraryExtension() {
  if (process.platform === "darwin") return "dylib";
  if (process.platform === "win32") return "dll";
  return "so";
}
