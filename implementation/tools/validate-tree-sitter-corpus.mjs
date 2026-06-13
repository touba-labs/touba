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
const treeSitterBin = join(
  implementationRoot,
  process.platform === "win32" ? "node_modules/.bin/tree-sitter.cmd" : "node_modules/.bin/tree-sitter",
);
const buildDir = mkdtempSync(join(tmpdir(), "touba-tree-sitter-"));
const libPath = join(buildDir, `tree-sitter-touba.${sharedLibraryExtension()}`);

const fixtures = listTbFixtures(examplesRoot)
  .map((file) => relative(grammarRoot, file))
  .filter((file) => !file.replaceAll("\\", "/").includes("/negative/syntax/"))
  .sort();

run(treeSitterBin, ["generate"], { cwd: grammarRoot });
run(cCompiler(), cCompilerArgs(libPath), { cwd: grammarRoot });
for (const fixtureChunk of chunks(fixtures, 40)) {
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
      ...fixtureChunk,
    ],
    { cwd: grammarRoot },
  );
}

console.log(`tree-sitter-corpus: status=success checked=${fixtures.length}`);

function* chunks(values, size) {
  for (let index = 0; index < values.length; index += size) {
    yield values.slice(index, index + size);
  }
}

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
    shell: process.platform === "win32" && command.endsWith(".cmd"),
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

function cCompiler() {
  if (process.platform === "win32") return "clang";
  return "cc";
}

function cCompilerArgs(outputPath) {
  if (process.platform === "win32") {
    return ["-shared", "-I./src", "src/parser.c", "src/scanner.c", "-o", outputPath];
  }
  return ["-fPIC", "-I./src", "-shared", "src/parser.c", "src/scanner.c", "-o", outputPath];
}
