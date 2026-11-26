#!/usr/bin/env node

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const implementationRoot = resolve(__dir, "..");
const toubaRoot = resolve(implementationRoot, "..");
const repoRoot = toubaRoot;
const MARKER_PATTERN = /^<!-- touba-example: (compile|fragment) -->$/;

export function extractToubaExamples(content, docPath = "document.md") {
  const lines = content.split(/\r?\n/);
  const examples = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^```touba(?:\s|$)/.test(lines[index])) continue;
    const startLine = index + 1;
    let end = index + 1;
    while (end < lines.length && !/^```\s*$/.test(lines[end])) end += 1;
    if (end >= lines.length) {
      throw new Error(`${docPath}:${startLine}: unclosed Touba code fence`);
    }
    const previous = lastNonEmptyLine(lines, index);
    const marker = previous?.match(MARKER_PATTERN)?.[1];
    examples.push({
      docPath,
      startLine,
      marker,
      source: `${lines.slice(index + 1, end).join("\n")}\n`,
    });
    index = end;
  }
  return examples;
}

// Dependencies come only from complete blocks on the same published page.
// No repository fixture or inferred declaration may repair an incomplete recipe.
export function exampleModuleDependencies(example, examples) {
  const selected = new Map();
  const entryModule = example.source.match(/^module\s+(\S+)/m)?.[1];
  const visit = current => {
    for (const match of current.source.matchAll(/^import\s+\w+\s+\w+\s+from\s+(\S+)\s*$/gm)) {
      const module = match[1];
      if (module === entryModule || selected.has(module)) continue;
      const candidates = examples.filter(other => other.docPath === example.docPath
        && other.marker === "compile" && other.source.match(/^module\s+(\S+)/m)?.[1] === module);
      const sources = [...new Set(candidates.map(other => other.source))];
      if (sources.length > 1) throw new Error(
        `${example.docPath}: ambiguous published dependency ${module}; give the example one complete definition`);
      if (candidates.length === 0) continue; // The real compiler diagnoses the missing import.
      selected.set(module, candidates[0]);
      visit(candidates[0]);
    }
  };
  visit(example);
  return [...selected.values()];
}

export function validateExampleMetadata(example) {
  const diagnostics = [];
  if (example.marker === undefined) {
    diagnostics.push(`${example.docPath}:${example.startLine}: Touba block must be marked with <!-- touba-example: compile|fragment -->`);
    return diagnostics;
  }
  if (example.source.trim() === "") {
    diagnostics.push(`${example.docPath}:${example.startLine}: empty Touba block`);
  }
  if (example.marker === "compile" && !/^module\s+[a-z][a-z0-9_.]*\s*$/m.test(example.source)) {
    diagnostics.push(`${example.docPath}:${example.startLine}: compiled Touba block must declare its module`);
  }
  for (const agent of agentBlocks(example.source)) {
    const responsibilities = agent.body.filter((line) => /^\s+responsibility\s+"/.test(line));
    if (responsibilities.length !== 1) {
      diagnostics.push(`${example.docPath}:${example.startLine + agent.line}: agent ${agent.name} must show exactly one responsibility`);
    }
  }
  return diagnostics;
}

export function validateRelativeMarkdownLinks(content, docPath, root = repoRoot) {
  const diagnostics = [];
  const pattern = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of content.matchAll(pattern)) {
    const target = match[1].trim().split("#")[0];
    if (!target || /^(?:https?:|mailto:|#|\/)/.test(target)) continue;
    const resolved = resolve(dirname(resolve(root, docPath)), target);
    if (!existsAsDocumentTarget(resolved)) {
      diagnostics.push(`${docPath}: broken relative link ${match[1]}`);
    }
  }
  return diagnostics;
}

export function publicDocumentationPaths(root = repoRoot) {
  const manifest = JSON.parse(readFileSync(resolve(root, "implementation/tools/documentation-sources.json"), "utf8"));
  if (!Array.isArray(manifest.documents) || manifest.documents.length === 0
    || new Set(manifest.documents).size !== manifest.documents.length
    || manifest.documents.some(path => typeof path !== "string" || path.startsWith("/") || path.split("/").includes(".."))) {
    throw new Error("documentation sources must be a non-empty, unique list of relative paths");
  }
  return [...manifest.documents].sort();
}

export function runDocumentationValidation(options = {}) {
  const root = options.root ?? repoRoot;
  const cargo = options.cargo ?? process.env.CARGO ?? "cargo";
  const docPaths = options.docPaths ?? publicDocumentationPaths(root);
  const contentByPath = new Map();
  const examples = [];
  const diagnostics = [];

  for (const docPath of docPaths) {
    const absolute = resolve(root, docPath);
    if (!existsSync(absolute)) {
      diagnostics.push(`${docPath}: document missing`);
      continue;
    }
    const content = readFileSync(absolute, "utf8");
    contentByPath.set(docPath, content);
    try {
      const extracted = extractToubaExamples(content, docPath);
      examples.push(...extracted);
      for (const example of extracted) diagnostics.push(...validateExampleMetadata(example));
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
    }
    diagnostics.push(...validateRelativeMarkdownLinks(content, docPath, root));

  }

  const tempRoot = mkdtempSync(join(tmpdir(), "touba-doc-examples-"));
  let compiled = 0;
  try {
    for (const [index, example] of examples.entries()) {
      if (example.marker !== "compile") continue;
      const sourcePath = join(tempRoot, `${String(index).padStart(4, "0")}-${safeName(basename(example.docPath))}.tb`);
      writeFileSync(sourcePath, example.source, "utf8");
      let dependencies;
      try { dependencies = exampleModuleDependencies(example, examples); }
      catch (error) { diagnostics.push(error.message); continue; }
      const dependencyArgs = dependencies.flatMap((dependency, dependencyIndex) => {
        const path = join(tempRoot, `dependency-${index}-${dependencyIndex}.tb`);
        writeFileSync(path, dependency.source, "utf8");
        return ["--module-source", path];
      });
      const result = spawnSync(
        cargo,
        ["run", "-p", "touba-cli", "--bin", "touba-compile", "--quiet", "--", sourcePath, ...dependencyArgs],
        { cwd: options.implementationRoot ?? resolve(root, "implementation"), encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      );
      if (result.status !== 0) {
        diagnostics.push(`${example.docPath}:${example.startLine}: displayed Touba block does not compile: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
        continue;
      }
      try {
        const air = JSON.parse(result.stdout);
        if (air.air_schema_version !== "touba-air-v1") throw new Error("unexpected AIR schema version");
        compiled += 1;
      } catch (error) {
        diagnostics.push(`${example.docPath}:${example.startLine}: compiler output invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }

  const summary = {
    documents_checked: contentByPath.size,
    examples_checked: examples.length,
    compiled,
    fragments: examples.filter((example) => example.marker === "fragment").length,
  };

  if (diagnostics.length > 0) {
    throw new Error(`documentation validation failed (${diagnostics.length}):\n- ${diagnostics.join("\n- ")}`);
  }
  return { summary };
}

function lastNonEmptyLine(lines, before) {
  for (let index = before - 1; index >= 0; index -= 1) {
    if (lines[index].trim() !== "") return lines[index].trim();
  }
  return undefined;
}

function agentBlocks(source) {
  const lines = source.split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^agent\s+([A-Z][A-Za-z0-9_]*)\s*$/);
    if (!match) continue;
    const body = [];
    let cursor = index + 1;
    while (cursor < lines.length && (lines[cursor].startsWith("    ") || lines[cursor].trim() === "")) {
      body.push(lines[cursor]);
      cursor += 1;
    }
    blocks.push({ name: match[1], line: index, body });
  }
  return blocks;
}

function existsAsDocumentTarget(path) {
  return existsSync(path) || existsSync(`${path}.md`) || existsSync(join(path, "README.md"));
}

function safeName(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

const isMain = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const result = runDocumentationValidation();
    process.stdout.write(
      `docs-examples: status=success documents=${result.summary.documents_checked} checked=${result.summary.examples_checked} compiled=${result.summary.compiled} fragments=${result.summary.fragments}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
