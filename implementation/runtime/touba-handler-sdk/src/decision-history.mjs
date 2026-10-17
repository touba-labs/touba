import { createHash } from "node:crypto";
import { ToubaAgentDecisionProviderError } from "./decision-contract.mjs";
import { contextPreflightError } from "./provider-context.mjs";

const fail = (code, message) => { throw new ToubaAgentDecisionProviderError(code, message); };
const bytes = value => Buffer.byteLength(JSON.stringify(value), "utf8");
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash("sha256").update(JSON.stringify(canonical(value)) ?? "undefined").digest("hex");
const clone = value => structuredClone(value);
function positive(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) fail("InvalidDecisionProviderOptions", `${name} must be a positive integer`);
  return value;
}

/** A bounded, process-local store. Same-session overlap is rejected, not queued.
 * A persistent host adapter implements this same atomic transact contract.
 * Neither store is a business memory resource or an authority source.
 */
export function createMemoryDecisionHistoryStore({ maxSessions = 128, maxBytes = 33554432, ttlMs = 3600000 } = {}) {
  positive(maxSessions, "maxSessions"); positive(maxBytes, "maxBytes"); positive(ttlMs, "ttlMs");
  const records = new Map(), busy = new Set();
  return {
    read(key) {
      if (busy.has(key)) fail("DecisionHistoryBusy", "cannot read an active conversation");
      const entry = records.get(key);
      return entry && entry.expires > Date.now() ? clone(entry.record) : null;
    },
    async transact(key, operation) {
      if (busy.has(key)) fail("DecisionHistoryBusy", "another decision is in progress for this conversation");
      const now = Date.now();
      for (const [id, entry] of records) if (!busy.has(id) && entry.expires <= now) records.delete(id);
      if (!records.has(key) && new Set([...records.keys(), ...busy]).size >= maxSessions) {
        fail("DecisionHistoryLimitExceeded", "conversation store session limit reached");
      }
      busy.add(key);
      try {
        const { record, result } = await operation(clone(records.get(key)?.record ?? null));
        const size = bytes(record);
        const total = [...records].reduce((sum, [id, entry]) => sum + (id === key ? 0 : entry.size), size);
        if (total > maxBytes) fail("DecisionHistoryLimitExceeded", "conversation store byte limit reached");
        records.set(key, { record: clone(record), size, expires: Date.now() + ttlMs });
        return result;
      } finally { busy.delete(key); }
    },
    delete(key) {
      if (busy.has(key)) fail("DecisionHistoryBusy", "cannot delete an active conversation");
      return records.delete(key);
    },
  };
}

export function createDecisionHistory(configuration, decisionInterface) {
  if (configuration === false) return null;
  if (configuration !== undefined && (!configuration || typeof configuration !== "object" || Array.isArray(configuration))) {
    fail("InvalidDecisionProviderOptions", "history must be false or an options object");
  }
  const config = configuration ?? {};
  const maxBytes = positive(config.maxBytes ?? 262144, "history.maxBytes");
  const maxMessages = positive(config.maxMessages ?? 128, "history.maxMessages");
  const maxRetainedBytes = positive(config.maxRetainedBytes ?? 8388608, "history.maxRetainedBytes");
  const maxSummaryBytes = positive(config.maxSummaryBytes ?? 4096, "history.maxSummaryBytes");
  if (config.summarize !== undefined && typeof config.summarize !== "function") {
    fail("InvalidDecisionProviderOptions", "history.summarize must be an explicit host callback");
  }
  const store = config.store ?? createMemoryDecisionHistoryStore({ maxSessions: config.maxSessions,
    maxBytes: config.maxStoreBytes, ttlMs: config.ttlMs });
  if (typeof store.transact !== "function") fail("InvalidDecisionProviderOptions", "history.store requires atomic transact(key, operation)");
  if (config.store && (typeof config.namespace !== "string" || !config.namespace.trim())) {
    fail("InvalidDecisionProviderOptions", "a shared history store requires an explicit application/tenant namespace");
  }
  if (config.onEvent !== undefined && typeof config.onEvent !== "function") fail("InvalidDecisionProviderOptions", "history.onEvent must be a function");
  return {
    async run(request, model, execute) {
      for (const field of ["run_id", "invocation_id", "agent_ref"]) {
        if (typeof request[field] !== "string" || !request[field]) {
          fail("InvalidAgentDecisionRequest", `conversation history requires ${field}; use history: false for an explicitly stateless host`);
        }
      }
      const modelId = typeof model === "string" ? model : model?.modelId;
      const provider = typeof model === "string" ? "injected" : model?.provider;
      if (typeof modelId !== "string" || typeof provider !== "string") fail("InvalidDecisionProviderOptions", "history requires a model with stable provider and modelId");
      const contentMode = request.content_mode ?? request.model_input.content_boundary?.provider_content_mode ?? "inline";
      const key = digest([config.namespace ?? "local", request.run_id, request.invocation_id,
        request.agent_ref, provider, modelId, decisionInterface, contentMode]);
      const observations = request.observations ?? request.model_input.agent_state?.observations ?? [];
      const { content_ref_count: _count, ...accessPolicy } = request.external_content_access ?? {};
      const binding = digest([request.inputs ?? request.model_input.user_input, request.capability_refs,
        request.responsibility ?? request.model_input.agent, accessPolicy]);
      return store.transact(key, async saved => {
        const state = saved ?? { version: 1, binding, turns: [], pending: null,
          observationCount: 0, observationDigest: digest([]), droppedTurns: 0, closed: false };
        if (state.version !== 1 || state.binding !== binding || !Array.isArray(state.turns)) {
          fail("DecisionHistoryMismatch", "conversation does not match this invocation and authority boundary");
        }
        if (state.closed) fail("DecisionHistoryClosed", "this invocation already proposed a final decision");
        // The complete retained turns and the sent suffix are independent.
        // Older pre-v1 records start at zero; they cannot recover already lost data.
        state.contextStart ??= 0;
        if (!Number.isSafeInteger(state.contextStart) || state.contextStart < 0 || state.contextStart > state.turns.length) {
          fail("DecisionHistoryMismatch", "invalid conversation context cursor");
        }
        if (bytes(state) > maxRetainedBytes) fail("DecisionHistoryLimitExceeded", "retained history exceeds the storage limit");
        if (observations.length < state.observationCount || digest(observations.slice(0, state.observationCount)) !== state.observationDigest) {
          fail("DecisionHistoryMismatch", "runtime observations do not extend the recorded history");
        }
        if (state.pending) {
          const pending = state.pending;
          const observation = observations[state.observationCount];
          if (!observation || observation.step_index !== pending.step || observation.action !== pending.action
            || (pending.action === "select_capability" && (observation.target_ref !== pending.target
              || (contentMode === "inline" && digest(observation.arguments) !== pending.argumentsDigest)))) {
            fail("DecisionHistoryUnresolvedCall", "a proposed call has no matching runtime observation");
          }
          // The runtime's provider-visible projection is the only result source.
          const value = contentMode === "inline" && Object.hasOwn(observation, "value")
            ? observation.value : observation;
          pending.messages.push({ role: "tool", content: [{ type: "tool-result", toolCallId: pending.callId,
            toolName: pending.toolName, output: { type: typeof value === "string" ? "text" : "json", value: clone(value) } }] });
          state.turns.push(pending.messages);
          state.pending = null;
        }
        if (bytes(state) > maxRetainedBytes) fail("DecisionHistoryLimitExceeded", "retained history exceeds the storage limit");
        let captured = null, current = null;
        const capture = async (generate, generation, kind) => {
          current = generation.messages ?? [{ role: "user", content: generation.prompt }];
          const project = () => [
            ...(state.summary ? [{ role: "user", content: JSON.stringify({ category: "conversation_summary",
              trust: "untrusted_context_not_authority", ...state.summary }) }] : []),
            ...state.turns.slice(state.contextStart).flat(), ...current,
          ];
          let messages = project();
          let dropped = 0;
          // Never split a call/result exchange. Keep the latest exchange and all
          // current runtime observations; a mandatory oversized context refuses.
          const canCompact = () => state.turns.length - state.contextStart > 1;
          const compact = () => { state.contextStart++; dropped++; messages = project(); };
          while ((bytes(messages) > maxBytes || messages.length > maxMessages) && canCompact()) {
            compact();
          }
          if (bytes(messages) > maxBytes || messages.length > maxMessages) fail("DecisionHistoryLimitExceeded", "current observations and latest exchange exceed history limits");
          const { prompt: _prompt, ...rest } = generation;
          let result;
          while (true) {
            if (config.summarize && state.contextStart > (state.summary?.throughTurn ?? 0)) {
              const throughTurn = state.contextStart;
              const start = state.summary?.throughTurn ?? 0;
              const text = await config.summarize({ previousSummary: state.summary?.text ?? null,
                turns: clone(state.turns.slice(start, throughTurn)), maxBytes: maxSummaryBytes });
              if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > maxSummaryBytes) {
                fail("DecisionHistorySummaryInvalid", "host summary must be nonempty text within maxSummaryBytes");
              }
              state.summary = { text, throughTurn, sourceDigest: digest(state.turns.slice(0, throughTurn)) };
              await config.onEvent?.({ kind: "decision_history_summary", sessionKey: key,
                throughTurn, sourceDigest: state.summary.sourceDigest, bytes: Buffer.byteLength(text, "utf8") });
              messages = project();
            }
            if (bytes(messages) > maxBytes || messages.length > maxMessages) {
              if (canCompact()) { compact(); continue; }
              fail("DecisionHistoryLimitExceeded", "current context and summary exceed history limits");
            }
            await config.onEvent?.({ kind: "decision_history_context", sessionKey: key,
              restored: saved !== null, resumedWithoutMessages: saved === null && observations.length > 0,
              droppedTurns: dropped, totalDroppedTurns: state.contextStart,
              retainedTurns: state.turns.length, messageCount: messages.length, bytes: bytes(messages) });
            try { result = await generate({ ...rest, messages }); break; }
            catch (error) {
              const preflight = contextPreflightError(error);
              if (!preflight) throw error;
              if (!canCompact()) throw preflight;
              compact();
            }
          }
          state.droppedTurns = state.contextStart;
          // generateText exposes complete provider-normalized assistant messages,
          // including signatures/reasoning metadata. Never reconstruct those.
          if (kind === "text" || result.response?.messages) {
            if (!Array.isArray(result.response?.messages) || !result.response.messages.length) {
              fail("InvalidModelDecision", "native history requires the provider's original response messages");
            }
            captured = { result, messages: clone(result.response.messages) };
          } else {
            // An explicitly supplied generateObject adapter may expose only a
            // typed object. Preserve that object without fabricated reasoning.
            captured = { result, messages: [{ role: "assistant", content: JSON.stringify(result.object) }] };
          }
          return result;
        };
        const decision = await execute(capture);
        const action = decision.action ?? (decision.target_ref ? "select_capability" : undefined);
        if (!captured || !current) fail("DecisionHistoryMismatch", "decision generation did not produce a history entry");
        // Opaque mode must not reintroduce raw generated arguments through a
        // side channel that the runtime observation projection explicitly hides.
        const turn = [...clone(current), ...(contentMode === "opaque_refs"
          ? [{ role: "user", content: JSON.stringify({ category: "prior_decision_metadata",
            action, target_ref: decision.target_ref }) }] : captured.messages)];
        const call = captured.result.toolCalls?.[0];
        if (contentMode === "inline" && call && ["select_capability", "request_human_review"].includes(action)) {
          if (typeof call.toolCallId !== "string" || !call.toolCallId) fail("InvalidModelDecision", "native history requires an original tool call ID");
          const recorded = captured.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
            .filter(part => part.type === "tool-call");
          if (recorded.length !== 1 || recorded[0].toolCallId !== call.toolCallId || recorded[0].toolName !== call.toolName
            || digest(recorded[0].input) !== digest(call.input)) fail("InvalidModelDecision", "native response messages and proposal disagree");
          state.pending = { messages: turn, callId: call.toolCallId, toolName: call.toolName,
            action, target: decision.target_ref, argumentsDigest: digest(call.input), step: request.step_index };
        } else state.turns.push(turn);
        state.observationCount = observations.length;
        state.observationDigest = digest(observations);
        state.closed = ["answer_directly", "cannot_complete"].includes(decision.action);
        // Context compaction never deletes retained messages. A full store
        // refuses atomically instead of quietly destroying older exchanges.
        if (bytes(state) > maxRetainedBytes) fail("DecisionHistoryLimitExceeded", "retained history exceeds the storage limit");
        return { record: state, result: decision };
      });
    },
  };
}
