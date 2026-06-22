import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateObject } from "../../../tools/validate-product-surface-contracts.mjs";
import {
  createTraceAuditExport,
  createTraceAuditManifest,
  createTraceTimeline,
  implementationDir,
  loadTraceAuditArtifacts,
  renderTraceAuditValidation,
  validateTraceAuditArtifacts,
} from "../src/audit.mjs";

const auditScript = path.join(implementationDir, "cli/touba-audit/src/audit.mjs");
const traceTimelineSchemaPath = path.join(
  implementationDir,
  "contracts/product-surfaces/schemas/touba-trace-timeline-v1.schema.json",
);

test("generates a TA-1 audit manifest and validation report for coherent artifacts", () => {
  withFixtureProject((fixture) => {
    const artifacts = loadTraceAuditArtifacts(fixture.paths);
    const validation = validateTraceAuditArtifacts(artifacts, {
      createdAt: "2026-06-05T00:00:00Z",
    });
    const rendered = renderTraceAuditValidation(validation);

    assert.equal(validation.validationReport.status, "ok");
    assert.equal(validation.traceAuditManifest.trace_audit_schema_version, "trace-audit-v0.1");
    assert.match(validation.traceAuditManifest.artifacts.trace_digest.value, /^[a-f0-9]{64}$/u);
    assert.equal(validation.validationReport.checked.trace_air_coherence, true);
    assert.match(rendered, /Diagnostics ok/);
    assert.doesNotMatch(JSON.stringify(validation), /TOUBA_SHOULD_NOT_LEAK|\.env loaded/i);
  });
});

test("reports trace and AIR module mismatch", () => {
  withFixtureProject((fixture) => {
    fixture.air.module.id = "module:examples.other";
    writeJson(fixture.paths.air, fixture.air);

    const validation = validateTraceAuditArtifacts(loadTraceAuditArtifacts(fixture.paths));

    assert.equal(validation.validationReport.status, "failed");
    assertDiagnostic(validation, "TraceAirModuleMismatch");
  });
});

test("reports invalid trace sequence", () => {
  withFixtureProject((fixture) => {
    fixture.trace.events[1].sequence_index = 0;
    writeJson(fixture.paths.trace, fixture.trace);

    const validation = validateTraceAuditArtifacts(loadTraceAuditArtifacts(fixture.paths));

    assert.equal(validation.validationReport.status, "failed");
    assertDiagnostic(validation, "TraceSequenceInvalid");
  });
});

test("reports digest mismatch for supplied audit manifest", () => {
  withFixtureProject((fixture) => {
    const artifacts = loadTraceAuditArtifacts(fixture.paths);
    const manifest = createTraceAuditManifest(artifacts, {
      createdAt: "2026-06-05T00:00:00Z",
    });
    manifest.artifacts.trace_digest.value = "0".repeat(64);
    const auditManifestPath = path.join(fixture.root, "trace-audit.json");
    writeJson(auditManifestPath, manifest);

    const validation = validateTraceAuditArtifacts(loadTraceAuditArtifacts({
      ...fixture.paths,
      auditManifest: auditManifestPath,
    }));

    assert.equal(validation.validationReport.status, "failed");
    assertDiagnostic(validation, "TraceAuditDigestMismatch");
  });
});

test("reports redaction violations without copying secret values into diagnostics", () => {
  withFixtureProject((fixture) => {
    fixture.trace.events.push({
      event_id: "event:run-ta1:3",
      run_id: "run-ta1",
      sequence_index: 2,
      kind: "tool_failed",
      payload: {
        secret_value: "TOUBA_SHOULD_NOT_LEAK",
      },
    });
    writeJson(fixture.paths.trace, fixture.trace);

    const validation = validateTraceAuditArtifacts(loadTraceAuditArtifacts(fixture.paths));
    const serialized = JSON.stringify(validation);

    assert.equal(validation.validationReport.status, "failed");
    assertDiagnostic(validation, "TraceAuditSecretLeakDetected");
    assert.doesNotMatch(serialized, /TOUBA_SHOULD_NOT_LEAK/);
  });
});

test("creates a local export document only from explicit artifacts", () => {
  withFixtureProject((fixture) => {
    const artifacts = loadTraceAuditArtifacts(fixture.paths);
    const validation = validateTraceAuditArtifacts(artifacts);
    const exportDocument = createTraceAuditExport(artifacts, validation);

    assert.equal(exportDocument.trace_audit_export_schema_version, "trace-audit-export-v0.1-local");
    assert.equal(exportDocument.artifacts.trace.run.run_id, "run-ta1");
    assert.equal(exportDocument.artifacts.air.module.id, "module:examples.ta1");
    assert.equal(exportDocument.artifacts.source.text, fixture.sourceText);
    assert.equal(exportDocument.artifacts.secrets, undefined);
    assert.doesNotMatch(JSON.stringify(exportDocument), /\.env loaded|TOUBA_SHOULD_NOT_LEAK/i);
  });
});

test("creates a bounded trace timeline without copying raw payloads", () => {
  withFixtureProject((fixture) => {
    fixture.trace.events.push({
      event_id: "event:run-ta1:3",
      run_id: "run-ta1",
      sequence_index: 2,
      kind: "agent_decision_requested",
      payload: {
        agent_ref: "agent:examples.ta1/Auditor",
        mode: "capabilities",
        raw_prompt: "TOUBA_SHOULD_NOT_LEAK",
      },
    });

    const timeline = createTraceTimeline(fixture.trace);
    const serialized = JSON.stringify(timeline);

    assert.deepEqual(validateObject(traceTimelineSchema(), timeline), []);
    assert.equal(timeline.schema_version, "touba-trace-timeline-v1");
    assert.equal(timeline.run_id, "run-ta1");
    assert.equal(timeline.events[2].type, "agent.decision.requested");
    assert.equal(timeline.events[2].timestamp, "sequence:2");
    assert.equal(timeline.events[2].source_ref, "agent:examples.ta1/Auditor");
    assert.equal(timeline.events[2].redaction, "secrets_redacted");
    assert.doesNotMatch(serialized, /TOUBA_SHOULD_NOT_LEAK|raw_prompt/);
  });
});

test("CLI validates and writes a bounded export", () => {
  withFixtureProject((fixture) => {
    const exportPath = path.join(fixture.root, "audit.export.json");
    const result = spawnSync(
      process.execPath,
      [
        auditScript,
        "--trace",
        fixture.paths.trace,
        "--air",
        fixture.paths.air,
        "--source",
        fixture.paths.source,
        "--export",
        exportPath,
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Touba Trace Audit/);
    assert.match(result.stdout, /Status ok/);
    const exportDocument = JSON.parse(readFileSync(exportPath, "utf8"));
    assert.equal(exportDocument.validation_report.status, "ok");
  });
});

test("CLI writes an explicit trace timeline product surface", () => {
  withFixtureProject((fixture) => {
    fixture.trace.events.push({
      event_id: "event:run-ta1:3",
      run_id: "run-ta1",
      sequence_index: 2,
      kind: "trigger_event_received",
      payload: {
        trigger_ref: "trigger:examples.ta1/Nightly",
        payload_bytes: 128,
        payload_sha256: "a".repeat(64),
      },
    });
    writeJson(fixture.paths.trace, fixture.trace);

    const timelinePath = path.join(fixture.root, "audit.trace-timeline.json");
    const result = spawnSync(
      process.execPath,
      [
        auditScript,
        "--trace",
        fixture.paths.trace,
        "--air",
        fixture.paths.air,
        "--source",
        fixture.paths.source,
        "--timeline-out",
        timelinePath,
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Touba Trace Audit/);
    const timeline = JSON.parse(readFileSync(timelinePath, "utf8"));
    assert.deepEqual(validateObject(traceTimelineSchema(), timeline), []);
    assert.equal(timeline.events[2].type, "trigger.event.received");
    assert.equal(timeline.events[2].summary, "Trigger event received for trigger:examples.ta1/Nightly.");
    assert.equal(timeline.events[2].redaction, "payload_minimized");
    assert.doesNotMatch(JSON.stringify(timeline), /payload_sha256|payload_bytes|raw-secret-payload/i);
  });
});

test("CLI refuses ambiguous trace timeline output suffixes", () => {
  withFixtureProject((fixture) => {
    const timelinePath = path.join(fixture.root, "timeline.json");
    const result = spawnSync(
      process.execPath,
      [
        auditScript,
        "--trace",
        fixture.paths.trace,
        "--air",
        fixture.paths.air,
        "--source",
        fixture.paths.source,
        "--timeline-out",
        timelinePath,
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 2);
    assert.match(result.stderr, /--timeline-out path must end with \.trace-timeline\.json/);
    assert.throws(() => readFileSync(timelinePath, "utf8"));
  });
});

test("CLI writes an explicit trace audit report with the canonical suffix", () => {
  withFixtureProject((fixture) => {
    const reportPath = path.join(fixture.root, "audit.trace-audit-report.json");
    const result = spawnSync(
      process.execPath,
      [
        auditScript,
        "--trace",
        fixture.paths.trace,
        "--air",
        fixture.paths.air,
        "--source",
        fixture.paths.source,
        "--report-out",
        reportPath,
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Touba Trace Audit/);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.validationReport.trace_audit_validation_schema_version, "trace-audit-validation-v0.1");
    assert.equal(report.validationReport.status, "ok");
    assert.equal(report.traceAuditManifest.trace_audit_schema_version, "trace-audit-v0.1");
  });
});

test("CLI refuses ambiguous trace audit report output suffixes", () => {
  withFixtureProject((fixture) => {
    const reportPath = path.join(fixture.root, "audit.report.json");
    const result = spawnSync(
      process.execPath,
      [
        auditScript,
        "--trace",
        fixture.paths.trace,
        "--air",
        fixture.paths.air,
        "--source",
        fixture.paths.source,
        "--report-out",
        reportPath,
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 2);
    assert.match(result.stderr, /--report-out path must end with \.trace-audit-report\.json/);
    assert.throws(() => readFileSync(reportPath, "utf8"));
  });
});

test("CLI exits non-zero and does not write export on redaction failure", () => {
  withFixtureProject((fixture) => {
    fixture.trace.events.push({
      event_id: "event:run-ta1:3",
      run_id: "run-ta1",
      sequence_index: 2,
      kind: "user_interaction_answered",
      payload: {
        answer: "raw local answer",
      },
    });
    writeJson(fixture.paths.trace, fixture.trace);
    const exportPath = path.join(fixture.root, "audit.export.json");

    const result = spawnSync(
      process.execPath,
      [
        auditScript,
        "--trace",
        fixture.paths.trace,
        "--air",
        fixture.paths.air,
        "--source",
        fixture.paths.source,
        "--export",
        exportPath,
        "--output",
        "json",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.match(result.stdout, /TraceAuditUserInputLeakDetected/);
    assert.doesNotMatch(result.stdout, /raw local answer/);
    assert.throws(() => readFileSync(exportPath, "utf8"));
  });
});

function withFixtureProject(callback) {
  const root = mkdtempSync(path.join(tmpdir(), "touba-audit-ta1-"));
  try {
    const sourcePath = path.join(root, "program.tb");
    const sourceText = [
      "module examples.ta1",
      "",
      "strategy RunAudit",
      "    do",
      "        show",
      "            with message as \"audit\"",
      "",
    ].join("\n");
    writeFileSync(sourcePath, sourceText, "utf8");

    const air = airFixture(sourcePath);
    const trace = traceFixture(sourcePath);
    const manifest = {
      manifest_version: "touba-manifest-v1",
      bindings: {},
    };

    const paths = {
      source: sourcePath,
      air: path.join(root, "program.air.json"),
      trace: path.join(root, "program.trace.json"),
      manifest: path.join(root, "touba.manifest.json"),
    };
    writeJson(paths.air, air);
    writeJson(paths.trace, trace);
    writeJson(paths.manifest, manifest);

    callback({
      root,
      sourceText,
      air,
      trace,
      manifest,
      paths,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function airFixture(sourcePath) {
  const graphId = "graph:strategy:examples.ta1/RunAudit";
  const nodeId = "node:graph:strategy:examples.ta1/RunAudit:1";
  return {
    air_schema_version: "air-minimal-v0.1",
    module: {
      id: "module:examples.ta1",
      name: "examples.ta1",
      source_ref: sourceRef(sourcePath),
    },
    definitions: {
      types: [],
      functions: [],
      tools: [],
      skills: [],
      agents: [],
      strategies: [
        {
          id: "strategy:examples.ta1/RunAudit",
          name: "RunAudit",
          source_ref: sourceRef(sourcePath),
        },
      ],
    },
    execution_graphs: [
      {
        id: graphId,
        owner_ref: "strategy:examples.ta1/RunAudit",
        entry_node_id: nodeId,
        nodes: [
          {
            id: nodeId,
            kind: "user_show",
            source_ref: sourceRef(sourcePath),
          },
        ],
        edges: [],
      },
    ],
  };
}

function traceFixture(sourcePath) {
  const graphId = "graph:strategy:examples.ta1/RunAudit";
  const nodeId = "node:graph:strategy:examples.ta1/RunAudit:1";
  return {
    trace_protocol_version: "trace-minimal-v0.1",
    run: {
      run_id: "run-ta1",
      air_schema_version: "air-minimal-v0.1",
      module_ref: "module:examples.ta1",
      entry_ref: "strategy:examples.ta1/RunAudit",
    },
    events: [
      {
        event_id: "event:run-ta1:1",
        run_id: "run-ta1",
        sequence_index: 0,
        kind: "run_started",
      },
      {
        event_id: "event:run-ta1:2",
        run_id: "run-ta1",
        sequence_index: 1,
        kind: "user_interaction_shown",
        air_ref: {
          flow_graph_ref: graphId,
          owner_ref: "strategy:examples.ta1/RunAudit",
          node_id: nodeId,
          source_ref: sourceRef(sourcePath),
        },
        payload: {
          interaction_ref: "interaction:run-ta1:1",
        },
      },
    ],
  };
}

function sourceRef(sourcePath) {
  return {
    source_id: path.resolve(sourcePath),
    start_byte: 0,
    end_byte: 1,
    start_line: 0,
    start_column: 0,
    end_line: 0,
    end_column: 1,
  };
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assertDiagnostic(validation, code) {
  assert.ok(
    validation.validationReport.diagnostics.some((diagnostic) => diagnostic.code === code),
    `expected diagnostic ${code}, got ${JSON.stringify(validation.validationReport.diagnostics)}`,
  );
}

function traceTimelineSchema() {
  return JSON.parse(readFileSync(traceTimelineSchemaPath, "utf8"));
}
