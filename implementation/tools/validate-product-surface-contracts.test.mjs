import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { buildAirInputContract } from "../contracts/product-surfaces/input-contracts.mjs";
import { buildInteractionContract } from "../contracts/product-surfaces/interaction-contracts.mjs";
import {
  PRODUCT_SURFACE_CONTRACTS,
  PRODUCT_SURFACE_CONTRACTS_SCHEMA_VERSION,
  buildProductSurfaceContractsReport,
  validateObject,
} from "./validate-product-surface-contracts.mjs";

const contractsRoot = new URL("../contracts/product-surfaces/", import.meta.url);

test("canonical validation follows nested references and bounds values", () => {
  const schema = { type: "object", required: ["field"], additionalProperties: false,
    properties: { field: { $ref: "#/$defs/field" } },
    $defs: { field: { anyOf: [
      { type: "string", pattern: "^[0-9]+$", minLength: 2, maxLength: 4 },
      { type: "integer", minimum: 1, maximum: 3 },
    ] } } };
  for (const field of ["12", "1234", 1, 3]) assert.deepEqual(validateObject(schema, { field }), []);
  for (const field of ["a", "1", "12345", 0, 4, 1.5, null, {}]) assert.ok(validateObject(schema, { field }).length, JSON.stringify(field));
  assert.ok(validateObject(schema, {}).length);
  assert.ok(validateObject(schema, { field: 2, extra: true }).length);
  assert.ok(validateObject({ $ref: "#/absent" }, {}).length);
  assert.ok(validateObject({ type: "array", uniqueItems: true }, [{ a: 1, b: 2 }, { b: 2, a: 1 }]).length);
});

test("validates all product surface fixtures", () => {
  const files = readdirSync(new URL("schemas/", contractsRoot)).filter(name => name.endsWith(".schema.json"))
    .map(name => name.replace(/\.schema\.json$/u, "")).sort();
  assert.deepEqual([...PRODUCT_SURFACE_CONTRACTS].sort(), files, "every schema must be advertised and validated");
  const report = buildProductSurfaceContractsReport();

  assert.equal(report.schema_version, PRODUCT_SURFACE_CONTRACTS_SCHEMA_VERSION);
  assert.equal(report.status, "ok");
  assert.equal(report.summary.contract_count, PRODUCT_SURFACE_CONTRACTS.length);
  assert.equal(report.summary.fixture_count, PRODUCT_SURFACE_CONTRACTS.length);
  assert.deepEqual(report.diagnostics, []);
});

test("rejects an approval decision without request_id", () => {
  const schema = readJson("schemas/touba-approval-decision-v1.schema.json");
  const sample = readJson("fixtures/valid/touba-approval-decision-v1.json");
  delete sample.request_id;

  const diagnostics = validateObject(schema, sample);

  assert.equal(diagnostics.some((item) => item.code === "RequiredPropertyMissing"), true);
});

test("validates the exclusive alternatives of a published package plan", () => {
  const schema = readJson("schemas/touba-project-packages-v1.schema.json");
  const sample = readJson("fixtures/valid/touba-project-packages-v1.json");
  for (const host_plan of [
    null,
    { schema_version: "touba-package-host-plan-v1", package_lock_digest: `sha256:${"a".repeat(64)}`, hosts: {} },
  ]) {
    assert.deepEqual(validateObject(schema, { ...sample, host_plan }), []);
  }
  assert.ok(validateObject(schema, { ...sample, host_plan: "pending" }).some(item =>
    item.code === "OneOfMismatch" && item.path === "$.host_plan"));
  const overlapping = { oneOf: [{ type: "integer" }, { type: "number" }] };
  assert.equal(validateObject(overlapping, 2)[0].code, "OneOfMismatch");
  assert.deepEqual(validateObject(overlapping, 2.5), []);
});

test("honors property limits on nullable package preview records", () => {
  const schema = readJson("schemas/touba-project-package-preview-v2.schema.json");
  const before = schema.properties.contract_changes.items.properties.before;
  const atLimit = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`field${index}`, index]));
  assert.deepEqual(validateObject(before, null), []);
  assert.deepEqual(validateObject(before, atLimit), []);
  assert.deepEqual(validateObject(before, { ...atLimit, extra: 33 }).map(item => item.code),
    ["ObjectTooManyProperties"]);
});

test("rejects extra fields on product contracts", () => {
  const schema = readJson("schemas/touba-alert-v1.schema.json");
  const sample = readJson("fixtures/valid/touba-alert-v1.json");
  sample.internal_note = "must not cross the product boundary";

  const diagnostics = validateObject(schema, sample);

  assert.equal(diagnostics.some((item) => item.code === "AdditionalPropertyRejected"), true);
});

test("uses the explicit agent signature as its declared input contract", () => {
  const requestType = {
    id: "type:demo/Request",
    name: "Request",
    fields: [{ name: "goal", type_ref: "builtin:Text" }],
  };
  const signature = {
    inputs: [{ name: "request", type_ref: requestType.id }],
    output_type: "builtin:Text",
  };
  const agent = {
    id: "agent:demo/Coordinator",
    signature,
    uses: ["skill:demo/Plan", "tool:demo/Inspect"],
  };
  const contract = buildAirInputContract({
    air: {
      definitions: {
        agents: [agent],
        functions: [],
        skills: [{ id: "skill:demo/Plan", signature }],
        strategies: [],
        tools: [{ id: "tool:demo/Inspect", signature }],
        types: [requestType],
      },
    },
    definition: agent,
    kind: "agent",
  });

  assert.equal(contract.mode, "declared");
  assert.deepEqual(contract.fields, [
    { name: "request", type_ref: requestType.id, required: true },
  ]);
  assert.deepEqual(contract.types[0].fields, [
    { name: "goal", type_ref: "builtin:Text", required: true },
  ]);
});

test("keeps a historical agent input contract open without inferring from uses", () => {
  const agent = {
    id: "agent:demo/Coordinator",
    uses: ["skill:demo/Plan", "tool:demo/Inspect"],
  };
  const contract = buildAirInputContract({
    air: {
      definitions: {
        agents: [agent],
        functions: [],
        skills: [{
          id: "skill:demo/Plan",
          signature: {
            inputs: [{ name: "request", type_ref: "builtin:Text" }],
            output_type: "builtin:Text",
          },
        }],
        strategies: [],
        tools: [{
          id: "tool:demo/Inspect",
          signature: {
            inputs: [{ name: "artifact", type_ref: "builtin:Text" }],
            output_type: "builtin:Text",
          },
        }],
        types: [],
      },
    },
    definition: agent,
    kind: "agent",
  });

  assert.equal(contract.mode, "open");
  assert.deepEqual(contract.fields, []);
});

test("string length limits count Unicode code points", () => {
  const schema = { type: "string", minLength: 2, maxLength: 2 };
  assert.deepEqual(validateObject(schema, "A😀"), []);
  assert.deepEqual(validateObject(schema, "😀😀"), []);
  assert.deepEqual(validateObject(schema, "😀").map(item => item.code), ["StringTooShort"]);
  assert.deepEqual(validateObject(schema, "A😀😀").map(item => item.code), ["StringTooLong"]);
});

test("derives adaptive interaction profiles without inventing media support", () => {
  const contract = {
    mode: "declared",
    fields: [{ name: "request", type_ref: "type:demo/Request", required: true }],
    types: [{
      ref: "type:demo/Request",
      name: "Request",
      fields: [
        { name: "workflow_goal", type_ref: "builtin:Text", required: true },
        { name: "priority", type_ref: "builtin:Int", required: true },
      ],
    }],
  };

  assert.deepEqual(buildInteractionContract({ inputContract: contract, kind: "agent" }), {
    presentation: "conversation",
    primary_input_path: ["request", "workflow_goal"],
    context_paths: [["request"], ["request", "priority"]],
    accepted_content_kinds: ["text"],
    media_fields: [],
  });
});

test("accepts media only through canonical typed handles", () => {
  const contract = {
    mode: "declared",
    fields: [{ name: "image", type_ref: "type:demo/ImageHandle", required: true }],
    types: [{
      ref: "type:demo/ImageHandle",
      name: "ImageHandle",
      fields: [
        { name: "handle", type_ref: "builtin:Text", required: true },
        { name: "name", type_ref: "builtin:Text", required: true },
        { name: "media_type", type_ref: "builtin:Text", required: true },
        { name: "size_bytes", type_ref: "builtin:Int", required: true },
        { name: "digest", type_ref: "builtin:Text", required: true },
      ],
    }],
  };
  const profile = buildInteractionContract({ inputContract: contract, kind: "tool" });

  assert.deepEqual(profile.accepted_content_kinds, ["image"]);
  assert.deepEqual(profile.media_fields, [{
    path: ["image"],
    content_kind: "image",
    type_ref: "type:demo/ImageHandle",
    multiple: false,
  }]);
});

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, contractsRoot), "utf8"));
}

test("retains enum members through nested list and record input contracts", () => {
  const contract = buildAirInputContract({
    air: { definitions: { types: [
      { id: "type:orders/Priority", name: "Priority", fields: [], variants: [{ name: "low" }, { name: "high" }] },
      { id: "type:orders/Order", name: "Order", fields: [{ name: "priority", type_ref: "type:orders/Priority" }] },
    ] } },
    kind: "strategy",
    definition: { signature: { inputs: [
      { name: "orders", type_ref: "optional:list:optional:list:type:orders/Order" },
      { name: "priority", type_ref: "type:orders/Priority" },
    ] } },
  });
  assert.equal(contract.types.length, 2);
  assert.deepEqual(contract.types.find(type => type.name === "Priority"), {
    ref: "type:orders/Priority", name: "Priority", fields: [], enum_values: ["low", "high"],
  });
  assert.equal(contract.fields.every(field => field.required), true);
  const schema = readJson("schemas/touba-project-inspection-v1.schema.json");
  assert.deepEqual(validateObject({ ...schema.$defs.inputType, $defs: schema.$defs }, contract.types[1]), []);
});
