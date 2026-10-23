import "../../tools/fixture-clock.mjs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANNEAU1_POSITIVE_FIXTURES,
  CorpusFixtureError,
  executeAnneau1Fixture,
  implementationDir,
  validateTraceResult,
} from "./corpus-runner.mjs";

const checkOnly = process.argv.includes("--check");
const tracesDir = join(implementationDir, "tests/traces/anneau-1");

mkdirSync(tracesDir, { recursive: true });

let allPassed = true;

for (const fixture of ANNEAU1_POSITIVE_FIXTURES) {
  const outputPath = join(tracesDir, `${fixture.id}.trace.json`);

  let execResult;
  try {
    ({ result: execResult } = await executeAnneau1Fixture(fixture));
  } catch (e) {
    const stage = e instanceof CorpusFixtureError ? e.stage : "execute";
    console.error(`FAIL [${fixture.id}] ${stage}: ${e.message}`);
    allPassed = false;
    continue;
  }

  const errors = validateTraceResult(fixture, execResult);
  if (errors.length > 0) {
    console.error(`FAIL [${fixture.id}]:`);
    for (const err of errors) console.error(`  - ${err}`);
    allPassed = false;
    continue;
  }

  const serialized = `${JSON.stringify(execResult.trace, null, 2)}\n`;

  if (checkOnly) {
    let current;
    try {
      current = readFileSync(outputPath, "utf8");
    } catch {
      console.error(`FAIL [${fixture.id}] trace fixture missing: ${outputPath}`);
      allPassed = false;
      continue;
    }
    if (current !== serialized) {
      console.error(`FAIL [${fixture.id}] trace fixture is stale: ${outputPath}`);
      allPassed = false;
      continue;
    }
    console.log(`pass [${fixture.id}] anneau 1 trace fixture current`);
  } else {
    writeFileSync(outputPath, serialized, "utf8");
    console.log(`wrote ${outputPath}`);
  }
}

process.exit(allPassed ? 0 : 1);
