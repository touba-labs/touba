import { createHash } from "node:crypto";

const TOOL_REF = "tool:examples.memory_postgres_rb2/ReadCustomerMemory";
const MEMORY_REF = "memory:examples.memory_postgres_rb2/CustomerMemory";
const SECRET_HANDLE = "POSTGRES_MEMORY_TOKEN";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", async () => {
  try {
    const envelope = JSON.parse(input);
    assertEnvelope(envelope);
    const request = envelope.arguments?.request;
    if (!request || typeof request.customer_id !== "string") {
      throw new Error("request.customer_id is required");
    }
    const binding = memoryBinding(envelope.resource_bindings ?? []);
    const endpointUrl = endpointFromBinding(binding);
    const response = await fetch(`${endpointUrl}/notes/${encodeURIComponent(request.customer_id)}`, {
      method: "GET",
      headers: {
        "authorization": `Bearer ${process.env[SECRET_HANDLE]}`,
      },
    });
    if (!response.ok) {
      throw new Error(`backend read failed with HTTP ${response.status}`);
    }
    const body = await response.json();
    if (typeof body?.customer_id !== "string" || typeof body?.stored_note !== "string") {
      throw new Error("backend response does not match MemoryResult");
    }
    const value = {
      customer_id: body.customer_id,
      stored_note: body.stored_note,
      backend: "postgres",
    };
    process.stdout.write(JSON.stringify({
      ok: true,
      value,
      memory_metadata: [
        {
          memory_ref: MEMORY_REF,
          operation: "read",
          source_kind: "backend_import",
          source_ref: `postgres:customer_memory/${body.customer_id}`,
          writer_ref: "handler:examples.memory_postgres_rb2/ReadCustomerMemory",
          written_at: new Date().toISOString(),
          digest_kind: "sha256",
          digest: `sha256:${createHash("sha256").update(body.stored_note).digest("hex")}`,
          schema_ref: "schema:examples.memory_postgres_rb2/MemoryResult",
          version_ref: "postgres-memory-api:v0.1",
          integrity_evidence: "digest_reported",
        },
      ],
    }));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: {
        code: "PostgresMemoryPiReadFailed",
        message: error instanceof Error ? error.message : String(error),
      },
    }));
  }
});

function assertEnvelope(envelope) {
  if (envelope?.protocol !== "touba-tool-handler-v1") {
    throw new Error(`unexpected protocol ${envelope?.protocol}`);
  }
  if (envelope.tool_ref !== TOOL_REF) {
    throw new Error(`unexpected tool_ref ${envelope.tool_ref}`);
  }
  if (!Array.isArray(envelope.grants) || !envelope.grants.includes("memory_read")) {
    throw new Error("memory_read grant is required");
  }
  if (!Array.isArray(envelope.secret_handles) || !envelope.secret_handles.includes(SECRET_HANDLE)) {
    throw new Error("POSTGRES_MEMORY_TOKEN handle is required");
  }
  if (typeof process.env[SECRET_HANDLE] !== "string" || process.env[SECRET_HANDLE].length === 0) {
    throw new Error("POSTGRES_MEMORY_TOKEN value is required in handler environment");
  }
}

function memoryBinding(bindings) {
  const binding = bindings.find((candidate) => candidate.resource_ref === MEMORY_REF);
  if (!binding || binding.kind !== "memory_backend" || binding.provider !== "host.postgres.memory_api") {
    throw new Error("CustomerMemory PostgreSQL resource binding is required");
  }
  return binding;
}

function endpointFromBinding(binding) {
  const endpointUrl = binding.config?.endpoint_url;
  if (typeof endpointUrl !== "string" || !endpointUrl.startsWith("http://127.0.0.1:")) {
    throw new Error("endpoint_url must be an explicit loopback HTTP URL");
  }
  return endpointUrl;
}
