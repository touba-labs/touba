import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
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
    assert.throws(() => copyDependency(source, join(root, "cycle"), new Map(), new Map([[realpathSync(source), target]])), /cycle/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a required cyclic peer resolves to the exact packaged ancestor without checkout access", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-cyclic-peer-"));
  const source = join(root, "source/node_modules/driver");
  const target = join(root, "output/node_modules/driver");
  try {
    mkdirSync(join(source, "node_modules/pool"), { recursive: true });
    writeFileSync(join(source, "package.json"), JSON.stringify({ name: "driver", version: "1.0.0", main: "index.cjs", dependencies: { pool: "1.0.0" } }));
    writeFileSync(join(source, "index.cjs"), "exports.version='1.0.0'; exports.pool=require('pool');\n");
    writeFileSync(join(source, "node_modules/pool/package.json"), JSON.stringify({ name: "pool", version: "1.0.0", main: "index.cjs", peerDependencies: { driver: "1.0.0" } }));
    writeFileSync(join(source, "node_modules/pool/index.cjs"), "exports.driverVersion=()=>require('driver').version;\n");
    const inventory = new Map();
    copyDependency(source, target, inventory);
    rmSync(join(root, "source"), { recursive: true });
    const require = createRequire(join(root, "output/package.json"));
    assert.equal(require("driver").pool.driverVersion(), "1.0.0");
    assert.deepEqual([...inventory.keys()].sort(), ["driver@1.0.0", "pool@1.0.0"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("PostgreSQL and its cyclic required peer work from an isolated copied dependency tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-packaged-pg-"));
  try {
    const requireSource = createRequire(new URL("../../touba-run/package.json", import.meta.url));
    const source = join(requireSource.resolve("pg/package.json"), "..");
    const inventory = new Map();
    copyDependency(source, join(root, "node_modules/pg"), inventory);
    const require = createRequire(join(root, "package.json"));
    const { Client, Pool } = require("pg");
    assert.equal(typeof Client, "function");
    const pool = new Pool({ max: 1 });
    assert.equal(pool.Client, Client);
    await pool.end();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
