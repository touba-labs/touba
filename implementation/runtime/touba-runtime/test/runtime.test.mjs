import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  AIR_CAPABILITY_PROFILE,
  AIR_JSON_PROFILE,
  AIR_SCHEMA_VERSION,
  EFFECT_JOURNAL_SCHEMA_VERSION,
  RUNTIME_CAPABILITIES,
  TRACE_PROTOCOL_VERSION,
  ToubaRuntimeError,
  executeAirDocument,
  executeTriggerEvent,
  loadAirFromJson,
  loadSecretsFromJson,
  loadToolBindingManifestFromJson,
} from "../src/index.mjs";

test("loads AIR V1 machine contract and rejects unsupported schema versions", () => {
  const document = baseDocument();
  const loaded = loadAirFromJson(JSON.stringify(document));

  assert.equal(loaded.air_schema_version, AIR_SCHEMA_VERSION);
  assert.equal(AIR_JSON_PROFILE, "touba-air-json-canonical-v1");
  assert.ok(RUNTIME_CAPABILITIES.includes("touba-trace-v1"));

  assert.throws(
    () => loadAirFromJson(JSON.stringify({ ...document, air_schema_version: "unknown" })),
    (error) =>
      error instanceof ToubaRuntimeError && error.code === "UnsupportedAirSchemaVersion",
  );
});

test("loads manifest and secrets documents for tool binding V1", () => {
  const manifest = loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument()));
  assert.equal(manifest.bindings.get("tool:test/Search").limits.timeout_ms, 5000);
  assert.deepEqual([...manifest.bindings.get("tool:test/Search").secrets], ["SEARCH_API_KEY"]);

  const secretStore = loadSecretsFromJson(JSON.stringify(secretsDocument()), {
    env: { SEARCH_API_TOKEN: "resolved-secret-value" },
  });
  assert.equal(secretStore.has("SEARCH_API_KEY"), true);
  assert.equal(JSON.stringify(secretStore).includes("resolved-secret-value"), false);
  assert.throws(
    () => loadSecretsFromJson(JSON.stringify({
      secrets_version: "touba-secrets-v1",
      secrets: {
        SEARCH_API_KEY: {
          source: "env",
          name: "SEARCH_API_TOKEN",
          status: "paused",
        },
      },
    })),
    (error) => error instanceof ToubaRuntimeError && error.code === "InvalidSecretsFile",
  );
  assert.throws(
    () => loadSecretsFromJson(JSON.stringify({
      secrets_version: "touba-secrets-v1",
      secrets: {
        SEARCH_API_KEY: {
          source: "env",
          name: "SEARCH_API_TOKEN",
          expires_at: "not-a-date",
        },
      },
    })),
    (error) => error instanceof ToubaRuntimeError && error.code === "InvalidSecretsFile",
  );

  assert.throws(
    () => loadToolBindingManifestFromJson(JSON.stringify({ manifest_version: "wrong" })),
    (error) =>
      error instanceof ToubaRuntimeError && error.code === "InvalidToolBindingManifest",
  );
  assert.throws(
    () => loadSecretsFromJson(JSON.stringify({ secrets_version: "wrong" })),
    (error) => error instanceof ToubaRuntimeError && error.code === "InvalidSecretsFile",
  );
});

test("loads BQ-1 run limits and rejects invalid budget declarations", () => {
  const manifest = loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument({
    runLimits: {
      max_run_ms: 30000,
      max_steps: 10,
      max_tool_calls: 2,
      max_agent_invocations: 1,
    },
  })));

  assert.equal(manifest.runLimits.get("max_tool_calls").value, 2);
  assert.equal(manifest.runLimits.get("max_tool_calls").authoritySource, "manifest");

  assert.throws(
    () => loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument({
      runLimits: { max_tokens: 100 },
    }))),
    (error) =>
      error instanceof ToubaRuntimeError && error.code === "InvalidToolBindingManifest",
  );

  assert.throws(
    () => loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument({
      runLimits: { max_steps: 0 },
    }))),
    (error) =>
      error instanceof ToubaRuntimeError && error.code === "InvalidToolBindingManifest",
  );

  assert.throws(
    () => loadAirFromJson(JSON.stringify(baseDocument({
      budgets: {
        run: {
          max_steps: {
            value: 0,
            source_ref: sourceRef(),
          },
        },
      },
    }))),
    (error) => error instanceof ToubaRuntimeError && error.code === "InvalidAirDocument",
  );

  assert.throws(
    () => loadAirFromJson(JSON.stringify(baseDocument({
      budgets: {
        run: {
          max_tokens: {
            value: 100,
            source_ref: sourceRef(),
          },
        },
      },
    }))),
    (error) => error instanceof ToubaRuntimeError && error.code === "InvalidAirDocument",
  );
});

test("loads explicit dotenv and touba_store secret sources without serializing values", () => {
  const files = new Map([
    ["/project/.env", "OPENAI_API_KEY=dotenv-secret\nIGNORED=value\n"],
    ["/project/.touba/secrets.local.json", JSON.stringify({
      store_version: "touba-secret-store-local-v1",
      secrets: {
        GITHUB_TOKEN: "store-secret",
      },
    })],
  ]);
  const normalizeTestPath = (path) => path.replaceAll("\\", "/").replace(/^[A-Za-z]:/u, "");
  const secretStore = loadSecretsFromJson(JSON.stringify({
    secrets_version: "touba-secrets-v1",
    secrets: {
      OPENAI_API_KEY: {
        source: "dotenv",
        path: ".env",
        name: "OPENAI_API_KEY",
      },
      GITHUB_TOKEN: {
        source: "touba_store",
        path: ".touba/secrets.local.json",
        name: "GITHUB_TOKEN",
      },
    },
  }), {
    baseDir: "/project",
    fileExists: (path) => files.has(normalizeTestPath(path)),
    readTextFile: (path) => files.get(normalizeTestPath(path)),
  });

  assert.equal(secretStore.has("OPENAI_API_KEY"), true);
  assert.equal(secretStore.has("GITHUB_TOKEN"), true);
  assert.equal(secretStore.valueFor("OPENAI_API_KEY"), "dotenv-secret");
  assert.equal(secretStore.valueFor("GITHUB_TOKEN"), "store-secret");
  assert.equal(JSON.stringify(secretStore).includes("dotenv-secret"), false);
  assert.equal(JSON.stringify(secretStore).includes("store-secret"), false);
});

test("treats missing explicit dotenv and touba_store files as unresolved handles", () => {
  const secretStore = loadSecretsFromJson(JSON.stringify({
    secrets_version: "touba-secrets-v1",
    secrets: {
      OPENAI_API_KEY: {
        source: "dotenv",
        path: ".env",
        name: "OPENAI_API_KEY",
      },
      GITHUB_TOKEN: {
        source: "touba_store",
        path: ".touba/secrets.local.json",
        name: "GITHUB_TOKEN",
      },
    },
  }), {
    baseDir: "/project",
    fileExists: () => false,
    readTextFile: () => {
      throw new Error("must not read absent files");
    },
  });

  assert.equal(secretStore.has("OPENAI_API_KEY"), false);
  assert.equal(secretStore.has("GITHUB_TOKEN"), false);
});

test("executes a linear skill with a bound tool and emits minimal traces", async () => {
  const document = baseDocument({
    tools: [tool("Fetch")],
    skills: [skill("Build", "graph:skill:test/Build", ["tool:test/Fetch"])],
    graphs: [
      graph("graph:skill:test/Build", "skill:test/Build", [
        node("n1", "call_tool", { target_ref: "tool:test/Fetch" }),
        node("n2", "give", { arguments: ["literal:string:done"] }),
      ], [
        edge("n1", "n2", "next"),
      ]),
    ],
  });

  const result = await executeAirDocument(document, {
    entryRef: "skill:test/Build",
    toolHandlers: {
      "tool:test/Fetch": () => "fetched",
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.result, "done");
  assertTraceShape(result.trace, "skill:test/Build");
  assertKinds(result.trace, ["run_started", "scope_entered", "call_started", "call_completed", "scope_exited", "run_completed"]);
});

test("checks manifest grants and secret scopes before dispatching a tool", async () => {
  const document = secretToolDocument({ throughAgent: true });

  const result = await executeAirDocument(document, {
    entryRef: "strategy:test/RunSearch",
    toolBindingManifest: loadToolBindingManifestFromJson(
      JSON.stringify(bindingManifestDocument({
        agentSecretScopes: {
          "agent:test/Researcher": ["SEARCH_API_KEY"],
        },
      })),
    ),
    secretStore: loadSecretsFromJson(JSON.stringify(secretsDocument()), {
      env: { SEARCH_API_TOKEN: "resolved-secret-value" },
    }),
    toolHandlers: {
      "tool:test/Search": ({ binding }) => {
        assert.deepEqual(binding.grants, ["network", "secret_read"]);
        assert.deepEqual(binding.secretHandles, ["SEARCH_API_KEY"]);
        assert.deepEqual(binding.limits, {
          timeout_ms: 5000,
          max_payload_bytes: 1048576,
        });
        return "searched";
      },
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.result, "searched");
  assert.equal(JSON.stringify(result.trace).includes("resolved-secret-value"), false);
  const firstCall = eventOf(result.trace, "call_started");
  assert.equal(firstCall.payload.target_ref, "agent:test/Researcher");
  assert.equal(firstCall.payload.caller_ref, "strategy:test/RunSearch");
  assert.equal(firstCall.payload.agent_ref, null);
  assert.deepEqual(eventOf(result.trace, "tool_binding_authorized").payload, {
    tool_ref: "tool:test/Search",
    caller_ref: "skill:test/SearchFlow",
    agent_ref: "agent:test/Researcher",
    required_capabilities: ["network", "secret_read"],
    granted_capabilities: ["network", "secret_read"],
    memory_accesses_required: [],
    memory_accesses_granted: [],
    secret_handles_required: ["SEARCH_API_KEY"],
    secret_handles_granted: ["SEARCH_API_KEY"],
    secret_handles_used: ["SEARCH_API_KEY"],
    handler_kind: "process",
    timeout_ms: 5000,
    max_payload_bytes: 1048576,
  });
  assert.deepEqual(eventOf(result.trace, "secret_handle_authorized").payload, {
    caller_ref: "skill:test/SearchFlow",
    agent_ref: "agent:test/Researcher",
    tool_ref: "tool:test/Search",
    secret_handle: "SEARCH_API_KEY",
    authority_source: "binding_and_agent_secret_scope",
  });
});

test("enforces SH-1 revoked and expired secret handles before handler dispatch", async () => {
  const cases = [
    {
      name: "revoked",
      secretRecord: {
        source: "env",
        name: "SEARCH_API_TOKEN",
        status: "revoked",
      },
      expectedCode: "SecretHandleRevoked",
      expectedReason: "revoked",
    },
    {
      name: "expired",
      secretRecord: {
        source: "env",
        name: "SEARCH_API_TOKEN",
        expires_at: "2026-06-10T11:00:00.000Z",
      },
      expectedCode: "SecretHandleExpired",
      expectedReason: "expired",
    },
  ];

  for (const fixture of cases) {
    let handlerWasCalled = false;
    const result = await executeAirDocument(secretToolDocument(), {
      entryRef: "skill:test/SearchFlow",
      now: () => Date.parse("2026-06-10T12:00:00.000Z"),
      toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument())),
      secretStore: loadSecretsFromJson(JSON.stringify({
        secrets_version: "touba-secrets-v1",
        secrets: {
          SEARCH_API_KEY: fixture.secretRecord,
        },
      }), {
        env: { SEARCH_API_TOKEN: "resolved-secret-value" },
      }),
      toolHandlers: {
        "tool:test/Search": () => {
          handlerWasCalled = true;
          return "unexpected";
        },
      },
    });

    assert.equal(result.status, "failure", fixture.name);
    assert.equal(handlerWasCalled, false, fixture.name);
    const refused = eventOf(result.trace, "secret_handle_refused");
    assert.equal(refused.payload.tool_ref, "tool:test/Search", fixture.name);
    assert.equal(refused.payload.secret_handle, "SEARCH_API_KEY", fixture.name);
    assert.equal(refused.payload.reason, fixture.expectedReason, fixture.name);
    const failure = eventOf(result.trace, "failure_detected");
    assert.equal(failure.payload.runtime_error_code, fixture.expectedCode, fixture.name);
    assert.deepEqual(failure.payload.secret_handles_refused, ["SEARCH_API_KEY"], fixture.name);
    assert.deepEqual(failure.payload.secret_refusal_reasons, {
      SEARCH_API_KEY: fixture.expectedReason,
    }, fixture.name);
    assert.equal(JSON.stringify(result.trace).includes("resolved-secret-value"), false, fixture.name);
  }
});

test("refuses invalid or incomplete tool binding authority before handler dispatch", async () => {
  const cases = [
    {
      name: "missing manifest",
      options: {},
      expectedMessage: /missing tool binding manifest/,
    },
    {
      name: "missing binding",
      options: {
        toolBindingManifest: loadToolBindingManifestFromJson(
          JSON.stringify(bindingManifestDocument({ bindings: {} })),
        ),
      },
      expectedMessage: /missing manifest binding/,
    },
    {
      name: "missing network grant",
      options: {
        toolBindingManifest: loadToolBindingManifestFromJson(
          JSON.stringify(bindingManifestDocument({ grants: ["secret_read"] })),
        ),
      },
      expectedMessage: /missing required capabilities network/,
    },
    {
      name: "missing secret_read grant",
      options: {
        toolBindingManifest: loadToolBindingManifestFromJson(
          JSON.stringify(bindingManifestDocument({ grants: ["network"], secrets: ["SEARCH_API_KEY"] })),
        ),
      },
      expectedMessage: /secret_read grant missing/,
    },
    {
      name: "secret absent from binding",
      options: {
        toolBindingManifest: loadToolBindingManifestFromJson(
          JSON.stringify(bindingManifestDocument({ secrets: [] })),
        ),
      },
      expectedMessage: /missing required secret handles SEARCH_API_KEY/,
    },
    {
      name: "missing secrets file",
      options: {
        toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument())),
      },
      expectedMessage: /secrets file is required/,
    },
    {
      name: "secret not resolved",
      options: {
        toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument())),
        secretStore: loadSecretsFromJson(JSON.stringify(secretsDocument()), { env: {} }),
      },
      expectedMessage: /not usable.*SEARCH_API_KEY/,
    },
    {
      name: "secret not granted to active agent",
      document: secretToolDocument({ throughAgent: true }),
      options: {
        toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument())),
        secretStore: loadSecretsFromJson(JSON.stringify(secretsDocument()), {
          env: { SEARCH_API_TOKEN: "resolved-secret-value" },
        }),
      },
      expectedMessage: /agent agent:test\/Researcher is not granted/,
    },
  ];

  for (const fixture of cases) {
    let handlerWasCalled = false;
    const result = await executeAirDocument(fixture.document ?? secretToolDocument(), {
      entryRef: fixture.document ? "strategy:test/RunSearch" : "skill:test/SearchFlow",
      toolHandlers: {
        "tool:test/Search": () => {
          handlerWasCalled = true;
          return "unexpected";
        },
      },
      ...fixture.options,
    });

    assert.equal(result.status, "failure", fixture.name);
    assert.equal(handlerWasCalled, false, fixture.name);
    const failureEvent = eventOf(result.trace, "failure_detected");
    assert.match(failureEvent.message, fixture.expectedMessage, fixture.name);
    assert.equal(failureEvent.payload.tool_ref, "tool:test/Search", fixture.name);
    assert.equal(failureEvent.payload.caller_ref, "skill:test/SearchFlow", fixture.name);
    assert.deepEqual(failureEvent.payload.secret_handles_required, ["SEARCH_API_KEY"], fixture.name);
    assert.equal(JSON.stringify(result.trace).includes("resolved-secret-value"), false, fixture.name);
  }
});

test("authorizes memory access through manifest grants and owner scope before dispatch", async () => {
  const result = await executeAirDocument(memoryToolDocument(), {
    entryRef: "skill:test/ReadKnowledgeFlow",
    toolBindingManifest: loadToolBindingManifestFromJson(
      JSON.stringify(memoryBindingManifestDocument()),
    ),
    toolHandlers: {
      "tool:test/ReadProjectKnowledge": ({ binding }) => {
        assert.deepEqual(binding.grants, ["memory_read"]);
        assert.deepEqual(binding.memories, [
          {
            memory_ref: "memory:test/ProjectKnowledge",
            access: "read",
          },
        ]);
        return { documents: [] };
      },
    },
  });

  assert.equal(result.status, "success");
  assert.deepEqual(result.result, { documents: [] });
  assert.deepEqual(eventOf(result.trace, "memory_access_authorized").payload, {
    owner_ref: "skill:test/ReadKnowledgeFlow",
    caller_ref: "skill:test/ReadKnowledgeFlow",
    tool_ref: "tool:test/ReadProjectKnowledge",
    memory_ref: "memory:test/ProjectKnowledge",
    access: "read",
    authority_source: "memory_scope",
  });
  const bindingEvent = eventOf(result.trace, "tool_binding_authorized").payload;
  assert.deepEqual(bindingEvent.memory_accesses_required, [
    {
      memory_ref: "memory:test/ProjectKnowledge",
      access: "read",
    },
  ]);
  assert.deepEqual(bindingEvent.memory_accesses_granted, [
    {
      memory_ref: "memory:test/ProjectKnowledge",
      access: "read",
    },
  ]);
  assert.equal(JSON.stringify(result.trace).includes("knowledge row"), false);
});

test("authorizes memory access from an active agent memory scope", async () => {
  const result = await executeAirDocument(
    memoryToolDocument({ throughAgent: true, skillScope: false, agentScope: true }),
    {
      entryRef: "strategy:test/RunKnowledge",
      toolBindingManifest: loadToolBindingManifestFromJson(
        JSON.stringify(memoryBindingManifestDocument()),
      ),
      toolHandlers: {
        "tool:test/ReadProjectKnowledge": () => "agent-scope-ok",
      },
    },
  );

  assert.equal(result.status, "success");
  assert.equal(result.result, "agent-scope-ok");
  assert.deepEqual(eventOf(result.trace, "memory_access_authorized").payload, {
    owner_ref: "agent:test/Researcher",
    caller_ref: "skill:test/ReadKnowledgeFlow",
    agent_ref: "agent:test/Researcher",
    tool_ref: "tool:test/ReadProjectKnowledge",
    memory_ref: "memory:test/ProjectKnowledge",
    access: "read",
    authority_source: "agent_memory_scope",
  });
});

test("refuses memory access when active agent lacks memory scope even if skill has one", async () => {
  let handlerWasCalled = false;
  const result = await executeAirDocument(
    memoryToolDocument({ throughAgent: true, skillScope: true, agentScope: false }),
    {
      entryRef: "strategy:test/RunKnowledge",
      toolBindingManifest: loadToolBindingManifestFromJson(
        JSON.stringify(memoryBindingManifestDocument()),
      ),
      toolHandlers: {
        "tool:test/ReadProjectKnowledge": () => {
          handlerWasCalled = true;
          return "unexpected";
        },
      },
    },
  );

  assert.equal(result.status, "failure");
  assert.equal(handlerWasCalled, false);
  const refused = eventOf(result.trace, "memory_access_refused");
  assert.equal(refused.payload.owner_ref, "agent:test/Researcher");
  assert.equal(refused.payload.reason, "owner_scope_missing");
  const failure = eventOf(result.trace, "failure_detected");
  assert.equal(failure.payload.runtime_error_code, "MemoryNotGrantedToOwner");
});

test("refuses memory access before handler dispatch when binding, grant or owner scope is missing", async () => {
  const cases = [
    {
      name: "missing memory_read grant",
      document: memoryToolDocument(),
      manifest: memoryBindingManifestDocument({ grants: [], memories: memoryManifestAccesses() }),
      expectedCode: "MemoryGrantMissing",
      expectedReason: "grant_missing",
    },
    {
      name: "memory not granted to binding",
      document: memoryToolDocument(),
      manifest: memoryBindingManifestDocument({ grants: ["memory_read"], memories: [] }),
      expectedCode: "MemoryNotGrantedToBinding",
      expectedReason: "binding_memory_missing",
    },
    {
      name: "memory not granted to owner",
      document: memoryToolDocument({ skillScope: false }),
      manifest: memoryBindingManifestDocument(),
      expectedCode: "MemoryNotGrantedToOwner",
      expectedReason: "owner_scope_missing",
    },
  ];

  for (const fixture of cases) {
    let handlerWasCalled = false;
    const result = await executeAirDocument(fixture.document, {
      entryRef: "skill:test/ReadKnowledgeFlow",
      toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(fixture.manifest)),
      toolHandlers: {
        "tool:test/ReadProjectKnowledge": () => {
          handlerWasCalled = true;
          return "unexpected";
        },
      },
    });

    assert.equal(result.status, "failure", fixture.name);
    assert.equal(handlerWasCalled, false, fixture.name);
    const refused = eventOf(result.trace, "memory_access_refused");
    assert.equal(refused.payload.tool_ref, "tool:test/ReadProjectKnowledge", fixture.name);
    assert.equal(refused.payload.memory_ref, "memory:test/ProjectKnowledge", fixture.name);
    assert.equal(refused.payload.access, "read", fixture.name);
    assert.equal(refused.payload.reason, fixture.expectedReason, fixture.name);
    const failure = eventOf(result.trace, "failure_detected");
    assert.equal(failure.payload.runtime_error_code, fixture.expectedCode, fixture.name);
    assert.deepEqual(failure.payload.required_memory_accesses, [
      {
        memory_ref: "memory:test/ProjectKnowledge",
        access: "read",
      },
    ], fixture.name);
    assert.equal(JSON.stringify(result.trace).includes("knowledge row"), false, fixture.name);
  }
});

test("traces PI-1 memory provenance and integrity metadata from a process handler", async () => {
  const handlerScript = `
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => {
      const request = JSON.parse(input);
      const binding = request.resource_bindings?.[0];
      if (binding?.resource_ref !== "memory:test/ProjectKnowledge"
        || binding.kind !== "memory_backend"
        || binding.provider !== "host.http.project_knowledge"
        || binding.config?.endpoint_url !== "http://127.0.0.1:39017/memory/project-knowledge") {
        process.stderr.write("missing expected resource binding");
        process.exit(1);
      }
      process.stdout.write(JSON.stringify({
        ok: true,
        value: { documents: [] },
        memory_metadata: [
          {
            memory_ref: "memory:test/ProjectKnowledge",
            operation: "read",
            source_kind: "backend_import",
            source_ref: "source:project-knowledge/main",
            writer_ref: "handler:read_project_knowledge",
            written_at: "2026-05-17T12:00:00Z",
            digest_kind: "sha256",
            digest: "sha256:opaque-digest",
            schema_ref: "schema:test/KnowledgeEntry",
            version_ref: "backend-version:42",
            integrity_evidence: "digest_reported"
          }
        ]
      }));
    });
  `;

  const result = await executeAirDocument(memoryToolDocument(), {
    entryRef: "skill:test/ReadKnowledgeFlow",
    toolBindingManifest: loadToolBindingManifestFromJson(
      JSON.stringify(processMemoryBindingManifestDocument(handlerScript)),
    ),
    resourceBindings: memoryResourceBindingsDocument(),
  });

  assert.equal(result.status, "success");
  assert.deepEqual(result.result, { documents: [] });
  assert.deepEqual(eventOf(result.trace, "tool_binding_authorized").payload.resource_bindings, [
    {
      resource_ref: "memory:test/ProjectKnowledge",
      kind: "memory_backend",
      provider: "host.http.project_knowledge",
    },
  ]);
  assert.deepEqual(eventOf(result.trace, "memory_provenance_observed").payload, {
    owner_ref: "skill:test/ReadKnowledgeFlow",
    caller_ref: "skill:test/ReadKnowledgeFlow",
    memory_ref: "memory:test/ProjectKnowledge",
    operation: "read",
    tool_ref: "tool:test/ReadProjectKnowledge",
    source_kind: "backend_import",
    source_ref: "source:project-knowledge/main",
    writer_ref: "handler:read_project_knowledge",
    written_at: "2026-05-17T12:00:00Z",
    integrity_evidence: "digest_reported",
  });
  assert.deepEqual(eventOf(result.trace, "memory_integrity_observed").payload, {
    owner_ref: "skill:test/ReadKnowledgeFlow",
    caller_ref: "skill:test/ReadKnowledgeFlow",
    memory_ref: "memory:test/ProjectKnowledge",
    operation: "read",
    tool_ref: "tool:test/ReadProjectKnowledge",
    integrity_evidence: "digest_reported",
    digest_kind: "sha256",
    digest: "sha256:opaque-digest",
    schema_ref: "schema:test/KnowledgeEntry",
    version_ref: "backend-version:42",
  });
  assert.equal(JSON.stringify(result.trace).includes("knowledge row"), false);
});

test("refuses malformed PI-1 memory metadata without tracing raw content", async () => {
  const cases = [
    {
      name: "raw content field",
      metadata: {
        memory_ref: "memory:test/ProjectKnowledge",
        operation: "read",
        source_kind: "backend_import",
        source_ref: "source:project-knowledge/main",
        integrity_evidence: "handler_reported",
        content: "knowledge row must not be traced",
      },
      expectedCode: "MemoryMetadataLeakDetected",
      expectedReason: "metadata_leak_detected",
      forbiddenText: "knowledge row must not be traced",
    },
    {
      name: "unauthorized write operation",
      metadata: {
        memory_ref: "memory:test/ProjectKnowledge",
        operation: "write",
        source_kind: "backend_import",
        source_ref: "source:project-knowledge/main",
        integrity_evidence: "handler_reported",
      },
      expectedCode: "MemoryMetadataUnauthorized",
      expectedReason: "unauthorized_memory_metadata",
      forbiddenText: "source:project-knowledge/main",
    },
  ];

  for (const fixture of cases) {
    const handlerScript = `
      process.stdout.write(JSON.stringify({
        ok: true,
        value: { documents: [] },
        memory_metadata: [${JSON.stringify(fixture.metadata)}]
      }));
    `;

    const result = await executeAirDocument(memoryToolDocument(), {
      entryRef: "skill:test/ReadKnowledgeFlow",
      toolBindingManifest: loadToolBindingManifestFromJson(
        JSON.stringify(processMemoryBindingManifestDocument(handlerScript)),
      ),
    });

    assert.equal(result.status, "failure", fixture.name);
    const refused = eventOf(result.trace, "memory_metadata_refused");
    assert.equal(refused.payload.tool_ref, "tool:test/ReadProjectKnowledge", fixture.name);
    assert.equal(refused.payload.reason, fixture.expectedReason, fixture.name);
    assert.equal(refused.payload.runtime_error_code, fixture.expectedCode, fixture.name);
    const failure = eventOf(result.trace, "failure_detected");
    assert.equal(failure.payload.runtime_error_code, fixture.expectedCode, fixture.name);
    assert.equal(JSON.stringify(result.trace).includes(fixture.forbiddenText), false, fixture.name);
  }
});

test("refuses PI-1 metadata containing a resolved secret value", async () => {
  const secretValue = "resolved-\"secret\"\nwith\\slashes-never-disclose";
  const handlerScript = `
    process.stdout.write(JSON.stringify({
      ok: true,
      value: { documents: [] },
      memory_metadata: [
        {
          memory_ref: "memory:test/ProjectKnowledge",
          operation: "read",
          source_kind: "backend_import",
          source_ref: ${JSON.stringify(secretValue)},
          integrity_evidence: "handler_reported"
        }
      ]
    }));
  `;

  const manifestDocument = processMemoryBindingManifestDocument(handlerScript);
  manifestDocument.manifest_version = "touba-manifest-v2";
  manifestDocument.bindings["tool:test/ReadProjectKnowledge"].effect_contract = { kind: "none" };
  const observed = [];

  const result = await executeAirDocument(memoryToolDocument(), {
    entryRef: "skill:test/ReadKnowledgeFlow",
    runId: "run:memory-metadata-secret",
    operationId: "operation:memory-metadata-secret",
    effectScopeId: "operation:memory-metadata-secret",
    toolBindingManifest: loadToolBindingManifestFromJson(
      JSON.stringify(manifestDocument),
    ),
    secretStore: loadSecretsFromJson(JSON.stringify(secretsDocument()), {
      env: { SEARCH_API_TOKEN: secretValue },
    }),
    effectJournal: {
      schemaVersion: EFFECT_JOURNAL_SCHEMA_VERSION,
      readEntry: () => null,
      writeEntry: () => {},
      entriesForScope: () => [],
    },
    executionCheckpointObserver: async (snapshot) => {
      observed.push(structuredClone(snapshot));
    },
  });

  assert.equal(result.status, "failure");
  assert.equal(eventOf(result.trace, "memory_metadata_refused").payload.runtime_error_code, "MemoryMetadataLeakDetected");
  const failure = eventOf(result.trace, "failure_detected");
  assert.equal(failure.payload.runtime_error_code, "MemoryMetadataLeakDetected");
  assert.deepEqual(failure.payload.secret_handles_refused, ["SEARCH_API_KEY"]);
  assert.equal(JSON.stringify(result.trace).includes(secretValue), false);
  assert.equal(JSON.stringify(observed).includes(secretValue), false);
});

test("executes a process tool handler V1 with JSON protocol and minimal secret environment", async () => {
  const previousLeak = process.env.TOUBA_SHOULD_NOT_LEAK;
  process.env.TOUBA_SHOULD_NOT_LEAK = "host-only";

  const handlerScript = `
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const request = JSON.parse(input);
      process.stdout.write(JSON.stringify({
        ok: true,
        value: {
          protocol: request.protocol,
          tool_ref: request.tool_ref,
          arguments: request.arguments,
          grants: request.grants,
          memory_accesses: request.memory_accesses,
          secret_handles: request.secret_handles,
          has_authorized_secret: process.env.SEARCH_API_KEY === "resolved-secret-value",
          inherited_env_visible: Object.hasOwn(process.env, "TOUBA_SHOULD_NOT_LEAK"),
          secret_value_in_stdin: input.includes("resolved-secret-value")
        }
      }));
    });
  `;

  try {
    const result = await executeAirDocument(processToolDocument(), {
      entryRef: "skill:test/SearchFlow",
      inputs: {
        query: "touba",
      },
      toolBindingManifest: loadToolBindingManifestFromJson(
        JSON.stringify(processBindingManifestDocument(handlerScript)),
      ),
      secretStore: loadSecretsFromJson(JSON.stringify(secretsDocument()), {
        env: { SEARCH_API_TOKEN: "resolved-secret-value" },
      }),
    });

    assert.equal(result.status, "success");
    assert.deepEqual(result.result, {
      protocol: "touba-tool-handler-v1",
      tool_ref: "tool:test/Search",
      arguments: { query: "touba" },
      grants: ["network", "secret_read"],
      memory_accesses: [],
      secret_handles: ["SEARCH_API_KEY"],
      has_authorized_secret: true,
      inherited_env_visible: false,
      secret_value_in_stdin: false,
    });
    assert.equal(JSON.stringify(result.trace).includes("resolved-secret-value"), false);
  } finally {
    if (previousLeak === undefined) {
      delete process.env.TOUBA_SHOULD_NOT_LEAK;
    } else {
      process.env.TOUBA_SHOULD_NOT_LEAK = previousLeak;
    }
  }
});

test("reports process tool handler timeout, invalid output and oversized output", async () => {
  const cases = [
    {
      name: "timeout",
      script: "setTimeout(() => {}, 1000);",
      manifestOptions: { timeoutMs: 20 },
      expectedMessage: /timed out/,
    },
    {
      name: "invalid JSON",
      script: "process.stdout.write('not json');",
      expectedMessage: /invalid JSON/,
    },
    {
      name: "oversized stdout",
      script: "process.stdout.write(JSON.stringify({ ok: true, value: 'x'.repeat(1024) }));",
      manifestOptions: { maxPayloadBytes: 512 },
      expectedMessage: /stdout exceeded max_payload_bytes/,
    },
  ];

  for (const fixture of cases) {
    const result = await executeAirDocument(processToolDocument(), {
      entryRef: "skill:test/SearchFlow",
      inputs: {
        query: "touba",
      },
      toolBindingManifest: loadToolBindingManifestFromJson(
        JSON.stringify(processBindingManifestDocument(fixture.script, fixture.manifestOptions)),
      ),
      secretStore: loadSecretsFromJson(JSON.stringify(secretsDocument()), {
        env: { SEARCH_API_TOKEN: "resolved-secret-value" },
      }),
    });

    assert.equal(result.status, "failure", fixture.name);
    assert.match(eventOf(result.trace, "failure_detected").message, fixture.expectedMessage, fixture.name);
    assert.equal(JSON.stringify(result.trace).includes("resolved-secret-value"), false, fixture.name);
  }
});

test("redacts secrets from process handler controlled errors and non-zero exits", async () => {
  const cases = [
    {
      name: "controlled error",
      script:
        "process.stdout.write(JSON.stringify({ ok: false, error: { code: 'Denied', message: process.env.SEARCH_API_KEY } }));",
      expectedMessage: /returned error.*\[redacted-secret\]/,
    },
    {
      name: "non-zero exit",
      script: "process.stderr.write(process.env.SEARCH_API_KEY); process.exit(2);",
      expectedMessage: /exited non-zero.*\[redacted-secret\]/,
    },
  ];

  for (const fixture of cases) {
    const result = await executeAirDocument(processToolDocument(), {
      entryRef: "skill:test/SearchFlow",
      inputs: {
        query: "touba",
      },
      toolBindingManifest: loadToolBindingManifestFromJson(
        JSON.stringify(processBindingManifestDocument(fixture.script)),
      ),
      secretStore: loadSecretsFromJson(JSON.stringify(secretsDocument()), {
        env: { SEARCH_API_TOKEN: "resolved-secret-value" },
      }),
    });

    const message = eventOf(result.trace, "failure_detected").message;
    assert.equal(result.status, "failure", fixture.name);
    assert.match(message, fixture.expectedMessage, fixture.name);
    assert.equal(JSON.stringify(result.trace).includes("resolved-secret-value"), false, fixture.name);
  }
});

test("refuses resolved secret values in tool arguments before handler dispatch", async () => {
  let handlerWasCalled = false;
  const resolvedSecret = 'resolved-"secret"\nwith\\slashes-never-disclose';
  const result = await executeAirDocument(processToolDocument(), {
    entryRef: "skill:test/SearchFlow",
    inputs: {
      query: resolvedSecret,
    },
    toolBindingManifest: loadToolBindingManifestFromJson(
      JSON.stringify(processBindingManifestDocument("process.stdout.write('{}');")),
    ),
    secretStore: loadSecretsFromJson(JSON.stringify(secretsDocument()), {
      env: { SEARCH_API_TOKEN: resolvedSecret },
    }),
    toolHandlers: {
      "tool:test/Search": () => {
        handlerWasCalled = true;
        return "unexpected";
      },
    },
  });

  assert.equal(result.status, "failure");
  assert.equal(handlerWasCalled, false);
  const failure = eventOf(result.trace, "failure_detected");
  assert.equal(failure.payload.runtime_error_code, "SecretValueInToolArguments");
  assert.equal(failure.payload.tool_ref, "tool:test/Search");
  assert.deepEqual(failure.payload.secret_handles_refused, ["SEARCH_API_KEY"]);
  assert.equal(JSON.stringify(result.trace).includes(resolvedSecret), false);
});

test("redacts secrets from in-process handler errors", async () => {
  const result = await executeAirDocument(processToolDocument(), {
    entryRef: "skill:test/SearchFlow",
    inputs: {
      query: "touba",
    },
    toolBindingManifest: loadToolBindingManifestFromJson(
      JSON.stringify(processBindingManifestDocument("process.stdout.write('{}');")),
    ),
    secretStore: loadSecretsFromJson(JSON.stringify(secretsDocument()), {
      env: { SEARCH_API_TOKEN: "resolved-secret-value" },
    }),
    toolHandlers: {
      "tool:test/Search": () => {
        throw new Error("handler leaked resolved-secret-value");
      },
    },
  });

  const message = eventOf(result.trace, "failure_detected").message;
  assert.equal(result.status, "failure");
  assert.match(message, /\[redacted-secret\]/);
  assert.equal(JSON.stringify(result.trace).includes("resolved-secret-value"), false);
});

test("validates tool input payloads before handler dispatch", async () => {
  let handlerWasCalled = false;
  const result = await executeAirDocument(toolPayloadSchemaDocument(), {
    entryRef: "skill:test/SearchFlow",
    inputs: {
      request: {
        query: "parks",
        rows: "1",
        tags: ["open-data"],
      },
    },
    toolHandlers: {
      "tool:test/Search": () => {
        handlerWasCalled = true;
        return { title: "unexpected", score: 1 };
      },
    },
  });

  assert.equal(result.status, "failure");
  assert.equal(handlerWasCalled, false);
  const failure = eventOf(result.trace, "failure_detected");
  assert.equal(failure.payload.runtime_error_code, "ToolInputSchemaInvalid");
  assert.equal(failure.payload.schema_path, "arguments.request.rows");
  assert.equal(failure.payload.expected_type_ref, "builtin:Int");
  assert.equal(failure.payload.actual_type, "string");
  assert.equal(JSON.stringify(result.trace).includes("parks"), false);
});

test("validates tool output payloads before result binding", async () => {
  const result = await executeAirDocument(toolPayloadSchemaDocument(), {
    entryRef: "skill:test/SearchFlow",
    inputs: {
      request: {
        query: "parks",
        rows: 1,
        tags: ["open-data"],
      },
    },
    toolHandlers: {
      "tool:test/Search": () => ({
        title: "dataset",
      }),
    },
  });

  assert.equal(result.status, "failure");
  const failure = eventOf(result.trace, "failure_detected");
  assert.equal(failure.payload.runtime_error_code, "ToolOutputSchemaInvalid");
  assert.equal(failure.payload.schema_path, "value");
  assert.deepEqual(failure.payload.missing_fields, ["score"]);
  assert.equal(JSON.stringify(result.trace).includes("dataset"), false);
});

test("accepts tool payloads matching builtin, list and local schemas", async () => {
  const result = await executeAirDocument(toolPayloadSchemaDocument(), {
    entryRef: "skill:test/SearchFlow",
    inputs: {
      request: {
        query: "parks",
        rows: 1,
        tags: ["open-data"],
      },
    },
    toolHandlers: {
      "tool:test/Search": () => ({
        title: "dataset",
        score: 0.75,
      }),
    },
  });

  assert.equal(result.status, "success");
  assert.deepEqual(result.result, {
    title: "dataset",
    score: 0.75,
  });
});

test("enforces manifest input payload constraints before handler dispatch", async () => {
  let handlerWasCalled = false;
  const result = await executeAirDocument(toolPayloadSchemaDocument(), {
    entryRef: "skill:test/SearchFlow",
    inputs: {
      request: {
        query: "   ",
        rows: 1,
        tags: ["open-data"],
      },
    },
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument({
      bindings: {
        "tool:test/Search": {
          ...bindingManifestDocument().bindings["tool:test/Search"],
          payload_constraints: {
            input: {
              "request.query": {
                non_empty: true,
                max_length: 16,
              },
              "request.rows": {
                min: 1,
                max: 10,
              },
            },
          },
        },
      },
    }))),
    toolHandlers: {
      "tool:test/Search": () => {
        handlerWasCalled = true;
        return { title: "unexpected", score: 1 };
      },
    },
  });

  assert.equal(result.status, "failure");
  assert.equal(handlerWasCalled, false);
  const failure = eventOf(result.trace, "failure_detected");
  assert.equal(failure.payload.runtime_error_code, "ToolPayloadConstraintViolation");
  assert.equal(failure.payload.constraint_path, "request.query");
  assert.equal(failure.payload.payload_constraint, "non_empty");
  assert.equal(JSON.stringify(result.trace).includes("open-data"), false);
});

test("enforces PC-2 allowed input payload values before handler dispatch", async () => {
  let handlerWasCalled = false;
  const result = await executeAirDocument(toolPayloadSchemaDocument(), {
    entryRef: "skill:test/SearchFlow",
    inputs: {
      request: {
        query: "manual-transfer",
        rows: 5,
        tags: ["finance"],
      },
    },
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument({
      bindings: {
        "tool:test/Search": {
          ...bindingManifestDocument().bindings["tool:test/Search"],
          payload_constraints: {
            input: {
              "request.query": {
                allowed_values: ["approved-search", "regulated-search"],
              },
              "request.rows": {
                allowed_values: [1, 5, 10],
              },
            },
          },
        },
      },
    }))),
    toolHandlers: {
      "tool:test/Search": () => {
        handlerWasCalled = true;
        return { title: "unexpected", score: 1 };
      },
    },
  });

  assert.equal(result.status, "failure");
  assert.equal(handlerWasCalled, false);
  const failure = eventOf(result.trace, "failure_detected");
  assert.equal(failure.payload.runtime_error_code, "ToolPayloadConstraintViolation");
  assert.equal(failure.payload.constraint_path, "request.query");
  assert.equal(failure.payload.payload_constraint, "allowed_values");
  assert.equal(failure.payload.allowed_values_count, 2);
  assert.equal(JSON.stringify(result.trace).includes("manual-transfer"), false);
  assert.equal(JSON.stringify(result.trace).includes("approved-search"), false);
});

test("enforces manifest output payload constraints before result publication", async () => {
  const result = await executeAirDocument(toolPayloadSchemaDocument(), {
    entryRef: "skill:test/SearchFlow",
    inputs: {
      request: {
        query: "parks",
        rows: 1,
        tags: ["open-data"],
      },
    },
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument({
      bindings: {
        "tool:test/Search": {
          ...bindingManifestDocument().bindings["tool:test/Search"],
          payload_constraints: {
            output: {
              title: {
                max_length: 4,
              },
              score: {
                min: 0,
                max: 1,
              },
            },
          },
        },
      },
    }))),
    toolHandlers: {
      "tool:test/Search": () => ({
        title: "dataset",
        score: 0.75,
      }),
    },
  });

  assert.equal(result.status, "failure");
  const failure = eventOf(result.trace, "failure_detected");
  assert.equal(failure.payload.runtime_error_code, "ToolPayloadConstraintViolation");
  assert.equal(failure.payload.constraint_path, "title");
  assert.equal(failure.payload.payload_constraint, "max_length");
  assert.equal(failure.payload.payload_constraint_limit_value, 4);
  assert.equal(failure.payload.observed_length, 7);
  assert.equal(JSON.stringify(result.trace).includes("dataset"), false);
});

test("enforces PC-2 allowed output payload values before result publication", async () => {
  const result = await executeAirDocument(toolPayloadSchemaDocument(), {
    entryRef: "skill:test/SearchFlow",
    inputs: {
      request: {
        query: "parks",
        rows: 1,
        tags: ["open-data"],
      },
    },
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument({
      bindings: {
        "tool:test/Search": {
          ...bindingManifestDocument().bindings["tool:test/Search"],
          payload_constraints: {
            output: {
              title: {
                allowed_values: ["public-dataset", "internal-dataset"],
              },
            },
          },
        },
      },
    }))),
    toolHandlers: {
      "tool:test/Search": () => ({
        title: "restricted-dataset",
        score: 0.75,
      }),
    },
  });

  assert.equal(result.status, "failure");
  const failure = eventOf(result.trace, "failure_detected");
  assert.equal(failure.payload.runtime_error_code, "ToolPayloadConstraintViolation");
  assert.equal(failure.payload.constraint_path, "title");
  assert.equal(failure.payload.payload_constraint, "allowed_values");
  assert.equal(failure.payload.payload_constraint_limit_value, 2);
  assert.equal(JSON.stringify(result.trace).includes("restricted-dataset"), false);
  assert.equal(JSON.stringify(result.trace).includes("public-dataset"), false);
});

test("enforces PC-3A list cardinality input constraints before handler dispatch", async () => {
  let handlerWasCalled = false;
  const result = await executeAirDocument(listPayloadConstraintDocument(), {
    entryRef: "skill:test/BatchFlow",
    inputs: {
      request: {
        recipients: ["a@example.test", "b@example.test", "c@example.test"],
      },
    },
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument({
      bindings: {
        "tool:test/SendBatch": {
          ...bindingManifestDocument().bindings["tool:test/Search"],
          payload_constraints: {
            input: {
              "request.recipients": {
                min_items: 1,
                max_items: 2,
              },
            },
          },
        },
      },
    }))),
    toolHandlers: {
      "tool:test/SendBatch": () => {
        handlerWasCalled = true;
        return ["unexpected"];
      },
    },
  });

  assert.equal(result.status, "failure");
  assert.equal(handlerWasCalled, false);
  const failure = eventOf(result.trace, "failure_detected");
  assert.equal(failure.payload.runtime_error_code, "ToolPayloadConstraintViolation");
  assert.equal(failure.payload.constraint_path, "request.recipients");
  assert.equal(failure.payload.payload_constraint, "max_items");
  assert.equal(failure.payload.payload_constraint_limit_value, 2);
  assert.equal(failure.payload.observed_length, 3);
  assert.equal(JSON.stringify(result.trace).includes("a@example.test"), false);
});

test("enforces PC-3A minimum list cardinality before handler dispatch", async () => {
  let handlerWasCalled = false;
  const result = await executeAirDocument(listPayloadConstraintDocument(), {
    entryRef: "skill:test/BatchFlow",
    inputs: {
      request: {
        recipients: [],
      },
    },
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument({
      bindings: {
        "tool:test/SendBatch": {
          ...bindingManifestDocument().bindings["tool:test/Search"],
          payload_constraints: {
            input: {
              "request.recipients": {
                min_items: 1,
              },
            },
          },
        },
      },
    }))),
    toolHandlers: {
      "tool:test/SendBatch": () => {
        handlerWasCalled = true;
        return ["unexpected"];
      },
    },
  });

  assert.equal(result.status, "failure");
  assert.equal(handlerWasCalled, false);
  const failure = eventOf(result.trace, "failure_detected");
  assert.equal(failure.payload.runtime_error_code, "ToolPayloadConstraintViolation");
  assert.equal(failure.payload.constraint_path, "request.recipients");
  assert.equal(failure.payload.payload_constraint, "min_items");
  assert.equal(failure.payload.payload_constraint_limit_value, 1);
  assert.equal(failure.payload.observed_length, 0);
});

test("enforces PC-3A root output list cardinality before result publication", async () => {
  const result = await executeAirDocument(listPayloadConstraintDocument(), {
    entryRef: "skill:test/BatchFlow",
    inputs: {
      request: {
        recipients: ["a@example.test"],
      },
    },
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument({
      bindings: {
        "tool:test/SendBatch": {
          ...bindingManifestDocument().bindings["tool:test/Search"],
          payload_constraints: {
            output: {
              "$": {
                max_items: 1,
              },
            },
          },
        },
      },
    }))),
    toolHandlers: {
      "tool:test/SendBatch": () => ["sent-a", "sent-b"],
    },
  });

  assert.equal(result.status, "failure");
  const failure = eventOf(result.trace, "failure_detected");
  assert.equal(failure.payload.runtime_error_code, "ToolPayloadConstraintViolation");
  assert.equal(failure.payload.constraint_path, "$");
  assert.equal(failure.payload.payload_constraint, "max_items");
  assert.equal(failure.payload.payload_constraint_limit_value, 1);
  assert.equal(failure.payload.observed_length, 2);
  assert.equal(JSON.stringify(result.trace).includes("sent-a"), false);
});

test("accepts PC-3A list cardinality constraints inside declared bounds", async () => {
  const result = await executeAirDocument(listPayloadConstraintDocument(), {
    entryRef: "skill:test/BatchFlow",
    inputs: {
      request: {
        recipients: ["a@example.test", "b@example.test"],
      },
    },
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument({
      bindings: {
        "tool:test/SendBatch": {
          ...bindingManifestDocument().bindings["tool:test/Search"],
          payload_constraints: {
            input: {
              "request.recipients": {
                min_items: 1,
                max_items: 2,
              },
            },
            output: {
              "$": {
                min_items: 1,
                max_items: 2,
              },
            },
          },
        },
      },
    }))),
    toolHandlers: {
      "tool:test/SendBatch": () => ["sent-a", "sent-b"],
    },
  });

  assert.equal(result.status, "success");
  assert.deepEqual(result.result, ["sent-a", "sent-b"]);
});

test("rejects invalid manifest payload constraints", () => {
  assert.throws(
    () => loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument({
      bindings: {
        "tool:test/Search": {
          ...bindingManifestDocument().bindings["tool:test/Search"],
          payload_constraints: {
            input: {
              "request.query": {
                regex: "^open",
              },
            },
          },
        },
      },
    }))),
    (error) =>
      error instanceof ToubaRuntimeError && error.code === "InvalidToolBindingManifest",
  );

  assert.throws(
    () => loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument({
      bindings: {
        "tool:test/Search": {
          ...bindingManifestDocument().bindings["tool:test/Search"],
          payload_constraints: {
            input: {
              "request.rows": {
                min: 10,
                max: 1,
              },
            },
          },
        },
      },
    }))),
    (error) =>
      error instanceof ToubaRuntimeError && error.code === "InvalidToolBindingManifest",
  );

  assert.throws(
    () => loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument({
      bindings: {
        "tool:test/Search": {
          ...bindingManifestDocument().bindings["tool:test/Search"],
          payload_constraints: {
            input: {
              "request.query": {
                allowed_values: [],
              },
            },
          },
        },
      },
    }))),
    (error) =>
      error instanceof ToubaRuntimeError && error.code === "InvalidToolBindingManifest",
  );

  assert.throws(
    () => loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument({
      bindings: {
        "tool:test/Search": {
          ...bindingManifestDocument().bindings["tool:test/Search"],
          payload_constraints: {
            input: {
              "request.query": {
                allowed_values: ["approved", "approved"],
              },
            },
          },
        },
      },
    }))),
    (error) =>
      error instanceof ToubaRuntimeError && error.code === "InvalidToolBindingManifest",
  );

  assert.throws(
    () => loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument({
      bindings: {
        "tool:test/Search": {
          ...bindingManifestDocument().bindings["tool:test/Search"],
          payload_constraints: {
            input: {
              "request.tags": {
                min_items: "1",
              },
            },
          },
        },
      },
    }))),
    (error) =>
      error instanceof ToubaRuntimeError && error.code === "InvalidToolBindingManifest",
  );

  assert.throws(
    () => loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument({
      bindings: {
        "tool:test/Search": {
          ...bindingManifestDocument().bindings["tool:test/Search"],
          payload_constraints: {
            input: {
              "request.tags": {
                max_items: -1,
              },
            },
          },
        },
      },
    }))),
    (error) =>
      error instanceof ToubaRuntimeError && error.code === "InvalidToolBindingManifest",
  );

  assert.throws(
    () => loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument({
      bindings: {
        "tool:test/Search": {
          ...bindingManifestDocument().bindings["tool:test/Search"],
          payload_constraints: {
            input: {
              "request.tags": {
                min_items: 3,
                max_items: 2,
              },
            },
          },
        },
      },
    }))),
    (error) =>
      error instanceof ToubaRuntimeError && error.code === "InvalidToolBindingManifest",
  );
});

test("resolves call arguments and exposes explicit result bindings", async () => {
  const document = baseDocument({
    tools: [
      {
        id: "tool:test/Fetch",
        name: "Fetch",
        signature: {
          inputs: [
            {
              name: "request",
              type_ref: "type:test/Request",
              source_ref: sourceRef(),
            },
          ],
          output_type: "type:test/Text",
        },
        source_ref: sourceRef(),
      },
    ],
    skills: [skill("Build", "graph:skill:test/Build", ["tool:test/Fetch"])],
    graphs: [
      graph("graph:skill:test/Build", "skill:test/Build", [
        node("n1", "call_tool", {
          target_ref: "tool:test/Fetch",
          arguments: ["value:original"],
          result_binding: "source",
        }),
        node("n2", "give", { arguments: ["value:source"] }),
      ], [
        edge("n1", "n2", "next"),
      ]),
    ],
  });

  const result = await executeAirDocument(document, {
    entryRef: "skill:test/Build",
    inputs: {
      original: "input request",
    },
    toolHandlers: {
      "tool:test/Fetch": ({ arguments: args }) => {
        assert.deepEqual(args, { request: "input request" });
        return "resolved source";
      },
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.result, "resolved source");
  assert.equal(eventOf(result.trace, "call_completed").payload.result_binding, "source");
});

test("fails observably when an AIR call argument value is absent", async () => {
  const document = baseDocument({
    tools: [tool("Fetch")],
    skills: [skill("Build", "graph:skill:test/Build", ["tool:test/Fetch"])],
    graphs: [
      graph("graph:skill:test/Build", "skill:test/Build", [
        node("n1", "call_tool", {
          target_ref: "tool:test/Fetch",
          arguments: ["value:missing"],
        }),
      ]),
    ],
  });

  const result = await executeAirDocument(document, {
    entryRef: "skill:test/Build",
    toolHandlers: {
      "tool:test/Fetch": () => "unused",
    },
  });

  assert.equal(result.status, "failure");
  assert.equal(result.trace.events.at(-1).payload.status, "failure");
});

test("evaluates a branch from an explicit local boolean value", async () => {
  const document = baseDocument({
    skills: [skill("Review", "graph:skill:test/Review")],
    graphs: [
      graph("graph:skill:test/Review", "skill:test/Review", [
        node("n1", "branch", { condition_ref: "value:accepted" }),
        node("n2", "give", { arguments: ["literal:string:accepted"] }),
        node("n3", "stop"),
      ], [
        edge("n1", "n2", "true"),
        edge("n1", "n3", "false"),
      ]),
    ],
  });

  const accepted = await executeAirDocument(document, {
    entryRef: "skill:test/Review",
    inputs: {
      accepted: true,
    },
  });
  assert.equal(accepted.status, "success");
  assert.equal(accepted.result, "accepted");
  assertTraceShape(accepted.trace, "skill:test/Review");
  assert.equal(eventOf(accepted.trace, "branch_evaluated").payload.selected_edge_role, "true");

  const stopped = await executeAirDocument(document, {
    entryRef: "skill:test/Review",
    inputs: {
      accepted: false,
    },
  });
  assert.equal(stopped.status, "stopped");
  assert.equal(eventOf(stopped.trace, "branch_evaluated").payload.selected_edge_role, "false");
});

test("pauses human approval without a decision and resumes when approved", async () => {
  const document = humanApprovalDocument();

  const paused = await executeAirDocument(document, {
    entryRef: "skill:test/NeedsApproval",
    inputs: {
      change: { summary: "needs review" },
    },
  });

  assert.equal(paused.status, "stopped");
  assertKinds(paused.trace, [
    "run_started",
    "scope_entered",
    "human_approval_requested",
    "human_approval_paused",
    "scope_exited",
    "run_completed",
  ]);
  assert.deepEqual(eventOf(paused.trace, "human_approval_requested").payload, {
    approval_ref: "approval:test:required",
    mode: "required_approval",
    context_refs: ["value:change"],
    caller_ref: "skill:test/NeedsApproval",
    required_by_ref: "skill:test/NeedsApproval",
  });

  const approved = await executeAirDocument(document, {
    entryRef: "skill:test/NeedsApproval",
    inputs: {
      change: { summary: "needs review" },
    },
    humanApprovalDecisions: {
      "approval:test:required": "approved",
    },
  });

  assert.equal(approved.status, "success");
  assert.equal(approved.result, "approved");
  assert.equal(eventOf(approved.trace, "human_approval_decided").payload.decision, "approved");
  assert.deepEqual(eventOf(approved.trace, "human_approval_resumed").payload, {
    approval_ref: "approval:test:required",
    resume_target_ref: "n2",
    decision_binding: "approval",
  });
});

test("cancels a run before the first dispatch when host requested cancellation", async () => {
  const document = baseDocument({
    skills: [skill("Build", "graph:skill:test/Build")],
    graphs: [
      graph("graph:skill:test/Build", "skill:test/Build", [
        node("n1", "give", { arguments: ["literal:string:unused"] }),
      ]),
    ],
  });

  const result = await executeAirDocument(document, {
    entryRef: "skill:test/Build",
    cancelRequested: true,
  });

  assert.equal(result.status, "cancelled");
  assertKinds(result.trace, [
    "run_started",
    "run_cancel_requested",
    "dispatch_refused_cancelled",
    "run_cancelled",
    "run_completed",
  ]);
  assert.deepEqual(eventOf(result.trace, "run_cancel_requested").payload, {
    authority_source: "host",
    reason: "cancel_requested",
    scope: "runtime",
  });
  assert.equal(
    eventOf(result.trace, "dispatch_refused_cancelled").payload.target_ref,
    "skill:test/Build",
  );
  assert.equal(eventOf(result.trace, "run_completed").payload.status, "cancelled");
});

test("streams immutable trace events without changing the canonical trace", async () => {
  const observed = [];
  const document = baseDocument({
    skills: [skill("Build", "graph:skill:test/Build")],
    graphs: [
      graph("graph:skill:test/Build", "skill:test/Build", [
        node("n1", "give", { arguments: ["literal:string:observed"] }),
      ]),
    ],
  });
  const result = await executeAirDocument(document, {
    entryRef: "skill:test/Build",
    traceEventObserver(event) {
      observed.push(event);
      event.kind = "observer_mutation";
    },
  });

  assert.equal(result.status, "success");
  assert.deepEqual(
    observed.map((event) => event.kind),
    result.trace.events.map((event) => event.kind).map(() => "observer_mutation"),
  );
  assert.equal(result.trace.events[0].kind, "run_started");
  assert.equal(result.trace.events.at(-1).kind, "run_completed");
});

test("observes a host cancellation request before a later dispatch", async () => {
  let cancelRequested = false;
  let secondToolCalled = false;
  const result = await executeAirDocument(twoToolDispatchDocument(), {
    entryRef: "skill:test/TwoTools",
    cancelRequestedProvider: () => cancelRequested,
    traceEventObserver(event) {
      if (event.kind === "call_completed" && event.payload?.target_ref === "tool:test/First") {
        cancelRequested = true;
      }
    },
    toolHandlers: {
      "tool:test/First": () => "first",
      "tool:test/Second": () => {
        secondToolCalled = true;
        return "second";
      },
    },
  });

  assert.equal(result.status, "cancelled");
  assert.equal(result.trace.events.some((event) => event.kind === "run_cancel_requested"), true);
  assert.equal(result.trace.events.some((event) => event.kind === "dispatch_refused_cancelled"), true);
  assert.equal(secondToolCalled, false);
});

test("cancels a paused human approval when host requests cancellation on pause", async () => {
  const result = await executeAirDocument(humanApprovalDocument(), {
    entryRef: "skill:test/NeedsApproval",
    inputs: {
      change: { summary: "needs review" },
    },
    cancelOnPause: true,
  });

  assert.equal(result.status, "cancelled");
  assert.equal(eventOf(result.trace, "human_approval_paused").payload.approval_ref, "approval:test:required");
  assert.deepEqual(eventOf(result.trace, "run_cancel_requested").payload, {
    authority_source: "host",
    reason: "cancel_requested",
    scope: "runtime",
  });
  assert.equal(eventsOf(result.trace, "human_approval_decided").length, 0);
  assert.equal(eventOf(result.trace, "run_completed").payload.status, "cancelled");
});

test("records terminal human approval decisions without resuming", async () => {
  for (const decision of ["rejected", "expired", "cancelled"]) {
    const result = await executeAirDocument(humanApprovalDocument(), {
      entryRef: "skill:test/NeedsApproval",
      inputs: {
        change: { summary: "needs review" },
      },
      humanApprovalDecisions: {
        "approval:test:required": decision,
      },
    });

    assert.equal(result.status, "stopped", decision);
    assert.equal(
      eventOf(result.trace, `human_approval_${decision}`).payload.approval_ref,
      "approval:test:required",
      decision,
    );
    assert.equal(eventsOf(result.trace, "human_approval_resumed").length, 0, decision);
  }
});

test("stops before external tool dispatch when required human approval is rejected", async () => {
  let handlerCalled = false;
  const result = await executeAirDocument(humanApprovalThenToolDocument(), {
    entryRef: "skill:test/ApproveThenSearch",
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument({
      bindings: {
        "tool:test/Search": toolBindingEntry({
          grants: ["network", "secret_read"],
          secrets: ["SEARCH_API_KEY"],
        }),
      },
    }))),
    secretStore: loadSecretsFromJson(JSON.stringify(secretsDocument()), {
      env: { SEARCH_API_TOKEN: "resolved-secret-value" },
    }),
    humanApprovalDecisions: {
      "approval:test:external-effect": "rejected",
    },
    toolHandlers: {
      "tool:test/Search": () => {
        handlerCalled = true;
        return "must-not-run";
      },
    },
  });

  assert.equal(result.status, "stopped");
  assert.equal(handlerCalled, false);
  assert.equal(eventOf(result.trace, "human_approval_rejected").payload.approval_ref, "approval:test:external-effect");
  assert.equal(eventsOf(result.trace, "tool_binding_authorized").length, 0);
  assert.equal(JSON.stringify(result.trace).includes("resolved-secret-value"), false);
});

test("refuses invalid human approval resume decisions with trace", async () => {
  const result = await executeAirDocument(humanApprovalDocument(), {
    entryRef: "skill:test/NeedsApproval",
    inputs: {
      change: { summary: "needs review" },
    },
    humanApprovalDecisions: {
      "approval:test:required": "maybe",
    },
  });

  assert.equal(result.status, "failure");
  const failure = eventOf(result.trace, "failure_detected");
  assert.equal(failure.payload.runtime_error_code, "InvalidHumanApprovalDecision");
  assert.equal(failure.payload.approval_ref, "approval:test:required");
  assert.match(failure.message, /invalid human approval decision maybe/);
});

test("executes show and pauses ask until user input is provided", async () => {
  const document = userInteractionDocument();

  const paused = await executeAirDocument(document, {
    entryRef: "skill:test/Interact",
  });

  assert.equal(paused.status, "stopped");
  assert.equal(eventOf(paused.trace, "user_interaction_shown").payload.message, "Touba ready");
  assert.deepEqual(eventOf(paused.trace, "user_interaction_requested").payload, {
    interaction_ref: "interaction:test:ask",
    mode: "ask",
    prompt_ref: "literal:string:Search query?",
    prompt: "Search query?",
    caller_ref: "skill:test/Interact",
  });
  assert.equal(eventOf(paused.trace, "user_interaction_paused").payload.resume_target_ref, "n3");

  const answered = await executeAirDocument(document, {
    entryRef: "skill:test/Interact",
    userInputs: {
      "interaction:test:ask": "parks",
    },
  });

  assert.equal(answered.status, "success");
  assert.equal(answered.result, "parks");
  assert.equal(eventOf(answered.trace, "user_interaction_answered").payload.result_binding, "query");
  assert.equal(JSON.stringify(answered.trace).includes("parks"), false);
});

test("executes ask through an explicit host user input provider", async () => {
  const document = userInteractionDocument();
  const providerCalls = [];

  const answered = await executeAirDocument(document, {
    entryRef: "skill:test/Interact",
    userInputProvider: async (request) => {
      providerCalls.push(request);
      return "parks";
    },
  });

  assert.equal(answered.status, "success");
  assert.equal(answered.result, "parks");
  assert.equal(providerCalls.length, 1);
  assert.deepEqual({
    ...providerCalls[0],
    airRef: {
      flow_graph_ref: providerCalls[0].airRef.flow_graph_ref,
      owner_ref: providerCalls[0].airRef.owner_ref,
      node_id: providerCalls[0].airRef.node_id,
    },
  }, {
    interactionRef: "interaction:test:ask",
    mode: "ask",
    prompt: "Search query?",
    promptRef: "literal:string:Search query?",
    callerRef: "skill:test/Interact",
    agentRef: null,
    airRef: {
      flow_graph_ref: "graph:skill:test/Interact",
      owner_ref: "skill:test/Interact",
      node_id: "n2",
    },
  });
  assert.equal(JSON.stringify(answered.trace).includes("parks"), false);
});

test("cancels a paused ask without tracing an answer value", async () => {
  const result = await executeAirDocument(userInteractionDocument(), {
    entryRef: "skill:test/Interact",
    cancelOnPause: true,
  });

  assert.equal(result.status, "cancelled");
  assert.equal(eventOf(result.trace, "user_interaction_shown").payload.message, "Touba ready");
  assert.equal(eventOf(result.trace, "user_interaction_paused").payload.interaction_ref, "interaction:test:ask");
  assert.equal(eventOf(result.trace, "run_cancel_requested").payload.reason, "cancel_requested");
  assert.equal(eventsOf(result.trace, "user_interaction_answered").length, 0);
  assert.equal(JSON.stringify(result.trace).includes("parks"), false);
  assert.equal(eventOf(result.trace, "run_completed").payload.status, "cancelled");
});

test("cancels ask before downstream external tool dispatch", async () => {
  let handlerCalled = false;
  const result = await executeAirDocument(userInteractionThenToolDocument(), {
    entryRef: "skill:test/AskThenSearch",
    cancelOnPause: true,
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument({
      bindings: {
        "tool:test/Search": toolBindingEntry({ grants: ["network"] }),
      },
    }))),
    toolHandlers: {
      "tool:test/Search": () => {
        handlerCalled = true;
        return "must-not-run";
      },
    },
  });

  assert.equal(result.status, "cancelled");
  assert.equal(handlerCalled, false);
  assert.equal(eventOf(result.trace, "user_interaction_paused").payload.interaction_ref, "interaction:test:ask-before-tool");
  assert.equal(eventsOf(result.trace, "tool_binding_authorized").length, 0);
  assert.equal(eventOf(result.trace, "run_completed").payload.status, "cancelled");
});

test("refuses user interaction output that contains a resolved secret value", async () => {
  const document = userInteractionDocument({
    showMessage: "resolved-secret-value",
  });

  const result = await executeAirDocument(document, {
    entryRef: "skill:test/Interact",
    secretStore: loadSecretsFromJson(JSON.stringify(secretsDocument()), {
      env: { SEARCH_API_TOKEN: "resolved-secret-value" },
    }),
  });

  assert.equal(result.status, "failure");
  const failure = eventOf(result.trace, "failure_detected");
  assert.equal(failure.payload.runtime_error_code, "SecretValueInUserInteraction");
  assert.equal(failure.payload.interaction_ref, "interaction:test:show");
  assert.deepEqual(failure.payload.secret_handles_refused, ["SEARCH_API_KEY"]);
  assert.equal(JSON.stringify(result.trace).includes("resolved-secret-value"), false);
});

test("cancels cooperatively when the global run timeout is observed before next dispatch", async () => {
  const document = twoToolDispatchDocument();
  let currentTimeMs = 0;
  let secondToolCalled = false;

  const result = await executeAirDocument(document, {
    entryRef: "skill:test/TwoTools",
    runTimeoutMs: 5,
    now: () => currentTimeMs,
    toolHandlers: {
      "tool:test/First": () => {
        currentTimeMs = 10;
        return "first";
      },
      "tool:test/Second": () => {
        secondToolCalled = true;
        return "second";
      },
    },
  });

  assert.equal(result.status, "cancelled");
  assert.equal(secondToolCalled, false);
  assert.deepEqual(eventOf(result.trace, "run_timeout_exceeded").payload, {
    timeout_ms: 5,
    authority_source: "timeout",
    elapsed_ms: 10,
    scope: "runtime",
    reason: "global_timeout_exceeded",
  });
  assert.deepEqual(eventOf(result.trace, "dispatch_refused_cancelled").payload, {
    target_ref: "tool:test/Second",
    reason: "global_timeout_exceeded",
    tool_ref: "tool:test/Second",
  });
  assert.equal(eventsOf(result.trace, "call_started").length, 1);
  assert.equal(eventOf(result.trace, "run_completed").payload.status, "cancelled");
});

test("enforces BQ-1 max_tool_calls before dispatching an extra tool", async () => {
  const document = twoToolDispatchDocument({
    budgets: {
      run: {
        max_tool_calls: {
          value: 2,
          source_ref: sourceRef(),
        },
      },
    },
  });
  let secondToolCalled = false;

  const result = await executeAirDocument(document, {
    entryRef: "skill:test/TwoTools",
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument({
      runLimits: {
        max_tool_calls: 1,
      },
      bindings: {
        "tool:test/First": toolBindingEntry({ grants: [] }),
        "tool:test/Second": toolBindingEntry({ grants: [] }),
      },
    }))),
    toolHandlers: {
      "tool:test/First": () => "first",
      "tool:test/Second": () => {
        secondToolCalled = true;
        return "second";
      },
    },
  });

  assert.equal(result.status, "failure");
  assert.equal(secondToolCalled, false);
  assert.equal(eventOf(result.trace, "budget_limit_checked").payload.budget_kind, "max_tool_calls");
  assert.deepEqual(eventOf(result.trace, "budget_consumed").payload, {
    budget_kind: "max_tool_calls",
    consumed_value: 1,
    limit_value: 1,
    authority_source: "manifest",
    target_ref: "tool:test/First",
  });
  assert.deepEqual(eventOf(result.trace, "dispatch_refused_budget_exceeded").payload, {
    budget_kind: "max_tool_calls",
    limit_value: 1,
    consumed_value: 1,
    target_ref: "tool:test/Second",
    tool_ref: "tool:test/Second",
    runtime_error_code: "ToolCallBudgetExceeded",
  });
  assert.equal(eventsOf(result.trace, "call_started").length, 1);
  assert.equal(eventOf(result.trace, "run_completed").payload.status, "failure");
});

test("enforces BQ-1 max_agent_invocations before invoking an extra agent", async () => {
  const document = twoAgentDispatchDocument();

  const result = await executeAirDocument(document, {
    entryRef: "strategy:test/RunBuild",
    runLimits: {
      max_agent_invocations: 1,
    },
  });

  assert.equal(result.status, "failure");
  assert.equal(eventsOf(result.trace, "agent_invocation_authorized").length, 1);
  assert.deepEqual(eventOf(result.trace, "dispatch_refused_budget_exceeded").payload, {
    budget_kind: "max_agent_invocations",
    limit_value: 1,
    consumed_value: 1,
    target_ref: "agent:test/Builder",
    agent_ref: "agent:test/Builder",
    runtime_error_code: "AgentInvocationBudgetExceeded",
  });
});

test("enforces BQ-1 max_steps on graph nodes", async () => {
  const document = bindThenGiveDocument();

  const result = await executeAirDocument(document, {
    entryRef: "skill:test/BindThenGive",
    runLimits: {
      max_steps: 1,
    },
  });

  assert.equal(result.status, "failure");
  assert.equal(eventsOf(result.trace, "binding_created").length, 1);
  assert.equal(eventOf(result.trace, "budget_limit_exceeded").payload.budget_kind, "max_steps");
  assert.equal(eventOf(result.trace, "budget_limit_exceeded").payload.limit_value, 1);
  assert.equal(eventOf(result.trace, "run_completed").payload.status, "failure");
});

test("enforces BQ-1 max_run_ms as a budget failure distinct from cancel timeout", async () => {
  const document = bindThenGiveDocument();
  const times = [0, 10];

  const result = await executeAirDocument(document, {
    entryRef: "skill:test/BindThenGive",
    runLimits: {
      max_run_ms: 5,
    },
    now: () => times.shift() ?? 10,
  });

  assert.equal(result.status, "failure");
  assert.equal(eventsOf(result.trace, "run_timeout_exceeded").length, 0);
  assert.equal(eventsOf(result.trace, "run_cancel_requested").length, 0);
  assert.deepEqual(eventOf(result.trace, "budget_limit_exceeded").payload, {
    budget_kind: "max_run_ms",
    limit_value: 5,
    consumed_value: 10,
    authority_source: "host_policy",
    target_ref: "skill:test/BindThenGive",
    reason: "budget_limit_exceeded",
  });
  assert.equal(eventOf(result.trace, "run_completed").payload.status, "failure");
});

test("refuses a manifest run_limit that widens an AIR budget", async () => {
  const document = bindThenGiveDocument({
    budgets: {
      run: {
        max_steps: {
          value: 1,
          source_ref: sourceRef(),
        },
      },
    },
  });

  const result = await executeAirDocument(document, {
    entryRef: "skill:test/BindThenGive",
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument({
      runLimits: {
        max_steps: 2,
      },
      bindings: {},
    }))),
  });

  assert.equal(result.status, "failure");
  assert.deepEqual(eventOf(result.trace, "budget_limit_exceeded").payload, {
    budget_kind: "max_steps",
    limit_value: 1,
    attempted_value: 2,
    authority_source: "manifest",
    reason: "manifest_limit_exceeds_air",
  });
  assert.equal(eventsOf(result.trace, "scope_entered").length, 0);
});

test("evaluates structured arithmetic expressions in give nodes", async () => {
  const document = baseDocument({
    functions: [
      fnDef("Compute", "graph:function:test/Compute", [
        parameter("count", "builtin:Int"),
        parameter("bonus", "builtin:Int"),
      ], "builtin:Int"),
    ],
    graphs: [
      graph("graph:function:test/Compute", "function:test/Compute", [
        node("n1", "give", { arguments: ["expr:e2"] }),
      ], [], [], [
        expression("e1", "binary_op", {
          operator: "multiply",
          operands: ["value:bonus", "literal:int:2"],
          type_ref: "builtin:Int",
        }),
        expression("e2", "binary_op", {
          operator: "add",
          operands: ["value:count", "expr:e1"],
          type_ref: "builtin:Int",
        }),
      ]),
    ],
  });

  const result = await executeAirDocument(document, {
    entryRef: "function:test/Compute",
    inputs: {
      count: 3,
      bonus: 2,
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.result, 7);
});

test("constructs nominal records in canonical field order without host evaluation", async () => {
  const document = baseDocument({
    types: [{
      id: "type:test/Decision",
      name: "Decision",
      fields: [parameter("approved", "builtin:Boolean"), parameter("risk", "builtin:Float")],
      source_ref: sourceRef(),
    }],
    functions: [fnDef("Build", "graph:function:test/Build", [parameter("risk", "builtin:Float")], "type:test/Decision")],
    graphs: [graph("graph:function:test/Build", "function:test/Build", [
      node("n1", "give", { arguments: ["expr:e1"] }),
    ], [], [], [expression("e1", "construct_record", {
      type_ref: "type:test/Decision",
      record_fields: [
        { name: "approved", value_ref: "literal:bool:true" },
        { name: "risk", value_ref: "value:risk" },
      ],
    })])],
  });

  const result = await executeAirDocument(document, {
    entryRef: "function:test/Build",
    inputs: { risk: 0.25 },
  });
  assert.equal(result.status, "success");
  assert.deepEqual(result.result, { approved: true, risk: 0.25 });
  assert.deepEqual(Object.keys(result.result), ["approved", "risk"]);
});

test("refuses malformed AIR record fields that are not unique and canonical", async () => {
  const document = baseDocument({
    functions: [fnDef("Build", "graph:function:test/Build", [], "builtin:Text")],
    graphs: [graph("graph:function:test/Build", "function:test/Build", [
      node("n1", "give", { arguments: ["expr:e1"] }),
    ], [], [], [expression("e1", "construct_record", {
      type_ref: "type:test/Decision",
      record_fields: [
        { name: "risk", value_ref: "literal:float:0.25" },
        { name: "approved", value_ref: "literal:bool:true" },
      ],
    })])],
  });

  await assert.rejects(
    executeAirDocument(document, { entryRef: "function:test/Build" }),
    (error) => error instanceof ToubaRuntimeError
      && error.code === "InvalidAirDocument"
      && error.details.contractCode === "AirRecordFieldsNonCanonical",
  );
});

test("executes immutable bind nodes and resolves module constants", async () => {
  const document = baseDocument({
    constants: [
      {
        id: "constant:test/ScoreLimit",
        name: "ScoreLimit",
        type_ref: "builtin:Float",
        literal_float: "0.75",
        source_ref: sourceRef(),
      },
    ],
    functions: [
      fnDef("Review", "graph:function:test/Review", [
        parameter("score", "builtin:Float"),
      ], "builtin:Text"),
    ],
    graphs: [
      graph("graph:function:test/Review", "function:test/Review", [
        node("n1", "bind", {
          arguments: ["expr:e1"],
          result_binding: "accepted",
        }),
        node("n2", "branch", { condition_ref: "value:accepted" }),
        node("n3", "give", { arguments: ["literal:string:accepted"] }),
        node("n4", "give", { arguments: ["literal:string:review"] }),
      ], [
        edge("n1", "n2", "next"),
        edge("n2", "n3", "true"),
        edge("n2", "n4", "false"),
      ], [], [
        expression("e1", "binary_op", {
          operator: "greater_than_or_equal",
          operands: ["value:score", "constant:test/ScoreLimit"],
          type_ref: "builtin:Boolean",
        }),
      ]),
    ],
  });

  const result = await executeAirDocument(document, {
    entryRef: "function:test/Review",
    inputs: {
      score: 0.8,
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.result, "accepted");
  const binding = eventOf(result.trace, "binding_created");
  assert.equal(binding.payload.binding, "accepted");
  assert.equal(binding.payload.value_ref, "expr:e1");
  assert.equal(JSON.stringify(binding).includes("true"), false);
});

test("evaluates field access expressions in call arguments", async () => {
  const document = baseDocument({
    tools: [
      {
        id: "tool:test/StoreScore",
        name: "StoreScore",
        signature: {
          inputs: [parameter("score", "builtin:Float")],
          output_type: "type:test/Decision",
        },
        source_ref: sourceRef(),
      },
    ],
    skills: [skill("ReviewScore", "graph:skill:test/ReviewScore", ["tool:test/StoreScore"])],
    graphs: [
      graph("graph:skill:test/ReviewScore", "skill:test/ReviewScore", [
        node("n1", "call_tool", {
          target_ref: "tool:test/StoreScore",
          arguments: ["expr:e2"],
          result_binding: "decision",
        }),
        node("n2", "give", { arguments: ["value:decision"] }),
      ], [
        edge("n1", "n2", "next"),
      ], [], [
        expression("e1", "field_access", {
          operands: ["value:analysis"],
          field_name: "score",
          type_ref: "builtin:Float",
        }),
        expression("e2", "binary_op", {
          operator: "add",
          operands: ["expr:e1", "value:bonus"],
          type_ref: "builtin:Float",
        }),
      ]),
    ],
  });

  const result = await executeAirDocument(document, {
    entryRef: "skill:test/ReviewScore",
    inputs: {
      analysis: { score: 4 },
      bonus: 0.5,
    },
    toolHandlers: {
      "tool:test/StoreScore": ({ arguments: args }) => {
        assert.deepEqual(args, { score: 4.5 });
        return { approved: true };
      },
    },
  });

  assert.equal(result.status, "success");
  assert.deepEqual(result.result, { approved: true });
});

test("evaluates structured boolean branch expressions", async () => {
  const document = baseDocument({
    skills: [skill("Review", "graph:skill:test/Review")],
    graphs: [
      graph("graph:skill:test/Review", "skill:test/Review", [
        node("n1", "branch", { condition_ref: "expr:e4" }),
        node("n2", "give", { arguments: ["literal:string:accepted"] }),
        node("n3", "give", { arguments: ["literal:string:rejected"] }),
      ], [
        edge("n1", "n2", "true"),
        edge("n1", "n3", "false"),
      ], [], [
        expression("e1", "field_access", {
          operands: ["value:analysis"],
          field_name: "score",
          type_ref: "builtin:Float",
        }),
        expression("e2", "binary_op", {
          operator: "greater_than_or_equal",
          operands: ["expr:e1", "value:threshold"],
          type_ref: "builtin:Boolean",
        }),
        expression("e3", "unary_op", {
          operator: "not",
          operands: ["value:blocked"],
          type_ref: "builtin:Boolean",
        }),
        expression("e4", "binary_op", {
          operator: "and",
          operands: ["expr:e2", "expr:e3"],
          type_ref: "builtin:Boolean",
        }),
      ]),
    ],
  });

  const result = await executeAirDocument(document, {
    entryRef: "skill:test/Review",
    inputs: {
      analysis: { score: 0.9 },
      threshold: 0.8,
      blocked: false,
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.result, "accepted");
  assert.equal(eventOf(result.trace, "branch_evaluated").payload.condition_result, true);
});

test("fails observably on invalid expression evaluation", async () => {
  const cases = [
    {
      name: "division by zero",
      expressions: [
        expression("e1", "binary_op", {
          operator: "divide",
          operands: ["value:total", "literal:int:0"],
          type_ref: "builtin:Float",
        }),
      ],
      inputs: { total: 4 },
    },
    {
      name: "missing field",
      expressions: [
        expression("e1", "field_access", {
          operands: ["value:analysis"],
          field_name: "score",
          type_ref: "builtin:Float",
        }),
      ],
      inputs: { analysis: {} },
    },
    {
      name: "Int overflow",
      expressions: [
        expression("e1", "binary_op", {
          operator: "add",
          operands: ["literal:int:9007199254740991", "literal:int:1"],
          type_ref: "builtin:Int",
        }),
      ],
      inputs: {},
    },
    {
      name: "non-finite Float literal",
      expressions: [
        expression("e1", "literal_float", {
          literal_float: "1e309",
          type_ref: "builtin:Float",
        }),
      ],
      inputs: {},
    },
  ];

  for (const fixture of cases) {
    const document = baseDocument({
      functions: [fnDef("Evaluate", "graph:function:test/Evaluate")],
      graphs: [
        graph("graph:function:test/Evaluate", "function:test/Evaluate", [
          node("n1", "give", { arguments: ["expr:e1"] }),
        ], [], [], fixture.expressions),
      ],
    });

    const result = await executeAirDocument(document, {
      entryRef: "function:test/Evaluate",
      inputs: fixture.inputs,
    });

    assert.equal(result.status, "failure", fixture.name);
    assert.equal(result.trace.events.at(-1).payload.status, "failure", fixture.name);
  }
});

test("executes a bounded collection loop", async () => {
  let visits = 0;
  const document = baseDocument({
    tools: [tool("Visit")],
    skills: [skill("VisitItems", "graph:skill:test/VisitItems", ["tool:test/Visit"])],
    graphs: [
      graph("graph:skill:test/VisitItems", "skill:test/VisitItems", [
        node("n1", "loop", {
          arguments: ["value:items", "value:item"],
          condition_ref: "loop_has_next:value:items",
        }),
        node("n2", "call_tool", { target_ref: "tool:test/Visit" }),
        node("n3", "give", { arguments: ["literal:string:done"] }),
      ], [
        edge("n1", "n2", "loop_next"),
        edge("n2", "n1", "loop_next"),
        edge("n1", "n3", "loop_exit"),
      ]),
    ],
  });

  const result = await executeAirDocument(document, {
    entryRef: "skill:test/VisitItems",
    inputs: {
      items: ["a", "b"],
    },
    toolHandlers: {
      "tool:test/Visit": ({ values }) => {
        visits += 1;
        assert.ok(["a", "b"].includes(values["value:item"]));
      },
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.result, "done");
  assert.equal(visits, 2);
  assert.equal(eventsOf(result.trace, "loop_evaluated").length, 3);
});

test("loop cursors are fresh after an early return and local to each graph invocation", async () => {
  const document = baseDocument({
    functions: [fnDef("First", "graph:function:test/First", [parameter("items", "list:builtin:Int")], "builtin:Int")],
    skills: [{ ...skill("Twice", "graph:skill:test/Twice", ["function:test/First"]),
      signature: { inputs: [parameter("items", "list:builtin:Int")], output_type: "builtin:Int" } }],
    graphs: [
      graph("graph:function:test/First", "function:test/First", [
        node("loop", "loop", { arguments: ["value:items", "value:item"], condition_ref: "loop_has_next:value:items" }),
        node("found", "give", { arguments: ["value:item"] }),
        node("empty", "give", { arguments: ["literal:int:0"] }),
      ], [edge("loop", "found", "loop_next"), edge("loop", "empty", "loop_exit")]),
      graph("graph:skill:test/Twice", "skill:test/Twice", [
        node("first", "call_function", { target_ref: "function:test/First", arguments: ["value:items"], result_binding: "first" }),
        node("again", "call_function", { target_ref: "function:test/First", arguments: ["value:items"], result_binding: "again" }),
        node("return", "give", { arguments: ["value:again"] }),
      ], [edge("first", "again", "next"), edge("again", "return", "next")]),
    ],
  });
  const result = await executeAirDocument(document, { entryRef: "skill:test/Twice", inputs: { items: [6, 12] } });
  assert.equal(result.status, "success");
  assert.equal(result.result, 6);
  assert.deepEqual(eventsOf(result.trace, "loop_evaluated").map(event => event.payload.iteration_index), [0, 0]);
});

test("a binding at the end of a loop follows its loop continuation", async () => {
  const document = baseDocument({
    skills: [skill("Iterate", "graph:skill:test/Iterate")],
    graphs: [graph("graph:skill:test/Iterate", "skill:test/Iterate", [
      node("loop", "loop", { condition_ref: "literal:bool:true" }),
      node("bind", "bind", { arguments: ["literal:string:iteration"], result_binding: "label" }),
      node("exit", "give", { arguments: ["literal:string:done"] }),
    ], [edge("loop", "bind", "loop_next"), edge("bind", "loop", "loop_next"), edge("loop", "exit", "loop_exit")])],
  });
  const result = await executeAirDocument(document, { maxLoopIterations: 2 });
  assert.equal(result.status, "failure");
  assert.equal(eventOf(result.trace, "failure_detected").payload.runtime_error_code, "LoopIterationLimitExceeded");
  assert.equal(eventsOf(result.trace, "binding_created").length, 2);
});

test("human checkpoints preserve collection cursors and loop continuations", async () => {
  const document = baseDocument({
    tools: [tool("Write")],
    skills: [skill("ReviewItems", "graph:skill:test/ReviewItems", ["tool:test/Write"])],
    graphs: [graph("graph:skill:test/ReviewItems", "skill:test/ReviewItems", [
      node("loop", "loop", { arguments: ["value:items", "value:item"], condition_ref: "loop_has_next:value:items" }),
      node("write", "call_tool", { target_ref: "tool:test/Write" }),
      node("review", "human_approval", { approval_ref: "approval:items", approval_mode: "required_approval", result_binding: "decision" }),
      node("exit", "give", { arguments: ["literal:string:done"] }),
    ], [edge("loop", "write", "loop_next"), edge("write", "review", "next"),
      edge("review", "loop", "loop_next"), edge("loop", "exit", "loop_exit")])],
  });
  const writes = [];
  const options = { entryRef: "skill:test/ReviewItems", inputs: { items: ["first", "second"] }, durableHumanApprovals: true,
    toolHandlers: { "tool:test/Write": ({ values }) => { writes.push(values["value:item"]); return "stored"; } } };
  const paused = await executeAirDocument(document, options);
  assert.equal(paused.status, "stopped");
  assert.deepEqual(paused.checkpoint.loop_state, { "graph:skill:test/ReviewItems:loop": { index: 1 } });
  for (const corrupt of [
    checkpoint => { delete checkpoint.loop_state; },
    checkpoint => { checkpoint.loop_state["graph:skill:test/ReviewItems:loop"].index = -1; },
    checkpoint => { checkpoint.loop_state["foreign"] = { index: 1 }; },
  ]) {
    const checkpoint = structuredClone(paused.checkpoint);
    corrupt(checkpoint);
    const refused = await executeAirDocument(document, { ...options, humanApprovalResumeCheckpoint: checkpoint,
      humanApprovalDecisions: { "approval:items": "approved" } });
    assert.equal(refused.status, "failure");
    assert.deepEqual(writes, ["first"]);
  }
  const resumed = await executeAirDocument(document, { ...options, humanApprovalResumeCheckpoint: paused.checkpoint,
    humanApprovalDecisions: { "approval:items": "approved" } });
  assert.equal(resumed.status, "success");
  assert.equal(resumed.result, "done");
  assert.deepEqual(writes, ["first", "second"]);
});

test("selects a fallback path after a tool failure", async () => {
  const document = baseDocument({
    tools: [tool("Primary")],
    skills: [
      skill("PrimaryFlow", "graph:skill:test/PrimaryFlow", [
        "tool:test/Primary",
        "skill:test/FallbackFlow",
      ]),
      skill("FallbackFlow", "graph:skill:test/FallbackFlow"),
    ],
    graphs: [
      graph("graph:skill:test/PrimaryFlow", "skill:test/PrimaryFlow", [
        node("n1", "call_tool", { target_ref: "tool:test/Primary" }),
        node("n2", "give", { arguments: ["literal:string:primary"] }),
        node("n3", "fallback", { target_ref: "skill:test/FallbackFlow" }),
      ], [
        edge("n1", "n2", "next"),
        edge("n1", "n3", "failure"),
        edge("n1", "n3", "fallback"),
      ], [
        {
          id: "failure:graph:skill:test/PrimaryFlow:1",
          scope_ref: "graph:skill:test/PrimaryFlow",
          trigger_node_id: "n1",
          mode: "fallback",
          failure_family: "handler",
          target_node_id: "n3",
          source_ref: sourceRef(),
        },
      ]),
      graph("graph:skill:test/FallbackFlow", "skill:test/FallbackFlow", [
        node("f1", "give", { arguments: ["literal:string:fallback"] }),
      ]),
    ],
  });

  const result = await executeAirDocument(document, {
    entryRef: "skill:test/PrimaryFlow",
  });

  assert.equal(result.status, "success");
  assert.equal(result.result, "fallback");
  assert.ok(eventsOf(result.trace, "failure_detected").length >= 1);
  assert.equal(eventOf(result.trace, "fallback_selected").payload.target_node_id, "n3");
});

test("selects a fallback path after a tool handler error", async () => {
  const document = baseDocument({
    tools: [tool("Primary")],
    skills: [
      skill("PrimaryFlow", "graph:skill:test/PrimaryFlow", [
        "tool:test/Primary",
        "skill:test/FallbackFlow",
      ]),
      skill("FallbackFlow", "graph:skill:test/FallbackFlow"),
    ],
    graphs: [
      graph("graph:skill:test/PrimaryFlow", "skill:test/PrimaryFlow", [
        node("n1", "call_tool", { target_ref: "tool:test/Primary" }),
        node("n2", "give", { arguments: ["literal:string:primary"] }),
        node("n3", "fallback", { target_ref: "skill:test/FallbackFlow" }),
      ], [
        edge("n1", "n2", "next"),
        edge("n1", "n3", "failure"),
        edge("n1", "n3", "fallback"),
      ], [
        {
          id: "failure:graph:skill:test/PrimaryFlow:1",
          scope_ref: "graph:skill:test/PrimaryFlow",
          trigger_node_id: "n1",
          mode: "fallback",
          failure_family: "handler",
          target_node_id: "n3",
          source_ref: sourceRef(),
        },
      ]),
      graph("graph:skill:test/FallbackFlow", "skill:test/FallbackFlow", [
        node("f1", "give", { arguments: ["literal:string:fallback"] }),
      ]),
    ],
  });

  const result = await executeAirDocument(document, {
    entryRef: "skill:test/PrimaryFlow",
    toolHandlers: {
      "tool:test/Primary": () => {
        throw new Error("adapter unavailable");
      },
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.result, "fallback");
  assert.match(eventOf(result.trace, "failure_detected").message, /tool handler failed/);
  assert.equal(eventOf(result.trace, "failure_detected").payload.failure_family, "handler");
});

test("does not let a fallback capture an undeclared failure family", async () => {
  const document = baseDocument({
    tools: [tool("Primary")],
    skills: [
      skill("PrimaryFlow", "graph:skill:test/PrimaryFlow", [
        "tool:test/Primary",
        "skill:test/FallbackFlow",
      ]),
      skill("FallbackFlow", "graph:skill:test/FallbackFlow"),
    ],
    graphs: [
      graph("graph:skill:test/PrimaryFlow", "skill:test/PrimaryFlow", [
        node("n1", "call_tool", { target_ref: "tool:test/Primary" }),
        node("n2", "fallback", { target_ref: "skill:test/FallbackFlow" }),
      ], [
        edge("n1", "n2", "failure"),
        edge("n1", "n2", "fallback"),
      ], [{
        id: "failure:graph:skill:test/PrimaryFlow:1",
        scope_ref: "graph:skill:test/PrimaryFlow",
        trigger_node_id: "n1",
        mode: "fallback",
        failure_family: "authority",
        target_node_id: "n2",
        source_ref: sourceRef(),
      }]),
      graph("graph:skill:test/FallbackFlow", "skill:test/FallbackFlow", [
        node("f1", "give", { arguments: ["literal:string:fallback"] }),
      ]),
    ],
  });

  const result = await executeAirDocument(document, { entryRef: "skill:test/PrimaryFlow" });
  assert.equal(result.status, "failure");
  assert.equal(eventsOf(result.trace, "fallback_selected").length, 0);
  const failure = eventOf(result.trace, "failure_detected");
  assert.equal(failure.payload.failure_family, "handler");
  assert.equal(failure.payload.declared_failure_family, "authority");
});

test("exposes and enforces the positive loop iteration bound", async () => {
  const document = baseDocument({
    skills: [skill("Loop", "graph:skill:test/Loop")],
    graphs: [graph("graph:skill:test/Loop", "skill:test/Loop", [
      node("n1", "loop", { condition_ref: "literal:bool:true" }),
    ], [edge("n1", "n1", "loop_next")])],
  });
  const result = await executeAirDocument(document, {
    entryRef: "skill:test/Loop",
    maxLoopIterations: 2,
  });
  assert.equal(result.status, "failure");
  assert.equal(eventOf(result.trace, "run_started").payload.max_loop_iterations, 2);
  const failure = eventOf(result.trace, "failure_detected");
  assert.equal(failure.payload.runtime_error_code, "LoopIterationLimitExceeded");
  assert.equal(failure.payload.failure_family, "authority");
});

test("executes a strategy through an agent responsibility", async () => {
  const document = baseDocument({
    skills: [skill("Build", "graph:skill:test/Build")],
    agents: [
      {
        id: "agent:test/Builder",
        name: "Builder",
        responsibility: "Builder",
        uses: ["skill:test/Build"],
        callable_by: [
          {
            caller_ref: "strategy:test/RunBuild",
            caller_kind: "strategy",
            source_ref: sourceRef(),
          },
        ],
        source_ref: sourceRef(),
      },
    ],
    strategies: [
      {
        id: "strategy:test/RunBuild",
        name: "RunBuild",
        uses: ["agent:test/Builder"],
        flow_graph_ref: "graph:strategy:test/RunBuild",
        source_ref: sourceRef(),
      },
    ],
    graphs: [
      graph("graph:skill:test/Build", "skill:test/Build", [
        node("b1", "give", { arguments: ["literal:string:built"] }),
      ]),
      graph("graph:strategy:test/RunBuild", "strategy:test/RunBuild", [
        node("s1", "call_agent", { target_ref: "agent:test/Builder" }),
        node("s2", "give", { arguments: ["literal:string:complete"] }),
      ], [
        edge("s1", "s2", "next"),
      ]),
    ],
  });

  const result = await executeAirDocument(document);

  assert.equal(result.status, "success");
  assert.equal(result.result, "complete");
  assertTraceShape(result.trace, "strategy:test/RunBuild");
  assert.equal(eventOf(result.trace, "call_started").payload.target_ref, "agent:test/Builder");
  assert.deepEqual(eventOf(result.trace, "agent_invocation_authorized").payload, {
    caller_ref: "strategy:test/RunBuild",
    agent_ref: "agent:test/Builder",
    authority_source: "callable_by",
  });
  assert.deepEqual(eventOf(result.trace, "agent_capabilities_listed").payload.capability_refs, [
    "skill:test/Build",
  ]);
});

test("executes a typed agent call with explicit input and result binding", async () => {
  const document = typedAgentCallDocument();
  const result = await executeAirDocument(document, {
    inputs: { request: { summary: "review this" } },
    agentDecisionProvider: async (request) => {
      assert.equal(request.agent_ref, "agent:test/Reviewer");
      assert.deepEqual(request.inputs.request, { summary: "review this" });
      return {
        action: "answer_directly",
        source: "test_provider",
        result: { verdict: "approved" },
      };
    },
  });

  assert.equal(result.status, "success");
  assert.deepEqual(result.result, { verdict: "approved" });
  assert.deepEqual(eventOf(result.trace, "agent_interface_entered").payload, {
    agent_ref: "agent:test/Reviewer",
    caller_ref: "strategy:test/RunReview",
    input_count: 1,
    output_type: "type:test/ReviewResult",
  });
  assert.deepEqual(eventOf(result.trace, "agent_interface_result_returned").payload, {
    agent_ref: "agent:test/Reviewer",
    caller_ref: "strategy:test/RunReview",
    output_type: "type:test/ReviewResult",
    result_type: "object",
  });
});

test("refuses a typed agent final answer incompatible with gives", async () => {
  const result = await executeAirDocument(typedAgentCallDocument(), {
    inputs: { request: { summary: "review this" } },
    agentDecisionProvider: async () => ({
      action: "answer_directly",
      source: "test_provider",
      result: "not a ReviewResult",
    }),
  });

  assert.equal(result.status, "failure");
  assert.equal(eventOf(result.trace, "failure_detected").payload.runtime_error_code, "AgentInterfaceResultTypeMismatch");
  assert.deepEqual(eventOf(result.trace, "agent_interface_refused").payload, {
    agent_ref: "agent:test/Reviewer",
    caller_ref: "strategy:test/RunReview",
    reason: "result_type_mismatch",
    runtime_error_code: "AgentInterfaceResultTypeMismatch",
    expected_type_ref: "type:test/ReviewResult",
    value_kind: "string",
  });
  assert.equal(eventsOf(result.trace, "agent_direct_answer_returned").length, 0);
});

test("refuses malformed AIR arguments before entering a typed agent", async () => {
  const document = typedAgentCallDocument();
  const call = document.execution_graphs[0].nodes[0];
  call.arguments = ["literal:string:not-a-record"];
  const result = await executeAirDocument(document, {
    inputs: { request: { summary: "review this" } },
    agentDecisionProvider: async () => assert.fail("provider must not be called"),
  });

  assert.equal(result.status, "failure");
  assert.equal(eventOf(result.trace, "failure_detected").payload.runtime_error_code, "AgentInterfaceInputTypeMismatch");
  assert.equal(eventsOf(result.trace, "agent_interface_entered").length, 0);
});

test("keeps historical agents valid but refuses enriched calls without interface", async () => {
  const document = typedAgentCallDocument();
  delete document.definitions.agents[0].signature;
  const result = await executeAirDocument(document, {
    inputs: { request: { summary: "review this" } },
    agentDecisionProvider: async () => assert.fail("provider must not be called"),
  });

  assert.equal(result.status, "failure");
  assert.equal(eventOf(result.trace, "failure_detected").payload.runtime_error_code, "AgentInterfaceRequired");
  assert.equal(eventOf(result.trace, "agent_interface_refused").payload.reason, "interface_missing");
});

test("lets an agent select one declared capability through a governed decision", async () => {
  const document = baseDocument({
    skills: [
      skill("UseDatasetSearch", "graph:skill:test/UseDatasetSearch"),
      skill("UseMemorySearch", "graph:skill:test/UseMemorySearch"),
    ],
    agents: [
      {
        id: "agent:test/Researcher",
        name: "Researcher",
        responsibility: "Researcher",
        uses: ["skill:test/UseDatasetSearch", "skill:test/UseMemorySearch"],
        callable_by: [
          {
            caller_ref: "strategy:test/RunResearch",
            caller_kind: "strategy",
            source_ref: sourceRef(),
          },
        ],
        source_ref: sourceRef(),
      },
    ],
    strategies: [
      {
        id: "strategy:test/RunResearch",
        name: "RunResearch",
        uses: ["agent:test/Researcher"],
        flow_graph_ref: "graph:strategy:test/RunResearch",
        source_ref: sourceRef(),
      },
    ],
    graphs: [
      graph("graph:skill:test/UseDatasetSearch", "skill:test/UseDatasetSearch", [
        node("d1", "give", { arguments: ["literal:string:dataset"] }),
      ]),
      graph("graph:skill:test/UseMemorySearch", "skill:test/UseMemorySearch", [
        node("m1", "give", { arguments: ["literal:string:memory"] }),
      ]),
      graph("graph:strategy:test/RunResearch", "strategy:test/RunResearch", [
        node("s1", "call_agent", { target_ref: "agent:test/Researcher" }),
      ]),
    ],
  });

  const result = await executeAirDocument(document, {
    agentDecisions: {
      "agent:test/Researcher": {
        target_ref: "skill:test/UseMemorySearch",
        source: "test_decision",
        reason: "memory context requested",
      },
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.result, "memory");
  assert.deepEqual(eventOf(result.trace, "agent_capabilities_listed").payload.capability_refs, [
    "skill:test/UseDatasetSearch",
    "skill:test/UseMemorySearch",
  ]);
  assert.deepEqual(eventOf(result.trace, "agent_decision_recorded").payload, {
    agent_ref: "agent:test/Researcher",
    selected_ref: "skill:test/UseMemorySearch",
    decision_source: "test_decision",
    reason: "memory context requested",
  });
  assert.deepEqual(eventOf(result.trace, "agent_capability_selected").payload, {
    agent_ref: "agent:test/Researcher",
    selected_ref: "skill:test/UseMemorySearch",
    authority_source: "uses",
    decision_source: "test_decision",
    reason: "memory context requested",
  });
  assert.equal(
    result.trace.events.some((event) => event.air_ref?.owner_ref === "skill:test/UseDatasetSearch"),
    false,
  );
});

test("refuses an agent decision outside declared uses before entering a capability", async () => {
  const document = baseDocument({
    skills: [
      skill("Allowed", "graph:skill:test/Allowed"),
      skill("Hidden", "graph:skill:test/Hidden"),
    ],
    agents: [
      {
        id: "agent:test/Researcher",
        name: "Researcher",
        responsibility: "Researcher",
        uses: ["skill:test/Allowed"],
        callable_by: [
          {
            caller_ref: "strategy:test/RunResearch",
            caller_kind: "strategy",
            source_ref: sourceRef(),
          },
        ],
        source_ref: sourceRef(),
      },
    ],
    strategies: [
      {
        id: "strategy:test/RunResearch",
        name: "RunResearch",
        uses: ["agent:test/Researcher"],
        flow_graph_ref: "graph:strategy:test/RunResearch",
        source_ref: sourceRef(),
      },
    ],
    graphs: [
      graph("graph:skill:test/Allowed", "skill:test/Allowed", [
        node("a1", "give", { arguments: ["literal:string:allowed"] }),
      ]),
      graph("graph:skill:test/Hidden", "skill:test/Hidden", [
        node("h1", "give", { arguments: ["literal:string:hidden"] }),
      ]),
      graph("graph:strategy:test/RunResearch", "strategy:test/RunResearch", [
        node("s1", "call_agent", { target_ref: "agent:test/Researcher" }),
      ]),
    ],
  });

  const result = await executeAirDocument(document, {
    agentDecisions: {
      "agent:test/Researcher": "skill:test/Hidden",
    },
  });

  assert.equal(result.status, "failure");
  assert.deepEqual(eventOf(result.trace, "agent_capability_refused").payload, {
    agent_ref: "agent:test/Researcher",
    selected_ref: "skill:test/Hidden",
    allowed_refs: ["skill:test/Allowed"],
    reason: "capability_not_declared_in_uses",
  });
  assert.equal(
    result.trace.events.some((event) => event.air_ref?.owner_ref === "skill:test/Hidden"),
    false,
  );
  const failure = eventOf(result.trace, "failure_detected");
  assert.equal(failure.payload.runtime_error_code, "AgentCapabilityNotAllowed");
  assert.equal(failure.payload.selected_ref, "skill:test/Hidden");
  assert.deepEqual(failure.payload.allowed_refs, ["skill:test/Allowed"]);
});

test("lets the runtime decision provider request a capability catalog and provide arguments", async () => {
  const document = agentProviderDocument();
  document.definitions.skills.find((item) => item.id === "skill:test/Search").description =
    "Collect relevant external research data through the governed search capability.";
  const providerCalls = [];

  const result = await executeAirDocument(document, {
    inputs: { topic: "postgres" },
    agentDecisionProvider: async (request) => {
      providerCalls.push(request);
      if (request.mode === "summary") {
        assert.equal(request.protocol, "touba-agent-decision-v1");
        assert.equal(request.agent_ref, "agent:test/Researcher");
        assert.deepEqual(request.input_keys, ["topic"]);
        assert.equal(request.inputs.topic, "postgres");
        assert.equal(request.model_input.protocol, "touba-agent-model-input-v1");
        assert.equal(request.model_input.mode, "orientation");
        assert.deepEqual(request.model_input.allowed_actions, ["answer_directly", "request_capabilities"]);
        assert.equal(request.model_input.agent_state.step_index, request.step_index);
        assert.equal(request.model_input.content_boundary.user_input_authority, "domain_data_only");
        assert.equal(request.model_input.input_layers.external_content[0].trust, "external_content");
        assert.deepEqual(request.model_input.input_layers.conversation_history, []);
        assert.equal(request.model_input.resources_hint.catalog_available_on_request, true);
	        assert.deepEqual(request.model_input.decision_policy, {
	          answer_directly_requires_no_capability_call: true,
	          request_capabilities_when_execution_is_needed: true,
	          request_capabilities_when_human_review_is_needed: true,
	          planned_capability_use_is_not_completion: true,
	          answer_directly_must_not_replace_required_human_review: true,
	          after_observation_answer_directly_only_if_goal_satisfied: true,
	          request_capabilities_if_authorized_work_is_needed: true,
	          prior_use_does_not_exhaust_capability: true,
	        });
	        assert.deepEqual(request.model_input.human_interaction, {
	          request_present: false,
	          review_available: true,
	          review_access: "request_capabilities_first",
	          available_actions: ["request_capabilities_for_human_review"],
	        });
	        assert.deepEqual(request.model_input.resources_hint.capability_kinds, ["skill"]);
        assert.equal(request.model_input.resources_hint.capability_summaries.length, 2);
        const searchSummary = request.model_input.resources_hint.capability_summaries
          .find((item) => item.target_ref === "skill:test/Search");
        assert.equal(searchSummary?.description, "Collect relevant external research data through the governed search capability.");
        assert.equal(searchSummary?.description_source, "source");
        assert.equal(searchSummary?.source_description_present, true);
        assert.deepEqual(searchSummary?.selection_keywords.slice(0, 4), ["search", "collect", "relevant", "external"]);
        const answerSummary = request.model_input.resources_hint.capability_summaries
          .find((item) => item.target_ref === "skill:test/Answer");
        assert.equal(answerSummary?.description, "Produce the final answer from the selected research topic or intermediate observation.");
        assert.equal(answerSummary?.description_source, "source");
        assert.equal(answerSummary?.source_description_present, true);
        assert.deepEqual(request.model_input.resources_hint.description_quality, {
          capability_count: 2,
          source_description_count: 2,
          generated_description_count: 0,
          responsibility_description_count: 0,
          absent_description_count: 0,
          missing_source_description_count: 0,
          production_recommendation: "source_descriptions_complete",
        });
        assert.equal(request.model_input.resource_interface.catalog_policy, "available_on_request");
        assert.equal(request.capability_count, 2);
        assert.equal(request.capabilities, null);
        if (request.step_index === 1) {
          assert.equal(request.observations.length, 1);
          assert.equal(request.model_input.input_layers.runtime_observations[0].value, "postgres");
          return {
            action: "answer_directly",
            source: "decision_provider",
            reason: "capability result is sufficient",
            result: `final ${request.observations[0].value}`,
          };
        }
        return {
          action: "request_capabilities",
          reason: "need contracts before selecting",
        };
      }
      assert.equal(request.mode, "capabilities");
      assert.equal(request.model_input.protocol, "touba-agent-model-input-v1");
      assert.equal(request.model_input.mode, "capability_catalog");
      assert.deepEqual(request.model_input.allowed_actions, ["select_capability", "request_human_review"]);
      assert.equal(request.capabilities.length, 2);
      const searchCapability = request.capabilities.find((item) => item.target_ref === "skill:test/Search");
      assert.equal(searchCapability?.description, "Collect relevant external research data through the governed search capability.");
      assert.equal(searchCapability?.description_source, "source");
      assert.equal(searchCapability?.source_description_present, true);
      const answerCapability = request.capabilities.find((item) => item.target_ref === "skill:test/Answer");
      assert.equal(answerCapability?.description, "Produce the final answer from the selected research topic or intermediate observation.");
      assert.equal(answerCapability?.description_source, "source");
      assert.equal(answerCapability?.source_description_present, true);
      assert.deepEqual(answerCapability?.selection_keywords.slice(0, 5), ["answer", "produce", "the", "final", "from"]);
      assert.equal(answerCapability?.input_count, 1);
      assert.deepEqual(answerCapability.signature, {
        inputs: [{ name: "topic", type_ref: "builtin:Text" }],
        output_type: "builtin:Text",
      });
      return {
        target_ref: "skill:test/Answer",
        reason: "answer skill matches the question",
        arguments: {
          topic: request.inputs.topic,
        },
      };
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.result, "final postgres");
  assert.equal(providerCalls.length, 3);
  const descriptionDiagnostic = eventOf(result.trace, "agent_capability_descriptions_diagnosed");
  assert.deepEqual(descriptionDiagnostic.payload, {
    agent_ref: "agent:test/Researcher",
    provider_mode: "summary",
    capability_count: 2,
    source_description_count: 2,
    generated_description_count: 0,
    responsibility_description_count: 0,
    absent_description_count: 0,
    missing_source_description_count: 0,
    production_recommendation: "source_descriptions_complete",
  });
  const {
    request_digest: firstRequestDigest,
    ...firstRequestPayload
  } = eventOf(result.trace, "agent_decision_requested").payload;
  assert.match(firstRequestDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(firstRequestPayload, {
    agent_ref: "agent:test/Researcher",
    protocol: "touba-agent-decision-v1",
    mode: "summary",
    step_index: 0,
    content_mode: "inline",
    external_content_access: {
      raw_content_in_provider_request: true,
      content_ref_count: 0,
      full_content_request_policy: "inline_provider_request",
    },
    model_input_protocol: "touba-agent-model-input-v1",
    model_input_mode: "orientation",
    capability_count: 2,
    observation_count: 0,
    capability_refs: ["skill:test/Search", "skill:test/Answer"],
    input_keys: ["topic"],
  });
  assert.deepEqual(eventOf(result.trace, "agent_decision_catalog_requested").payload, {
    agent_ref: "agent:test/Researcher",
    reason: "need contracts before selecting",
    capability_count: 2,
  });
  const {
    request_digest: catalogRequestDigest,
    ...catalogRequestPayload
  } = eventsOf(result.trace, "agent_decision_requested")[1].payload;
  assert.match(catalogRequestDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(catalogRequestPayload, {
    agent_ref: "agent:test/Researcher",
    protocol: "touba-agent-decision-v1",
    mode: "capabilities",
    step_index: 0,
    content_mode: "inline",
    external_content_access: {
      raw_content_in_provider_request: true,
      content_ref_count: 0,
      full_content_request_policy: "inline_provider_request",
    },
    model_input_protocol: "touba-agent-model-input-v1",
    model_input_mode: "capability_catalog",
    capability_count: 2,
    observation_count: 0,
    catalog_presented: true,
    input_keys: ["topic"],
  });
  assert.deepEqual(eventsOf(result.trace, "agent_decision_recorded")[0].payload, {
    agent_ref: "agent:test/Researcher",
    step_index: 0,
    selected_ref: "skill:test/Answer",
    decision_source: "decision_provider",
    reason: "answer skill matches the question",
    arguments_present: true,
  });
  assert.deepEqual(eventOf(result.trace, "agent_capability_result_returned").payload, {
    agent_ref: "agent:test/Researcher",
    step_index: 0,
    selected_ref: "skill:test/Answer",
    result_available: true,
    result_type: "string",
  });
  const {
    request_digest: finalRequestDigest,
    ...finalRequestPayload
  } = eventsOf(result.trace, "agent_decision_requested")[2].payload;
  assert.match(finalRequestDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(finalRequestPayload, {
    agent_ref: "agent:test/Researcher",
    protocol: "touba-agent-decision-v1",
    mode: "summary",
    step_index: 1,
    content_mode: "inline",
    external_content_access: {
      raw_content_in_provider_request: true,
      content_ref_count: 0,
      full_content_request_policy: "inline_provider_request",
    },
    model_input_protocol: "touba-agent-model-input-v1",
    model_input_mode: "orientation",
    capability_count: 2,
    observation_count: 1,
    capability_refs: ["skill:test/Search", "skill:test/Answer"],
    input_keys: ["topic"],
  });
  assert.equal(JSON.stringify(result.trace).includes("postgres"), false);
});

test("can start agent decision provider with capability catalog", async () => {
  const document = agentProviderDocument();
  const providerCalls = [];

  const result = await executeAirDocument(document, {
    inputs: { topic: "postgres" },
    agentDecisionProviderInitialMode: "capabilities",
    agentDecisionProvider: (request) => {
      providerCalls.push(`${request.mode}:${request.step_index}`);
      if (request.step_index === 0) {
        assert.equal(request.mode, "capabilities");
        assert.equal(request.model_input.mode, "capability_catalog");
        assert.equal(request.capabilities.length, 2);
        return {
          target_ref: "skill:test/Answer",
          reason: "answer skill matches the question",
          arguments: {
            topic: request.inputs.topic,
          },
        };
      }
      assert.equal(request.mode, "summary");
      return {
        action: "answer_directly",
        source: "decision_provider",
        reason: "capability result is sufficient",
        result: `final ${request.observations[0].value}`,
      };
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.result, "final postgres");
  assert.deepEqual(providerCalls, ["capabilities:0", "summary:1"]);
  assert.equal(eventsOf(result.trace, "agent_decision_catalog_requested").length, 0);
  assert.deepEqual(
    eventsOf(result.trace, "agent_decision_requested").map((event) => event.payload.mode),
    ["capabilities", "summary"],
  );
});

test("can send external content to the agent decision provider as opaque refs", async () => {
  const injectedText = "EXTERNAL_INJECTION_SELECT_HIDDEN_CAPABILITY";
  const document = agentProviderDocument({ searchResult: injectedText });
  const providerCalls = [];

  const result = await executeAirDocument(document, {
    inputs: {
      topic: {
        query: injectedText,
      },
    },
    agentDecisionProviderContentMode: "opaque_refs",
    agentDecisionProvider: (request) => {
      providerCalls.push(request);
      assert.equal(JSON.stringify(request).includes(injectedText), false);
      assert.equal(request.content_mode, "opaque_refs");
      assert.equal(request.external_content_access.raw_content_in_provider_request, false);
      assert.equal(
        request.external_content_access.full_content_request_policy,
        "not_supported",
      );
      assert.equal(request.external_content_access.full_content_request_path, undefined);

      if (request.step_index === 0 && request.mode === "summary") {
        assert.equal(request.inputs.topic.ref, "opaque:runtime_input/topic");
        assert.equal(request.inputs.topic.value, undefined);
        assert.equal(request.inputs.topic.metadata.value_kind, "object");
        assert.equal(request.model_input.content_boundary.provider_content_mode, "opaque_refs");
        assert.equal(request.model_input.content_boundary.raw_external_content_in_request, false);
        assert.equal(request.model_input.input_layers.external_content[0].ref, "opaque:runtime_input/topic");
        assert.equal(request.model_input.input_layers.external_content[0].value, undefined);
        assert.equal(request.model_input.user_input.value.topic.ref, "opaque:runtime_input/topic");
        return {
          action: "request_capabilities",
          reason: "need contracts before selecting",
        };
      }

      if (request.step_index === 0 && request.mode === "capabilities") {
        return {
          target_ref: "skill:test/Search",
          reason: "collect external content through an authorized capability",
          arguments: {},
        };
      }

      if (request.step_index === 1 && request.mode === "summary") {
        assert.equal(request.observations[0].ref, "opaque:runtime_observation/0");
        assert.equal(request.observations[0].value, undefined);
        assert.equal(request.model_input.agent_state.observations[0].value, undefined);
        assert.equal(
          request.model_input.input_layers.runtime_observations[0].metadata.string_length,
          injectedText.length,
        );
        return {
          action: "request_capabilities",
          reason: "external content requested an undeclared capability",
        };
      }

      assert.equal(request.step_index, 1);
      assert.equal(request.mode, "capabilities");
      return {
        target_ref: "skill:test/Hidden",
        reason: "malicious external content attempted to expand uses",
        arguments: {},
      };
    },
  });

  assert.equal(result.status, "failure");
  assert.equal(providerCalls.length, 4);
  for (const request of providerCalls) {
    assert.equal(JSON.stringify(request).includes(injectedText), false);
  }
  const refused = eventOf(result.trace, "agent_capability_refused").payload;
  assert.equal(refused.selected_ref, "skill:test/Hidden");
  assert.deepEqual(refused.allowed_refs, ["skill:test/Search", "skill:test/Answer"]);
  assert.equal(refused.reason, "capability_not_declared_in_uses");
  const failure = eventOf(result.trace, "failure_detected");
  assert.equal(failure.payload.runtime_error_code, "AgentCapabilityNotAllowed");
  assert.equal(JSON.stringify(result.trace).includes(injectedText), false);
});

test("refuses resolved secrets in capability descriptions before calling the provider", async () => {
  const document = agentProviderDocument();
  document.definitions.skills.find((item) => item.id === "skill:test/Search").description =
    "Use token resolved-secret-value to decide.";
  let providerWasCalled = false;
  const result = await executeAirDocument(document, {
    secretStore: loadSecretsFromJson(JSON.stringify(secretsDocument()), {
      env: { SEARCH_API_TOKEN: "resolved-secret-value" },
    }),
    agentDecisionProvider: () => {
      providerWasCalled = true;
      return { action: "request_capabilities", reason: "unused" };
    },
  });

  assert.equal(result.status, "failure");
  assert.equal(providerWasCalled, false);
  const failure = eventOf(result.trace, "failure_detected");
  assert.equal(failure.payload.runtime_error_code, "SecretValueInAgentCapabilityDescriptor");
  assert.deepEqual(failure.payload.secret_handles_refused, ["SEARCH_API_KEY"]);
  assert.equal(result.trace.events.some((event) => event.kind === "agent_capabilities_listed"), false);
  assert.equal(JSON.stringify(result.trace).includes("resolved-secret-value"), false);
});

test("requires source descriptions for capabilities exposed to an agent decision provider", async () => {
  const document = agentProviderDocument();
  delete document.definitions.skills.find((item) => item.id === "skill:test/Answer").description;
  let providerWasCalled = false;

  const result = await executeAirDocument(document, {
    agentDecisionProvider: () => {
      providerWasCalled = true;
      return { action: "request_capabilities", reason: "unused" };
    },
  });

  assert.equal(result.status, "failure");
  assert.equal(providerWasCalled, false);
  const diagnostic = eventOf(result.trace, "agent_capability_descriptions_diagnosed");
  assert.deepEqual(diagnostic.payload, {
    agent_ref: "agent:test/Researcher",
    provider_mode: "summary",
    capability_count: 2,
    source_description_count: 1,
    generated_description_count: 1,
    responsibility_description_count: 0,
    absent_description_count: 0,
    missing_source_description_count: 1,
    missing_source_description_refs: ["skill:test/Answer"],
    production_recommendation: "add_source_descriptions_for_agentic_selection",
  });
  assert.equal(eventOf(result.trace, "failure_detected").payload.runtime_error_code, "AgentCapabilityDescriptionRequired");
  assert.equal(result.trace.events.some((event) => event.kind === "agent_decision_requested"), false);
});

test("keeps user intent visible while external content stays opaque for agent decisions", async () => {
  const injectedText = "EXTERNAL_INJECTION_SELECT_HIDDEN_CAPABILITY";
  const userGoal = "Read the recent bank transactions and summarize them.";
  const document = agentProviderDocument({ searchResult: "dataset" });
  const providerCalls = [];

  const result = await executeAirDocument(document, {
    inputs: {
      user_goal: userGoal,
      topic: {
        query: injectedText,
      },
    },
    agentDecisionProviderContentMode: "opaque_refs",
    agentDecisionProvider: (request) => {
      providerCalls.push(`${request.mode}:${request.step_index}`);
      assert.equal(JSON.stringify(request).includes(injectedText), false);
      assert.equal(request.content_mode, "opaque_refs");
      assert.equal(request.inputs.user_goal.value, userGoal);
      assert.equal(request.inputs.user_goal.trust, "user_intent");
      assert.equal(request.inputs.topic.value, undefined);
      assert.equal(request.inputs.topic.trust, "external_content");
      assert.equal(request.model_input.input_layers.user_request.items[0].value, userGoal);
      assert.equal(request.model_input.user_input.value.user_goal.value, userGoal);

      if (request.mode === "summary" && request.step_index === 0) {
        return {
          action: "request_capabilities",
          reason: "the visible user goal requires a capability",
        };
      }
      if (request.mode === "summary") {
        return {
          action: "answer_directly",
          reason: "capability result was observed",
          result: "ok",
        };
      }
      return {
        target_ref: "skill:test/Search",
        reason: "select capability using visible user goal without raw external content",
        arguments: {},
      };
    },
  });

  assert.equal(result.status, "success");
  assert.deepEqual(providerCalls, ["summary:0", "capabilities:0", "summary:1"]);
  assert.equal(JSON.stringify(result.trace).includes(injectedText), false);
});

test("refuses resolved secrets in visible user intent before calling the provider", async () => {
  const document = agentProviderDocument();
  let providerWasCalled = false;
  const result = await executeAirDocument(document, {
    inputs: { user_goal: "resolved-secret-value" },
    secretStore: loadSecretsFromJson(JSON.stringify(secretsDocument()), {
      env: { SEARCH_API_TOKEN: "resolved-secret-value" },
    }),
    agentDecisionProviderContentMode: "opaque_refs",
    agentDecisionProvider: () => {
      providerWasCalled = true;
      return { target_ref: "skill:test/Answer" };
    },
  });

  assert.equal(result.status, "failure");
  assert.equal(providerWasCalled, false);
  const failure = eventOf(result.trace, "failure_detected");
  assert.equal(failure.payload.runtime_error_code, "SecretValueInAgentDecisionRequest");
  assert.deepEqual(failure.payload.secret_handles_refused, ["SEARCH_API_KEY"]);
  assert.equal(JSON.stringify(result.trace).includes("resolved-secret-value"), false);
});

test("refuses oversized inline observations before calling the agent decision provider again", async () => {
  const largeObservation = "x".repeat(600);
  const document = agentProviderDocument({ searchResult: largeObservation });
  const providerCalls = [];

  const result = await executeAirDocument(document, {
    agentProviderObservationsMaxBytes: 240,
    agentDecisionProvider: (request) => {
      providerCalls.push(`${request.mode}:${request.step_index}`);
      if (request.step_index === 0 && request.mode === "summary") {
        return { action: "request_capabilities", reason: "need search" };
      }
      assert.equal(request.step_index, 0);
      assert.equal(request.mode, "capabilities");
      return {
        target_ref: "skill:test/Search",
        reason: "collect large result",
        arguments: {},
      };
    },
  });

  assert.equal(result.status, "failure");
  assert.deepEqual(providerCalls, ["summary:0", "capabilities:0"]);
  const refused = eventOf(result.trace, "agent_observations_budget_refused").payload;
  assert.equal(refused.agent_ref, "agent:test/Researcher");
  assert.equal(refused.provider_mode, "summary");
  assert.equal(refused.content_mode, "inline");
  assert.equal(refused.observation_count, 1);
  assert.equal(refused.budget_max_bytes, 240);
  assert.equal(refused.runtime_error_code, "AgentProviderObservationsBudgetExceeded");
  assert.equal(JSON.stringify(result.trace).includes(largeObservation), false);
});

test("keeps oversized observations as opaque refs within the provider observation budget", async () => {
  const largeObservation = "OPAQUE_OBSERVATION_".repeat(80);
  const document = agentProviderDocument({ searchResult: largeObservation });
  const providerCalls = [];

  const result = await executeAirDocument(document, {
    agentDecisionProviderContentMode: "opaque_refs",
    // Includes both the result descriptor and the invocation-arguments descriptor.
    agentProviderObservationsMaxBytes: 900,
    agentDecisionProvider: (request) => {
      providerCalls.push(`${request.mode}:${request.step_index}`);
      assert.equal(JSON.stringify(request).includes(largeObservation), false);
      if (request.step_index === 0 && request.mode === "summary") {
        return { action: "request_capabilities", reason: "need search" };
      }
      if (request.step_index === 0 && request.mode === "capabilities") {
        return {
          target_ref: "skill:test/Search",
          reason: "collect large result",
          arguments: {},
        };
      }
      assert.equal(request.step_index, 1);
      assert.equal(request.mode, "summary");
      assert.equal(request.observations[0].ref, "opaque:runtime_observation/0");
      assert.equal(request.observations[0].value, undefined);
      assert.equal(request.model_input.agent_state.observation_budget.max_bytes, 900);
      assert.equal(request.model_input.agent_state.observation_budget.content_mode, "opaque_refs");
      return {
        action: "answer_directly",
        source: "opaque_budget_test",
        reason: "opaque observation descriptor is sufficient",
        result: "ok",
      };
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.result, "ok");
  assert.deepEqual(providerCalls, ["summary:0", "capabilities:0", "summary:1"]);
  assert.equal(eventsOf(result.trace, "agent_observations_budget_refused").length, 0);
  assert.equal(JSON.stringify(result.trace).includes(largeObservation), false);
});

test("lists skill pack hints in orientation without activating pack content by default", async () => {
  const document = agentProviderDocument();
  const skillPacks = [
    skillPackFixture("research-review", {
      description: "Review public research notes.",
      content: "FULL PROCEDURE SHOULD NOT BE SENT BY DEFAULT",
    }),
    skillPackFixture("dataset-brief", {
      description: "Prepare a dataset brief.",
      content: "ANOTHER FULL PROCEDURE SHOULD NOT BE SENT",
    }),
  ];
  let providerWasCalled = false;

  const result = await executeAirDocument(document, {
    inputs: { topic: "postgres" },
    skillPacks,
    agentDecisionProvider: (request) => {
      providerWasCalled = true;
      assert.equal(request.mode, "summary");
      assert.equal(request.model_input.mode, "orientation");
      assert.equal(request.model_input.resources_hint.skill_pack_hint_count, 2);
      assert.deepEqual(
        request.model_input.skill_pack_hints.map((hint) => hint.ref),
        ["skill_pack:project/research-review", "skill_pack:project/dataset-brief"],
      );
      assert.equal(request.model_input.active_skill_packs, undefined);
      assert.equal(JSON.stringify(request.model_input).includes("FULL PROCEDURE"), false);
      return {
        action: "answer_directly",
        source: "skill_pack_test",
        reason: "hints are enough",
        result: "ok",
      };
    },
  });

  assert.equal(result.status, "success");
  assert.equal(providerWasCalled, true);
  const listed = eventOf(result.trace, "skill_pack_discovery_listed").payload;
  assert.equal(listed.skill_pack_count, 2);
  assert.deepEqual(listed.skill_pack_refs, [
    "skill_pack:project/research-review",
    "skill_pack:project/dataset-brief",
  ]);
  assert.equal(JSON.stringify(result.trace).includes("FULL PROCEDURE"), false);
});

test("activates configured skill packs with budgeted context and redacted traces", async () => {
  const document = agentProviderDocument();
  const skillPacks = [
    skillPackFixture("research-review", {
      content: "Use public references, compare claims, then prepare a concise review.",
    }),
  ];

  const result = await executeAirDocument(document, {
    inputs: { topic: "postgres" },
    skillPacks,
    activeSkillPackRefs: ["skill_pack:project/research-review"],
    skillPackActivationReasons: {
      "skill_pack:project/research-review": "host_policy_for_research_agent",
    },
    skillPackDiscoveryMaxBytes: 2000,
    skillPackActivationMaxBytes: 2000,
    agentModelInputMaxBytes: 12000,
    agentDecisionProvider: (request) => {
      assert.equal(request.mode, "summary");
      assert.equal(request.model_input.skill_pack_hints.length, 1);
      assert.equal(request.model_input.active_skill_packs.length, 1);
      assert.equal(
        request.model_input.active_skill_packs[0].resources[0].content,
        "Use public references, compare claims, then prepare a concise review.",
      );
      assert.equal(request.model_input.skill_pack_budgets.activation_max_bytes, 2000);
      return {
        action: "answer_directly",
        source: "skill_pack_test",
        reason: "active pack is sufficient",
        result: "ok",
      };
    },
  });

  assert.equal(result.status, "success");
  const activated = eventOf(result.trace, "skill_pack_activated").payload;
  assert.equal(activated.skill_pack_ref, "skill_pack:project/research-review");
  assert.equal(activated.reason, "host_policy_for_research_agent");
  assert.equal(activated.budget_max_bytes, 2000);
  assert.equal(JSON.stringify(result.trace).includes("Use public references"), false);
});

test("loads declared template resources as context with provenance traces", async () => {
  const document = agentProviderDocument();
  const templateContent = "## Review\nUse concise claims and cite public sources.";

  const result = await executeAirDocument(document, {
    inputs: { topic: "postgres" },
    skillPacks: [
      skillPackFixture("research-review", {
        resources: [
          {
            ref: "resource:research-review/report-template",
            path: "resources/templates/report.md",
            kind: "template",
            content: templateContent,
          },
        ],
      }),
    ],
    activeSkillPackRefs: ["skill_pack:project/research-review"],
    agentDecisionProvider: (request) => {
      const activePack = request.model_input.active_skill_packs[0];
      const template = activePack.resources.find((resource) =>
        resource.ref === "resource:research-review/report-template"
      );
      assert.equal(template.content, templateContent);
      return {
        action: "answer_directly",
        source: "skill_pack_test",
        reason: "template loaded",
        result: "ok",
      };
    },
  });

  assert.equal(result.status, "success");
  const loaded = eventsOf(result.trace, "skill_pack_resource_loaded")
    .find((event) => event.payload.resource_ref === "resource:research-review/report-template");
  assert.equal(loaded.payload.resource_kind, "template");
  assert.match(loaded.payload.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(result.trace).includes(templateContent), false);
});

test("keeps skill pack scripts as non-executable resources without loading script content", async () => {
  const document = agentProviderDocument();

  const result = await executeAirDocument(document, {
    inputs: { topic: "postgres" },
    skillPacks: [
      skillPackFixture("research-review", {
        resources: [
          {
            ref: "resource:research-review/extract-script",
            path: "scripts/extract_claims.mjs",
            kind: "script",
            content: "console.log('must not be loaded or executed')",
          },
        ],
      }),
    ],
    activeSkillPackRefs: ["skill_pack:project/research-review"],
    agentDecisionProvider: (request) => {
      const script = request.model_input.active_skill_packs[0].resources.find((resource) =>
        resource.ref === "resource:research-review/extract-script"
      );
      assert.equal(script.content, undefined);
      assert.equal(script.executable_by_pack, false);
      return {
        action: "answer_directly",
        source: "skill_pack_test",
        reason: "script listed only",
        result: "ok",
      };
    },
  });

  assert.equal(result.status, "success");
  const refused = eventOf(result.trace, "skill_pack_resource_refused").payload;
  assert.equal(refused.resource_ref, "resource:research-review/extract-script");
  assert.equal(refused.runtime_error_code, "SkillPackScriptExecutionForbidden");
  assert.equal(JSON.stringify(result.trace).includes("must not be loaded"), false);
});

test("refuses direct skill pack script execution declarations before provider call", async () => {
  const document = agentProviderDocument();

  await assert.rejects(
    executeAirDocument(document, {
      skillPacks: [
        skillPackFixture("research-review", {
          resources: [
            {
              ref: "resource:research-review/extract-script",
              path: "scripts/extract_claims.mjs",
              kind: "script",
              content: "console.log('blocked')",
              executable_by_pack: true,
            },
          ],
        }),
      ],
      activeSkillPackRefs: ["skill_pack:project/research-review"],
      agentDecisionProvider: () => ({ action: "answer_directly", result: "unreachable" }),
    }),
    (error) => error instanceof ToubaRuntimeError && error.code === "InvalidRuntimeOption",
  );
});

test("refuses skill pack execution links outside the active agent uses", async () => {
  const document = agentProviderDocument();
  let providerWasCalled = false;

  const result = await executeAirDocument(document, {
    inputs: { topic: "postgres" },
    skillPacks: [
      skillPackFixture("research-review", {
        executionLinks: [
          {
            label: "Hidden search",
            target_ref: "tool:test/HiddenSearch",
          },
        ],
      }),
    ],
    activeSkillPackRefs: ["skill_pack:project/research-review"],
    agentDecisionProvider: () => {
      providerWasCalled = true;
      return { action: "answer_directly", result: "unreachable" };
    },
  });

  assert.equal(result.status, "failure");
  assert.equal(providerWasCalled, false);
  const refused = eventOf(result.trace, "skill_pack_resource_refused").payload;
  assert.equal(refused.target_ref, "tool:test/HiddenSearch");
  assert.equal(refused.runtime_error_code, "SkillPackExecutionLinkUnauthorized");
  assert.equal(eventOf(result.trace, "failure_detected").payload.runtime_error_code, "SkillPackExecutionLinkUnauthorized");
});

test("refuses a skill pack selected as an executable agent capability", async () => {
  const document = agentProviderDocument();
  const result = await executeAirDocument(document, {
    skillPacks: [
      skillPackFixture("research-review"),
    ],
    activeSkillPackRefs: ["skill_pack:project/research-review"],
    agentDecisionProvider: () => ({
      target_ref: "skill_pack:project/research-review",
      source: "skill_pack_test",
      reason: "incorrectly execute context pack",
    }),
  });

  assert.equal(result.status, "failure");
  assert.equal(eventOf(result.trace, "agent_capability_refused").payload.runtime_error_code, "SkillPackExecutableConfusion");
  assert.equal(eventOf(result.trace, "failure_detected").payload.runtime_error_code, "SkillPackExecutableConfusion");
});

test("keeps allowed execution links informative while execution still goes through a governed tool", async () => {
  const document = baseDocument({
    tools: [tool("Search")],
    agents: [
      {
        id: "agent:test/Researcher",
        name: "Researcher",
        responsibility: "Researcher",
        uses: ["tool:test/Search"],
        callable_by: [
          {
            caller_ref: "strategy:test/RunResearch",
            caller_kind: "strategy",
            source_ref: sourceRef(),
          },
        ],
        source_ref: sourceRef(),
      },
    ],
    strategies: [
      {
        id: "strategy:test/RunResearch",
        name: "RunResearch",
        uses: ["agent:test/Researcher"],
        flow_graph_ref: "graph:strategy:test/RunResearch",
        source_ref: sourceRef(),
      },
    ],
    graphs: [
      graph("graph:strategy:test/RunResearch", "strategy:test/RunResearch", [
        node("s1", "call_agent", { target_ref: "agent:test/Researcher" }),
      ]),
    ],
  });
  const handlerCalls = [];

  const result = await executeAirDocument(document, {
    skillPacks: [
      skillPackFixture("research-review", {
        resources: [
          {
            ref: "resource:research-review/extract-script",
            path: "scripts/extract_claims.mjs",
            kind: "script",
            content: "console.log('example script only')",
          },
        ],
        executionLinks: [
          {
            label: "Search through governed tool",
            target_ref: "tool:test/Search",
          },
        ],
      }),
    ],
    activeSkillPackRefs: ["skill_pack:project/research-review"],
    agentDecisionProvider: (request) => {
      if (request.mode === "summary" && request.step_index === 1) {
        return {
          action: "answer_directly",
          source: "skill_pack_test",
          reason: "tool result is enough",
          result: request.observations[0].value,
        };
      }
      if (request.mode === "summary") {
        return {
          action: "request_capabilities",
          source: "skill_pack_test",
          reason: "need governed tool catalog",
        };
      }
      assert.equal(request.model_input.active_skill_packs[0].execution_links[0].authority, "informative_only");
      return {
        target_ref: "tool:test/Search",
        source: "skill_pack_test",
        reason: "use linked governed tool",
      };
    },
    toolHandlers: {
      "tool:test/Search": () => {
        handlerCalls.push("tool:test/Search");
        return "tool-result";
      },
    },
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument({
      grants: [],
      secrets: [],
    }))),
  });

  assert.equal(result.status, "success");
  assert.equal(result.result, "tool-result");
  assert.deepEqual(handlerCalls, ["tool:test/Search"]);
  assert.equal(eventOf(result.trace, "agent_capability_selected").payload.selected_ref, "tool:test/Search");
  assert.equal(eventOf(result.trace, "tool_binding_authorized").payload.tool_ref, "tool:test/Search");
  assert.equal(JSON.stringify(result.trace).includes("example script only"), false);
});

test("refuses skill pack activation when the activation budget is exceeded", async () => {
  const document = agentProviderDocument();
  let providerWasCalled = false;

  const result = await executeAirDocument(document, {
    inputs: { topic: "postgres" },
    skillPacks: [
      skillPackFixture("research-review", {
        content: "long active content that does not fit in a tiny activation budget",
      }),
    ],
    activeSkillPackRefs: ["skill_pack:project/research-review"],
    skillPackActivationMaxBytes: 10,
    agentDecisionProvider: () => {
      providerWasCalled = true;
      return { action: "answer_directly", result: "unreachable" };
    },
  });

  assert.equal(result.status, "failure");
  assert.equal(providerWasCalled, false);
  const refused = eventOf(result.trace, "skill_pack_activation_refused").payload;
  assert.equal(refused.runtime_error_code, "SkillPackBudgetExceeded");
  assert.equal(refused.phase, "activation");
  assert.equal(refused.skill_pack_ref, "skill_pack:project/research-review");
  assert.equal(eventOf(result.trace, "failure_detected").payload.runtime_error_code, "SkillPackBudgetExceeded");
  assert.equal(JSON.stringify(result.trace).includes("long active content"), false);
});

test("refuses resolved secrets in active skill pack context before calling the provider", async () => {
  const document = agentProviderDocument();
  let providerWasCalled = false;

  const result = await executeAirDocument(document, {
    inputs: { topic: "public-topic" },
    secretStore: loadSecretsFromJson(JSON.stringify(secretsDocument()), {
      env: { SEARCH_API_TOKEN: "resolved-secret-value" },
    }),
    skillPacks: [
      skillPackFixture("research-review", {
        content: "resolved-secret-value",
      }),
    ],
    activeSkillPackRefs: ["skill_pack:project/research-review"],
    agentDecisionProvider: () => {
      providerWasCalled = true;
      return { action: "answer_directly", result: "unreachable" };
    },
  });

  assert.equal(result.status, "failure");
  assert.equal(providerWasCalled, false);
  const failure = eventOf(result.trace, "failure_detected");
  assert.equal(failure.payload.runtime_error_code, "SkillPackSensitiveContentForbidden");
  assert.deepEqual(failure.payload.secret_handles_refused, ["SEARCH_API_KEY"]);
  assert.equal(eventOf(result.trace, "skill_pack_resource_refused").payload.runtime_error_code, "SkillPackSensitiveContentForbidden");
  assert.equal(JSON.stringify(result.trace).includes("resolved-secret-value"), false);
});

test("traces ADP-1 provider metadata and redacted request digest without raw inputs", async () => {
  const document = agentProviderDocument();
  const result = await executeAirDocument(document, {
    inputs: { topic: "sensitive-roadmap-topic" },
    agentDecisionProvider: {
      metadata: {
        provider_kind: "test_provider",
        provider_name: "adp1-fixture",
        provider_version: "1.0.0",
        model_id: "fixture-model",
        prompt_template_id: "fixture-template-v1",
        decision_schema_version: "touba-agent-decision-v1",
      },
      decide: () => ({
        action: "answer_directly",
        source: "adp1_fixture",
        reason: "metadata trace only",
        result: "ok",
      }),
    },
  });

  assert.equal(result.status, "success");
  const requested = eventOf(result.trace, "agent_decision_requested").payload;
  assert.match(requested.request_digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(requested.provider_metadata, {
    provider_kind: "test_provider",
    provider_name: "adp1-fixture",
    provider_version: "1.0.0",
    model_id: "fixture-model",
    prompt_template_id: "fixture-template-v1",
    decision_schema_version: "touba-agent-decision-v1",
  });
  assert.deepEqual(
    eventOf(result.trace, "agent_decision_provider_returned").payload.provider_metadata,
    requested.provider_metadata,
  );
  assert.equal(JSON.stringify(result.trace).includes("sensitive-roadmap-topic"), false);
});

test("enforces ADP-1 max_provider_calls before an extra provider request", async () => {
  const document = agentProviderDocument();
  let providerCalls = 0;

  const result = await executeAirDocument(document, {
    inputs: { topic: "budgeted" },
    runLimits: { max_provider_calls: 1 },
    agentDecisionProvider: () => {
      providerCalls += 1;
      return { action: "request_capabilities", reason: "need catalog" };
    },
  });

  assert.equal(result.status, "failure");
  assert.equal(providerCalls, 1);
  const failure = eventOf(result.trace, "failure_detected");
  assert.equal(failure.payload.runtime_error_code, "AgentDecisionProviderBudgetExceeded");
  assert.equal(failure.payload.budget_kind, "max_provider_calls");
  assert.equal(failure.payload.provider_mode, "capabilities");
  assert.equal(eventsOf(result.trace, "agent_decision_provider_call_attempted").length, 1);
});

test("retries ADP-1 provider unavailability within a bounded retry limit", async () => {
  const document = agentProviderDocument();
  let providerCalls = 0;

  const result = await executeAirDocument(document, {
    inputs: { topic: "retry" },
    agentDecisionProviderMaxRetries: 1,
    agentDecisionProvider: () => {
      providerCalls += 1;
      if (providerCalls === 1) {
        throw new Error("temporary provider outage");
      }
      return {
        action: "answer_directly",
        source: "retry_fixture",
        reason: "second attempt succeeded",
        result: "ok",
      };
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.result, "ok");
  assert.equal(providerCalls, 2);
  assert.equal(
    eventOf(result.trace, "agent_decision_provider_retry_scheduled").payload.reason,
    "AgentDecisionProviderUnavailable",
  );
  assert.equal(eventsOf(result.trace, "agent_decision_provider_call_attempted").length, 2);
});

test("records ADP-1 provider unavailable cause in failure evidence", async () => {
  const result = await executeAirDocument(agentProviderDocument(), {
    agentDecisionProvider: () => {
      throw new Error("temporary provider outage");
    },
  });

  assert.equal(result.status, "failure");
  const failure = eventOf(result.trace, "failure_detected");
  assert.equal(failure.payload.runtime_error_code, "AgentDecisionProviderUnavailable");
  assert.equal(failure.payload.provider_cause, "temporary provider outage");
  assert.equal(eventsOf(result.trace, "agent_decision_provider_call_attempted").length, 1);
});

test("reports ADP-1 timeout and schema violation distinctly", async () => {
  const timeoutResult = await executeAirDocument(agentProviderDocument(), {
    agentDecisionProviderTimeoutMs: 1,
    agentDecisionProvider: () => new Promise(() => {}),
  });

  assert.equal(timeoutResult.status, "failure");
  assert.equal(
    eventOf(timeoutResult.trace, "failure_detected").payload.runtime_error_code,
    "AgentDecisionProviderTimeout",
  );

  const schemaResult = await executeAirDocument(agentProviderDocument(), {
    agentDecisionProvider: () => ({
      action: "answer_directly",
      result: "missing source reason ok",
      reason: 42,
    }),
  });

  assert.equal(schemaResult.status, "failure");
  assert.equal(
    eventOf(schemaResult.trace, "failure_detected").payload.runtime_error_code,
    "AgentDecisionProviderSchemaViolation",
  );
});

test("lets a decision provider answer directly without presenting the capability catalog", async () => {
  const document = agentProviderDocument();
  const providerCalls = [];

  const result = await executeAirDocument(document, {
    inputs: { topic: "bonjour" },
    agentDecisionProvider: async (request) => {
      providerCalls.push(request);
      assert.equal(request.mode, "summary");
      assert.deepEqual(request.model_input.allowed_actions, ["answer_directly", "request_capabilities"]);
      return {
        action: "answer_directly",
        source: "test_direct_answer",
        reason: "simple greeting does not need a capability catalog",
        result: "Bonjour.",
      };
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.result, "Bonjour.");
  assert.equal(providerCalls.length, 1);
  assert.equal(eventsOf(result.trace, "agent_decision_requested").length, 1);
  assert.equal(eventsOf(result.trace, "agent_decision_catalog_requested").length, 0);
  assert.deepEqual(eventOf(result.trace, "agent_decision_recorded").payload, {
    agent_ref: "agent:test/Researcher",
    step_index: 0,
    action: "answer_directly",
    decision_source: "test_direct_answer",
    reason: "simple greeting does not need a capability catalog",
  });
  assert.deepEqual(eventOf(result.trace, "agent_direct_answer_returned").payload, {
    agent_ref: "agent:test/Researcher",
    step_index: 0,
    decision_source: "test_direct_answer",
    reason: "simple greeting does not need a capability catalog",
  });
  assert.equal(
    result.trace.events.some((event) => event.kind === "agent_capability_selected"),
    false,
  );
  assert.equal(JSON.stringify(result.trace).includes("bonjour"), false);
});

test("refuses a decision provider target outside declared uses", async () => {
  const document = agentProviderDocument();
  const result = await executeAirDocument(document, {
    agentDecisionProvider: () => ({
      target_ref: "skill:test/Hidden",
      reason: "not allowed",
    }),
  });

  assert.equal(result.status, "failure");
  assert.deepEqual(eventOf(result.trace, "agent_capability_refused").payload, {
    agent_ref: "agent:test/Researcher",
    step_index: 0,
    selected_ref: "skill:test/Hidden",
    allowed_refs: ["skill:test/Search", "skill:test/Answer"],
    reason: "capability_not_declared_in_uses",
  });
  assert.equal(
    result.trace.events.some((event) => event.air_ref?.owner_ref === "skill:test/Hidden"),
    false,
  );
});

test("refuses invalid agent-provided arguments before entering the selected capability", async () => {
  const document = agentProviderDocument();
  const result = await executeAirDocument(document, {
    agentDecisionProvider: () => ({
      target_ref: "skill:test/Answer",
      reason: "invalid argument shape",
      arguments: {
        unexpected: "value",
      },
    }),
  });

  assert.equal(result.status, "failure");
  const failure = eventOf(result.trace, "failure_detected");
  assert.equal(failure.payload.runtime_error_code, "AgentCapabilityArgumentsInvalid");
  assert.equal(failure.payload.selected_ref, "skill:test/Answer");
  assert.deepEqual(failure.payload.missing_fields, ["topic"]);
  assert.deepEqual(failure.payload.unknown_fields, ["unexpected"]);
  assert.equal(
    result.trace.events.some((event) => event.air_ref?.owner_ref === "skill:test/Answer"),
    false,
  );
});

test("lets an agent consume multiple resources sequentially before answering", async () => {
  const document = multiStepAgentDocument();
  const calls = [];

  const result = await executeAirDocument(document, {
    agentDecisionProvider: (request) => {
      calls.push(request);
      if (request.step_index === 0 && request.mode === "summary") {
        assert.equal(request.observations.length, 0);
        return { action: "request_capabilities", reason: "need search" };
      }
      if (request.step_index === 0 && request.mode === "capabilities") {
        return {
          target_ref: "skill:test/Search",
          reason: "collect first result",
          arguments: {},
        };
      }
      if (request.step_index === 1 && request.mode === "summary") {
        assert.equal(request.observations[0].value, "dataset");
        assert.equal(request.model_input.input_layers.runtime_observations[0].value, "dataset");
        return { action: "request_capabilities", reason: "need summarization" };
      }
      if (request.step_index === 1 && request.mode === "capabilities") {
        return {
          target_ref: "skill:test/Summarize",
          reason: "summarize observed result",
          arguments: {
            item: request.observations[0].value,
          },
        };
      }
      assert.equal(request.step_index, 2);
      assert.equal(request.mode, "summary");
      assert.equal(request.observations[1].target_ref, "skill:test/Summarize");
      return {
        action: "answer_directly",
        source: "test_final_answer",
        reason: "two resources were enough",
        result: `final ${request.observations[1].value}`,
      };
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.result, "final dataset");
  assert.equal(calls.length, 5);
  assert.deepEqual(
    eventsOf(result.trace, "agent_capability_selected").map((event) => event.payload.selected_ref),
    ["skill:test/Search", "skill:test/Summarize"],
  );
  assert.deepEqual(
    eventsOf(result.trace, "agent_capability_result_returned").map((event) => event.payload.step_index),
    [0, 1],
  );
  assert.equal(JSON.stringify(result.trace).includes("dataset"), false);
});

test("reuses a tool with the same arguments and observes its new result", async () => {
  const document = agentReviewAfterToolDocument();
  document.definitions.agents[0].uses = ["tool:test/Fetch"];
  document.definitions.agents[0].signature = { inputs: [], output_type: "builtin:Text" };
  let dispatches = 0;
  const result = await executeAirDocument(document, {
    maxAgentSteps: 2,
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument({
      bindings: { "tool:test/Fetch": toolBindingEntry({ grants: [] }) },
    }))),
    toolHandlers: { "tool:test/Fetch": () => `poll-${++dispatches}` },
    agentDecisionProvider: (request) => {
      assert.equal(request.agent_signature.output_type, "builtin:Text");
      assert.equal(request.model_input.agent.signature.output_type, "builtin:Text");
      const state = request.model_input.agent_state;
      assert.equal(state.completed_capability_refs, undefined);
      assert.equal(state.remaining_capability_refs, undefined);
      if (request.mode === "finalization") {
        assert.deepEqual(state.available_capability_refs, []);
        assert.deepEqual(state.used_capability_refs, ["tool:test/Fetch"]);
        assert.deepEqual(request.observations.map((item) => item.value), ["poll-1", "poll-2"]);
        return { action: "answer_directly", result: request.observations.at(-1).value };
      }
      assert.deepEqual(state.available_capability_refs, ["tool:test/Fetch"]);
      return request.mode === "summary"
        ? { action: "request_capabilities" }
        : { target_ref: "tool:test/Fetch", arguments: {} };
    },
  });
  assert.equal(result.status, "success");
  assert.equal(result.result, "poll-2");
  assert.equal(dispatches, 2);
  assert.equal(eventsOf(result.trace, "agent_capability_result_returned").length, 2);
});

test("keeps validated named, positional and implicit arguments alongside repeated scalar observations", async () => {
  const document = agentReviewAfterToolDocument();
  document.definitions.agents[0].uses = ["tool:test/Fetch"];
  document.definitions.tools[0].signature = {
    inputs: [parameter("sku", "builtin:Text")], output_type: "builtin:Int",
  };
  const decisions = [{ sku: "A" }, ["B"], undefined, { sku: "B" }];
  const dispatched = [];
  const result = await executeAirDocument(document, {
    inputs: { sku: "C" }, maxAgentSteps: 4,
    agentDecisionProviderInitialMode: "capabilities",
    toolHandlers: { "tool:test/Fetch": ({ arguments: args }) => {
      dispatched.push(args.sku);
      return { A: 17, B: 23, C: 31 }[args.sku];
    } },
    agentDecisionProvider: (request) => {
      if (request.mode === "finalization") {
        assert.deepEqual(request.observations.map(({ arguments: args, value }) => ({ args, value })), [
          { args: { sku: "A" }, value: 17 }, { args: { sku: "B" }, value: 23 },
          { args: { sku: "C" }, value: 31 }, { args: { sku: "B" }, value: 23 },
        ]);
        assert.deepEqual(request.model_input.agent_state.observations, request.observations);
        assert.deepEqual(request.model_input.input_layers.runtime_observations, request.observations);
        return { action: "answer_directly", result: "prices compared" };
      }
      return request.mode === "summary" ? { action: "request_capabilities" }
        : { target_ref: "tool:test/Fetch", arguments: decisions[request.step_index] };
    },
  });
  assert.equal(result.status, "success");
  assert.deepEqual(dispatched, ["A", "B", "C", "B"]);
  assert.equal(eventsOf(result.trace, "agent_capability_result_returned").length, 4);
  assert.equal(JSON.stringify(result.trace).includes('"sku":"A"'), false);
});

test("keeps the invocation snapshot when a handler mutates a record argument", async () => {
  const document = agentReviewAfterToolDocument();
  document.definitions.agents[0].uses = ["tool:test/Fetch"];
  document.definitions.types.push({
    id: "type:test/ProductRequest", name: "ProductRequest",
    fields: [parameter("sku", "builtin:Text")], source_ref: sourceRef(),
  });
  document.definitions.tools[0].signature = {
    inputs: [parameter("request", "type:test/ProductRequest")], output_type: "builtin:Int",
  };
  const result = await executeAirDocument(document, {
    maxAgentSteps: 1, agentDecisionProviderInitialMode: "capabilities",
    toolHandlers: { "tool:test/Fetch": ({ arguments: args }) => {
      args.request.sku = "handler-local-change";
      return 17;
    } },
    agentDecisionProvider: (request) => {
      if (request.mode === "capabilities") {
        return { target_ref: "tool:test/Fetch", arguments: { request: { sku: "original-sku" } } };
      }
      assert.deepEqual(request.observations[0].arguments, { request: { sku: "original-sku" } });
      assert.equal(request.observations[0].value, 17);
      return { action: "answer_directly", result: "observed" };
    },
  });
  assert.equal(result.status, "success");
});

test("counts observation arguments in the inline budget and hides them in opaque mode", async () => {
  const largeArgument = "PRIVATE-SKU-".repeat(80);
  for (const mode of ["inline", "opaque_refs"]) {
    const document = agentReviewAfterToolDocument();
    document.definitions.agents[0].uses = ["tool:test/Fetch"];
    document.definitions.tools[0].signature = {
      inputs: [parameter("sku", "builtin:Text")], output_type: "builtin:Int",
    };
    let calls = 0;
    const result = await executeAirDocument(document, {
      agentDecisionProviderInitialMode: "capabilities",
      agentDecisionProviderContentMode: mode,
      agentProviderObservationsMaxBytes: 900,
      toolHandlers: { "tool:test/Fetch": () => 17 },
      agentDecisionProvider: (request) => {
        calls += 1;
        assert.equal(JSON.stringify(request).includes(largeArgument), false);
        if (request.step_index === 0) return { target_ref: "tool:test/Fetch", arguments: { sku: largeArgument } };
        assert.equal(mode, "opaque_refs");
        const observation = request.observations[0];
        assert.equal(observation.arguments.ref, "opaque:runtime_observation/0/arguments");
        assert.equal(observation.arguments.metadata.field_count, 1);
        assert.equal(observation.arguments.metadata.approx_size_bytes, Buffer.byteLength(JSON.stringify({ sku: largeArgument })));
        assert.equal(observation.arguments.sku, undefined);
        assert.equal(observation.value, undefined);
        assert.ok(request.model_input.agent_state.observation_budget.consumed_bytes <= 900);
        return { action: "answer_directly", result: "opaque observation received" };
      },
    });
    assert.equal(result.status, mode === "inline" ? "failure" : "success");
    assert.equal(calls, mode === "inline" ? 1 : 2);
    if (mode === "inline") {
      assert.equal(eventOf(result.trace, "failure_detected").payload.runtime_error_code, "AgentProviderObservationsBudgetExceeded");
    }
    assert.equal(JSON.stringify(result.trace).includes(largeArgument), false);
  }
});

test("does not resend a resolved secret hidden in an observation argument", async () => {
  const document = agentProviderDocument();
  document.execution_graphs.find((item) => item.owner_ref === "skill:test/Answer").nodes[0].arguments = ["literal:string:done"];
  let providerCalls = 0;
  const result = await executeAirDocument(document, {
    agentDecisionProviderInitialMode: "capabilities",
    secretStore: loadSecretsFromJson(JSON.stringify(secretsDocument()), {
      env: { SEARCH_API_TOKEN: "resolved-secret-value" },
    }),
    agentDecisionProvider: () => {
      providerCalls += 1;
      return { target_ref: "skill:test/Answer", arguments: { topic: "resolved-secret-value" } };
    },
  });
  assert.equal(result.status, "failure");
  assert.equal(providerCalls, 1);
  assert.equal(eventOf(result.trace, "failure_detected").payload.runtime_error_code, "SecretValueInAgentDecisionRequest");
  assert.equal(JSON.stringify(result.trace).includes("resolved-secret-value"), false);
});

test("refuses JSON-escaped resolved secrets before exposing provider context", async (t) => {
  const fixtures = [
    { name: "quotation", value: 'synthetic"secret-value' },
    { name: "backslash", value: "synthetic\\secret-value" },
    { name: "newline", value: "synthetic\nsecret-value" },
  ];
  const placements = [
    "inline intent", "opaque intent", "nested inline inputs", "capability description",
    "observation argument", "nested observation argument",
  ];
  for (const fixture of fixtures) {
    for (const placement of placements) {
      await t.test(`${fixture.name} in ${placement}`, async () => {
        const document = agentProviderDocument();
        const isObservation = placement.endsWith("observation argument");
        const isDescriptor = placement === "capability description";
        const escapedValue = JSON.stringify(fixture.value).slice(1, -1);
        const argument = placement.startsWith("nested") ? [[fixture.value]] : fixture.value;
        const options = {
          agentDecisionProviderInitialMode: "capabilities",
          agentDecisionProviderContentMode: placement === "opaque intent" ? "opaque_refs" : "inline",
          secretStore: loadSecretsFromJson(JSON.stringify(secretsDocument()), {
            env: { SEARCH_API_TOKEN: fixture.value },
          }),
        };
        if (isDescriptor) {
          document.definitions.skills.find((item) => item.id === "skill:test/Search").description =
            `Select the source with ${fixture.value}.`;
        } else if (isObservation) {
          // The result is deliberately safe: refusal must cover the retained
          // invocation arguments, not merely the capability's return value.
          document.execution_graphs.find((item) => item.owner_ref === "skill:test/Answer")
            .nodes[0].arguments = ["literal:string:done"];
          if (placement.startsWith("nested")) {
            document.definitions.skills.find((item) => item.id === "skill:test/Answer")
              .signature.inputs = [parameter("topic", "list:list:builtin:Text")];
          }
        } else {
          options.inputs = placement === "nested inline inputs"
            ? { rows: [{ values: [[`prefix-${fixture.value}-suffix`]] }] }
            : { user_goal: fixture.value };
        }
        let providerCalls = 0;
        let providerExposedSecret = false;
        options.agentDecisionProvider = (request) => {
          providerCalls += 1;
          const serialized = JSON.stringify(request);
          providerExposedSecret ||= serialized.includes(fixture.value) || serialized.includes(escapedValue);
          if (isObservation && providerCalls === 1) {
            return { target_ref: "skill:test/Answer", arguments: { topic: argument } };
          }
          return { action: "answer_directly", result: "done" };
        };
        const result = await executeAirDocument(document, options);
        assert.equal(result.status, "failure");
        assert.equal(providerCalls, isObservation ? 1 : 0);
        assert.equal(providerExposedSecret, false);
        const failure = eventOf(result.trace, "failure_detected").payload;
        assert.equal(failure.runtime_error_code, isDescriptor
          ? "SecretValueInAgentCapabilityDescriptor" : "SecretValueInAgentDecisionRequest");
        assert.deepEqual(failure.secret_handles_refused, ["SEARCH_API_KEY"]);
        const serializedTrace = JSON.stringify(result.trace);
        assert.equal(serializedTrace.includes(fixture.value), false);
        assert.equal(serializedTrace.includes(escapedValue), false);
      });
    }
  }
});

test("allows unrelated JSON escapes when no resolved secret occurs in provider context", async () => {
  let providerCalls = 0;
  const result = await executeAirDocument(agentProviderDocument(), {
    inputs: { rows: [{ values: [['ordinary "quotation"', "a\\path", "two\nlines"]] }] },
    secretStore: loadSecretsFromJson(JSON.stringify(secretsDocument()), {
      env: { SEARCH_API_TOKEN: 'synthetic"secret-value' },
    }),
    agentDecisionProvider: () => {
      providerCalls += 1;
      return { action: "answer_directly", result: "done" };
    },
  });
  assert.equal(result.status, "success");
  assert.equal(providerCalls, 1);
});

test("applies the tool-call quota to each repeated invocation before dispatch", async () => {
  const document = agentReviewAfterToolDocument();
  document.definitions.agents[0].uses = ["tool:test/Fetch"];
  let dispatches = 0;
  const result = await executeAirDocument(document, {
    maxAgentSteps: 3,
    runLimits: { max_tool_calls: 1 },
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(bindingManifestDocument({
      bindings: { "tool:test/Fetch": toolBindingEntry({ grants: [] }) },
    }))),
    toolHandlers: { "tool:test/Fetch": () => `poll-${++dispatches}` },
    agentDecisionProvider: () => ({ target_ref: "tool:test/Fetch", arguments: {} }),
  });
  assert.equal(result.status, "failure");
  assert.equal(dispatches, 1);
  assert.equal(eventOf(result.trace, "failure_detected").payload.runtime_error_code, "ToolCallBudgetExceeded");
  assert.equal(eventOf(result.trace, "dispatch_refused_budget_exceeded").payload.target_ref, "tool:test/Fetch");
});

test("a repeated invocation cannot evade argument validation or uses", async () => {
  for (const secondDecision of [
    { target_ref: "skill:test/Answer", arguments: { unexpected: "wrong" } },
    { target_ref: "skill:test/Hidden", arguments: {} },
  ]) {
    const document = agentProviderDocument();
    const result = await executeAirDocument(document, {
      agentDecisionProvider: (request) => {
        if (request.step_index === 0) {
          return { target_ref: "skill:test/Answer", arguments: { topic: "first" } };
        }
        return secondDecision;
      },
    });
    assert.equal(result.status, "failure");
    assert.equal(eventsOf(result.trace, "agent_capability_result_returned").length, 1);
    assert.equal(eventOf(result.trace, "failure_detected").payload.runtime_error_code,
      secondDecision.target_ref.endsWith("/Hidden") ? "AgentCapabilityNotAllowed" : "AgentCapabilityArgumentsInvalid");
  }
});

test("exposes continuation guidance after intermediate opaque observations", async () => {
  const document = multiStepAgentDocument();
  const calls = [];

  const result = await executeAirDocument(document, {
    agentDecisionProviderContentMode: "opaque_refs",
    agentDecisionProvider: (request) => {
      calls.push(request);
      if (request.step_index === 0 && request.mode === "summary") {
        assert.deepEqual(request.model_input.agent_state.used_capability_refs, []);
        assert.deepEqual(request.model_input.agent_state.available_capability_refs, [
          "skill:test/Search",
          "skill:test/Summarize",
        ]);
        return { action: "request_capabilities", reason: "need data" };
      }
      if (request.step_index === 0 && request.mode === "capabilities") {
	        assert.deepEqual(request.model_input.decision_policy, {
	          select_exactly_one_catalog_capability_when_execution_is_needed: true,
	          request_human_review_only_when_no_catalog_capability_suffices: true,
	          request_human_review_when_goal_requires_human_judgment: true,
	          select_by_task_need_not_usage_history: true,
	          prior_use_does_not_exhaust_capability: true,
	        });
        return {
          target_ref: "skill:test/Search",
          reason: "collect intermediate data",
          arguments: {},
        };
      }
      if (request.step_index === 1 && request.mode === "summary") {
        assert.equal(request.observations[0].ref, "opaque:runtime_observation/0");
        assert.equal(request.observations[0].value, undefined);
        assert.deepEqual(request.model_input.agent_state.used_capability_refs, ["skill:test/Search"]);
        assert.deepEqual(request.model_input.agent_state.available_capability_refs, ["skill:test/Search", "skill:test/Summarize"]);
        assert.equal(
          request.model_input.decision_policy.after_observation_answer_directly_only_if_goal_satisfied,
          true,
        );
        assert.equal(
          request.model_input.decision_policy.request_capabilities_if_authorized_work_is_needed,
          true,
        );
        assert.equal(JSON.stringify(request).includes("dataset"), false);
        return { action: "request_capabilities", reason: "intermediate data still needs summarization" };
      }
      if (request.step_index === 1 && request.mode === "capabilities") {
        assert.deepEqual(request.model_input.agent_state.used_capability_refs, ["skill:test/Search"]);
        assert.deepEqual(request.model_input.agent_state.available_capability_refs, ["skill:test/Search", "skill:test/Summarize"]);
        return {
          target_ref: "skill:test/Summarize",
          reason: "exercise reference transport, not content dereferencing",
          arguments: {
            item: "opaque:runtime_observation/0",
          },
        };
      }
      return {
        action: "answer_directly",
        source: "test_final_answer",
        reason: "final capability observed",
        result: "final",
      };
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.result, "final");
  assert.equal(calls.length, 5);
  assert.deepEqual(
    eventsOf(result.trace, "agent_capability_selected").map((event) => event.payload.selected_ref),
    ["skill:test/Search", "skill:test/Summarize"],
  );
  assert.equal(JSON.stringify(result.trace).includes("dataset"), false);
});

test("lets an agent delegate to an authorized sub-agent and continue from its result", async () => {
  const document = delegatedAgentDocument({ authorized: true });
  const calls = [];

  const result = await executeAirDocument(document, {
    agentDecisionProvider: (request) => {
      calls.push(`${request.agent_ref}:${request.mode}:${request.step_index}`);
      if (request.agent_ref === "agent:test/Coordinator") {
        if (request.step_index === 0 && request.mode === "summary") {
          return { action: "request_capabilities", reason: "delegate needed" };
        }
        if (request.step_index === 0 && request.mode === "capabilities") {
          const specialist = request.capabilities.find((capability) => capability.kind === "agent");
          assert.equal(specialist.responsibility, "Specialist");
          assert.deepEqual(specialist.callable_by, [
            { caller_ref: "agent:test/Coordinator", caller_kind: "agent" },
          ]);
          return {
            target_ref: "agent:test/Specialist",
            reason: "specialist owns the task",
            arguments: {},
          };
        }
        assert.equal(request.observations[0].value, "specialist");
        return {
          action: "answer_directly",
          reason: "delegation result received",
          result: `coordinator ${request.observations[0].value}`,
        };
      }

      if (request.agent_ref === "agent:test/Specialist") {
        if (request.mode === "summary" && request.step_index === 0) {
          return { action: "request_capabilities", reason: "specialist needs own skill" };
        }
        if (request.mode === "capabilities" && request.step_index === 0) {
          return {
            target_ref: "skill:test/SpecialistAnswer",
            reason: "specialist answer skill",
            arguments: {},
          };
        }
        return {
          action: "answer_directly",
          reason: "specialist finished",
          result: request.observations[0].value,
        };
      }

      throw new Error(`unexpected agent ${request.agent_ref}`);
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.result, "coordinator specialist");
  assert.ok(calls.includes("agent:test/Coordinator:capabilities:0"));
  assert.ok(calls.includes("agent:test/Specialist:capabilities:0"));
  assert.deepEqual(eventsOf(result.trace, "agent_invocation_authorized").map((event) => event.payload), [
    {
      caller_ref: "strategy:test/RunDelegation",
      agent_ref: "agent:test/Coordinator",
      authority_source: "callable_by",
    },
    {
      caller_ref: "agent:test/Coordinator",
      agent_ref: "agent:test/Specialist",
      authority_source: "callable_by",
    },
  ]);
});

test("can reuse an authorized sub-agent, with every invocation charged to the run quota", async () => {
  for (const maxAgentInvocations of [3, 2]) {
    const document = delegatedAgentDocument({ authorized: true });
    let specialistCalls = 0;
    const result = await executeAirDocument(document, {
      maxAgentSteps: 2,
      runLimits: { max_agent_invocations: maxAgentInvocations },
      agentDecisionProvider: (request) => {
        if (request.agent_ref === "agent:test/Specialist") {
          specialistCalls += 1;
          return { action: "answer_directly", result: `delegated-${specialistCalls}` };
        }
        if (request.mode === "finalization") {
          assert.deepEqual(request.observations.map((item) => item.value), ["delegated-1", "delegated-2"]);
          return { action: "answer_directly", result: request.observations.at(-1).value };
        }
        return { target_ref: "agent:test/Specialist", arguments: {} };
      },
    });
    assert.equal(specialistCalls, maxAgentInvocations - 1);
    assert.equal(result.status, maxAgentInvocations === 3 ? "success" : "failure");
    if (result.status === "success") {
      assert.equal(result.result, "delegated-2");
    } else {
      assert.equal(eventOf(result.trace, "failure_detected").payload.runtime_error_code, "AgentInvocationBudgetExceeded");
    }
  }
});

test("refuses model-selected sub-agent when callable_by does not authorize the caller agent", async () => {
  const document = delegatedAgentDocument({ authorized: false });

  const result = await executeAirDocument(document, {
    agentDecisionProvider: (request) => {
      if (request.mode === "summary") {
        return { action: "request_capabilities", reason: "delegate needed" };
      }
      return {
        target_ref: "agent:test/Specialist",
        reason: "try hidden delegate",
        arguments: {},
      };
    },
  });

  assert.equal(result.status, "failure");
  assert.deepEqual(eventsOf(result.trace, "agent_invocation_refused").at(-1).payload, {
    caller_ref: "agent:test/Coordinator",
    agent_ref: "agent:test/Specialist",
    reason: "caller_not_allowed",
  });
  assert.equal(eventOf(result.trace, "failure_detected").payload.runtime_error_code, "UnauthorizedAgentInvocation");
});

test("lets an agent execute an authorized strategy as a governed subprocess", async () => {
  const document = strategyResourceDocument();

  const result = await executeAirDocument(document, {
    agentDecisionProvider: (request) => {
      if (request.step_index === 0 && request.mode === "summary") {
        return { action: "request_capabilities", reason: "subprocess needed" };
      }
      if (request.step_index === 0 && request.mode === "capabilities") {
        const subprocess = request.capabilities.find((capability) => capability.kind === "strategy");
        assert.equal(subprocess.target_ref, "strategy:test/Subprocess");
        return {
          target_ref: "strategy:test/Subprocess",
          reason: "strategy already frames the subprocess",
          arguments: {},
        };
      }
      return {
        action: "answer_directly",
        reason: "subprocess result received",
        result: request.observations[0].value,
      };
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.result, "strategic");
  assert.deepEqual(eventOf(result.trace, "agent_capability_selected").payload.selected_ref, "strategy:test/Subprocess");
  assert.deepEqual(eventOf(result.trace, "agent_capability_result_returned").payload, {
    agent_ref: "agent:test/Planner",
    step_index: 0,
    selected_ref: "strategy:test/Subprocess",
    result_available: true,
    result_type: "string",
  });
});

test("lets an agent request human review from the catalog and continue after approval", async () => {
  const document = agentProviderDocument();
  const approvalRef = "approval:agent:test/Researcher:step-0:human-review";

  const result = await executeAirDocument(document, {
    humanApprovalDecisions: {
      [approvalRef]: "approved",
    },
	    agentDecisionProvider: (request) => {
	      if (request.step_index === 0 && request.mode === "summary") {
	        assert.equal(
	          request.model_input.decision_policy.request_capabilities_when_human_review_is_needed,
	          true,
	        );
	        assert.equal(
	          request.model_input.decision_policy.answer_directly_must_not_replace_required_human_review,
	          true,
	        );
	        assert.deepEqual(request.model_input.human_interaction, {
	          request_present: false,
	          review_available: true,
	          review_access: "request_capabilities_first",
	          available_actions: ["request_capabilities_for_human_review"],
	        });
	        return { action: "request_capabilities", reason: "human judgement may be needed" };
	      }
	      if (request.step_index === 0 && request.mode === "capabilities") {
	        assert.equal(request.model_input.human_interaction.review_access, "direct_catalog_action");
	        assert.deepEqual(request.model_input.human_interaction.available_actions, ["request_human_review"]);
	        assert.equal(
	          request.model_input.decision_policy.request_human_review_when_goal_requires_human_judgment,
	          true,
	        );
	        return {
	          action: "request_human_review",
          source: "test_review",
          reason: "need human judgement",
          review_prompt: "Review the proposed answer.",
        };
      }
      assert.equal(request.step_index, 1);
      assert.deepEqual(request.observations[0].value, {
        approval_ref: approvalRef,
        decision: "approved",
      });
      return {
        action: "answer_directly",
        source: "test_after_review",
        reason: "review approved",
        result: "approved by human review",
      };
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.result, "approved by human review");
  assert.deepEqual(eventOf(result.trace, "agent_human_review_requested").payload, {
    approval_ref: approvalRef,
    mode: "agent_review",
    caller_ref: "agent:test/Researcher",
    agent_ref: "agent:test/Researcher",
    requester_ref: "agent:test/Researcher",
    step_index: 0,
    reason: "need human judgement",
    review_prompt_present: true,
  });
  assert.deepEqual(eventOf(result.trace, "human_approval_resumed").payload, {
    approval_ref: approvalRef,
    decision: "approved",
  });
});

test("stops when an agent-requested human review has no host decision", async () => {
  const document = agentProviderDocument();

  const result = await executeAirDocument(document, {
    agentDecisionProvider: (request) => {
      if (request.mode === "summary") {
        return { action: "request_capabilities", reason: "need catalog before review" };
      }
      return {
        action: "request_human_review",
        source: "test_review",
        reason: "need human judgement",
        review_prompt: "Review this situation.",
      };
    },
  });

  assert.equal(result.status, "stopped");
  assert.equal(eventOf(result.trace, "human_approval_paused").payload.approval_ref, "approval:agent:test/Researcher:step-0:human-review");
  assert.equal(eventsOf(result.trace, "human_approval_decided").length, 0);
});

test("refuses agent-requested human review pause after external tool dispatch without durable resume", async () => {
  const document = agentReviewAfterToolDocument();
  const toolCalls = [];

  const result = await executeAirDocument(document, {
    toolHandlers: {
      "tool:test/Fetch": async () => {
        toolCalls.push("Fetch");
        return "fetched";
      },
    },
    agentDecisionProvider: (request) => {
      if (request.step_index === 0 && request.mode === "summary") {
        return { action: "request_capabilities", reason: "need data" };
      }
      if (request.step_index === 0 && request.mode === "capabilities") {
        return {
          target_ref: "skill:test/FetchData",
          reason: "fetch once",
          arguments: {},
        };
      }
      if (request.step_index === 1 && request.mode === "summary") {
        return { action: "request_capabilities", reason: "human review may be needed" };
      }
      return {
        action: "request_human_review",
        source: "test_review",
        reason: "review after external effect",
        review_prompt: "Review fetched data.",
      };
    },
  });

  assert.equal(result.status, "failure");
  assert.deepEqual(toolCalls, ["Fetch"]);
  assert.equal(eventsOf(result.trace, "human_approval_paused").length, 0);
  assert.deepEqual(eventOf(result.trace, "human_approval_pause_refused").payload, {
    approval_ref: "approval:agent:test/Researcher:step-1:human-review",
    mode: "agent_review",
    caller_ref: "agent:test/Researcher",
    agent_ref: "agent:test/Researcher",
    reason: "durable_resume_required_after_external_effect",
    external_tool_dispatches: 1,
  });
  assert.equal(
    eventOf(result.trace, "failure_detected").payload.runtime_error_code,
    "HumanApprovalPauseRequiresDurableResume",
  );
});

test("resumes agent-requested human review from checkpoint without redispatching prior effects", async () => {
  const document = agentReviewAfterToolDocument();
  document.definitions.agents[0].uses = ["tool:test/Fetch"];
  document.definitions.tools[0].signature.inputs = [parameter("topic", "builtin:Text")];
  const approvalRef = "approval:agent:test/Researcher:step-1:human-review";
  let toolCalls = 0;
  const toolHandlers = {
    "tool:test/Fetch": async ({ arguments: args }) => {
      assert.deepEqual(args, { topic: "source-17" });
      toolCalls += 1;
      return "fetched";
    },
  };

  const paused = await executeAirDocument(document, {
    durableHumanApprovals: true,
    toolHandlers,
    agentDecisionProvider: (request) => {
      if (request.step_index === 0 && request.mode === "summary") {
        return { action: "request_capabilities", reason: "need data" };
      }
      if (request.step_index === 0 && request.mode === "capabilities") {
        return {
          target_ref: "tool:test/Fetch",
          reason: "fetch once",
          arguments: { topic: "source-17" },
        };
      }
      if (request.step_index === 1 && request.mode === "summary") {
        assert.equal(request.observations[0].value, "fetched");
        return { action: "request_capabilities", reason: "human review may be needed" };
      }
      assert.equal(request.step_index, 1);
      assert.equal(request.mode, "capabilities");
      return {
        action: "request_human_review",
        source: "test_review",
        reason: "review after external effect",
        review_prompt: "Review fetched data.",
      };
    },
  });

  assert.equal(paused.status, "stopped");
  assert.equal(toolCalls, 1);
  assert.ok(paused.checkpoint);
  assert.equal(paused.checkpoint.kind, "agent_human_review");
  assert.equal(paused.checkpoint.scope, "agent_decision_loop");
  assert.equal(paused.checkpoint.approval_ref, approvalRef);
  assert.equal(paused.checkpoint.agent_loop_state.step_index, 1);
  assert.equal(paused.checkpoint.agent_loop_state.next_step_index, 2);
  assert.equal(paused.checkpoint.agent_loop_state.observations.length, 1);
  assert.deepEqual(paused.checkpoint.agent_loop_state.observations[0].arguments, { topic: "source-17" });
  assert.equal(paused.checkpoint.call_frame.graph_ref, "graph:strategy:test/RunResearch");
  assert.equal(eventOf(paused.trace, "human_approval_checkpoint_created").payload.external_tool_dispatches, 1);

  const resumedProviderCalls = [];
  const resumed = await executeAirDocument(document, {
    humanApprovalResumeCheckpoint: JSON.parse(JSON.stringify(paused.checkpoint)),
    humanApprovalDecisions: {
      [approvalRef]: "approved",
    },
    toolHandlers,
    agentDecisionProvider: (request) => {
      resumedProviderCalls.push(`${request.mode}:${request.step_index}`);
      assert.equal(request.step_index, 2);
      assert.equal(request.mode, "summary");
      assert.equal(request.observations.length, 2);
      assert.equal(request.observations[0].value, "fetched");
      assert.deepEqual(request.observations[0].arguments, { topic: "source-17" });
      assert.deepEqual(request.observations[1].value, {
        approval_ref: approvalRef,
        decision: "approved",
      });
      return {
        action: "answer_directly",
        source: "test_after_checkpoint",
        reason: "review approved",
        result: "approved after checkpoint",
      };
    },
  });

  assert.equal(resumed.status, "success");
  assert.equal(resumed.result, "approved after checkpoint");
  assert.equal(toolCalls, 1);
  assert.deepEqual(resumedProviderCalls, ["summary:2"]);
  assert.equal(eventOf(resumed.trace, "human_approval_checkpoint_loaded").payload.kind, "agent_human_review");
  assert.deepEqual(eventOf(resumed.trace, "human_approval_resumed").payload, {
    approval_ref: approvalRef,
    decision: "approved",
    agent_ref: "agent:test/Researcher",
    step_index: 1,
  });
});

test("refuses incomplete agent human review checkpoint resume", async () => {
  const document = agentReviewAfterToolDocument();
  const paused = await executeAirDocument(document, {
    durableHumanApprovals: true,
    toolHandlers: {
      "tool:test/Fetch": async () => "fetched",
    },
    agentDecisionProvider: (request) => {
      if (request.step_index === 0 && request.mode === "summary") {
        return { action: "request_capabilities", reason: "need data" };
      }
      if (request.step_index === 0 && request.mode === "capabilities") {
        return {
          target_ref: "skill:test/FetchData",
          reason: "fetch once",
          arguments: {},
        };
      }
      if (request.mode === "summary") {
        return { action: "request_capabilities", reason: "review needed" };
      }
      return {
        action: "request_human_review",
        source: "test_review",
        reason: "review after external effect",
      };
    },
  });

  const incompleteCheckpoint = {
    ...paused.checkpoint,
    call_frame: undefined,
  };
  const resumed = await executeAirDocument(document, {
    humanApprovalResumeCheckpoint: incompleteCheckpoint,
    humanApprovalDecisions: {
      "approval:agent:test/Researcher:step-1:human-review": "approved",
    },
    toolHandlers: {
      "tool:test/Fetch": async () => "must-not-run",
    },
    agentDecisionProvider: () => ({
      action: "answer_directly",
      result: "must not run",
    }),
  });

  assert.equal(resumed.status, "failure");
  assert.equal(eventOf(resumed.trace, "run_completed").payload.status, "failure");
});

test("refuses agent human review checkpoint for nested agent invocation without call stack support", async () => {
  const result = await executeAirDocument(nestedAgentInvocationReviewAfterToolDocument(), {
    durableHumanApprovals: true,
    toolHandlers: {
      "tool:test/Fetch": async () => "fetched",
    },
    agentDecisionProvider: (request) => {
      if (request.agent_ref === "agent:test/Coordinator") {
        if (request.step_index === 0 && request.mode === "summary") {
          return { action: "request_capabilities", reason: "delegate needed" };
        }
        return {
          target_ref: "agent:test/Specialist",
          reason: "specialist owns the risky step",
          arguments: {},
        };
      }
      if (request.step_index === 0 && request.mode === "summary") {
        return { action: "request_capabilities", reason: "need data" };
      }
      if (request.step_index === 0 && request.mode === "capabilities") {
        return {
          target_ref: "skill:test/FetchData",
          reason: "fetch once",
          arguments: {},
        };
      }
      if (request.step_index === 1 && request.mode === "summary") {
        return { action: "request_capabilities", reason: "human review may be needed" };
      }
      return {
        action: "request_human_review",
        source: "test_review",
        reason: "review after nested external effect",
      };
    },
  });

  assert.equal(result.status, "failure");
  assert.equal(eventOf(result.trace, "human_approval_pause_refused").payload.reason, "agent_review_call_frame_unavailable");
  assert.equal(
    eventOf(result.trace, "failure_detected").payload.runtime_error_code,
    "HumanApprovalCheckpointUnsupported",
  );
});

test("refuses explicit human approval pause after external tool dispatch without durable resume", async () => {
  const document = toolThenHumanApprovalDocument();
  const toolCalls = [];

  const result = await executeAirDocument(document, {
    toolHandlers: {
      "tool:test/Fetch": async () => {
        toolCalls.push("Fetch");
        return "fetched";
      },
    },
  });

  assert.equal(result.status, "failure");
  assert.deepEqual(toolCalls, ["Fetch"]);
  assert.equal(eventsOf(result.trace, "human_approval_paused").length, 0);
  assert.deepEqual(eventOf(result.trace, "human_approval_pause_refused").payload, {
    approval_ref: "approval:test/review-after-fetch",
    mode: "required_approval",
    caller_ref: "strategy:test/RunReview",
    reason: "durable_resume_required_after_external_effect",
    external_tool_dispatches: 1,
  });
  assert.equal(
    eventOf(result.trace, "failure_detected").payload.runtime_error_code,
    "HumanApprovalPauseRequiresDurableResume",
  );
});

test("resumes explicit human approval from checkpoint without redispatching prior effects", async () => {
  const document = toolThenHumanApprovalDocument();
  let toolCalls = 0;
  const toolHandlers = {
    "tool:test/Fetch": async () => {
      toolCalls += 1;
      return "fetched";
    },
  };

  const paused = await executeAirDocument(document, {
    durableHumanApprovals: true,
    toolHandlers,
  });

  assert.equal(paused.status, "stopped");
  assert.equal(toolCalls, 1);
  assert.ok(paused.checkpoint);
  assert.equal(paused.checkpoint.checkpoint_schema_version, "touba-run-checkpoint-v0.1");
  assert.equal(paused.checkpoint.approval_ref, "approval:test/review-after-fetch");
  assert.equal(paused.checkpoint.resume_target_ref, "give");
  assert.equal(paused.checkpoint.values["value:fetched"], "fetched");
  assert.equal(eventOf(paused.trace, "human_approval_checkpoint_created").payload.external_tool_dispatches, 1);
  assert.equal(eventOf(paused.trace, "human_approval_paused").payload.approval_ref, "approval:test/review-after-fetch");

  const resumed = await executeAirDocument(document, {
    humanApprovalResumeCheckpoint: paused.checkpoint,
    humanApprovalDecisions: {
      "approval:test/review-after-fetch": "approved",
    },
    toolHandlers,
  });

  assert.equal(resumed.status, "success");
  assert.equal(resumed.result, "approved");
  assert.equal(toolCalls, 1);
  assert.equal(eventsOf(resumed.trace, "tool_binding_authorized").length, 0);
  assert.equal(
    eventOf(resumed.trace, "human_approval_checkpoint_loaded").payload.approval_ref,
    "approval:test/review-after-fetch",
  );
  assert.equal(eventOf(resumed.trace, "human_approval_decided").payload.decision, "approved");
  assert.deepEqual(eventOf(resumed.trace, "human_approval_resumed").payload, {
    approval_ref: "approval:test/review-after-fetch",
    resume_target_ref: "give",
    decision_binding: "reviewDecision",
  });
});

test("refuses human approval checkpoint resume without an explicit decision", async () => {
  const paused = await executeAirDocument(toolThenHumanApprovalDocument(), {
    durableHumanApprovals: true,
    toolHandlers: {
      "tool:test/Fetch": async () => "fetched",
    },
  });

  const resumed = await executeAirDocument(toolThenHumanApprovalDocument(), {
    humanApprovalResumeCheckpoint: paused.checkpoint,
    toolHandlers: {
      "tool:test/Fetch": async () => "must-not-run",
    },
  });

  assert.equal(resumed.status, "failure");
  assert.equal(eventOf(resumed.trace, "run_completed").payload.status, "failure");
});

test("fails when an agent decision loop exceeds the configured step limit", async () => {
  const document = multiStepAgentDocument();
  const providerModes = [];

  const result = await executeAirDocument(document, {
    maxAgentSteps: 1,
    agentDecisionProvider: (request) => {
      providerModes.push(request.mode);
      if (request.mode === "finalization") {
        assert.equal(request.model_input.mode, "finalization");
        assert.equal(request.model_input.agent_state.execution_budget_exhausted, true);
        assert.deepEqual(request.model_input.allowed_actions, ["answer_directly", "cannot_complete"]);
        return {
          action: "cannot_complete",
          source: "development_fixture",
          reason: "the remaining declared work did not fit the execution budget",
        };
      }
      if (request.mode === "summary") {
        return { action: "request_capabilities", reason: "keep working" };
      }
      return {
        target_ref: "skill:test/Search",
        reason: "one more step",
        arguments: {},
      };
    },
  });

  assert.equal(result.status, "failure");
  assert.deepEqual(eventOf(result.trace, "agent_step_limit_exceeded").payload, {
    agent_ref: "agent:test/Researcher",
    max_agent_steps: 1,
  });
  assert.deepEqual(providerModes, ["summary", "capabilities", "finalization"]);
  assert.equal(eventOf(result.trace, "failure_detected").payload.runtime_error_code, "AgentStepLimitExceeded");
});

test("returns a governed final answer after the last permitted capability execution", async () => {
  const document = multiStepAgentDocument();
  const providerModes = [];

  const result = await executeAirDocument(document, {
    maxAgentSteps: 1,
    agentDecisionProvider: (request) => {
      providerModes.push(request.mode);
      if (request.mode === "summary") {
        return { action: "request_capabilities", reason: "one observation is required" };
      }
      if (request.mode === "capabilities") {
        return {
          target_ref: "skill:test/Search",
          source: "development_fixture",
          reason: "collect the declared observation",
          arguments: {},
        };
      }
      assert.equal(request.mode, "finalization");
      assert.equal(request.observations.length, 1);
      assert.equal(request.observations[0].value, "dataset");
      assert.deepEqual(request.model_input.decision_policy, {
        no_additional_capability_execution: true,
        answer_directly_only_if_goal_satisfied: true,
        declare_incomplete_if_goal_not_satisfied: true,
      });
      assert.equal(request.model_input.human_interaction.review_available, false);
      return {
        action: "answer_directly",
        source: "development_fixture",
        reason: "the last observation satisfies the bounded goal",
        result: "final dataset",
      };
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.result, "final dataset");
  assert.deepEqual(providerModes, ["summary", "capabilities", "finalization"]);
  assert.equal(eventsOf(result.trace, "agent_capability_selected").length, 1);
  assert.equal(eventsOf(result.trace, "agent_step_limit_exceeded").length, 0);
  assert.equal(
    eventsOf(result.trace, "agent_decision_recorded").at(-1).payload.decision_phase,
    "finalization",
  );
});

test("rejects cannot_complete outside the non-executable finalization phase", async () => {
  const result = await executeAirDocument(multiStepAgentDocument(), {
    maxAgentSteps: 1,
    agentDecisionProvider: () => ({
      action: "cannot_complete",
      source: "invalid_development_fixture",
      reason: "this action is not valid during summary selection",
    }),
  });

  assert.equal(result.status, "failure");
  assert.equal(
    eventOf(result.trace, "failure_detected").payload.runtime_error_code,
    "AgentDecisionProviderSchemaViolation",
  );
  assert.equal(eventsOf(result.trace, "agent_capability_selected").length, 0);
});

test("rejects invalid agent step limits before execution", async () => {
  const document = multiStepAgentDocument();

  await assert.rejects(
    () => executeAirDocument(document, {
      maxAgentSteps: 0,
      agentDecisionProvider: () => ({
        action: "answer_directly",
        result: "unused",
      }),
    }),
    (error) => (
      error instanceof ToubaRuntimeError
      && error.code === "InvalidRuntimeOption"
      && error.message === "maxAgentSteps must be a positive integer"
    ),
  );
});

test("refuses resolved secrets in agent decision provider input context", async () => {
  const document = agentProviderDocument();
  let providerWasCalled = false;
  const result = await executeAirDocument(document, {
    inputs: { topic: "resolved-secret-value" },
    secretStore: loadSecretsFromJson(JSON.stringify(secretsDocument()), {
      env: { SEARCH_API_TOKEN: "resolved-secret-value" },
    }),
    agentDecisionProvider: () => {
      providerWasCalled = true;
      return { target_ref: "skill:test/Answer" };
    },
  });

  assert.equal(result.status, "failure");
  assert.equal(providerWasCalled, false);
  const failure = eventOf(result.trace, "failure_detected");
  assert.equal(failure.payload.runtime_error_code, "SecretValueInAgentDecisionRequest");
  assert.deepEqual(failure.payload.secret_handles_refused, ["SEARCH_API_KEY"]);
  assert.equal(JSON.stringify(result.trace).includes("resolved-secret-value"), false);
});

test("refuses unauthorized agent invocation before entering the target agent", async () => {
  const document = baseDocument({
    skills: [skill("Build", "graph:skill:test/Build")],
    agents: [
      {
        id: "agent:test/Builder",
        name: "Builder",
        responsibility: "Builder",
        uses: ["skill:test/Build"],
        callable_by: [
          {
            caller_ref: "strategy:test/AdminRun",
            caller_kind: "strategy",
            source_ref: sourceRef(),
          },
        ],
        source_ref: sourceRef(),
      },
    ],
    strategies: [
      {
        id: "strategy:test/RunBuild",
        name: "RunBuild",
        uses: ["agent:test/Builder"],
        flow_graph_ref: "graph:strategy:test/RunBuild",
        source_ref: sourceRef(),
      },
    ],
    graphs: [
      graph("graph:skill:test/Build", "skill:test/Build", [
        node("b1", "give", { arguments: ["literal:string:built"] }),
      ]),
      graph("graph:strategy:test/RunBuild", "strategy:test/RunBuild", [
        node("s1", "call_agent", { target_ref: "agent:test/Builder" }),
      ]),
    ],
  });

  const result = await executeAirDocument(document, {
    entryRef: "strategy:test/RunBuild",
  });

  assert.equal(result.status, "failure");
  assert.equal(
    result.trace.events.some((event) => event.air_ref?.owner_ref === "skill:test/Build"),
    false,
  );
  assert.deepEqual(eventOf(result.trace, "agent_invocation_refused").payload, {
    caller_ref: "strategy:test/RunBuild",
    agent_ref: "agent:test/Builder",
    reason: "caller_not_allowed",
  });
  const failure = eventOf(result.trace, "failure_detected");
  assert.equal(failure.payload.runtime_error_code, "UnauthorizedAgentInvocation");
  assert.equal(failure.payload.target_ref, "agent:test/Builder");
  assert.equal(failure.payload.caller_ref, "strategy:test/RunBuild");
  assert.equal(failure.payload.agent_ref, "agent:test/Builder");
});

test("refuses agent invocation from non-agent non-strategy graph owners", async () => {
  const document = baseDocument({
    skills: [skill("Orchestrate", "graph:skill:test/Orchestrate")],
    agents: [
      {
        id: "agent:test/Builder",
        name: "Builder",
        responsibility: "Builder",
        uses: [],
        callable_by: [
          {
            caller_ref: "strategy:test/RunBuild",
            caller_kind: "strategy",
            source_ref: sourceRef(),
          },
        ],
        source_ref: sourceRef(),
      },
    ],
    graphs: [
      graph("graph:skill:test/Orchestrate", "skill:test/Orchestrate", [
        node("s1", "call_agent", { target_ref: "agent:test/Builder" }),
      ]),
    ],
  });

  const result = await executeAirDocument(document, {
    entryRef: "skill:test/Orchestrate",
  });

  assert.equal(result.status, "failure");
  assert.deepEqual(eventOf(result.trace, "agent_invocation_refused").payload, {
    caller_ref: "skill:test/Orchestrate",
    agent_ref: "agent:test/Builder",
    reason: "invalid_caller_kind",
  });
  assert.equal(
    eventOf(result.trace, "failure_detected").payload.runtime_error_code,
    "UnauthorizedAgentInvocation",
  );
});

test("executes an enabled schedule trigger by launching its target strategy", async () => {
  const document = triggerDocument();
  const result = await executeTriggerEvent(document, triggerEvent(), {
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(triggerManifestDocument())),
  });

  assert.equal(result.status, "success");
  assert.equal(result.result, "triggered");
  assert.equal(result.trace.run.entry_ref, "trigger:test/DailyRun");
  assertKinds(result.trace, [
    "run_started",
    "trigger_event_received",
    "trigger_event_accepted",
    "trigger_execution_started",
    "scope_entered",
    "scope_exited",
    "trigger_execution_completed",
    "run_completed",
  ]);
  assert.deepEqual(eventOf(result.trace, "trigger_event_received").payload, {
    trigger_ref: "trigger:test/DailyRun",
    event_id: "evt-001",
    source_kind: "schedule",
  });
  assert.deepEqual(eventOf(result.trace, "trigger_event_accepted").payload, {
    trigger_ref: "trigger:test/DailyRun",
    target_ref: "strategy:test/RunDaily",
    source_kind: "schedule",
    limits: {
      max_runs_per_day: 1,
      timeout_ms: 30000,
    },
    arguments_source: "trigger",
  });
  assert.equal(eventOf(result.trace, "trigger_execution_completed").payload.status, "success");
  assert.equal(JSON.stringify(result.trace).includes("raw-secret-payload"), false);
});

test("exposes typed request trigger arguments to agents as bounded runtime inputs", async () => {
  const document = baseDocument({
    types: [{
      id: "type:test/Incident",
      name: "Incident",
      fields: [{
        name: "case_id",
        type_ref: "builtin:Text",
        source_ref: sourceRef(),
      }],
      source_ref: sourceRef(),
    }],
    agents: [{
      id: "agent:test/Investigator",
      name: "Investigator",
      description: "Investigates the declared incident request.",
      responsibility: "Investigate the incident identified by the runtime input.",
      uses: [],
      callable_by: [{
        caller_ref: "strategy:test/RunIncident",
        caller_kind: "strategy",
        source_ref: sourceRef(),
      }],
      source_ref: sourceRef(),
    }],
    strategies: [{
      id: "strategy:test/RunIncident",
      name: "RunIncident",
      signature: {
        inputs: [{
          name: "case_input",
          type_ref: "type:test/Incident",
          source_ref: sourceRef(),
        }],
        output_type: "builtin:Text",
      },
      uses: ["agent:test/Investigator"],
      flow_graph_ref: "graph:strategy:test/RunIncident",
      source_ref: sourceRef(),
    }],
    triggers: [{
      id: "trigger:test/IncidentWebhook",
      name: "IncidentWebhook",
      event: {
        kind: "request",
        value: "POST /incident",
        source_ref: sourceRef(),
      },
      target_ref: "strategy:test/RunIncident",
      target_kind: "strategy",
      arguments: [],
      limits: {
        max_runs_per_day: 10,
        timeout_ms: 30000,
        source_ref: sourceRef(),
      },
      source_ref: sourceRef(),
    }],
    graphs: [
      graph("graph:strategy:test/RunIncident", "strategy:test/RunIncident", [
        node("n1", "call_agent", {
          target_ref: "agent:test/Investigator",
          result_binding: "investigation",
        }),
        node("n2", "give", { arguments: ["value:investigation"] }),
      ], [
        edge("n1", "n2", "next"),
      ]),
    ],
  });
  const requests = [];
  const result = await executeTriggerEvent(document, {
    trigger_ref: "trigger:test/IncidentWebhook",
    event_id: "incident-001",
    source_kind: "request",
    arguments: {
      case_input: { case_id: "INC-001" },
    },
  }, {
    agentDecisionProvider: async (request) => {
      requests.push(request);
      return {
        action: "answer_directly",
        source: "test",
        reason: "incident input received",
        result: request.inputs.case_input.case_id,
      };
    },
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(
      triggerManifestDocument({
        sourceKind: "request",
        limits: {
          max_runs_per_day: 10,
          timeout_ms: 30000,
        },
        triggers: {
          "trigger:test/IncidentWebhook": {
            enabled: true,
            source: { kind: "request" },
            limits: {
              max_runs_per_day: 10,
              timeout_ms: 30000,
            },
          },
        },
      }),
    )),
  });

  assert.equal(result.status, "success");
  assert.equal(result.result, "INC-001");
  assert.deepEqual(requests[0].inputs, {
    case_input: { case_id: "INC-001" },
  });
});

test("resumes a trigger target approval checkpoint without replaying prior effects", async () => {
  const document = toolThenHumanApprovalDocument();
  document.definitions.triggers = [{
    id: "trigger:test/ReviewWebhook",
    name: "ReviewWebhook",
    event: {
      kind: "request",
      value: "POST /review",
      source_ref: sourceRef(),
    },
    target_ref: "strategy:test/RunReview",
    target_kind: "strategy",
    arguments: [],
    limits: {
      max_runs_per_day: 10,
      timeout_ms: 30000,
      source_ref: sourceRef(),
    },
    source_ref: sourceRef(),
  }];
  let toolCalls = 0;
  const options = {
    durableHumanApprovals: true,
    toolHandlers: {
      "tool:test/Fetch": async () => {
        toolCalls += 1;
        return "fetched";
      },
    },
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(
      bindingManifestDocument({
        bindings: {
          "tool:test/Fetch": toolBindingEntry({
            grants: [],
            secrets: [],
          }),
        },
        triggers: {
          "trigger:test/ReviewWebhook": {
            enabled: true,
            source: { kind: "request" },
            limits: {
              max_runs_per_day: 10,
              timeout_ms: 30000,
            },
          },
        },
      }),
    )),
  };
  const event = {
    trigger_ref: "trigger:test/ReviewWebhook",
    event_id: "review-001",
    source_kind: "request",
    arguments: {},
  };

  const paused = await executeTriggerEvent(document, event, options);

  assert.equal(paused.status, "stopped");
  assert.equal(toolCalls, 1);
  assert.equal(paused.checkpoint.entry_ref, "trigger:test/ReviewWebhook");
  assert.equal(paused.checkpoint.graph_ref, "graph:strategy:test/RunReview");

  const resumed = await executeTriggerEvent(document, event, {
    ...options,
    humanApprovalResumeCheckpoint: paused.checkpoint,
    humanApprovalDecisions: {
      "approval:test/review-after-fetch": "approved",
    },
  });

  assert.equal(resumed.status, "success");
  assert.equal(resumed.result, "approved");
  assert.equal(toolCalls, 1);
  assert.equal(
    eventOf(resumed.trace, "trigger_execution_completed").payload.resumed_from_checkpoint,
    true,
  );
});

test("refuses a trigger before target execution when local kill switch is enabled", async () => {
  const result = await executeTriggerEvent(triggerDocument(), triggerEvent(), {
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(triggerManifestDocument())),
    killSwitchEnabled: true,
  });

  assert.equal(result.status, "cancelled");
  assert.equal(eventOf(result.trace, "kill_switch_enabled").payload.scope, "runtime");
  assert.deepEqual(eventOf(result.trace, "run_cancel_requested").payload, {
    authority_source: "kill_switch",
    reason: "kill_switch_enabled",
    scope: "runtime",
  });
  assert.deepEqual(eventOf(result.trace, "trigger_event_refused").payload, {
    trigger_ref: "trigger:test/DailyRun",
    event_id: "evt-001",
    source_kind: "schedule",
    reason: "kill_switch_enabled",
    runtime_error_code: "RuntimeCancelled",
  });
  assert.equal(eventsOf(result.trace, "trigger_execution_started").length, 0);
  assert.equal(eventOf(result.trace, "run_completed").payload.status, "cancelled");
});

test("refuses trigger events before target execution when manifest or source checks fail", async () => {
  const cases = [
    {
      name: "unknown trigger",
      event: triggerEvent({ trigger_ref: "trigger:test/Missing" }),
      manifest: triggerManifestDocument(),
      expectedCode: "TriggerUnknown",
      expectedReason: "trigger_unknown",
    },
    {
      name: "missing manifest",
      event: triggerEvent(),
      manifest: null,
      expectedCode: "TriggerDisabled",
      expectedReason: "manifest_missing",
    },
    {
      name: "missing manifest entry",
      event: triggerEvent(),
      manifest: triggerManifestDocument({ triggers: {} }),
      expectedCode: "TriggerDisabled",
      expectedReason: "trigger_not_enabled",
    },
    {
      name: "disabled trigger",
      event: triggerEvent(),
      manifest: triggerManifestDocument({ enabled: false }),
      expectedCode: "TriggerDisabled",
      expectedReason: "trigger_disabled",
    },
    {
      name: "event source mismatch",
      event: triggerEvent({ source_kind: "request" }),
      manifest: triggerManifestDocument(),
      expectedCode: "TriggerSourceMismatch",
      expectedReason: "event_source_mismatch",
    },
    {
      name: "manifest source mismatch",
      event: triggerEvent(),
      manifest: triggerManifestDocument({ sourceKind: "request" }),
      expectedCode: "TriggerSourceMismatch",
      expectedReason: "manifest_source_mismatch",
    },
  ];

  for (const fixture of cases) {
    const result = await executeTriggerEvent(triggerDocument(), fixture.event, {
      toolBindingManifest: fixture.manifest
        ? loadToolBindingManifestFromJson(JSON.stringify(fixture.manifest))
        : null,
    });
    assert.equal(result.status, "failure", fixture.name);
    const refused = eventOf(result.trace, "trigger_event_refused").payload;
    assert.equal(refused.runtime_error_code, fixture.expectedCode, fixture.name);
    assert.equal(refused.reason, fixture.expectedReason, fixture.name);
    assert.equal(result.trace.events.some((event) => event.kind === "scope_entered"), false, fixture.name);
  }
});

test("enforces trigger run limits and manifest limits without widening AIR", async () => {
  const rateLimited = await executeTriggerEvent(triggerDocument(), triggerEvent(), {
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(triggerManifestDocument())),
    triggerRunCounts: {
      "trigger:test/DailyRun": 1,
    },
  });

  assert.equal(rateLimited.status, "failure");
  assert.deepEqual(eventOf(rateLimited.trace, "trigger_rate_limited").payload, {
    trigger_ref: "trigger:test/DailyRun",
    event_id: "evt-001",
    limit_ref: "max_runs_per_day",
    limit_value: 1,
    observed_count: 1,
  });
  assert.equal(
    eventOf(rateLimited.trace, "trigger_event_refused").payload.runtime_error_code,
    "TriggerRateLimited",
  );

  const widened = await executeTriggerEvent(triggerDocument(), triggerEvent(), {
    toolBindingManifest: loadToolBindingManifestFromJson(
      JSON.stringify(triggerManifestDocument({
        limits: {
          max_runs_per_day: 2,
          timeout_ms: 30000,
        },
      })),
    ),
  });

  assert.equal(widened.status, "failure");
  assert.equal(
    eventOf(widened.trace, "trigger_event_refused").payload.runtime_error_code,
    "TriggerLimitExceeded",
  );
  assert.equal(eventOf(widened.trace, "trigger_event_refused").payload.reason, "manifest_limit_exceeds_air");
});

test("requires normalized trigger event identity before execution", async () => {
  const result = await executeTriggerEvent(triggerDocument(), {
    trigger_ref: "trigger:test/DailyRun",
    source_kind: "schedule",
    payload: {
      raw: "raw-secret-payload",
    },
  }, {
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(triggerManifestDocument())),
  });

  assert.equal(result.status, "failure");
  assert.equal(
    eventOf(result.trace, "trigger_event_refused").payload.runtime_error_code,
    "TriggerPayloadInvalid",
  );
  assert.equal(JSON.stringify(result.trace).includes("raw-secret-payload"), false);
  assert.equal(result.trace.events.some((event) => event.kind === "scope_entered"), false);
});

function humanApprovalDocument() {
  return baseDocument({
    skills: [skill("NeedsApproval", "graph:skill:test/NeedsApproval")],
    graphs: [
      graph("graph:skill:test/NeedsApproval", "skill:test/NeedsApproval", [
        node("n1", "human_approval", {
          approval_ref: "approval:test:required",
          approval_mode: "required_approval",
          context_refs: ["value:change"],
          result_binding: "approval",
        }),
        node("n2", "give", { arguments: ["value:approval"] }),
      ], [
        edge("n1", "n2", "next"),
      ]),
    ],
  });
}

function humanApprovalThenToolDocument() {
  return baseDocument({
    tools: [tool("Search", {
      required_capabilities: ["network", "secret_read"],
      required_secrets: ["SEARCH_API_KEY"],
    })],
    skills: [skill("ApproveThenSearch", "graph:skill:test/ApproveThenSearch", ["tool:test/Search"])],
    graphs: [
      graph("graph:skill:test/ApproveThenSearch", "skill:test/ApproveThenSearch", [
        node("n1", "human_approval", {
          approval_ref: "approval:test:external-effect",
          approval_mode: "required_approval",
          context_refs: ["literal:string:external search"],
          result_binding: "approval",
        }),
        node("n2", "call_tool", { target_ref: "tool:test/Search", result_binding: "result" }),
        node("n3", "give", { arguments: ["value:result"] }),
      ], [
        edge("n1", "n2", "next"),
        edge("n2", "n3", "next"),
      ]),
    ],
  });
}

function userInteractionDocument({ showMessage = "Touba ready" } = {}) {
  return baseDocument({
    skills: [skill("Interact", "graph:skill:test/Interact")],
    graphs: [
      graph("graph:skill:test/Interact", "skill:test/Interact", [
        node("n1", "user_interaction", {
          interaction_ref: "interaction:test:show",
          interaction_mode: "show",
          arguments: [`literal:string:${showMessage}`],
        }),
        node("n2", "user_interaction", {
          interaction_ref: "interaction:test:ask",
          interaction_mode: "ask",
          arguments: ["literal:string:Search query?"],
          result_binding: "query",
        }),
        node("n3", "give", { arguments: ["value:query"] }),
      ], [
        edge("n1", "n2", "next"),
        edge("n2", "n3", "next"),
      ]),
    ],
  });
}

function userInteractionThenToolDocument() {
  return baseDocument({
    tools: [tool("Search", {
      required_capabilities: ["network"],
    })],
    skills: [skill("AskThenSearch", "graph:skill:test/AskThenSearch", ["tool:test/Search"])],
    graphs: [
      graph("graph:skill:test/AskThenSearch", "skill:test/AskThenSearch", [
        node("n1", "user_interaction", {
          interaction_ref: "interaction:test:show-before-tool",
          interaction_mode: "show",
          arguments: ["literal:string:External call requires user input"],
        }),
        node("n2", "user_interaction", {
          interaction_ref: "interaction:test:ask-before-tool",
          interaction_mode: "ask",
          arguments: ["literal:string:Search query?"],
          result_binding: "query",
        }),
        node("n3", "call_tool", { target_ref: "tool:test/Search", result_binding: "result" }),
        node("n4", "give", { arguments: ["value:result"] }),
      ], [
        edge("n1", "n2", "next"),
        edge("n2", "n3", "next"),
        edge("n3", "n4", "next"),
      ]),
    ],
  });
}

function twoToolDispatchDocument(overrides = {}) {
  return baseDocument({
    budgets: overrides.budgets,
    tools: [
      tool("First"),
      tool("Second"),
    ],
    skills: [skill("TwoTools", "graph:skill:test/TwoTools", [
      "tool:test/First",
      "tool:test/Second",
    ])],
    graphs: [
      graph("graph:skill:test/TwoTools", "skill:test/TwoTools", [
        node("n1", "call_tool", { target_ref: "tool:test/First", result_binding: "first" }),
        node("n2", "call_tool", { target_ref: "tool:test/Second", result_binding: "second" }),
        node("n3", "give", { arguments: ["value:second"] }),
      ], [
        edge("n1", "n2", "next"),
        edge("n2", "n3", "next"),
      ]),
    ],
  });
}

function bindThenGiveDocument(overrides = {}) {
  return baseDocument({
    budgets: overrides.budgets,
    skills: [skill("BindThenGive", "graph:skill:test/BindThenGive")],
    graphs: [
      graph("graph:skill:test/BindThenGive", "skill:test/BindThenGive", [
        node("n1", "bind", {
          arguments: ["literal:string:ready"],
          result_binding: "message",
        }),
        node("n2", "give", { arguments: ["value:message"] }),
      ], [
        edge("n1", "n2", "next"),
      ]),
    ],
  });
}

function twoAgentDispatchDocument(overrides = {}) {
  return baseDocument({
    budgets: overrides.budgets,
    skills: [skill("Build", "graph:skill:test/Build")],
    agents: [
      {
        id: "agent:test/Builder",
        name: "Builder",
        responsibility: "Builder",
        uses: ["skill:test/Build"],
        callable_by: [
          {
            caller_ref: "strategy:test/RunBuild",
            caller_kind: "strategy",
            source_ref: sourceRef(),
          },
        ],
        source_ref: sourceRef(),
      },
    ],
    strategies: [
      {
        id: "strategy:test/RunBuild",
        name: "RunBuild",
        uses: ["agent:test/Builder"],
        flow_graph_ref: "graph:strategy:test/RunBuild",
        source_ref: sourceRef(),
      },
    ],
    graphs: [
      graph("graph:skill:test/Build", "skill:test/Build", [
        node("b1", "give", { arguments: ["literal:string:built"] }),
      ]),
      graph("graph:strategy:test/RunBuild", "strategy:test/RunBuild", [
        node("s1", "call_agent", { target_ref: "agent:test/Builder" }),
        node("s2", "call_agent", { target_ref: "agent:test/Builder" }),
        node("s3", "give", { arguments: ["literal:string:complete"] }),
      ], [
        edge("s1", "s2", "next"),
        edge("s2", "s3", "next"),
      ]),
    ],
  });
}

function secretToolDocument({ throughAgent = false } = {}) {
  const searchTool = tool("Search", {
    required_capabilities: ["network", "secret_read"],
    required_secrets: ["SEARCH_API_KEY"],
  });
  const searchSkill = skill("SearchFlow", "graph:skill:test/SearchFlow", ["tool:test/Search"]);
  const searchGraph = graph(
    "graph:skill:test/SearchFlow",
    "skill:test/SearchFlow",
    [
      node("n1", "call_tool", { target_ref: "tool:test/Search", result_binding: "result" }),
      node("n2", "give", { arguments: ["value:result"] }),
    ],
    [
      edge("n1", "n2", "next"),
    ],
  );

  if (!throughAgent) {
    return baseDocument({
      tools: [searchTool],
      skills: [searchSkill],
      graphs: [searchGraph],
    });
  }

  return baseDocument({
    tools: [searchTool],
    skills: [searchSkill],
    agents: [
      {
        id: "agent:test/Researcher",
        name: "Researcher",
        responsibility: "Researcher",
        uses: ["skill:test/SearchFlow"],
        callable_by: [
          {
            caller_ref: "strategy:test/RunSearch",
            caller_kind: "strategy",
            source_ref: sourceRef(),
          },
        ],
        source_ref: sourceRef(),
      },
    ],
    strategies: [
      {
        id: "strategy:test/RunSearch",
        name: "RunSearch",
        uses: ["agent:test/Researcher"],
        flow_graph_ref: "graph:strategy:test/RunSearch",
        source_ref: sourceRef(),
      },
    ],
    graphs: [
      searchGraph,
      graph("graph:strategy:test/RunSearch", "strategy:test/RunSearch", [
        node("s1", "call_agent", { target_ref: "agent:test/Researcher" }),
      ]),
    ],
  });
}

function memoryToolDocument({ throughAgent = false, skillScope = true, agentScope = false } = {}) {
  const readTool = tool("ReadProjectKnowledge", {
    required_capabilities: ["memory_read"],
    memory_accesses: [memoryAccess("ProjectKnowledge", "read")],
  });
  const readSkill = {
    ...skill("ReadKnowledgeFlow", "graph:skill:test/ReadKnowledgeFlow", [
      "tool:test/ReadProjectKnowledge",
    ]),
    ...(skillScope ? { memory_scopes: [memoryScope("ProjectKnowledge", "read")] } : {}),
  };
  const readGraph = graph(
    "graph:skill:test/ReadKnowledgeFlow",
    "skill:test/ReadKnowledgeFlow",
    [
      node("n1", "call_tool", {
        target_ref: "tool:test/ReadProjectKnowledge",
        result_binding: "knowledge",
      }),
      node("n2", "give", { arguments: ["value:knowledge"] }),
    ],
    [
      edge("n1", "n2", "next"),
    ],
  );

  if (!throughAgent) {
    return baseDocument({
      memories: [memory("ProjectKnowledge")],
      tools: [readTool],
      skills: [readSkill],
      graphs: [readGraph],
    });
  }

  return baseDocument({
    memories: [memory("ProjectKnowledge")],
    tools: [readTool],
    skills: [readSkill],
    agents: [
      {
        id: "agent:test/Researcher",
        name: "Researcher",
        responsibility: "Researcher",
        uses: ["skill:test/ReadKnowledgeFlow"],
        ...(agentScope ? { memory_scopes: [memoryScope("ProjectKnowledge", "read")] } : {}),
        callable_by: [
          {
            caller_ref: "strategy:test/RunKnowledge",
            caller_kind: "strategy",
            source_ref: sourceRef(),
          },
        ],
        source_ref: sourceRef(),
      },
    ],
    strategies: [
      {
        id: "strategy:test/RunKnowledge",
        name: "RunKnowledge",
        uses: ["agent:test/Researcher"],
        flow_graph_ref: "graph:strategy:test/RunKnowledge",
        source_ref: sourceRef(),
      },
    ],
    graphs: [
      readGraph,
      graph("graph:strategy:test/RunKnowledge", "strategy:test/RunKnowledge", [
        node("s1", "call_agent", { target_ref: "agent:test/Researcher" }),
      ]),
    ],
  });
}

function processToolDocument() {
  const searchTool = tool("Search", {
    signature: {
      inputs: [parameter("query", "builtin:Text")],
      output_type: "type:test/Text",
    },
    required_capabilities: ["network", "secret_read"],
    required_secrets: ["SEARCH_API_KEY"],
  });

  return baseDocument({
    tools: [searchTool],
    skills: [skill("SearchFlow", "graph:skill:test/SearchFlow", ["tool:test/Search"])],
    graphs: [
      graph("graph:skill:test/SearchFlow", "skill:test/SearchFlow", [
        node("n1", "call_tool", {
          target_ref: "tool:test/Search",
          arguments: ["value:query"],
          result_binding: "result",
        }),
        node("n2", "give", { arguments: ["value:result"] }),
      ], [
        edge("n1", "n2", "next"),
      ]),
    ],
  });
}

function toolPayloadSchemaDocument() {
  return baseDocument({
    types: [
      {
        id: "type:test/SearchRequest",
        name: "SearchRequest",
        fields: [
          parameter("query", "builtin:Text"),
          parameter("rows", "builtin:Int"),
          parameter("tags", "list:builtin:Text"),
        ],
        source_ref: sourceRef(),
      },
      {
        id: "type:test/SearchResult",
        name: "SearchResult",
        fields: [
          parameter("title", "builtin:Text"),
          parameter("score", "builtin:Float"),
        ],
        source_ref: sourceRef(),
      },
    ],
    tools: [
      tool("Search", {
        signature: {
          inputs: [parameter("request", "type:test/SearchRequest")],
          output_type: "type:test/SearchResult",
        },
      }),
    ],
    skills: [skill("SearchFlow", "graph:skill:test/SearchFlow", ["tool:test/Search"])],
    graphs: [
      graph("graph:skill:test/SearchFlow", "skill:test/SearchFlow", [
        node("n1", "call_tool", {
          target_ref: "tool:test/Search",
          arguments: ["value:request"],
          result_binding: "result",
        }),
        node("n2", "give", { arguments: ["value:result"] }),
      ], [
        edge("n1", "n2", "next"),
      ]),
    ],
  });
}

function listPayloadConstraintDocument() {
  return baseDocument({
    types: [
      {
        id: "type:test/BatchRequest",
        name: "BatchRequest",
        fields: [
          parameter("recipients", "list:builtin:Text"),
        ],
        source_ref: sourceRef(),
      },
    ],
    tools: [
      tool("SendBatch", {
        signature: {
          inputs: [parameter("request", "type:test/BatchRequest")],
          output_type: "list:builtin:Text",
        },
      }),
    ],
    skills: [skill("BatchFlow", "graph:skill:test/BatchFlow", ["tool:test/SendBatch"])],
    graphs: [
      graph("graph:skill:test/BatchFlow", "skill:test/BatchFlow", [
        node("n1", "call_tool", {
          target_ref: "tool:test/SendBatch",
          arguments: ["value:request"],
          result_binding: "result",
        }),
        node("n2", "give", { arguments: ["value:result"] }),
      ], [
        edge("n1", "n2", "next"),
      ]),
    ],
  });
}

function bindingManifestDocument({
  bindings,
  grants = ["network", "secret_read"],
  secrets = ["SEARCH_API_KEY"],
  agentSecretScopes,
  runLimits,
  triggers,
} = {}) {
  return {
    manifest_version: "touba-manifest-v1",
    ...(agentSecretScopes ? { agent_secret_scopes: agentSecretScopes } : {}),
    ...(runLimits ? { run_limits: runLimits } : {}),
    ...(triggers ? { triggers } : {}),
    bindings: bindings ?? {
      "tool:test/Search": {
        handler: {
          kind: "process",
          command: "node",
          args: ["./handlers/search.handler.js"],
        },
        grants,
        secrets,
        timeout_ms: 5000,
        max_payload_bytes: 1048576,
      },
    },
  };
}

function toolBindingEntry({
  command = "node",
  args = ["./handlers/test.handler.js"],
  grants = ["network", "secret_read"],
  secrets = [],
  timeoutMs = 5000,
  maxPayloadBytes = 1048576,
} = {}) {
  return {
    handler: {
      kind: "process",
      command,
      args,
    },
    grants,
    secrets,
    timeout_ms: timeoutMs,
    max_payload_bytes: maxPayloadBytes,
  };
}

function triggerManifestDocument({
  enabled = true,
  sourceKind = "schedule",
  limits = {
    max_runs_per_day: 1,
    timeout_ms: 30000,
  },
  triggers,
} = {}) {
  return bindingManifestDocument({
    bindings: {},
    triggers: triggers ?? {
      "trigger:test/DailyRun": {
        enabled,
        source: {
          kind: sourceKind,
          timezone: "America/Montreal",
        },
        limits,
      },
    },
  });
}

function triggerEvent(fields = {}) {
  return {
    trigger_ref: "trigger:test/DailyRun",
    event_id: "evt-001",
    source_kind: "schedule",
    payload: {
      raw: "raw-secret-payload",
    },
    ...fields,
  };
}

function skillPackFixture(skillId, {
  description = "Procedure for a runtime test skill pack.",
  content = "Follow the declared procedure.",
  resources = [],
  executionLinks = [],
} = {}) {
  const resourceDigest = `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
  const normalizedResources = resources.map((resource) => {
    const resourceContent = resource.content ?? "";
    return {
      ref: resource.ref,
      path: resource.path,
      kind: resource.kind,
      loadable_as_context: resource.loadable_as_context ?? true,
      digest: resource.digest ?? `sha256:${crypto.createHash("sha256").update(resourceContent).digest("hex")}`,
      content: resource.content,
      ...(resource.executable_by_pack !== undefined ? { executable_by_pack: resource.executable_by_pack } : {}),
    };
  });
  return {
    ref: `skill_pack:project/${skillId}`,
    name: skillId
      .split("-")
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(" "),
    description,
    version: "0.1.0",
    tags: ["test"],
    source: "project",
    activation: {
      model_invocable: true,
      user_invocable: true,
    },
    resources: [
      {
        ref: `resource:${skillId}/procedure`,
        path: "SKILL.md",
        kind: "procedure",
        loadable_as_context: true,
        digest: resourceDigest,
        content,
      },
      ...normalizedResources,
    ],
    execution_links: executionLinks,
  };
}

function processBindingManifestDocument(
  script,
  {
    grants = ["network", "secret_read"],
    secrets = ["SEARCH_API_KEY"],
    timeoutMs = 5000,
    maxPayloadBytes = 1048576,
  } = {},
) {
  return bindingManifestDocument({
    bindings: {
      "tool:test/Search": {
        handler: {
          kind: "process",
          command: process.execPath,
          args: ["-e", script],
        },
        grants,
        secrets,
        timeout_ms: timeoutMs,
        max_payload_bytes: maxPayloadBytes,
      },
    },
  });
}

function memoryBindingManifestDocument({
  grants = ["memory_read"],
  memories = memoryManifestAccesses(),
} = {}) {
  return bindingManifestDocument({
    bindings: {
      "tool:test/ReadProjectKnowledge": {
        handler: {
          kind: "process",
          command: "node",
          args: ["./handlers/read_project_knowledge.handler.js"],
        },
        grants,
        memories,
        timeout_ms: 5000,
        max_payload_bytes: 1048576,
      },
    },
  });
}

function processMemoryBindingManifestDocument(
  script,
  {
    grants = ["memory_read"],
    memories = memoryManifestAccesses(),
    timeoutMs = 5000,
    maxPayloadBytes = 1048576,
  } = {},
) {
  return bindingManifestDocument({
    bindings: {
      "tool:test/ReadProjectKnowledge": {
        handler: {
          kind: "process",
          command: process.execPath,
          args: ["-e", script],
        },
        grants,
        memories,
        timeout_ms: timeoutMs,
        max_payload_bytes: maxPayloadBytes,
      },
    },
  });
}

function memoryManifestAccesses() {
  return [
    {
      ref: "memory:test/ProjectKnowledge",
      access: "read",
    },
  ];
}

function memoryResourceBindingsDocument({
  config = {
    endpoint_url: "http://127.0.0.1:39017/memory/project-knowledge",
  },
} = {}) {
  return {
    resource_bindings_schema_version: "touba-resource-bindings-v0.1",
    resources: {
      "memory:test/ProjectKnowledge": {
        kind: "memory_backend",
        provider: "host.http.project_knowledge",
        grants: ["memory.read"],
        secrets: [],
        config,
        limits: {
          max_payload_bytes: 1048576,
        },
      },
    },
  };
}

function secretsDocument() {
  return {
    secrets_version: "touba-secrets-v1",
    secrets: {
      SEARCH_API_KEY: {
        source: "env",
        name: "SEARCH_API_TOKEN",
      },
    },
  };
}

function agentProviderDocument({ searchResult = "search" } = {}) {
  return baseDocument({
    skills: [
      {
        ...skill("Search", "graph:skill:test/Search"),
        description: "Collect relevant external research data through the governed search capability.",
        signature: {
          inputs: [],
          output_type: "builtin:Text",
        },
      },
      {
        ...skill("Answer", "graph:skill:test/Answer"),
        description: "Produce the final answer from the selected research topic or intermediate observation.",
        signature: {
          inputs: [parameter("topic", "builtin:Text")],
          output_type: "builtin:Text",
        },
      },
      {
        ...skill("Hidden", "graph:skill:test/Hidden"),
        description: "Hidden control capability that is not declared in the active agent uses.",
        signature: {
          inputs: [],
          output_type: "builtin:Text",
        },
      },
    ],
    agents: [
      {
        id: "agent:test/Researcher",
        name: "Researcher",
        responsibility: "Researcher",
        uses: ["skill:test/Search", "skill:test/Answer"],
        callable_by: [
          {
            caller_ref: "strategy:test/RunResearch",
            caller_kind: "strategy",
            source_ref: sourceRef(),
          },
        ],
        source_ref: sourceRef(),
      },
    ],
    strategies: [
      {
        id: "strategy:test/RunResearch",
        name: "RunResearch",
        uses: ["agent:test/Researcher"],
        flow_graph_ref: "graph:strategy:test/RunResearch",
        source_ref: sourceRef(),
      },
    ],
    graphs: [
      graph("graph:skill:test/Search", "skill:test/Search", [
        node("search", "give", { arguments: [`literal:string:${searchResult}`] }),
      ]),
      graph("graph:skill:test/Answer", "skill:test/Answer", [
        node("answer", "give", { arguments: ["value:topic"] }),
      ]),
      graph("graph:skill:test/Hidden", "skill:test/Hidden", [
        node("hidden", "give", { arguments: ["literal:string:hidden"] }),
      ]),
      graph("graph:strategy:test/RunResearch", "strategy:test/RunResearch", [
        node("run", "call_agent", { target_ref: "agent:test/Researcher" }),
      ]),
    ],
  });
}

function agentReviewAfterToolDocument() {
  return baseDocument({
    tools: [
      tool("Fetch", {
        signature: {
          inputs: [],
          output_type: "builtin:Text",
        },
      }),
    ],
    skills: [
      {
        ...skill("FetchData", "graph:skill:test/FetchData", ["tool:test/Fetch"]),
        signature: {
          inputs: [],
          output_type: "builtin:Text",
        },
      },
    ],
    agents: [
      {
        id: "agent:test/Researcher",
        name: "Researcher",
        responsibility: "Researcher",
        uses: ["skill:test/FetchData"],
        callable_by: [
          {
            caller_ref: "strategy:test/RunResearch",
            caller_kind: "strategy",
            source_ref: sourceRef(),
          },
        ],
        source_ref: sourceRef(),
      },
    ],
    strategies: [
      {
        id: "strategy:test/RunResearch",
        name: "RunResearch",
        uses: ["agent:test/Researcher"],
        flow_graph_ref: "graph:strategy:test/RunResearch",
        source_ref: sourceRef(),
      },
    ],
    graphs: [
      graph("graph:skill:test/FetchData", "skill:test/FetchData", [
        node("fetch", "call_tool", {
          target_ref: "tool:test/Fetch",
          result_binding: "fetched",
        }),
        node("give", "give", { arguments: ["value:fetched"] }),
      ], [
        edge("fetch", "give", "next"),
      ]),
      graph("graph:strategy:test/RunResearch", "strategy:test/RunResearch", [
        node("run", "call_agent", { target_ref: "agent:test/Researcher" }),
      ]),
    ],
  });
}

function nestedAgentInvocationReviewAfterToolDocument() {
  return baseDocument({
    tools: [
      tool("Fetch", {
        signature: {
          inputs: [],
          output_type: "builtin:Text",
        },
      }),
    ],
    skills: [
      {
        ...skill("FetchData", "graph:skill:test/FetchData", ["tool:test/Fetch"]),
        signature: {
          inputs: [],
          output_type: "builtin:Text",
        },
      },
    ],
    agents: [
      {
        id: "agent:test/Coordinator",
        name: "Coordinator",
        description: "Coordinate nested work by delegating the risky step to an authorized specialist agent.",
        responsibility: "Coordinator",
        uses: ["agent:test/Specialist"],
        callable_by: [
          {
            caller_ref: "strategy:test/RunNestedResearch",
            caller_kind: "strategy",
            source_ref: sourceRef(),
          },
        ],
        source_ref: sourceRef(),
      },
      {
        id: "agent:test/Specialist",
        name: "Specialist",
        description: "Perform the specialist fetch workflow before any nested human review decision.",
        responsibility: "Specialist",
        uses: ["skill:test/FetchData"],
        callable_by: [
          {
            caller_ref: "agent:test/Coordinator",
            caller_kind: "agent",
            source_ref: sourceRef(),
          },
        ],
        source_ref: sourceRef(),
      },
    ],
    strategies: [
      {
        id: "strategy:test/RunNestedResearch",
        name: "RunNestedResearch",
        uses: ["agent:test/Coordinator"],
        flow_graph_ref: "graph:strategy:test/RunNestedResearch",
        source_ref: sourceRef(),
      },
    ],
    graphs: [
      graph("graph:skill:test/FetchData", "skill:test/FetchData", [
        node("fetch", "call_tool", {
          target_ref: "tool:test/Fetch",
          result_binding: "fetched",
        }),
        node("give", "give", { arguments: ["value:fetched"] }),
      ], [
        edge("fetch", "give", "next"),
      ]),
      graph("graph:strategy:test/RunNestedResearch", "strategy:test/RunNestedResearch", [
        node("run", "call_agent", { target_ref: "agent:test/Coordinator" }),
      ]),
    ],
  });
}

function toolThenHumanApprovalDocument() {
  return baseDocument({
    tools: [
      tool("Fetch", {
        signature: {
          inputs: [],
          output_type: "builtin:Text",
        },
      }),
    ],
    strategies: [
      {
        id: "strategy:test/RunReview",
        name: "RunReview",
        flow_graph_ref: "graph:strategy:test/RunReview",
        source_ref: sourceRef(),
      },
    ],
    graphs: [
      graph("graph:strategy:test/RunReview", "strategy:test/RunReview", [
        node("fetch", "call_tool", {
          target_ref: "tool:test/Fetch",
          result_binding: "fetched",
        }),
        node("review", "human_approval", {
          approval_ref: "approval:test/review-after-fetch",
          approval_mode: "required_approval",
          context_refs: ["value:fetched"],
          result_binding: "reviewDecision",
        }),
        node("give", "give", { arguments: ["value:reviewDecision"] }),
      ], [
        edge("fetch", "review", "next"),
        edge("review", "give", "next"),
      ]),
    ],
  });
}

function multiStepAgentDocument() {
  return baseDocument({
    skills: [
      {
        ...skill("Search", "graph:skill:test/Search"),
        signature: {
          inputs: [],
          output_type: "builtin:Text",
        },
      },
      {
        ...skill("Summarize", "graph:skill:test/Summarize"),
        signature: {
          inputs: [parameter("item", "builtin:Text")],
          output_type: "builtin:Text",
        },
      },
    ],
    agents: [
      {
        id: "agent:test/Researcher",
        name: "Researcher",
        responsibility: "Researcher",
        uses: ["skill:test/Search", "skill:test/Summarize"],
        callable_by: [
          {
            caller_ref: "strategy:test/RunResearch",
            caller_kind: "strategy",
            source_ref: sourceRef(),
          },
        ],
        source_ref: sourceRef(),
      },
    ],
    strategies: [
      {
        id: "strategy:test/RunResearch",
        name: "RunResearch",
        uses: ["agent:test/Researcher"],
        flow_graph_ref: "graph:strategy:test/RunResearch",
        source_ref: sourceRef(),
      },
    ],
    graphs: [
      graph("graph:skill:test/Search", "skill:test/Search", [
        node("search", "give", { arguments: ["literal:string:dataset"] }),
      ]),
      graph("graph:skill:test/Summarize", "skill:test/Summarize", [
        node("summarize", "give", { arguments: ["value:item"] }),
      ]),
      graph("graph:strategy:test/RunResearch", "strategy:test/RunResearch", [
        node("run", "call_agent", { target_ref: "agent:test/Researcher" }),
      ]),
    ],
  });
}

function delegatedAgentDocument({ authorized }) {
  return baseDocument({
    skills: [
      {
        ...skill("SpecialistAnswer", "graph:skill:test/SpecialistAnswer"),
        signature: {
          inputs: [],
          output_type: "builtin:Text",
        },
      },
    ],
    agents: [
      {
        id: "agent:test/Coordinator",
        name: "Coordinator",
        description: "Coordinate the task by delegating specialist work to the authorized sub-agent.",
        responsibility: "Coordinator",
        uses: ["agent:test/Specialist"],
        callable_by: [
          {
            caller_ref: "strategy:test/RunDelegation",
            caller_kind: "strategy",
            source_ref: sourceRef(),
          },
        ],
        source_ref: sourceRef(),
      },
      {
        id: "agent:test/Specialist",
        name: "Specialist",
        description: "Complete the delegated specialist task through its declared answer skill.",
        responsibility: "Specialist",
        uses: ["skill:test/SpecialistAnswer"],
        callable_by: [
          {
            caller_ref: authorized ? "agent:test/Coordinator" : "strategy:test/RunDelegation",
            caller_kind: authorized ? "agent" : "strategy",
            source_ref: sourceRef(),
          },
        ],
        source_ref: sourceRef(),
      },
    ],
    strategies: [
      {
        id: "strategy:test/RunDelegation",
        name: "RunDelegation",
        uses: ["agent:test/Coordinator"],
        flow_graph_ref: "graph:strategy:test/RunDelegation",
        source_ref: sourceRef(),
      },
    ],
    graphs: [
      graph("graph:skill:test/SpecialistAnswer", "skill:test/SpecialistAnswer", [
        node("answer", "give", { arguments: ["literal:string:specialist"] }),
      ]),
      graph("graph:strategy:test/RunDelegation", "strategy:test/RunDelegation", [
        node("run", "call_agent", { target_ref: "agent:test/Coordinator" }),
      ]),
    ],
  });
}

function strategyResourceDocument() {
  return baseDocument({
    agents: [
      {
        id: "agent:test/Planner",
        name: "Planner",
        description: "Select the governed subprocess strategy when planning requires a separate execution unit.",
        responsibility: "Planner",
        uses: ["strategy:test/Subprocess"],
        callable_by: [
          {
            caller_ref: "strategy:test/RunPlanning",
            caller_kind: "strategy",
            source_ref: sourceRef(),
          },
        ],
        source_ref: sourceRef(),
      },
    ],
    strategies: [
      {
        id: "strategy:test/RunPlanning",
        name: "RunPlanning",
        uses: ["agent:test/Planner"],
        flow_graph_ref: "graph:strategy:test/RunPlanning",
        source_ref: sourceRef(),
      },
      {
        id: "strategy:test/Subprocess",
        name: "Subprocess",
        description: "Execute the bounded subprocess that returns the strategic planning result.",
        uses: [],
        signature: {
          inputs: [],
          output_type: "builtin:Text",
        },
        flow_graph_ref: "graph:strategy:test/Subprocess",
        source_ref: sourceRef(),
      },
    ],
    graphs: [
      graph("graph:strategy:test/RunPlanning", "strategy:test/RunPlanning", [
        node("run", "call_agent", { target_ref: "agent:test/Planner" }),
      ]),
      graph("graph:strategy:test/Subprocess", "strategy:test/Subprocess", [
        node("sub", "give", { arguments: ["literal:string:strategic"] }),
      ]),
    ],
  });
}

function baseDocument(overrides = {}) {
  return {
    air_schema_version: AIR_SCHEMA_VERSION,
    air_capability_profile: AIR_CAPABILITY_PROFILE,
    air_json_profile: AIR_JSON_PROFILE,
    module: {
      id: "module:test",
      name: "test",
      source_ref: sourceRef(),
    },
    ...(overrides.budgets ? { budgets: overrides.budgets } : {}),
    definitions: {
      types: overrides.types ?? [],
      constants: overrides.constants ?? [],
      functions: overrides.functions ?? [],
      tools: overrides.tools ?? [],
      memories: overrides.memories ?? [],
      skills: overrides.skills ?? [],
      agents: overrides.agents ?? [],
      strategies: overrides.strategies ?? [],
      triggers: overrides.triggers ?? [],
    },
    execution_graphs: overrides.graphs ?? [],
    trace_points: overrides.tracePoints ?? [],
  };
}

function typedAgentCallDocument() {
  return baseDocument({
    types: [
      {
        id: "type:test/ReviewRequest",
        name: "ReviewRequest",
        fields: [parameter("summary", "builtin:Text")],
        source_ref: sourceRef(),
      },
      {
        id: "type:test/ReviewResult",
        name: "ReviewResult",
        fields: [parameter("verdict", "builtin:Text")],
        source_ref: sourceRef(),
      },
    ],
    agents: [
      {
        id: "agent:test/Reviewer",
        name: "Reviewer",
        responsibility: "Review the explicit request and return one typed final result.",
        signature: {
          inputs: [parameter("request", "type:test/ReviewRequest")],
          output_type: "type:test/ReviewResult",
        },
        uses: [],
        callable_by: [{
          caller_ref: "strategy:test/RunReview",
          caller_kind: "strategy",
          source_ref: sourceRef(),
        }],
        source_ref: sourceRef(),
      },
    ],
    strategies: [
      {
        id: "strategy:test/RunReview",
        name: "RunReview",
        signature: {
          inputs: [parameter("request", "type:test/ReviewRequest")],
          output_type: "type:test/ReviewResult",
        },
        uses: ["agent:test/Reviewer"],
        flow_graph_ref: "graph:strategy:test/RunReview",
        source_ref: sourceRef(),
      },
    ],
    graphs: [
      graph(
        "graph:strategy:test/RunReview",
        "strategy:test/RunReview",
        [
          node("call", "call_agent", {
            target_ref: "agent:test/Reviewer",
            arguments: ["value:request"],
            result_binding: "review",
          }),
          node("give", "give", { arguments: ["value:review"] }),
        ],
        [edge("call", "give", "next")],
      ),
    ],
  });
}

function triggerDocument({
  targetRef = "strategy:test/RunDaily",
  targetKind = "strategy",
  limits = {
    max_runs_per_day: 1,
    timeout_ms: 30000,
  },
} = {}) {
  return baseDocument({
    triggers: [
      {
        id: "trigger:test/DailyRun",
        name: "DailyRun",
        event: {
          kind: "schedule",
          value: "0 8 * * *",
          source_ref: sourceRef(),
        },
        target_ref: targetRef,
        target_kind: targetKind,
        arguments: [],
        limits: {
          ...limits,
          source_ref: sourceRef(),
        },
        source_ref: sourceRef(),
      },
    ],
    strategies: [
      {
        id: "strategy:test/RunDaily",
        name: "RunDaily",
        signature: {
          inputs: [],
          output_type: "builtin:Text",
        },
        flow_graph_ref: "graph:strategy:test/RunDaily",
        source_ref: sourceRef(),
      },
    ],
    graphs: [
      graph("graph:strategy:test/RunDaily", "strategy:test/RunDaily", [
        node("n1", "give", { arguments: ["literal:string:triggered"] }),
      ]),
    ],
  });
}

function sourceRef() {
  return {
    source_id: "test.tb",
    start_byte: 0,
    end_byte: 0,
    start_line: 1,
    start_column: 0,
    end_line: 1,
    end_column: 0,
  };
}

function tool(name, fields = {}) {
  return {
    id: `tool:test/${name}`,
    name,
    description: `${name} test tool capability.`,
    signature: {
      inputs: [],
      output_type: "type:test/Text",
    },
    source_ref: sourceRef(),
    ...fields,
  };
}

function memory(name) {
  return {
    id: `memory:test/${name}`,
    name,
    source_ref: sourceRef(),
  };
}

function memoryAccess(name, access) {
  return {
    memory_ref: `memory:test/${name}`,
    access,
    source_ref: sourceRef(),
  };
}

function memoryScope(name, access) {
  return {
    memory_ref: `memory:test/${name}`,
    access,
    source_ref: sourceRef(),
  };
}

function fnDef(name, flowGraphRef, inputs = [], outputType = "type:test/Text") {
  return {
    id: `function:test/${name}`,
    name,
    description: `${name} test function capability.`,
    signature: {
      inputs,
      output_type: outputType,
    },
    body_graph_ref: flowGraphRef,
    source_ref: sourceRef(),
  };
}

function parameter(name, typeRef) {
  return {
    name,
    type_ref: typeRef,
    source_ref: sourceRef(),
  };
}

function skill(name, flowGraphRef, uses = []) {
  return {
    id: `skill:test/${name}`,
    name,
    description: `${name} test skill capability.`,
    signature: {
      inputs: [],
      output_type: "type:test/Text",
    },
    uses,
    flow_graph_ref: flowGraphRef,
    source_ref: sourceRef(),
  };
}

function graph(id, ownerRef, nodes, edges = [], failurePaths = [], expressions = []) {
  return {
    id,
    owner_ref: ownerRef,
    entry_node_id: nodes[0].id,
    nodes,
    edges,
    expressions,
    failure_paths: failurePaths,
    failure_path_refs: failurePaths.map((failurePath) => failurePath.id),
    source_ref: sourceRef(),
  };
}

function expression(id, kind, fields = {}) {
  return {
    id,
    kind,
    operands: [],
    source_ref: sourceRef(),
    ...fields,
  };
}

function node(id, kind, fields = {}) {
  return {
    id,
    kind,
    arguments: [],
    trace_point_refs: [],
    source_ref: sourceRef(),
    ...fields,
  };
}

function edge(fromNodeId, toNodeId, role) {
  return {
    from_node_id: fromNodeId,
    to_node_id: toNodeId,
    role,
  };
}

function assertTraceShape(trace, entryRef) {
  assert.equal(trace.trace_protocol_version, TRACE_PROTOCOL_VERSION);
  assert.equal(trace.run.entry_ref, entryRef);
  assert.equal(trace.events[0].kind, "run_started");
  assert.equal(trace.events.at(-1).kind, "run_completed");
  trace.events.forEach((event, index) => {
    assert.equal(event.sequence_index, index);
    assert.equal(event.run_id, trace.run.run_id);
  });
}

function assertKinds(trace, kinds) {
  assert.deepEqual(trace.events.map((event) => event.kind), kinds);
}

function eventOf(trace, kind) {
  return eventsOf(trace, kind)[0];
}

function eventsOf(trace, kind) {
  return trace.events.filter((event) => event.kind === kind);
}
