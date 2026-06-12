import {
  ToubaHandlerError,
  defineTool,
} from "@touba/sdk";

const TOOL_REF = "tool:examples.memory_postgres_rb2/WriteCustomerMemory";
const MEMORY_REF = "memory:examples.memory_postgres_rb2/CustomerMemory";
const SECRET_HANDLE = "POSTGRES_MEMORY_TOKEN";

await defineTool({
  toolRef: TOOL_REF,
  requiredGrants: ["network", "secret_read", "memory_write"],
  requiredSecretHandles: [SECRET_HANDLE],
  inputSignature: [{ name: "request", type_ref: "type:examples.memory_postgres_rb2/MemoryRequest" }],
  outputType: "type:examples.memory_postgres_rb2/MemoryResult",
  run: async ({ request, context }) => {
    const endpointUrl = endpointFromBinding(memoryBinding(context));
    const response = await fetch(`${endpointUrl}/notes/${encodeURIComponent(request.customer_id)}`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${context.env[SECRET_HANDLE]}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ note: request.note }),
    });

    if (!response.ok) {
      throw new ToubaHandlerError("PostgresMemoryWriteFailed", `backend write failed with HTTP ${response.status}`);
    }

    return normalizeResult(await response.json());
  },
});

function memoryBinding(context) {
  const binding = context.resourceBindings.find((candidate) => candidate.resource_ref === MEMORY_REF);
  if (!binding || binding.kind !== "memory_backend" || binding.provider !== "host.postgres.memory_api") {
    throw new ToubaHandlerError("MissingPostgresMemoryBinding", "CustomerMemory PostgreSQL resource binding is required");
  }
  return binding;
}

function endpointFromBinding(binding) {
  const endpointUrl = binding.config?.endpoint_url;
  if (typeof endpointUrl !== "string" || !endpointUrl.startsWith("http://127.0.0.1:")) {
    throw new ToubaHandlerError("InvalidPostgresMemoryEndpoint", "endpoint_url must be an explicit loopback HTTP URL");
  }
  return endpointUrl;
}

function normalizeResult(body) {
  if (typeof body?.customer_id !== "string" || typeof body?.stored_note !== "string") {
    throw new ToubaHandlerError("InvalidPostgresMemoryResponse", "backend response does not match MemoryResult");
  }
  return {
    customer_id: body.customer_id,
    stored_note: body.stored_note,
    backend: "postgres",
  };
}
