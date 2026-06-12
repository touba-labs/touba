import {
  ToubaHandlerError,
  defineTool,
} from "../../src/index.mjs";

const TOOL_REF = "tool:examples.sdk/EchoProfile";

await defineTool({
  toolRef: TOOL_REF,
  requiredGrants: ["network", "secret_read"],
  requiredSecretHandles: ["DEMO_API_KEY"],
  inputSignature: [{ name: "request", type_ref: "type:examples.sdk/ProfileRequest" }],
  outputType: "type:examples.sdk/Profile",
  run: async ({ request, context }) => {
    if (typeof context.rawInput !== "string" || context.rawInput.length === 0) {
      throw new ToubaHandlerError("InvalidTestContext", "rawInput must be provided");
    }
    if (context.request.call_id !== "call:test-sdk:1") {
      throw new ToubaHandlerError("InvalidTestContext", "call_id was not relayed");
    }
    if (!context.grants.includes("network") || !context.grants.includes("secret_read")) {
      throw new ToubaHandlerError("InvalidTestContext", "expected network and secret_read grants");
    }
    if (!context.secretHandles.includes("DEMO_API_KEY")) {
      throw new ToubaHandlerError("InvalidTestContext", "expected DEMO_API_KEY handle");
    }
    if (context.env.DEMO_API_KEY !== "sdk-secret-value") {
      throw new ToubaHandlerError("InvalidTestContext", "expected DEMO_API_KEY env value");
    }
    if (context.limits.timeout_ms !== 5000) {
      throw new ToubaHandlerError("InvalidTestContext", "timeout limit was not relayed");
    }
    if (context.memoryAccesses.length !== 1 || context.memoryAccesses[0].access !== "read") {
      throw new ToubaHandlerError("InvalidTestContext", "memory accesses were not relayed");
    }
    if (typeof request?.name !== "string") {
      throw new ToubaHandlerError("InvalidArguments", "request.name must be a string");
    }

    return {
      message: `Hello ${request.name}`,
      secret_seen: true,
      memory_ref: context.memoryAccesses[0].memory_ref,
    };
  },
});
