import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

test("validates all product surface fixtures", () => {
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
  return JSON.parse(readFileSync(join(contractsRoot.pathname, relativePath), "utf8"));
}
