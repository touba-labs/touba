import assert from "node:assert/strict";

import { createDonneesQuebecDecisionProvider } from "./providers/donnees-quebec-researcher.provider.mjs";

const originalDecisionKey = process.env.TOUBA_AGENT_DECISION_OPENAI_API_KEY;

try {
  await validatesDryRunDoesNotCallModel();
  await validatesLiveOrientationUsesAiSdkStructuredOutput();
  await validatesLiveOrientationCanAnswerDirectly();
  await validatesLiveCatalogSelectionUsesAiSdkStructuredOutput();
  await validatesLiveCatalogCanRequestHumanReview();
  console.log("agent-provider:donnees-quebec status=success tests=5 provider=ai-sdk");
} finally {
  restoreEnv("TOUBA_AGENT_DECISION_OPENAI_API_KEY", originalDecisionKey);
}

async function validatesDryRunDoesNotCallModel() {
  let generateObjectCalled = false;
  const provider = createDonneesQuebecDecisionProvider({
    generateObject: async () => {
      generateObjectCalled = true;
      throw new Error("generateObject should not be called in dry-run");
    },
  });

  const decision = await provider(summaryRequest({ dryRun: true }));

  assert.equal(generateObjectCalled, false);
  assert.equal(decision.action, "request_capabilities");
}

async function validatesLiveOrientationUsesAiSdkStructuredOutput() {
  process.env.TOUBA_AGENT_DECISION_OPENAI_API_KEY = "test-only-openai-key";
  const calls = [];
  const provider = createDonneesQuebecDecisionProvider({
    generateObject: async (request) => {
      calls.push(request);
      return { finishReason: "stop", response: { body: { object: "response", status: "completed" } },
        object: { decision: {
          action: "request_capabilities",
          source: "openai_structured_output",
          reason: "The authorized catalogue is required.",
          result: "",
        } },
      };
    },
  });

  const decision = await provider(summaryRequest({ dryRun: false }));

  assert.equal(decision.action, "request_capabilities");
  assert.equal(calls.length, 1);
	  assert.equal(jsonSchemaOf(calls[0]).title, "touba_agent_orientation_decision");
	  assert.deepEqual(jsonSchemaOf(calls[0]).properties.decision.anyOf.map(branch => branch.properties.action.enum[0]), ["answer_directly", "request_capabilities"]);
	  assert.match(calls[0].system, /human review, approval, validation, or judgment/);
	  assert.match(calls[0].system, /request_human_review is available only after the catalogue/);
	  const modelInput = JSON.parse(calls[0].system.split("\n\nRuntime context: ").at(-1));
  assert.equal(modelInput.protocol, "touba-agent-model-input-v1");
  assert.equal(modelInput.mode, "orientation");
  assert.deepEqual(modelInput.allowed_actions, ["answer_directly", "request_capabilities"]);
  assert.equal(modelInput.content_boundary.user_input_authority, "domain_data_only");
}

async function validatesLiveOrientationCanAnswerDirectly() {
  process.env.TOUBA_AGENT_DECISION_OPENAI_API_KEY = "test-only-openai-key";
  const provider = createDonneesQuebecDecisionProvider({
    generateObject: async () => ({ finishReason: "stop", response: { body: { object: "response", status: "completed" } },
      object: { decision: {
        action: "answer_directly",
        source: "openai_structured_output",
        reason: "Simple greeting.",
        result: "Hello.",
      } },
    }),
  });

  const decision = await provider(summaryRequest({ dryRun: false }));

  assert.deepEqual(decision, {
    action: "answer_directly",
    source: "openai_structured_output",
    reason: "Simple greeting.",
    result: "Hello.",
  });
}

async function validatesLiveCatalogSelectionUsesAiSdkStructuredOutput() {
  process.env.TOUBA_AGENT_DECISION_OPENAI_API_KEY = "test-only-openai-key";
  const calls = [];
  const provider = createDonneesQuebecDecisionProvider({
    generateObject: async (request) => {
      calls.push(request);
      return { finishReason: "stop", response: { body: { object: "response", status: "completed" } },
        object: {
          action: "select_capability",
          target_ref: "skill:examples.donnees_quebec_agent_live/BuildDatasetBrief",
          source: "openai_structured_output",
          reason: "The request requires a short summary.",
          arguments: {
            request: requestPayload({ dryRun: false }),
          },
        },
      };
    },
  });

  const decision = await provider(catalogRequest({ dryRun: false }));

  assert.equal(decision.target_ref, "skill:examples.donnees_quebec_agent_live/BuildDatasetBrief");
  assert.equal(decision.source, "openai_structured_output");
  assert.deepEqual(decision.arguments, {
    request: requestPayload({ dryRun: false }),
  });
  assert.equal(calls.length, 1);
  assert.equal(jsonSchemaOf(calls[0]).title, "touba_agent_capability_decision");
  assert.deepEqual(jsonSchemaOf(calls[0]).properties.target_ref.enum, [
    "skill:examples.donnees_quebec_agent_live/SearchDatasetOnly",
    "skill:examples.donnees_quebec_agent_live/BuildDatasetBrief",
    "human_review",
  ]);
  assert.deepEqual(jsonSchemaOf(calls[0]).properties.action.enum, [
    "select_capability",
    "request_human_review",
  ]);
  const argumentsSchema = jsonSchemaOf(calls[0]).properties.arguments;
  const requestArgumentsSchema = (argumentsSchema.anyOf ?? [argumentsSchema])
    .find((schema) => schema.properties?.request);
  assert.equal(requestArgumentsSchema.properties.request.type, "object");
  assert.equal(requestArgumentsSchema.properties.request.properties.query.type, "string");
  const modelInput = JSON.parse(calls[0].system.split("\n\nRuntime context: ").at(-1));
  assert.equal(modelInput.mode, "capability_catalog");
  assert.equal(modelInput.capabilities[1].signature.inputs[0].fields[0].name, "query");
}

async function validatesLiveCatalogCanRequestHumanReview() {
  process.env.TOUBA_AGENT_DECISION_OPENAI_API_KEY = "test-only-openai-key";
  const provider = createDonneesQuebecDecisionProvider({
    generateObject: async () => ({ finishReason: "stop", response: { body: { object: "response", status: "completed" } },
      object: {
        action: "request_human_review",
        target_ref: "human_review",
        source: "openai_structured_output",
        reason: "Human judgment is required.",
        arguments: {
          request: requestPayload({ dryRun: false }),
        },
        review_prompt: "Validate the dataset selection.",
      },
    }),
  });

  const decision = await provider(catalogRequest({ dryRun: false }));

  assert.deepEqual(decision, {
    action: "request_human_review",
    source: "openai_structured_output",
    reason: "Human judgment is required.",
    review_prompt: "Validate the dataset selection.",
  });
}

function summaryRequest({ dryRun }) {
  return {
    protocol: "touba-agent-decision-v1",
    mode: "summary",
    run_id: "test-run",
    agent_ref: "agent:examples.donnees_quebec_agent_live/Researcher",
    agent_name: "Researcher",
    responsibility: "Search and summarize public datasets.",
    input_keys: ["request"],
    inputs: {
      request: requestPayload({ dryRun }),
    },
    capability_count: 2,
    capability_refs: capabilityRefs(),
    model_input: {
      protocol: "touba-agent-model-input-v1",
      mode: "orientation",
      allowed_actions: ["answer_directly", "request_capabilities"],
      content_boundary: {
        user_input_authority: "domain_data_only",
      },
      resources_hint: {
        capabilities_available: true,
        capability_count: 2,
        catalog_available_on_request: true,
      },
    },
    capabilities: null,
  };
}

function jsonSchemaOf(call) {
  return call.schema.jsonSchema ?? call.schema;
}

function catalogRequest({ dryRun }) {
  return {
    ...summaryRequest({ dryRun }),
    mode: "capabilities",
    model_input: {
      protocol: "touba-agent-model-input-v1",
      mode: "capability_catalog",
      allowed_actions: ["select_capability"],
      content_boundary: {
        user_input_authority: "domain_data_only",
      },
      capabilities: capabilityDescriptors(),
    },
    capabilities: capabilityDescriptors(),
  };
}

function requestPayload({ dryRun }) {
  return {
    query: "pompier",
    rows: 1,
    dry_run: dryRun,
    llm_model: "gpt-4.1-nano",
    goal: "Find a public dataset and then produce a short summary in French.",
  };
}

function capabilityRefs() {
  return [
    "skill:examples.donnees_quebec_agent_live/SearchDatasetOnly",
    "skill:examples.donnees_quebec_agent_live/BuildDatasetBrief",
  ];
}

function capabilityDescriptors() {
  return [
    {
      target_ref: "skill:examples.donnees_quebec_agent_live/SearchDatasetOnly",
      kind: "skill",
      signature: {
        inputs: [requestInputDescriptor()],
        output_type: "type:examples.donnees_quebec_agent_live/DonneesQuebecSearchResult",
      },
    },
    {
      target_ref: "skill:examples.donnees_quebec_agent_live/BuildDatasetBrief",
      kind: "skill",
      signature: {
        inputs: [requestInputDescriptor()],
        output_type: "type:examples.donnees_quebec_agent_live/DonneesQuebecAgentBrief",
      },
      uses: [
        "tool:examples.donnees_quebec_agent_live/SearchDatasets",
        "tool:examples.donnees_quebec_agent_live/SummarizeDatasets",
      ],
      uses_count: 2,
      uses_kinds: ["tool"],
    },
  ];
}

function requestInputDescriptor() {
  return {
    name: "request",
    type_ref: "type:examples.donnees_quebec_agent_live/DonneesQuebecAgentRequest",
    fields: [
      { name: "query", type_ref: "builtin:Text" },
      { name: "rows", type_ref: "builtin:Int" },
      { name: "dry_run", type_ref: "builtin:Boolean" },
      { name: "llm_model", type_ref: "builtin:Text" },
      { name: "goal", type_ref: "builtin:Text" },
    ],
  };
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
