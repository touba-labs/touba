import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const implementationDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(implementationDir, "package.json"), "utf8"));
const expected = packageJson.engines?.node;
const actual = process.versions.node;

if (!expected) {
  throw new Error("package.json engines.node is not defined");
}

if (actual !== expected) {
  const localNode = path.join(
    implementationDir,
    ".toolchains",
    `node-v${expected}-darwin-arm64`,
    "bin",
  );
  console.error(`Node.js ${expected} is required; current runtime is ${actual}.`);
  console.error("Run Touba implementation commands with a matching Node.js runtime.");
  console.error(`Local macOS arm64 cache path, when bootstrapped: ${localNode}`);
  process.exit(1);
}
