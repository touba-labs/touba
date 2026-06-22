#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DESIGN_TOKENS_REPORT_SCHEMA_VERSION = "touba-design-tokens-report-v0.1";
export const DESIGN_TOKENS_SCHEMA_VERSION = "touba-design-tokens-v1";

const REQUIRED_PALETTE = Object.freeze([
  "blue",
  "blue_dark",
  "blue_darker",
  "ink",
  "black",
  "white",
  "teal",
  "teal_soft",
  "gold",
  "gold_soft",
  "red",
  "red_soft",
  "gray_50",
  "gray_100",
  "gray_200",
  "gray_300",
  "gray_600",
  "gray_800",
]);

const REQUIRED_SEMANTIC = Object.freeze([
  "background",
  "surface",
  "surface_muted",
  "surface_raised",
  "text",
  "text_muted",
  "border",
  "border_soft",
  "primary",
  "primary_hover",
  "primary_text",
  "secondary",
  "secondary_text",
  "focus",
  "success",
  "success_soft",
  "warning",
  "warning_soft",
  "danger",
  "danger_soft",
  "neutral",
  "white",
]);

const HEX_COLOR = /^#[0-9a-f]{6}$/;
const __dir = dirname(fileURLToPath(import.meta.url));

export function buildDesignTokensReport(options = {}) {
  const implementationRoot = resolve(options.implementationRoot ?? join(__dir, ".."));
  const designRoot = resolve(options.designRoot ?? join(implementationRoot, "contracts", "design"));
  const jsonPath = join(designRoot, "touba-design-tokens-v1.json");
  const cssPath = join(designRoot, "touba-design-tokens-v1.css");
  const diagnostics = [];
  const tokens = readJson(jsonPath, diagnostics);
  const css = existsSync(cssPath) ? readFileSync(cssPath, "utf8") : null;

  if (!css) {
    diagnostics.push(error("CssExportMissing", "touba-design-tokens-v1.css is required", cssPath));
  }
  if (tokens) {
    validateTokens(tokens, diagnostics, jsonPath);
    if (css) {
      validateCssExport(tokens, css, diagnostics, cssPath);
    }
  }

  return {
    schema_version: DESIGN_TOKENS_REPORT_SCHEMA_VERSION,
    status: diagnostics.some((item) => item.severity === "error") ? "failed" : "ok",
    diagnostics,
    summary: {
      schema_version: tokens?.schema_version ?? "unknown",
      palette_count: tokens?.palette ? Object.keys(tokens.palette).length : 0,
      themes: Array.isArray(tokens?.themes) ? tokens.themes : [],
    },
  };
}

function validateTokens(tokens, diagnostics, path) {
  if (!isObject(tokens)) {
    diagnostics.push(error("TokensInvalid", "design tokens must be a JSON object", path));
    return;
  }
  if (tokens.schema_version !== DESIGN_TOKENS_SCHEMA_VERSION) {
    diagnostics.push(error("SchemaVersionMismatch", `schema_version must be ${DESIGN_TOKENS_SCHEMA_VERSION}`, path));
  }
  if (!Array.isArray(tokens.themes) || !tokens.themes.includes("light") || !tokens.themes.includes("dark")) {
    diagnostics.push(error("ThemesMissing", "themes must include light and dark", path));
  }
  validateColorMap(tokens.palette, REQUIRED_PALETTE, "palette", diagnostics, path);
  if (tokens?.palette?.white !== "#ffffff") {
    diagnostics.push(error("WhiteTokenInvalid", "palette.white must be #ffffff", path));
  }
  for (const theme of ["light", "dark"]) {
    validateColorMap(tokens?.semantic?.[theme], REQUIRED_SEMANTIC, `semantic.${theme}`, diagnostics, path);
    if (tokens?.semantic?.[theme]?.white !== "#ffffff") {
      diagnostics.push(error("ThemeWhiteTokenInvalid", `semantic.${theme}.white must be #ffffff`, path));
    }
  }
  if (tokens?.semantic?.light?.background !== "#ffffff" || tokens?.semantic?.light?.surface !== "#ffffff") {
    diagnostics.push(error("LightThemeWhiteSurfaceRequired", "light theme background and surface must be #ffffff", path));
  }
  validateRadii(tokens.radii, diagnostics, path);
}

function validateColorMap(value, requiredKeys, label, diagnostics, path) {
  if (!isObject(value)) {
    diagnostics.push(error("ColorMapInvalid", `${label} must be an object`, path));
    return;
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) {
      diagnostics.push(error("TokenMissing", `${label}.${key} is required`, path));
      continue;
    }
    if (typeof value[key] !== "string" || !HEX_COLOR.test(value[key])) {
      diagnostics.push(error("TokenColorInvalid", `${label}.${key} must be a lowercase six-digit hex color`, path));
    }
  }
}

function validateRadii(radii, diagnostics, path) {
  if (!isObject(radii)) {
    diagnostics.push(error("RadiiInvalid", "radii must be an object", path));
    return;
  }
  for (const key of ["control", "card", "panel"]) {
    if (!Number.isInteger(radii[key]) || radii[key] < 0 || radii[key] > 8) {
      diagnostics.push(error("RadiusInvalid", `radii.${key} must be an integer from 0 to 8`, path));
    }
  }
}

function validateCssExport(tokens, css, diagnostics, path) {
  for (const key of REQUIRED_PALETTE) {
    const variable = `--touba-${key.replaceAll("_", "-")}:`;
    if (!css.includes(variable)) {
      diagnostics.push(error("CssPaletteTokenMissing", `${variable} is missing from CSS export`, path));
    }
  }
  for (const key of REQUIRED_SEMANTIC) {
    const variable = key === "white" ? "--touba-white:" : `--touba-${key.replaceAll("_", "-")}:`;
    if (!css.includes(variable)) {
      diagnostics.push(error("CssSemanticTokenMissing", `${variable} is missing from CSS export`, path));
    }
  }
  if (!css.includes(".touba-theme-light") || !css.includes(".touba-theme-dark")) {
    diagnostics.push(error("CssThemeSelectorMissing", "CSS export must include .touba-theme-light and .touba-theme-dark", path));
  }
  if (!css.includes('[data-theme="dark"]')) {
    diagnostics.push(error("CssDarkDataThemeMissing", "CSS export must include [data-theme=\"dark\"]", path));
  }
  if (!css.includes(tokens.palette.white)) {
    diagnostics.push(error("CssWhiteMissing", "CSS export must include #ffffff", path));
  }
}

function readJson(path, diagnostics) {
  if (!existsSync(path)) {
    diagnostics.push(error("JsonMissing", `${path} is missing`, path));
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    diagnostics.push(error("JsonInvalid", `${path} is not valid JSON: ${cause.message}`, path));
    return null;
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function error(code, message, path) {
  return { severity: "error", code, message, path };
}

function main() {
  const report = buildDesignTokensReport();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "ok") {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
