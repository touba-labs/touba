import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CorpusFixtureError,
  FIXTURES,
  executeCorpusFixture,
  implementationDir,
} from "./corpus-runner.mjs";

const checkOnly = process.argv.includes("--check");
const airDir = join(implementationDir, "tests/air");
const tracesDir = join(implementationDir, "tests/traces");

mkdirSync(airDir, { recursive: true });

let allPassed = true;

for (const fixture of FIXTURES) {
  const label = fixture.id;
  const outputPath = join(airDir, `${fixture.id}.air.json`);

  let airDocument;
  try {
    ({ document: airDocument } = await executeCorpusFixture(fixture));
  } catch (e) {
    const stage = e instanceof CorpusFixtureError ? e.stage : "execute";
    console.error(`FAIL [${label}] ${stage}: ${e.message}`);
    allPassed = false;
    continue;
  }

  const tracePath = join(tracesDir, `${fixture.id}.trace.json`);
  let traceDocument;
  try {
    traceDocument = JSON.parse(readFileSync(tracePath, "utf8"));
  } catch (e) {
    console.error(`FAIL [${label}] read trace fixture: ${e.message}`);
    allPassed = false;
    continue;
  }

  const coherenceErrors = validateTraceAirCoherence(traceDocument, airDocument);
  if (coherenceErrors.length > 0) {
    console.error(`FAIL [${label}] trace/AIR coherence:`);
    for (const err of coherenceErrors) console.error(`  - ${err}`);
    allPassed = false;
    continue;
  }

  const serialized = `${JSON.stringify(airDocument, null, 2)}\n`;

  if (checkOnly) {
    let current;
    try {
      current = readFileSync(outputPath, "utf8");
    } catch {
      console.error(`FAIL [${label}] AIR fixture missing: ${outputPath}`);
      allPassed = false;
      continue;
    }
    if (current !== serialized) {
      console.error(`FAIL [${label}] AIR fixture is stale: ${outputPath}`);
      allPassed = false;
      continue;
    }
    console.log(`pass [${label}] AIR fixture current`);
  } else {
    writeFileSync(outputPath, serialized, "utf8");
    console.log(`wrote ${outputPath}`);
  }
}

process.exit(allPassed ? 0 : 1);

function validateTraceAirCoherence(trace, air) {
  const errors = [];
  if (trace.run?.air_schema_version !== air.air_schema_version) {
    errors.push(`trace air_schema_version ${trace.run?.air_schema_version} != AIR ${air.air_schema_version}`);
  }
  if (trace.run?.module_ref !== air.module?.id) {
    errors.push(`trace module_ref ${trace.run?.module_ref} != AIR module id ${air.module?.id}`);
  }

  const graphs = new Map((air.execution_graphs ?? []).map((graph) => [graph.id, graph]));
  const tracePoints = new Set((air.trace_points ?? []).map((tracePoint) => tracePoint.id));

  for (const event of trace.events ?? []) {
    const airRef = event.air_ref;
    if (!airRef) continue;

    const graph = graphs.get(airRef.flow_graph_ref);
    if (!graph) {
      errors.push(`${event.event_id}: unknown flow_graph_ref ${airRef.flow_graph_ref}`);
      continue;
    }

    if (airRef.node_id && !(graph.nodes ?? []).some((node) => node.id === airRef.node_id)) {
      errors.push(`${event.event_id}: unknown node_id ${airRef.node_id}`);
    }

    if (airRef.trace_point_ref && !tracePoints.has(airRef.trace_point_ref)) {
      errors.push(`${event.event_id}: unknown trace_point_ref ${airRef.trace_point_ref}`);
    }
  }

  return errors;
}
