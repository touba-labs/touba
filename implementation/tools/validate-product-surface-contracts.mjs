#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PRODUCT_SURFACE_CONTRACTS_SCHEMA_VERSION =
  "touba-product-surface-contracts-report-v0.1";

export const PRODUCT_SURFACE_CONTRACTS = Object.freeze([
  "touba-project-inspection-v1",
  "touba-project-refresh-request-v0.1",
  "touba-project-refresh-v0.1",
  "touba-project-change-proposal-v0.1",
  "touba-project-change-proposed-v0.1",
  "touba-project-change-apply-v0.1",
  "touba-project-change-result-v0.1",
  "touba-project-change-history-v0.1",
  "touba-project-change-detail-v0.1",
  "touba-project-event-stream-v0.1",
  "touba-project-event-v0.1",
  "touba-authority-graph-v0.1",
  "touba-product-identity-v0.1",
  "touba-run-summary-v1",
  "touba-sandbox-run-request-v0.1",
  "touba-sandbox-run-result-v0.1",
  "touba-trace-timeline-v1",
  "touba-trigger-status-v1",
  "touba-trigger-queue-health-v0.1",
  "touba-supply-chain-status-v0.1",
  "touba-governance-readiness-v0.1",
  "touba-cost-observatory-v0.1",
  "touba-handler-sandbox-status-v0.1",
  "touba-mobile-notification-v0.1",
  "touba-mobile-pairing-request-v0.1",
  "touba-mobile-quick-approval-policy-v0.1",
  "touba-mobile-escalation-v0.1",
  "touba-approval-request-v1",
  "touba-approval-decision-v1",
  "touba-human-review-request-v1",
  "touba-human-review-decision-v1",
  "touba-human-decision-history-v0.1",
  "touba-human-decision-detail-v0.1",
  "touba-registry-resource-v1",
  "touba-alert-v1",
]);

const __dir = dirname(fileURLToPath(import.meta.url));

export function buildProductSurfaceContractsReport(options = {}) {
  const implementationRoot = resolve(options.implementationRoot ?? join(__dir, ".."));
  const contractsRoot = resolve(
    options.contractsRoot ?? join(implementationRoot, "contracts", "product-surfaces"),
  );
  const diagnostics = [];

  for (const contract of PRODUCT_SURFACE_CONTRACTS) {
    const schemaPath = join(contractsRoot, "schemas", `${contract}.schema.json`);
    const fixturePath = join(contractsRoot, "fixtures", "valid", `${contract}.json`);
    const schema = readJson(schemaPath, diagnostics);
    const fixture = readJson(fixturePath, diagnostics);
    if (!schema || !fixture) {
      continue;
    }
    if (schema.title !== contract) {
      diagnostics.push(error("SchemaTitleMismatch", `${contract} schema title must match contract name`, schemaPath));
    }
    if (schema?.properties?.schema_version?.const !== contract) {
      diagnostics.push(error("SchemaVersionConstMissing", `${contract} must constrain schema_version`, schemaPath));
    }
    for (const item of validateObject(schema, fixture)) {
      diagnostics.push({ ...item, contract, file: fixturePath });
    }
  }

  return {
    schema_version: PRODUCT_SURFACE_CONTRACTS_SCHEMA_VERSION,
    status: diagnostics.some((item) => item.severity === "error") ? "failed" : "ok",
    diagnostics,
    summary: {
      contract_count: PRODUCT_SURFACE_CONTRACTS.length,
      fixture_count: PRODUCT_SURFACE_CONTRACTS.length,
      contracts_root: contractsRoot,
    },
  };
}

export function validateObject(schema, value, path = "$") {
  const diagnostics = [];
  validateSchemaNode(schema, value, path, diagnostics);
  return diagnostics;
}

function validateSchemaNode(schema, value, path, diagnostics) {
  if (!isObject(schema)) {
    diagnostics.push(error("SchemaNodeInvalid", `${path} schema node must be an object`, path));
    return;
  }
  if (Object.hasOwn(schema, "const") && value !== schema.const) {
    diagnostics.push(error("ConstMismatch", `${path} must be ${JSON.stringify(schema.const)}`, path));
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    diagnostics.push(error("EnumMismatch", `${path} must be one of ${schema.enum.join(", ")}`, path));
  }
  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    diagnostics.push(error("TypeMismatch", `${path} must be ${formatType(schema.type)}`, path));
    return;
  }
  if (schema.type === "object" || (schema.properties && isObject(value))) {
    validateObjectNode(schema, value, path, diagnostics);
  }
  if (schema.type === "array" || (schema.items && Array.isArray(value))) {
    validateArrayNode(schema, value, path, diagnostics);
  }
}

function validateObjectNode(schema, value, path, diagnostics) {
  if (!isObject(value)) {
    diagnostics.push(error("TypeMismatch", `${path} must be object`, path));
    return;
  }
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) {
      diagnostics.push(error("RequiredPropertyMissing", `${path}.${key} is required`, path));
    }
  }
  const properties = schema.properties ?? {};
  for (const [key, item] of Object.entries(value)) {
    if (Object.hasOwn(properties, key)) {
      validateSchemaNode(properties[key], item, `${path}.${key}`, diagnostics);
    } else if (schema.additionalProperties === false) {
      diagnostics.push(error("AdditionalPropertyRejected", `${path}.${key} is not allowed`, path));
    }
  }
}

function validateArrayNode(schema, value, path, diagnostics) {
  if (!Array.isArray(value)) {
    diagnostics.push(error("TypeMismatch", `${path} must be array`, path));
    return;
  }
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    diagnostics.push(error("ArrayTooShort", `${path} must contain at least ${schema.minItems} item(s)`, path));
  }
  if (schema.items) {
    for (const [index, item] of value.entries()) {
      validateSchemaNode(schema.items, item, `${path}[${index}]`, diagnostics);
    }
  }
}

function readJson(path, diagnostics) {
  if (!existsSync(path)) {
    diagnostics.push(error("FileMissing", `${path} is missing`, path));
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    diagnostics.push(error("JsonInvalid", `${path} is not valid JSON: ${cause.message}`, path));
    return null;
  }
}

function matchesType(value, expected) {
  const expectedTypes = Array.isArray(expected) ? expected : [expected];
  return expectedTypes.some((type) => {
    if (type === "array") {
      return Array.isArray(value);
    }
    if (type === "integer") {
      return Number.isInteger(value);
    }
    if (type === "number") {
      return typeof value === "number" && Number.isFinite(value);
    }
    if (type === "null") {
      return value === null;
    }
    if (type === "object") {
      return isObject(value);
    }
    return typeof value === type;
  });
}

function formatType(type) {
  return Array.isArray(type) ? type.join(" or ") : type;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function error(code, message, path) {
  return { severity: "error", code, message, path };
}

function main() {
  const report = buildProductSurfaceContractsReport();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "ok") {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
