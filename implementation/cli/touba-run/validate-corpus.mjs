import {
  CorpusFixtureError,
  FIXTURES,
  executeCorpusFixture,
  validateTraceResult,
} from "./corpus-runner.mjs";

let allPassed = true;

for (const fixture of FIXTURES) {
  const label = fixture.id;

  let execResult;
  try {
    ({ result: execResult } = await executeCorpusFixture(fixture));
  } catch (e) {
    const stage = e instanceof CorpusFixtureError ? e.stage : "execute";
    console.error(`FAIL [${label}] ${stage}: ${e.message}`);
    allPassed = false;
    continue;
  }

  const errors = validateTraceResult(fixture, execResult);
  const events = execResult.trace?.events ?? [];

  if (errors.length > 0) {
    console.error(`FAIL [${label}]:`);
    for (const err of errors) console.error(`  - ${err}`);
    allPassed = false;
  } else {
    console.log(`pass [${label}] status=${execResult.status} events=${events.length}`);
  }
}

process.exit(allPassed ? 0 : 1);
