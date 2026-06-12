import { isDeepStrictEqual } from "node:util";

import {
  BIND_DEFINE_NEGATIVE_FIXTURES,
  BIND_DEFINE_POSITIVE_FIXTURES,
  CorpusFixtureError,
  compileBindDefineNegativeFixture,
  compileBindDefinePositiveFixture,
  executeBindDefineFixture,
  validateTraceResult,
} from "./corpus-runner.mjs";

let allPassed = true;

for (const fixture of BIND_DEFINE_POSITIVE_FIXTURES) {
  if (fixture.compileOnly) {
    const result = compileBindDefinePositiveFixture(fixture);
    if (!result.ok) {
      console.error(`FAIL [${fixture.id}] compile: ${result.stderr}`);
      allPassed = false;
      continue;
    }

    const errors = validateAirConstants(fixture, result.stdout);
    if (errors.length > 0) {
      console.error(`FAIL [${fixture.id}]:`);
      for (const err of errors) console.error(`  - ${err}`);
      allPassed = false;
    } else {
      console.log(`pass [${fixture.id}] compile constants=${fixture.expectConstants.length}`);
    }
    continue;
  }

  let execResult;
  try {
    ({ result: execResult } = await executeBindDefineFixture(fixture));
  } catch (e) {
    const stage = e instanceof CorpusFixtureError ? e.stage : "execute";
    console.error(`FAIL [${fixture.id}] ${stage}: ${e.message}`);
    allPassed = false;
    continue;
  }

  const errors = validateTraceResult(fixture, execResult);
  if (!isDeepStrictEqual(execResult.result, fixture.expectResult)) {
    errors.push(
      `expected result ${JSON.stringify(fixture.expectResult)}, got ${JSON.stringify(execResult.result)}`,
    );
  }

  const bindingEvents = (execResult.trace?.events ?? []).filter((event) => event.kind === "binding_created");
  const observedBindings = bindingEvents.map((event) => event.payload?.binding);
  for (const binding of fixture.expectBindings ?? []) {
    if (!observedBindings.includes(binding)) {
      errors.push(`missing binding_created event for ${binding}`);
    }
  }

  const serializedEvents = JSON.stringify(bindingEvents);
  if (serializedEvents.includes("0.8") || serializedEvents.includes("0.45") || serializedEvents.includes("true")) {
    errors.push("binding_created event should not expose computed values");
  }

  if (errors.length > 0) {
    console.error(`FAIL [${fixture.id}]:`);
    for (const err of errors) console.error(`  - ${err}`);
    allPassed = false;
  } else {
    console.log(`pass [${fixture.id}] status=${execResult.status} bindings=${bindingEvents.length}`);
  }
}

for (const fixture of BIND_DEFINE_NEGATIVE_FIXTURES) {
  const result = compileBindDefineNegativeFixture(fixture);
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

function validateAirConstants(fixture, rawAir) {
  const errors = [];
  let air;
  try {
    air = JSON.parse(rawAir);
  } catch (error) {
    return [`invalid AIR JSON: ${error instanceof Error ? error.message : String(error)}`];
  }

  const constants = air.definitions?.constants ?? [];
  const names = constants.map((constant) => constant.name);
  for (const name of fixture.expectConstants ?? []) {
    if (!names.includes(name)) {
      errors.push(`missing AirConstant ${name}`);
    }
  }
  return errors;
}
