import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DESIGN_TOKENS_REPORT_SCHEMA_VERSION,
  buildDesignTokensReport,
} from "./validate-design-tokens.mjs";

const tokensUrl = new URL("../contracts/design/touba-design-tokens-v1.json", import.meta.url);

test("validates the Touba design token contract", () => {
  const report = buildDesignTokensReport();

  assert.equal(report.schema_version, DESIGN_TOKENS_REPORT_SCHEMA_VERSION);
  assert.equal(report.status, "ok");
  assert.deepEqual(report.diagnostics, []);
  assert.deepEqual(report.summary.themes, ["light", "dark"]);
});

test("keeps the white token explicit in palette and themes", () => {
  const tokens = JSON.parse(readFileSync(tokensUrl, "utf8"));

  assert.equal(tokens.palette.white, "#ffffff");
  assert.equal(tokens.semantic.light.white, "#ffffff");
  assert.equal(tokens.semantic.dark.white, "#ffffff");
  assert.equal(tokens.semantic.light.background, "#ffffff");
  assert.equal(tokens.semantic.light.surface, "#ffffff");
});

test("detects a different color or radius for a present CSS variable", t => {
  const designRoot = mkdtempSync(join(tmpdir(), "touba-design-tokens-"));
  t.after(() => rmSync(designRoot, { recursive: true, force: true }));
  copyFileSync(tokensUrl, join(designRoot, "touba-design-tokens-v1.json"));
  const css = readFileSync(new URL("../contracts/design/touba-design-tokens-v1.css", import.meta.url), "utf8");
  writeFileSync(join(designRoot, "touba-design-tokens-v1.css"), css
    .replace("--touba-background: #ffffff", "--touba-background: #f6f8fb")
    .replace("--touba-radius-control: 6px", "--touba-radius-control: 7px"));

  const report = buildDesignTokensReport({ designRoot });
  assert.equal(report.status, "failed");
  const mismatches = report.diagnostics.filter(item => item.code === "CssTokenMismatch");
  assert.ok(mismatches.some(item => item.message === ":root --touba-background must equal #ffffff"));
  assert.ok(mismatches.some(item => item.message === ".touba-theme-light --touba-radius-control must equal 6px"));
});
