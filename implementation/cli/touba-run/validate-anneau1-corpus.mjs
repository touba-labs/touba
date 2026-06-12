import {
  ANNEAU1_NEGATIVE_FIXTURES,
  ANNEAU1_POSITIVE_FIXTURES,
  CorpusFixtureError,
  compileAnneau1NegativeFixture,
  executeAnneau1Fixture,
  validateTraceResult,
} from "./corpus-runner.mjs";

let allPassed = true;

for (const fixture of ANNEAU1_POSITIVE_FIXTURES) {
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
  const events = execResult.trace?.events ?? [];

  if (errors.length > 0) {
    console.error(`FAIL [${fixture.id}]:`);
    for (const err of errors) console.error(`  - ${err}`);
    allPassed = false;
  } else {
    console.log(`pass [${fixture.id}] status=${execResult.status} events=${events.length}`);
  }
}

for (const fixture of ANNEAU1_NEGATIVE_FIXTURES) {
  const result = compileAnneau1NegativeFixture(fixture);
  if (result.ok) {
    console.error(`FAIL [${fixture.id}]: expected compilation failure`);
    allPassed = false;
    continue;
  }
  if (!result.stderr.includes(fixture.expectedDiagnostic)) {
    console.error(`FAIL [${fixture.id}]: expected ${fixture.expectedDiagnostic}`);
    console.error(result.stderr);
    allPassed = false;
    continue;
  }
  console.log(`pass [${fixture.id}] diagnostic=${fixture.expectedDiagnostic}`);
}

process.exit(allPassed ? 0 : 1);
