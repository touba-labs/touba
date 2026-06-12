import {
  ToubaHandlerError,
  defineTool,
} from "@touba/sdk";

const TOOL_REF = "tool:examples.memory_backend_host/ReadMemoryNote";
const MEMORY_REF = "memory:examples.memory_backend_host/CustomerMemory";
const SECRET_HANDLE = "MEMORY_BACKEND_TOKEN";

await defineTool({
  toolRef: TOOL_REF,
  requiredGrants: ["network", "secret_read", "memory_read"],
  requiredSecretHandles: [SECRET_HANDLE],
  inputSignature: [{ name: "request", type_ref: "type:examples.memory_backend_host/MemoryRequest" }],
  outputType: "type:examples.memory_backend_host/MemoryResult",
  run: async ({ request, context }) => {
    const binding = memoryBinding(context);
    const endpointUrl = endpointFromBinding(binding);
    const response = await fetch(`${endpointUrl}/notes/${encodeURIComponent(request.customer_id)}`, {
      method: "GET",
      headers: {
        "authorization": `Bearer ${context.env[SECRET_HANDLE]}`,
      },
    });

    if (!response.ok) {
      throw new ToubaHandlerError("MemoryBackendReadFailed", `backend read failed with HTTP ${response.status}`);
    }

    const body = await response.json();
    return normalizeResult(body);
  },
});

function memoryBinding(context) {
  const binding = context.resourceBindings.find((candidate) => candidate.resource_ref === MEMORY_REF);
  if (!binding || binding.kind !== "memory_backend" || binding.provider !== "host.http.memory_backend") {
    throw new ToubaHandlerError("MissingMemoryResourceBinding", "CustomerMemory resource binding is required");
  }
  return binding;
}

function endpointFromBinding(binding) {
  const endpointUrl = binding.config?.endpoint_url;
  if (typeof endpointUrl !== "string" || !endpointUrl.startsWith("http://127.0.0.1:")) {
    throw new ToubaHandlerError("InvalidMemoryEndpoint", "memory endpoint_url must be an explicit loopback HTTP URL");
  }
  return endpointUrl;
}

function normalizeResult(body) {
  if (typeof body?.customer_id !== "string" || typeof body?.stored_note !== "string") {
    throw new ToubaHandlerError("InvalidMemoryBackendResponse", "backend response does not match MemoryResult");
  }
  return {
    customer_id: body.customer_id,
    stored_note: body.stored_note,
    backend: "host_http_memory",
  };
}
