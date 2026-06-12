import {
  ToubaHandlerError,
  defineTool,
} from "../../../runtime/touba-handler-sdk/src/index.mjs";

await defineTool({
  toolRef: "tool:examples.v1_process_binding/FetchSource",
  requiredGrants: ["network", "secret_read"],
  requiredSecretHandles: ["SEARCH_API_KEY"],
  inputSignature: [{ name: "request", type_ref: "type:examples.v1_process_binding/SearchRequest" }],
  outputType: "type:examples.v1_process_binding/SourceText",
  run: async ({ request: sourceRequest, context }) => {
    if (typeof process.env.SEARCH_API_KEY !== "string" || process.env.SEARCH_API_KEY === "") {
      throw new ToubaHandlerError("MissingSecretValue", "SEARCH_API_KEY value missing from handler environment");
    }

    const secretInStdin = context.rawInput.includes(process.env.SEARCH_API_KEY);

    if (Object.hasOwn(process.env, "TOUBA_SHOULD_NOT_LEAK")) {
      return {
        body: "rejected-env-leak",
        inherited_env_visible: true,
        secret_value_in_stdin: secretInStdin,
      };
    }

    if (!sourceRequest || typeof sourceRequest.query !== "string") {
      throw new ToubaHandlerError("InvalidArguments", "request.query must be a string");
    }

    return {
      body: `fixture:${sourceRequest.query}`,
      inherited_env_visible: false,
      secret_value_in_stdin: secretInStdin,
    };
  },
});
