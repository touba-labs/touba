import {
  ToubaHandlerError,
  defineTool,
} from "@touba/sdk";

const TOOL_REF = "tool:org.example.customer/FetchCustomerProfile";
const SECRET_HANDLE = "CRM_API_TOKEN";

await defineTool({
  toolRef: TOOL_REF,
  requiredGrants: ["network", "secret_read", "memory_read"],
  requiredSecretHandles: [SECRET_HANDLE],
  inputSignature: [{ name: "request", type_ref: "type:org.example.customer/CustomerRequest" }],
  outputType: "type:org.example.customer/CustomerProfile",
  run: async ({ request, context }) => {
    for (const grant of ["network", "secret_read", "memory_read"]) {
      if (!context.grants.includes(grant)) {
        throw new ToubaHandlerError("MissingGrant", `${grant} grant is required`);
      }
    }
    if (!context.secretHandles.includes(SECRET_HANDLE)) {
      throw new ToubaHandlerError("MissingSecretHandle", `${SECRET_HANDLE} handle is required`);
    }
    const memoryBinding = context.resourceBindings.find(
      (binding) => binding.resource_ref === "memory:org.example.customer/CustomerNotes",
    );
    if (!memoryBinding || memoryBinding.provider !== "host.local.customer_notes") {
      throw new ToubaHandlerError("MissingMemoryResourceBinding", "CustomerNotes resource binding is required");
    }
    if (context.env[SECRET_HANDLE] !== "team-scenario-secret") {
      throw new ToubaHandlerError("MissingSecretValue", `${SECRET_HANDLE} value was not injected`);
    }
    if (typeof request?.customer_id !== "string" || request.customer_id.trim() === "") {
      throw new ToubaHandlerError("InvalidArguments", "request.customer_id must be a non-empty string");
    }

    return {
      customer_id: request.customer_id,
      segment: "enterprise",
      status: "review_ready",
    };
  },
});
