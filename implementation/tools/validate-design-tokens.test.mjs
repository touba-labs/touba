import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
