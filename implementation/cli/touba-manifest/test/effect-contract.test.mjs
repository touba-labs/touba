import assert from "node:assert/strict";
import test from "node:test";

import {
  effectContractToJson,
  normalizeEffectContract,
  TOUBA_MANIFEST_V1,
  validateManifestEffectContracts,
} from "../src/effect-contract.mjs";

test("normalizes the bounded effect contract modes", () => {
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

test("one manifest contract covers pure calls and governed writes; old formats and drafts refuse", () => {
  for (const effectContract of [{ kind: "none" }, { kind: "external_write", retry_mode: "reconcile" }]) {
    const result = validateManifestEffectContracts(manifest({ version: TOUBA_MANIFEST_V1, effectContract }));
    assert.equal(result.effectContracts.size, 1);
  }
  for (const version of ["touba-manifest-v2", "touba-manifest-v3"]) {
    assert.throws(() => validateManifestEffectContracts(manifest({ version, effectContract: { kind: "none" } })), { code: "ManifestVersionUnsupported" });
  }
  assert.throws(() => validateManifestEffectContracts(manifest({ version: TOUBA_MANIFEST_V1 })), { code: "EffectContractMissing" });
  assert.throws(() => validateManifestEffectContracts(manifest({ version: TOUBA_MANIFEST_V1, effectContract: null })), { code: "EffectContractInvalid" });
});

test("normalizes compensation in the canonical manifest", () => {
  const compensation = {
    kind: "external_write",
    retry_mode: "idempotency_key",
    compensation: { entry_ref: "strategy:example/UndoWrite" },
  };
  const v3 = manifest({ version: TOUBA_MANIFEST_V1, effectContract: compensation });
  const normalized = validateManifestEffectContracts(v3).effectContracts.get("tool:example/Write");
  assert.deepEqual(normalized, {
    kind: "external_write",
    retryMode: "idempotency_key",
    compensation: { entryRef: "strategy:example/UndoWrite" },
  });
  assert.deepEqual(effectContractToJson(normalized), compensation);

});

test("rejects malformed compensation fail closed", () => {
  const cases = [
    [{ kind: "none", compensation: { entry_ref: "strategy:example/Undo" } }, "EffectCompensationForbidden"],
    [{ kind: "external_write", retry_mode: "none", compensation: null }, "EffectCompensationInvalid"],
    [{ kind: "external_write", retry_mode: "none", compensation: {} }, "EffectCompensationEntryRefInvalid"],
    [{ kind: "external_write", retry_mode: "none", compensation: { entry_ref: "Undo" } }, "EffectCompensationEntryRefInvalid"],
    [{ kind: "external_write", retry_mode: "none", compensation: { entry_ref: "strategy:example/Undo", vendor: true } }, "EffectCompensationFieldUnknown"],
  ];
  for (const [effectContract, code] of cases) {
    assert.throws(
      () => validateManifestEffectContracts(manifest({ version: TOUBA_MANIFEST_V1, effectContract })),
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
