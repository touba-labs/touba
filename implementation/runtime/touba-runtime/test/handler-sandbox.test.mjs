import assert from "node:assert/strict";
import test from "node:test";

import { buildHandlerSandboxPlan } from "../src/handler-protocol.mjs";
import {
  ToubaRuntimeError,
  loadToolBindingManifestFromJson,
} from "../src/index.mjs";

const binding = Object.freeze({
  handler: Object.freeze({
    kind: "process",
    command: "node",
    args: Object.freeze(["handler.mjs"]),
    cwd: "/workspace/project",
  }),
  grants: Object.freeze(["filesystem_read"]),
  limits: Object.freeze({
    timeout_ms: 1000,
    max_payload_bytes: 4096,
  }),
  sandbox: Object.freeze({
    required: true,
    profile: "default",
    box_name: "ToubaHandler",
  }),
});

test("handler sandbox plan resolves node handlers to the current executable", () => {
  const plan = buildHandlerSandboxPlan({
    binding: {
      ...binding,
      sandbox: Object.freeze({ required: false }),
    },
    platform: "darwin",
    env: {},
  });

  assert.equal(plan.enabled, false);
  assert.equal(plan.mechanism, null);
  assert.equal(plan.command, process.execPath);
  assert.deepEqual(plan.args, ["handler.mjs"]);
});

test("handler sandbox plan wraps process handlers on Linux", () => {
  const plan = buildHandlerSandboxPlan({
    binding,
    platform: "linux",
    env: { TOUBA_BWRAP_COMMAND: "/usr/bin/bwrap" },
  });

  assert.equal(plan.enabled, true);
  assert.equal(plan.mechanism, "bubblewrap");
  assert.equal(plan.command, "/usr/bin/bwrap");
  assert.equal(plan.args.includes("--unshare-net"), true);
  assert.deepEqual(plan.args.slice(-2), [process.execPath, "handler.mjs"]);
});

test("handler sandbox plan wraps process handlers on macOS", () => {
  const plan = buildHandlerSandboxPlan({
    binding,
    platform: "darwin",
    env: { TOUBA_SANDBOX_EXEC_COMMAND: "/usr/bin/sandbox-exec" },
  });

  assert.equal(plan.enabled, true);
  assert.equal(plan.mechanism, "sandbox-exec");
  assert.equal(plan.command, "/usr/bin/sandbox-exec");
  assert.equal(plan.args[0], "-p");
  assert.match(plan.args[1], /\(deny default\)/u);
  assert.deepEqual(plan.args.slice(-2), [process.execPath, "handler.mjs"]);
});

test("handler sandbox plan wraps process handlers on Windows", () => {
  const plan = buildHandlerSandboxPlan({
    binding,
    platform: "win32",
    env: { TOUBA_SANDBOXIE_START_COMMAND: "C:\\Sandboxie\\Start.exe" },
  });

  assert.equal(plan.enabled, true);
  assert.equal(plan.mechanism, "Sandboxie-Plus");
  assert.equal(plan.command, "C:\\Sandboxie\\Start.exe");
  assert.deepEqual(plan.args, ["/box:ToubaHandler", process.execPath, "handler.mjs"]);
});

test("handler sandbox refuses unsupported required platforms", () => {
  assert.throws(
    () => buildHandlerSandboxPlan({ binding, platform: "freebsd", env: {} }),
    /handler sandbox is not supported/u,
  );
});

test("manifest sandbox contract is normalized and rejects unknown fields", () => {
  const manifest = loadToolBindingManifestFromJson(JSON.stringify({
    manifest_version: "touba-manifest-v1",
    bindings: {
      "tool:demo/Read": {
        effect_contract: { kind: "none" },
        handler: {
          kind: "process",
          command: "node",
          args: ["handler.mjs"],
        },
        grants: ["filesystem_read"],
        timeout_ms: 1000,
        max_payload_bytes: 4096,
        sandbox: {
          required: true,
          profile: "default",
        },
      },
    },
  }));
  assert.equal(manifest.bindings.get("tool:demo/Read").sandbox.required, true);

  assert.throws(
    () => loadToolBindingManifestFromJson(JSON.stringify({
      manifest_version: "touba-manifest-v1",
      bindings: {
        "tool:demo/Read": {
          effect_contract: { kind: "none" },
          handler: {
            kind: "process",
            command: "node",
            args: ["handler.mjs"],
          },
          grants: ["filesystem_read"],
          timeout_ms: 1000,
          max_payload_bytes: 4096,
          sandbox: {
            required: true,
            fallback: "host",
          },
        },
      },
    })),
    (error) => error instanceof ToubaRuntimeError
      && error.code === "InvalidToolBindingManifest"
      && /unknown fields/u.test(error.message),
  );
});
