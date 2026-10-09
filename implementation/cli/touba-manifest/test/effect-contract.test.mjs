import assert from "node:assert/strict";
import test from "node:test";

import {
  effectContractToJson,
  manifestVersionForExplicitEffectContracts,
  normalizeEffectContract,
  TOUBA_MANIFEST_V3,
  validateManifestEffectContracts,
} from "../src/effect-contract.mjs";

test("normalizes the bounded V2 effect contract modes", () => {
  assert.deepEqual(normalizeEffectContract({ kind: "none" }), { kind: "none" });
  assert.deepEqual(
    normalizeEffectContract({ kind: "external_write", retry_mode: "idempotency_key" }),
    { kind: "external_write", retryMode: "idempotency_key" },
  );
  assert.deepEqual(
    effectContractToJson({ kind: "external_write", retryMode: "reconcile" }),
    { kind: "external_write", retry_mode: "reconcile" },
  );
});

test("rejects unknown fields, kinds and retry modes fail closed", () => {
  const cases = [
    [{ kind: "none", retry_mode: "none" }, "EffectRetryModeForbidden"],
    [{ kind: "external_write" }, "EffectRetryModeRequired"],
    [{ kind: "external_write", retry_mode: "automatic" }, "EffectRetryModeUnsupported"],
    [{ kind: "read_only" }, "EffectContractKindUnsupported"],
    [{ kind: "none", vendor: "example" }, "EffectContractFieldUnknown"],
  ];
  for (const [contract, code] of cases) {
    assert.throws(
      () => normalizeEffectContract(contract),
      (error) => error.code === code,
      JSON.stringify(contract),
    );
  }
});

test("keeps V1 legacy and V2 strict without silent migration", () => {
  const legacy = manifest({ version: "touba-manifest-v1" });
  assert.equal(validateManifestEffectContracts(legacy).effectContracts.size, 0);

  legacy.bindings["tool:example/Write"].effect_contract = { kind: "none" };
  assert.throws(
    () => validateManifestEffectContracts(legacy),
    (error) => error.code === "EffectContractForbiddenInManifestV1",
  );

  const v2 = manifest({
    version: "touba-manifest-v2",
    effectContract: { kind: "external_write", retry_mode: "reconcile" },
  });
  assert.deepEqual(validateManifestEffectContracts(v2).effectContracts.get("tool:example/Write"), {
    kind: "external_write",
    retryMode: "reconcile",
  });

  delete v2.bindings["tool:example/Write"].effect_contract;
  assert.throws(
    () => validateManifestEffectContracts(v2),
    (error) => error.code === "EffectContractMissing",
  );
  assert.equal(validateManifestEffectContracts(manifest({
    version: TOUBA_MANIFEST_V3,
    effectContract: { kind: "external_write", retry_mode: "reconcile" },
  })).manifestVersion, TOUBA_MANIFEST_V3);
});

test("selects V2 only when every binding declares an explicit effect contract", () => {
  assert.equal(manifestVersionForExplicitEffectContracts({
    "tool:example/Read": binding(),
  }), "touba-manifest-v1");
  assert.equal(manifestVersionForExplicitEffectContracts({
    "tool:example/Read": binding({ kind: "none" }),
    "tool:example/Write": binding({ kind: "external_write", retry_mode: "idempotency_key" }),
  }), "touba-manifest-v2");
  assert.throws(
    () => manifestVersionForExplicitEffectContracts({
      "tool:example/Read": binding(),
      "tool:example/Write": binding({ kind: "external_write", retry_mode: "none" }),
    }),
    (error) => error.code === "EffectContractMissing"
      && error.details.tool_refs.includes("tool:example/Read"),
  );
});

test("normalizes V3 compensation without weakening V1 or V2", () => {
  const compensation = {
    kind: "external_write",
    retry_mode: "idempotency_key",
    compensation: { entry_ref: "strategy:example/UndoWrite" },
  };
  const v3 = manifest({ version: TOUBA_MANIFEST_V3, effectContract: compensation });
  const normalized = validateManifestEffectContracts(v3).effectContracts.get("tool:example/Write");
  assert.deepEqual(normalized, {
    kind: "external_write",
    retryMode: "idempotency_key",
    compensation: { entryRef: "strategy:example/UndoWrite" },
  });
  assert.deepEqual(effectContractToJson(normalized), compensation);
  assert.equal(manifestVersionForExplicitEffectContracts(v3.bindings), TOUBA_MANIFEST_V3);

  for (const version of ["touba-manifest-v1", "touba-manifest-v2"]) {
    assert.throws(
      () => validateManifestEffectContracts(manifest({ version, effectContract: compensation })),
      (error) => error.code === (version.endsWith("v1")
        ? "EffectContractForbiddenInManifestV1"
        : "EffectCompensationRequiresManifestV3"),
    );
  }
});

test("rejects malformed V3 compensation fail closed", () => {
  const cases = [
    [{ kind: "none", compensation: { entry_ref: "strategy:example/Undo" } }, "EffectCompensationForbidden"],
    [{ kind: "external_write", retry_mode: "none", compensation: null }, "EffectCompensationInvalid"],
    [{ kind: "external_write", retry_mode: "none", compensation: {} }, "EffectCompensationEntryRefInvalid"],
    [{ kind: "external_write", retry_mode: "none", compensation: { entry_ref: "Undo" } }, "EffectCompensationEntryRefInvalid"],
    [{ kind: "external_write", retry_mode: "none", compensation: { entry_ref: "strategy:example/Undo", vendor: true } }, "EffectCompensationFieldUnknown"],
  ];
  for (const [effectContract, code] of cases) {
    assert.throws(
      () => validateManifestEffectContracts(manifest({ version: TOUBA_MANIFEST_V3, effectContract })),
      (error) => error.code === code,
      code,
    );
  }
});

function manifest({ version, effectContract } = {}) {
  return {
    manifest_version: version,
    bindings: {
      "tool:example/Write": binding(effectContract),
    },
  };
}

function binding(effectContract) {
  return {
    handler: { kind: "process", command: "node", args: ["handler.mjs"] },
    grants: [],
    timeout_ms: 5000,
    max_payload_bytes: 1048576,
    ...(effectContract === undefined ? {} : { effect_contract: effectContract }),
  };
}
