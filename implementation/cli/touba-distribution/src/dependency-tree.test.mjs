import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { copyDependency } from "./package-sdk.mjs";

test("SDK and editor packaging preserve conflicting transitive versions and required peers", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-dependency-tree-"));
  const source = join(root, "source");
  const target = join(root, "packaged");
  const put = (directory, manifest) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  };
  try {
    put(source, { name: "consumer", version: "1.0.0", dependencies: { alpha: "1.0.0", beta: "1.0.0" } });
    for (const [name, version] of [["alpha", "1.0.0"], ["beta", "2.0.0"]]) {
      const parent = join(source, "node_modules", name);
      put(parent, { name, version: "1.0.0", dependencies: { shared: version },
        peerDependencies: { peer: "1.0.0" }, optionalDependencies: { absent: "1.0.0" } });
      put(join(parent, "node_modules/shared"), { name: "shared", version });
    }
    put(join(source, "node_modules/peer"), { name: "peer", version: "1.0.0" });
    const inventory = new Map();
    copyDependency(source, target, inventory);
    for (const [name, version] of [["alpha", "1.0.0"], ["beta", "2.0.0"]]) {
      const parent = join(target, "node_modules", name);
      assert.equal(JSON.parse(readFileSync(join(parent, "node_modules/shared/package.json"))).version, version);
      assert.equal(JSON.parse(readFileSync(join(parent, "node_modules/peer/package.json"))).version, "1.0.0");
    }
    assert.ok(inventory.has("shared@1.0.0"));
    assert.ok(inventory.has("shared@2.0.0"));
    assert.throws(() => copyDependency(source, join(root, "cycle"), new Map(), new Set([source])), /cycle/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
