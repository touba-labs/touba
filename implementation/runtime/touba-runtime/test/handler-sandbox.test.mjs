import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, realpathSync } from "node:fs";
import { dirname } from "node:path";

import { buildHandlerSandboxPlan } from "../src/handler-protocol.mjs";
import { probeHostSandbox } from "../src/hardened-execution-profile.mjs";
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

test("required handler sandbox refuses unqualified Linux policy", () => {
  assert.throws(() => buildHandlerSandboxPlan({ binding, platform: "linux", env: { TOUBA_SANDBOX_LAUNCHER: "/touba-missing-sandbox-launcher" } }),
    error => error.code === (process.platform === "linux" ? "HandlerSandboxUnavailable" : "HandlerSandboxUnsupportedPolicy"));
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

test("required Windows sandbox refuses a missing backend or a foreign host", () => {
  assert.throws(() => buildHandlerSandboxPlan({ binding, platform: "win32", env: { TOUBA_SANDBOX_LAUNCHER: "/touba-missing-sandbox-launcher" } }),
    error => error.code === (process.platform === "win32" ? "HandlerSandboxUnavailable" : "HandlerSandboxUnsupportedPolicy"));
});
test("Homebrew OpenSSL configuration access remains file-scoped", { skip: process.platform !== "darwin" }, () => {
  const plan = buildHandlerSandboxPlan({ binding, platform: "darwin",
    env: { TOUBA_SANDBOX_EXEC_COMMAND: "/usr/bin/sandbox-exec", OPENSSL_CONF: "/private/user-provided.cnf" } });
  const policy = plan.args[1];
  for (const config of ["/opt/homebrew/etc/openssl@4/openssl.cnf", "/usr/local/etc/openssl@4/openssl.cnf"]) {
    if (!existsSync(config)) continue;
    const resolved = realpathSync(config);
    assert.ok(policy.includes(`(literal ${JSON.stringify(resolved)})`));
    assert.ok(!policy.includes(`(subpath ${JSON.stringify(dirname(resolved))})`));
  }
  assert.ok(!policy.includes("/private/user-provided.cnf"));
});
test("handler sandbox refuses unsupported required platforms", () => {
  assert.throws(
    () => buildHandlerSandboxPlan({ binding, platform: "freebsd", env: {} }),
    /handler sandbox is not supported/u,
  );
});

test("an unqualified backend is never advertised as hardened by a version probe", () => {
  for (const platform of ["linux", "win32", "freebsd"]) {
    assert.equal(probeHostSandbox({ platform, env: { TOUBA_SANDBOX_LAUNCHER: "/touba-missing-sandbox-launcher" } }).available, false);
  }
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
      && /unknown configuration field: bindings\.tool:demo\/Read\.sandbox\.fallback/u.test(error.message),
  );
});
