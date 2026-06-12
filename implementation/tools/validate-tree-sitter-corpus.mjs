#!/usr/bin/env node
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dir = dirname(fileURLToPath(import.meta.url));
const implementationRoot = resolve(__dir, "..");
const grammarRoot = join(implementationRoot, "grammar/tree-sitter-touba");
const examplesRoot = join(grammarRoot, "examples");
const treeSitterBin = join(implementationRoot, "node_modules/.bin/tree-sitter");
const buildDir = mkdtempSync(join(tmpdir(), "touba-tree-sitter-"));
const libPath = join(buildDir, `tree-sitter-touba.${sharedLibraryExtension()}`);

const fixtures = listTbFixtures(examplesRoot)
  .map((file) => relative(grammarRoot, file))
  .filter((file) => !file.includes("/negative/syntax/"))
  .sort();

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
    ...fixtures,
  ],
  { cwd: grammarRoot },
);

console.log(`tree-sitter-corpus: status=success checked=${fixtures.length}`);

function listTbFixtures(root) {
  const fixtures = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      fixtures.push(...listTbFixtures(path));
    } else if (entry.endsWith(".tb")) {
      fixtures.push(path);
    }
  }
  return fixtures;
}

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
