import {
  ToubaHandlerError,
  defineTool,
} from "@touba/sdk";

const TOOL_REF = "tool:examples.js_sdk_engine_project/BuildGreeting";

await defineTool({
  toolRef: TOOL_REF,
  requiredGrants: ["network", "secret_read"],
  requiredSecretHandles: ["DEMO_API_KEY"],
  inputSignature: [{ name: "request", type_ref: "type:examples.js_sdk_engine_project/GreetingRequest" }],
  outputType: "type:examples.js_sdk_engine_project/GreetingResult",
  run: async ({ request, context }) => {
    if (!context.grants.includes("network") || !context.grants.includes("secret_read")) {
      throw new ToubaHandlerError("MissingGrant", "network and secret_read grants are required");
    }
    if (!context.secretHandles.includes("DEMO_API_KEY")) {
      throw new ToubaHandlerError("MissingSecretHandle", "DEMO_API_KEY handle is required");
    }
    if (context.env.DEMO_API_KEY !== "engine-fixture-secret") {
      throw new ToubaHandlerError("MissingSecretValue", "DEMO_API_KEY value was not injected");
    }
    if (typeof request?.name !== "string") {
      throw new ToubaHandlerError("InvalidArguments", "request.name must be a string");
    }

    return {
      message: `Hello ${request.name} from ToubaEngine`,
      secret_seen: true,
    };
  },
});
