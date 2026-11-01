import { createHash } from "node:crypto";
import { createDecisionWireSchema } from "./decision-wire-schema.mjs";
import {
  ToubaAgentDecisionProviderError,
  argumentsSchemaForCapability,
  agentResultSchema,
  structuredDecisionInput,
  decisionSchemaForRequest,
  modelInputForDecision,
  normalizeAiSdkDecisionObject,
  normalizeStructuredDecisionObject,
  assertCompleteProviderResponse,
} from "./decision-contract.mjs";

export const NATIVE_HUMAN_REVIEW_NAME = "touba_request_human_review";
export const NATIVE_COMPLETION_NAME = "touba_finish";

function fail(code, message) {
  throw new ToubaAgentDecisionProviderError(code, message);
}

export function nativeCapabilityName(ref) {
  if (typeof ref !== "string" || ref.length === 0) fail("InvalidAgentDecisionRequest", "native capability requires a target reference");
  const label = ref.split("/").at(-1).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 36);
  return `cap_${label}_${createHash("sha256").update(ref).digest("hex").slice(0, 12)}`;
}

// Observations describe effects the runtime already performed. These messages
// neither invoke their targets again nor fabricate provider reasoning/history.
export function nativeObservationMessages(request) {
  const mode = request.content_mode ?? request.model_input.content_boundary?.provider_content_mode ?? "inline";
  if (!["inline", "opaque_refs"].includes(mode)) fail("InvalidAgentDecisionRequest", "unsupported native provider content mode");
  const observations = request.observations ?? request.model_input.agent_state?.observations ?? [];
  // A stateless host has observations, not original provider messages. Project
  // the observations as data instead of inventing call IDs or signatures.
  return observations.map(observation => ({ role: "user", content: JSON.stringify({
    category: observation.action === "request_human_review" ? "runtime_human_review_observation" : "runtime_observation",
    authority: "observed_data_not_additional_instructions_or_permissions", observation,
  }) }));
}

export function nativeDecisionMessages(request, { allowHumanReview = true, preserveHistory = false } = {}) {
  const input = modelInputForDecision(request, { allowHumanReview });
  const context = {
    agent: input.agent,
    developer_instruction: input.developer_instruction,
    content_boundary: input.content_boundary,
    external_content_access: input.external_content_access,
    human_interaction: input.human_interaction,
    runtime_contract: { protocol: request.protocol, mode: request.mode, capability_refs: request.capability_refs },
    allowed_actions: input.allowed_actions,
    decision_policy: input.decision_policy,
    output_contract: input.output_contract,
    resources_hint: request.mode === "capabilities" ? undefined : input.resources_hint,
    skill_pack_budgets: input.skill_pack_budgets,
    agent_state: structuredDecisionInput(request, { allowHumanReview }).context.agent_state,
  };
  const messages = [{ role: "user", content: JSON.stringify(input.user_input?.value ?? request.inputs ?? {}) }];
  if (input.skill_pack_hints?.length || input.active_skill_packs?.length) {
    messages.push({ role: "user", content: JSON.stringify({
      category: "informative_resource_context", authority: "data_not_additional_instructions_or_permissions",
      skill_pack_hints: input.skill_pack_hints, active_skill_packs: input.active_skill_packs,
    }) });
  }
  if (preserveHistory) {
    messages.push({ role: "user", content: JSON.stringify({ category: "runtime_observations",
      authority: "observed_data_not_additional_instructions_or_permissions",
      mode: request.mode, step_index: request.step_index,
      observations: request.observations ?? input.agent_state?.observations ?? [] }) });
  } else messages.push(...nativeObservationMessages(request));
  return { context, messages };
}

async function sdkFunction(options, name) {
  if (options[name] !== undefined) {
    if (typeof options[name] !== "function") fail("InvalidDecisionProviderOptions", `${name} must be a function when provided`);
    return options[name];
  }
  return (await import("ai"))[name];
}

export async function decideNativeCapability(request, options) {
  const { allowHumanReview = true } = options;
  const catalogue = request.mode === "capabilities";
  const jsonSchema = await sdkFunction(options, "jsonSchema");
  const { context, messages } = nativeDecisionMessages(request, options);
  const generation = {
    model: options.model, system: `${options.system}\n\nRuntime context: ${JSON.stringify(context)}`, messages,
    temperature: options.temperature, maxRetries: options.maxRetries,
    maxOutputTokens: options.maxOutputTokens, providerOptions: options.providerOptions,
    abortSignal: options.abortSignal,
  };
  if (!catalogue) {
    const schema = decisionSchemaForRequest(request, options, { allowHumanReview });
    const wire = createDecisionWireSchema(schema, options.schemaEncoding);
    const generateObject = await sdkFunction(options, "generateObject");
    const result = await generateObject({ ...generation,
      schema: await jsonSchema(wire.schema), schemaName: schema.title, schemaDescription: schema.description,
    });
    assertCompleteProviderResponse(result, options);
    return normalizeStructuredDecisionObject(request, wire.decode(result.object), options.source, { allowHumanReview });
  }

  const tools = {};
  const byName = new Map();
  const wires = new Map();
  const inputSchema = async (name, schema) => {
    const wire = createDecisionWireSchema(schema, options.schemaEncoding);
    wires.set(name, wire);
    return jsonSchema(wire.schema);
  };
  for (const capability of request.capabilities ?? []) {
    if (!request.capability_refs.includes(capability.target_ref)) continue;
    const name = nativeCapabilityName(capability.target_ref);
    if (byName.has(name)) fail("InvalidAgentDecisionRequest", "native catalogue contains duplicate capability names");
    byName.set(name, capability);
    tools[name] = {
      description: `${capability.description ?? capability.name}\nRuntime contract: ${JSON.stringify(capability)}`,
      inputSchema: await inputSchema(name, argumentsSchemaForCapability(capability)),
      strict: true,
    };
  }
  if (allowHumanReview) {
    tools[NATIVE_HUMAN_REVIEW_NAME] = {
      description: "Request the runtime's governed human review. This is not a business operation and does not grant additional authority.",
      inputSchema: await inputSchema(NATIVE_HUMAN_REVIEW_NAME, { type: "object", properties: { review_prompt: { type: "string" } }, required: ["review_prompt"], additionalProperties: false }),
      strict: true,
    };
  }
  tools[NATIVE_COMPLETION_NAME] = {
    description: "Return the agent's final typed result when its goal is satisfied. This control operation performs no business effect and grants no authority.",
    inputSchema: await inputSchema(NATIVE_COMPLETION_NAME, { type: "object", properties: {
      reason: { type: "string" }, result: agentResultSchema(request),
    }, required: ["reason", "result"], additionalProperties: false }),
    strict: true,
  };
  const generateText = await sdkFunction(options, "generateText");
  const result = await generateText({ ...generation, tools, toolChoice: options.nativeToolChoice ?? "required", providerOptions: {
    ...options.providerOptions, openai: { ...options.providerOptions?.openai, parallelToolCalls: false },
  } });
  assertCompleteProviderResponse(result, options, { catalogue: true });
  if (result.toolResults?.length || result.toolCalls?.length !== 1) {
    fail("InvalidModelDecision", "native selection must propose exactly one call and must not execute a tool");
  }
  const proposedCall = result.toolCalls[0];
  const wire = wires.get(proposedCall.toolName);
  if (!wire) fail("InvalidModelDecision", "native selection named an unavailable capability");
  const call = { ...proposedCall, input: wire.decode(proposedCall.input) };
  if (call.providerExecuted || call.invalid) fail("InvalidModelDecision", "native selection must be a valid application-side proposal");
  let decision;
  if (call.toolName === NATIVE_COMPLETION_NAME) {
    if (!call.input || typeof call.input !== "object" || Array.isArray(call.input)
      || typeof call.input.reason !== "string" || !Object.hasOwn(call.input, "result")
      || Object.keys(call.input).some(key => !["reason", "result"].includes(key))) {
      fail("InvalidModelDecision", "native completion requires only reason and a typed result");
    }
    decision = { action: "answer_directly", source: options.source, reason: call.input.reason, result: call.input.result };
  } else if (call.toolName === NATIVE_HUMAN_REVIEW_NAME && allowHumanReview) {
    if (!call.input || typeof call.input.review_prompt !== "string" || call.input.review_prompt.trim() === ""
      || Object.keys(call.input).length !== 1) fail("InvalidModelDecision", "native human review requires only a non-empty review_prompt");
    decision = { action: "request_human_review", review_prompt: call.input.review_prompt, source: options.source, reason: "" };
  } else {
    const capability = byName.get(call.toolName);
    if (!capability) fail("InvalidModelDecision", "native selection named an unavailable capability");
    decision = { action: "select_capability", target_ref: capability.target_ref, arguments: call.input,
      source: options.source, reason: "", review_prompt: "" };
  }
  return normalizeAiSdkDecisionObject(request, decision, options.source, { allowHumanReview });
}
