import { RuntimeFailure } from "./runtime-errors.mjs";
import { normalizeAgentDecisionProviderMetadata } from "./runtime-options.mjs";

const fields = ["attempt_id", "budget_ref", "status", "currency", "reserved_micros", "cost_micros", "tariff_id", "tariff_date"];
const micros = value => typeof value === "string" && /^(0|[1-9][0-9]{0,127})$/.test(value);
const identifier = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !value.startsWith("0000-") && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function createProviderCostRecorder(request, context, assertSafe) {
  let active = true, count = 0, metadataCount = 0;
  return {
    close() { active = false; },
    recordProviderMetadata(value) {
      if (!active) return false;
      const metadata = normalizeAgentDecisionProviderMetadata(value, "provider execution metadata");
      if (!metadata?.model_id || !metadata?.provider_name || ++metadataCount > 8) {
        throw new RuntimeFailure("invalid provider execution metadata", {}, "InvalidAgentDecisionProvider");
      }
      assertSafe(metadata);
      context.trace.push("agent_decision_provider_model_resolved", { payload: { provider_metadata: metadata,
        agent_ref: request.agent_ref, invocation_id: request.invocation_id, step_index: request.step_index ?? 0 } });
      return true;
    },
    recordProviderCost(value) {
      // In-flight responses may settle their durable ledger after runtime
      // timeout, but cannot append events after this invocation has ended.
      if (!active) return false;
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length
        || fields.some(key => !Object.hasOwn(value, key)) || !identifier(value.attempt_id) || !identifier(value.tariff_id)
        || typeof value.budget_ref !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.budget_ref)
        || typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency)
        || !date(value.tariff_date) || !["pending", "reported", "estimated", "unknown"].includes(value.status)
        || !micros(value.reserved_micros) || (["pending", "unknown"].includes(value.status) ? value.cost_micros !== null : !micros(value.cost_micros))
        || ++count > 1024) {
        throw new RuntimeFailure("invalid provider cost evidence", {}, "ProviderCostEvidenceInvalid");
      }
      assertSafe(value);
      context.trace.push("provider_cost_recorded", { payload: { ...value, agent_ref: request.agent_ref,
        invocation_id: request.invocation_id, step_index: request.step_index ?? 0 } });
      return true;
    },
  };
}
