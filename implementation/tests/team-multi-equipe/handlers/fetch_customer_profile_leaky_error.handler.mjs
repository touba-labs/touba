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
  run: async ({ context }) => {
    throw new ToubaHandlerError(
      "CrmBackendRejected",
      `CRM backend rejected token ${context.env[SECRET_HANDLE]}`,
    );
  },
});
