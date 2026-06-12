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

if (!satisfiesNodeRange(actual, expected)) {
  console.error(`Node.js ${expected} is required; current runtime is ${actual}.`);
  console.error("Run Touba implementation commands with a matching Node.js runtime.");
  process.exit(1);
}

function satisfiesNodeRange(version, range) {
  const parsed = parseVersion(version);
  const clauses = range.split(/\s+/).filter(Boolean);
  return clauses.every((clause) => satisfiesClause(parsed, clause));
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(version);
  if (!match) {
    throw new Error(`invalid Node.js version ${version}`);
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

function satisfiesClause(version, clause) {
  const match = /^(>=|>|<=|<|=)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(clause);
  if (!match) {
    throw new Error(`unsupported package.json engines.node range clause ${clause}`);
  }
  const operator = match[1] ?? "=";
  const target = {
    major: Number.parseInt(match[2], 10),
    minor: Number.parseInt(match[3] ?? "0", 10),
    patch: Number.parseInt(match[4] ?? "0", 10),
  };
  const comparison = compareVersions(version, target);
  if (operator === ">=") return comparison >= 0;
  if (operator === ">") return comparison > 0;
  if (operator === "<=") return comparison <= 0;
  if (operator === "<") return comparison < 0;
  return comparison === 0;
}

function compareVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) {
      return left[key] > right[key] ? 1 : -1;
    }
  }
  return 0;
}
