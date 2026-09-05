#!/usr/bin/env node

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const implementationRoot = resolve(__dir, "..");
const toubaRoot = resolve(implementationRoot, "..");
const repoRoot = resolve(toubaRoot, "..");
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

export function validateRepositoryReferences(content, docPath, root = repoRoot) {
  const diagnostics = [];
  const pattern = /`((?:pap|touba|pilotage|publications|ide|livre)\/[A-Za-z0-9._\/-]+)`/g;
  for (const match of content.matchAll(pattern)) {
    if (!existsAsDocumentTarget(resolve(root, match[1]))) {
      diagnostics.push(`${docPath}: broken repository reference ${match[1]}`);
    }
  }
  return diagnostics;
}

export function publicDocumentationPaths(root = repoRoot) {
  const paths = ["touba/README.md", "pap/README.md"];
  const docsRoot = resolve(root, "touba/docs");
  for (const path of walkMarkdown(docsRoot)) {
    paths.push(relative(root, path));
  }
  const papRoot = resolve(root, "pap");
  for (const path of walkMarkdown(papRoot)) {
    paths.push(relative(root, path));
  }
  return [...new Set(paths)].sort();
}

export function proofStatusFromSources(root = repoRoot) {
  const live = readJson(resolve(
    root,
    "publications/artefacts/pap-touba-v1/benchmarks/pap002-live-model-benchmark/live-model-report.json",
  ));
  const structural = readJson(resolve(
    root,
    "publications/artefacts/pap-touba-v1/benchmarks/pap002-live-model-benchmark/runs/reverify-structural/structural-evidence-report.json",
  ));
  const liveCases = live.aggregate?.find((item) => item.id === "touba-openai-decision-provider-direct-catalog")?.cases;
  const structuralCases = structural.aggregate?.cases
    ?? structural.summary?.cases
    ?? (Array.isArray(structural.cases) ? structural.cases.length : structural.cases);
  if (!Number.isSafeInteger(liveCases) || !Number.isSafeInteger(structuralCases)) {
    throw new Error("benchmark proof sources do not expose integer case counts");
  }
  return {
    schema_version: "touba-documentation-proof-status-v1",
    sources: {
      live_model_report: "publications/artefacts/pap-touba-v1/benchmarks/pap002-live-model-benchmark/live-model-report.json",
      structural_evidence_report: "publications/artefacts/pap-touba-v1/benchmarks/pap002-live-model-benchmark/runs/reverify-structural/structural-evidence-report.json",
    },
    benchmarks: {
      live_model_cases: liveCases,
      structural_cases: structuralCases,
    },
  };
}

export function validatePublishedProofCounts(contentByPath, proofStatus) {
  const diagnostics = [];
  const live = proofStatus.benchmarks.live_model_cases;
  const structural = proofStatus.benchmarks.structural_cases;
  for (const docPath of ["touba/README.md", "pap/README.md"]) {
    const content = contentByPath.get(docPath);
    if (content === undefined) {
      diagnostics.push(`${docPath}: public proof document missing`);
      continue;
    }
    if (!content.includes(`${live} cases`)) {
      diagnostics.push(`${docPath}: live-model case count must match machine source (${live})`);
    }
    if (!content.includes(`${structural} `) && !content.includes(`${structural} cases`)) {
      diagnostics.push(`${docPath}: structural case count must match machine source (${structural})`);
    }
  }
  return diagnostics;
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
    if (docPath.startsWith("pap/")) {
      diagnostics.push(...validateRepositoryReferences(content, docPath, root));
    }
  }

  const tempRoot = mkdtempSync(join(tmpdir(), "touba-doc-examples-"));
  let compiled = 0;
  try {
    for (const [index, example] of examples.entries()) {
      if (example.marker !== "compile") continue;
      const sourcePath = join(tempRoot, `${String(index).padStart(4, "0")}-${safeName(basename(example.docPath))}.tb`);
      writeFileSync(sourcePath, example.source, "utf8");
      const result = spawnSync(
        cargo,
        ["run", "-p", "touba-cli", "--bin", "touba-compile", "--quiet", "--", sourcePath],
        { cwd: resolve(root, "touba/implementation"), encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
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

  const proofStatus = proofStatusFromSources(root);
  diagnostics.push(...validatePublishedProofCounts(contentByPath, proofStatus));
  const summary = {
    documents_checked: contentByPath.size,
    examples_checked: examples.length,
    compiled,
    fragments: examples.filter((example) => example.marker === "fragment").length,
  };

  if (diagnostics.length > 0) {
    throw new Error(`documentation validation failed (${diagnostics.length}):\n- ${diagnostics.join("\n- ")}`);
  }
  return { summary, proofStatus };
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

function walkMarkdown(root) {
  const paths = [];
  if (!existsSync(root)) return paths;
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) paths.push(...walkMarkdown(path));
    else if (extname(path) === ".md") paths.push(path);
  }
  return paths;
}

function existsAsDocumentTarget(path) {
  return existsSync(path) || existsSync(`${path}.md`) || existsSync(join(path, "README.md"));
}

function readJson(path) {
  if (!existsSync(path)) throw new Error(`proof source missing: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
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
    process.stdout.write(`docs-proof-status: ${JSON.stringify(result.proofStatus)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
