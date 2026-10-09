#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const docsRoot = resolve(__dir, "../../docs");

const forbidden = [
  { pattern: /touba\/implementation/, reason: "chemin interne implementation" },
  { pattern: /touba\/specifications/, reason: "chemin de specification interne" },
  { pattern: /touba\/validation/, reason: "chemin de validation interne" },
  { pattern: /grammar\/tree-sitter/, reason: "chemin de fixture parser interne" },
  { pattern: /tests\/tool-binding/, reason: "chemin de test interne" },
  { pattern: /\bfixture(s)?\b/i, reason: "vocabulaire de test interne" },
  { pattern: /pnpm\s+validate:/, reason: "script de validation interne" },
  { pattern: /\bvalidate:[a-z0-9:-]+/i, reason: "script de validation interne" },
  { pattern: /cargo\s+run\s+-p/, reason: "commande de monorepo interne" },
  { pattern: /node\s+cli\//, reason: "commande de chemin interne" },
  { pattern: /\/Users\//, reason: "chemin machine local" },
  { pattern: /\bd[ée]p[ôo]t\b/i, reason: "vocabulaire de depot interne" },
  { pattern: /monorepo/i, reason: "vocabulaire de depot interne" },
  { pattern: /organisation interne/i, reason: "mention de structure interne" },
  { pattern: /chemins internes/i, reason: "mention de chemins internes" },
  { pattern: /d[ée]tails de maintenance/i, reason: "mention de maintenance interne" },
];

const failures = [];

for (const file of walkMarkdown(docsRoot)) {
  const content = readFileSync(file, "utf8");
  const lines = content.split(/\r?\n/);
  let codeFence = null;
  for (const [index, line] of lines.entries()) {
    const fence = line.match(/^```([^\s]*)?(?:\s+title="([^"]+)")?/);
    if (fence) {
      if (codeFence === null) {
        codeFence = { language: fence[1] ?? "", title: fence[2] ?? "" };
      } else {
        codeFence = null;
      }
      continue;
    }
    for (const rule of forbidden) {
      if (rule.pattern.test(line)) {
        failures.push({
          file: relative(resolve(__dir, "../.."), file),
          line: index + 1,
          reason: rule.reason,
          text: line.trim(),
        });
      }
    }
    if (codeFence?.title === "touba.manifest.json" && /"memory_ref"\s*:/.test(line)) {
      failures.push({
        file: relative(resolve(__dir, "../.."), file),
        line: index + 1,
        reason: "manifest public avec champ memoire AIR/trace",
        text: line.trim(),
      });
    }
  }
}

if (failures.length > 0) {
  process.stderr.write("docs-public-boundary: status=failure\n");
  for (const failure of failures) {
    process.stderr.write(
      `${failure.file}:${failure.line}: ${failure.reason}: ${failure.text}\n`,
    );
  }
  process.exit(1);
}

process.stdout.write("docs-public-boundary: status=success\n");

function* walkMarkdown(root) {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      yield* walkMarkdown(path);
    } else if (entry.endsWith(".md") || entry.endsWith(".mdx")) {
      yield path;
    }
  }
}
