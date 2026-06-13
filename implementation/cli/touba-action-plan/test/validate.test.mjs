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

import {
  implementationDir,
  readActionPlan,
  renderActionPlanValidation,
  validateActionPlanDocument,
} from "../src/validate.mjs";

const validationFixturesDir = path.resolve(
  implementationDir,
  "../validation/action-plans-memoires-v0.1",
);
const validateScript = path.join(implementationDir, "cli/touba-action-plan/src/validate.mjs");

test("validates a plan-mode AddMemory fixture without applying patches", () => {
  const plan = readActionPlan(path.join(validationFixturesDir, "positive/add-memory.plan.json"));
  const report = validateActionPlanDocument(plan, {
    source: {
      kind: "source",
      path: "/tmp/example.tb",
    },
  });
  const rendered = renderActionPlanValidation(report);

  assert.equal(report.status, "ok");
  assert.match(rendered, /action=AddMemory mode=plan/);
  assert.match(rendered, /Diagnostics ok/);
  assert.doesNotMatch(rendered, /Report scope excludes|Absent data/);
  assert.doesNotMatch(rendered, /secret value|\.env loaded/i);
});

test("validates memory access against AIR and manifest artifacts", () => {
  const plan = readActionPlan(
    path.join(validationFixturesDir, "positive/validate-memory-access.plan.json"),
  );
  const report = validateActionPlanDocument(plan, {
    air: memoryAirFixture(),
    manifest: memoryManifestFixture(),
  });
  const rendered = renderActionPlanValidation(report);

  assert.equal(report.status, "ok");
  assert.match(rendered, /action=ValidateMemoryAccess mode=validate/);
  assert.match(rendered, /Artifacts source=absent air=present manifest=present trace=absent/);
  assert.match(rendered, /Diagnostics ok/);
});

test("reports missing grants, memory grants and owner scopes", () => {
  const plan = readActionPlan(
    path.join(validationFixturesDir, "positive/validate-memory-access.plan.json"),
  );
  const report = validateActionPlanDocument(plan, {
    air: memoryAirFixture({ agentScope: false }),
    manifest: memoryManifestFixture({ grants: [], memories: [] }),
  });

  assert.equal(report.status, "failed");
  assertDiagnostic(report, "MissingToolGrant");
  assertDiagnostic(report, "MissingToolMemoryGrant");
  assertDiagnostic(report, "MissingOwnerMemoryScope");
  assert.doesNotMatch(JSON.stringify(report), /DATABASE_URL|secret value|knowledge row/i);
});

test("refuses apply mode and forbidden backend reads", () => {
  const applyPlan = readActionPlan(path.join(validationFixturesDir, "negative/apply-mode.plan.json"));
  const backendPlan = readActionPlan(
    path.join(validationFixturesDir, "negative/forbidden-backend-read.plan.json"),
  );

  const applyReport = validateActionPlanDocument(applyPlan, {
    source: {
      kind: "source",
      path: "/tmp/example.tb",
    },
  });
  const backendReport = validateActionPlanDocument(backendPlan, {
    air: memoryAirFixture(),
  });

  assert.equal(applyReport.status, "failed");
  assertDiagnostic(applyReport, "ApplyModeUnsupported");
  assert.equal(backendReport.status, "failed");
  assertDiagnostic(backendReport, "ForbiddenArtifactRead");
});

test("reports missing explicit artifacts required by the plan", () => {
  const plan = readActionPlan(path.join(validationFixturesDir, "negative/missing-manifest.plan.json"));
  const report = validateActionPlanDocument(plan, {
    air: memoryAirFixture(),
  });

  assert.equal(report.status, "failed");
  assertDiagnostic(report, "MissingArtifact");
});

test("reports trace refusal when a matching memory access was refused", () => {
  const plan = readActionPlan(
    path.join(validationFixturesDir, "positive/validate-memory-access.plan.json"),
  );
  const report = validateActionPlanDocument(plan, {
    air: memoryAirFixture(),
    manifest: memoryManifestFixture(),
    trace: memoryTraceFixture({ refused: true }),
  });

  assert.equal(report.status, "failed");
  assertDiagnostic(report, "TraceMemoryAccessRefused");
});

test("validates PI-1 provenance and integrity trace metadata when requested", () => {
  const plan = readActionPlan(
    path.join(validationFixturesDir, "positive/validate-memory-access.plan.json"),
  );
  plan.inputs.require_provenance = true;
  plan.inputs.require_integrity_evidence = true;

  const report = validateActionPlanDocument(plan, {
    air: memoryAirFixture(),
    manifest: memoryManifestFixture(),
    trace: memoryTraceFixture({ provenance: true, integrity: true }),
  });
  const rendered = renderActionPlanValidation(report);

  assert.equal(report.status, "ok");
  assert.match(rendered, /Diagnostics ok/);
  assert.doesNotMatch(JSON.stringify(report), /knowledge row|DATABASE_URL|secret value|raw content/i);
});

test("reports missing PI-1 metadata when a plan explicitly requires it", () => {
  const plan = readActionPlan(
    path.join(validationFixturesDir, "positive/validate-memory-access.plan.json"),
  );
  plan.inputs.require_provenance = true;
  plan.inputs.require_integrity_evidence = true;

  const report = validateActionPlanDocument(plan, {
    air: memoryAirFixture(),
    manifest: memoryManifestFixture(),
    trace: memoryTraceFixture(),
  });

  assert.equal(report.status, "failed");
  assertDiagnostic(report, "TraceMemoryProvenanceMissing");
  assertDiagnostic(report, "TraceMemoryIntegrityMissing");
  assert.doesNotMatch(JSON.stringify(report), /knowledge row|DATABASE_URL|secret value|raw content/i);
});

test("reports PI-1 metadata refusals without leaking refused memory content", () => {
  const plan = readActionPlan(
    path.join(validationFixturesDir, "positive/validate-memory-access.plan.json"),
  );
  const report = validateActionPlanDocument(plan, {
    air: memoryAirFixture(),
    manifest: memoryManifestFixture(),
    trace: memoryTraceFixture({ metadataRefused: true }),
  });

  assert.equal(report.status, "failed");
  assertDiagnostic(report, "TraceMemoryMetadataRefused");
  assert.doesNotMatch(JSON.stringify(report), /knowledge row|DATABASE_URL|secret value|raw content/i);
});

test("CLI validates explicit artifacts without modifying them", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "touba-action-plan-"));
  try {
    const planPath = path.join(
      validationFixturesDir,
      "positive/validate-memory-access.plan.json",
    );
    const airPath = path.join(tempRoot, "memory.air.json");
    const manifestPath = path.join(tempRoot, "touba.manifest.json");
    writeFileSync(airPath, JSON.stringify(memoryAirFixture()), "utf8");
    writeFileSync(manifestPath, JSON.stringify(memoryManifestFixture()), "utf8");
    const beforeAir = readFileSync(airPath, "utf8");
    const beforeManifest = readFileSync(manifestPath, "utf8");

    const result = spawnSync(
      process.execPath,
      [validateScript, "--plan", planPath, "--air", airPath, "--manifest", manifestPath],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Touba Action Plan touba-action-plan-validation-v0\.1/);
    assert.match(result.stdout, /Status ok/);
    assert.equal(readFileSync(airPath, "utf8"), beforeAir);
    assert.equal(readFileSync(manifestPath, "utf8"), beforeManifest);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("CLI exits non-zero for unsupported apply mode while rendering diagnostics", () => {
  const sourcePath = path.join(
    implementationDir,
    "grammar/tree-sitter-touba/examples/memory-scopes-anneau-2/positive/tb-a2-mem-p01-agent-read-memory.tb",
  );
  const result = spawnSync(
    process.execPath,
    [
      validateScript,
      "--plan",
      path.join(validationFixturesDir, "negative/apply-mode.plan.json"),
      "--source",
      sourcePath,
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stdout, /ApplyModeUnsupported/);
});

function assertDiagnostic(report, code) {
  assert.ok(
    report.diagnostics.some((diagnostic) => diagnostic.code === code),
    `missing diagnostic ${code}: ${JSON.stringify(report.diagnostics)}`,
  );
}

function memoryAirFixture({ agentScope = true } = {}) {
  return {
    air_schema_version: "air-minimal-v0.1",
    module: {
      id: "module:examples.a2_memory_agent_read",
      name: "examples.a2_memory_agent_read",
    },
    definitions: {
      types: [],
      memories: [
        {
          id: "memory:examples.a2_memory_agent_read/ProjectKnowledge",
          name: "ProjectKnowledge",
        },
      ],
      functions: [],
      tools: [
        {
          id: "tool:examples.a2_memory_agent_read/ReadProjectKnowledge",
          name: "ReadProjectKnowledge",
          required_capabilities: ["memory_read"],
          memory_accesses: [
            {
              memory_ref: "memory:examples.a2_memory_agent_read/ProjectKnowledge",
              access: "read",
            },
          ],
        },
      ],
      skills: [
        {
          id: "skill:examples.a2_memory_agent_read/UseProjectKnowledge",
          name: "UseProjectKnowledge",
          memory_scopes: [
            {
              memory_ref: "memory:examples.a2_memory_agent_read/ProjectKnowledge",
              access: "read",
            },
          ],
        },
      ],
      agents: [
        {
          id: "agent:examples.a2_memory_agent_read/Researcher",
          name: "Researcher",
          memory_scopes: agentScope
            ? [
                {
                  memory_ref: "memory:examples.a2_memory_agent_read/ProjectKnowledge",
                  access: "read",
                },
              ]
            : [],
        },
      ],
      strategies: [],
    },
    execution_graphs: [],
    trace_points: [],
  };
}

function memoryManifestFixture({ grants = ["memory_read"], memories = undefined } = {}) {
  return {
    manifest_version: "touba-manifest-v1",
    bindings: {
      "tool:examples.a2_memory_agent_read/ReadProjectKnowledge": {
        handler: {
          kind: "process",
          command: "node",
          args: ["./handlers/read_project_knowledge.handler.mjs"],
        },
        grants,
        memories:
          memories ??
          [
            {
              ref: "memory:examples.a2_memory_agent_read/ProjectKnowledge",
              access: "read",
            },
          ],
        timeout_ms: 5000,
        max_payload_bytes: 1048576,
      },
    },
  };
}

function memoryTraceFixture({ refused = false, provenance = false, integrity = false, metadataRefused = false } = {}) {
  const toolRef = "tool:examples.a2_memory_agent_read/ReadProjectKnowledge";
  const memoryRef = "memory:examples.a2_memory_agent_read/ProjectKnowledge";
  const events = [
    {
      event_id: "event:memory:1",
      kind: refused ? "memory_access_refused" : "memory_access_authorized",
      payload: {
        tool_ref: toolRef,
        memory_ref: memoryRef,
        access: "read",
        reason: refused ? "owner_scope_missing" : undefined,
      },
    },
  ];
  if (provenance) {
    events.push({
      event_id: "event:memory:2",
      kind: "memory_provenance_observed",
      payload: {
        tool_ref: toolRef,
        memory_ref: memoryRef,
        operation: "read",
        source_kind: "tool_result",
        source_ref: "source:examples.a2_memory_agent_read/project_knowledge",
        writer_ref: toolRef,
        written_at: "2026-05-10T12:00:00.000Z",
        observed_at: "2026-05-10T12:00:00.010Z",
        schema_ref: "type:examples.a2_memory_agent_read/ProjectKnowledgeEntry",
        version_ref: "memory-version:project-knowledge:1",
      },
    });
  }
  if (integrity) {
    events.push({
      event_id: "event:memory:3",
      kind: "memory_integrity_observed",
      payload: {
        tool_ref: toolRef,
        memory_ref: memoryRef,
        operation: "read",
        digest_kind: "sha256",
        digest: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        integrity_evidence: "digest_reported",
      },
    });
  }
  if (metadataRefused) {
    events.push({
      event_id: "event:memory:4",
      kind: "memory_metadata_refused",
      payload: {
        tool_ref: toolRef,
        memory_ref: memoryRef,
        operation: "read",
        field: "content",
        integrity_evidence: "none",
      },
    });
  }
  return {
    trace_protocol_version: "trace-minimal-v0.1",
    run: {
      run_id: "run-memory",
      module_ref: "module:examples.a2_memory_agent_read",
      entry_ref: "strategy:examples.a2_memory_agent_read/RunResearch",
    },
    events,
  };
}
