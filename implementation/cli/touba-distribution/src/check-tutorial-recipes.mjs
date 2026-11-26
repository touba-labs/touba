#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDocumentRecipe } from "./tutorial-recipe.mjs";

const implementationRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
let roots = [
  ["fr", resolve(implementationRoot, "../docs/tutoriels")],
];
let toolchain;
let locale;
let docsRoot;
const selected = [];
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  if (flag === "--toolchain" && process.argv[index + 1]) toolchain = resolve(process.argv[++index]);
  else if (flag === "--locale" && process.argv[index + 1]) locale = process.argv[++index];
  else if (flag === "--docs-root" && process.argv[index + 1]) docsRoot = resolve(process.argv[++index]);
  else if (flag === "--document" && process.argv[index + 1]) selected.push(process.argv[++index]);
  else throw new Error("Usage: check-tutorial-recipes.mjs --toolchain <installed-root> [--locale fr|en [--docs-root <tutorials-directory>]] [--document <name.md>]");
}
if (locale && !["fr", "en"].includes(locale)) throw new Error("Locale must be fr or en");
if (docsRoot && !locale) throw new Error("An explicit docs root requires an explicit locale");
if (locale === "en" && !docsRoot) throw new Error("English recipes require --docs-root <tutorials-directory>");
if (locale) roots = docsRoot ? [[locale, docsRoot]] : roots.filter(([name]) => name === locale);
if (!toolchain || !existsSync(join(toolchain, "TOOLCHAIN.json"))) throw new Error("An installed or packaged Touba toolchain is required");
const documents = readdirSync(roots[0][1]).filter(name => name.endsWith(".md") && name !== "README.md").sort();
for (const name of selected) if (!documents.includes(name)) throw new Error(`Unknown tutorial: ${name}`);
const workspace = mkdtempSync(join(tmpdir(), "touba published recipes "));
const results = [];
try {
  for (const [locale, directory] of roots) {
    for (const name of selected.length ? selected : documents) {
      const root = join(workspace, locale, name.slice(0, -3));
      mkdirSync(root, { recursive: true });
      const env = { ...process.env, PATH: `${join(toolchain, "bin")}${delimiter}${process.env.PATH ?? ""}`,
        npm_config_cache: join(root, "empty npm cache") };
      for (const key of ["NODE_PATH", "TOUBA_IMPLEMENTATION_DIR", "TOUBA_COMPILE_BIN"]) delete env[key];
      try {
        const recipe = runDocumentRecipe(join(directory, name), root, env);
        if (!recipe.files || !recipe.commands) throw new Error("A complete tutorial must provide files and executable commands");
        results.push({ locale, document: name, status: "passed", commands: recipe.commands, files: recipe.files });
        console.log(`PASS ${locale}/${name} commands=${recipe.commands} files=${recipe.files}`);
      } catch (error) {
        results.push({ locale, document: name, status: "failed", error: error.message });
        console.error(`FAIL ${locale}/${name}\n${error.message}`);
      }
    }
  }
  const failures = results.filter(result => result.status === "failed");
  console.log(JSON.stringify({ scope: selected.length ? "selected" : "all", locales: roots.map(([name]) => name), tutorials: results.length,
    passed: results.length - failures.length, failed: failures.length, retained_workspace: failures.length ? workspace : null }));
  if (failures.length) process.exitCode = 1;
} finally {
  if (process.exitCode !== 1) rmSync(workspace, { recursive: true, force: true });
}
