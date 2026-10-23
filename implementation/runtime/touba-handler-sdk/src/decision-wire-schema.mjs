import { ToubaAgentDecisionProviderError } from "./decision-contract.mjs";
import { isIsoDate } from "./value-contracts.mjs";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = () => { throw new ToubaAgentDecisionProviderError("InvalidModelDecision", "provider output does not match the declared decision schema"); };
const optionalValue = schema => schema?.anyOf?.length === 2
  && schema.anyOf[0]?.properties?.present?.const === false
  && schema.anyOf[1]?.properties?.present?.const === true
  ? schema.anyOf[1].properties.value : undefined;
const mergeable = schema => schema?.type === "object" && object(schema.properties) && !Object.hasOwn(schema.properties, "present");

// This validator covers the closed schema vocabulary produced by the Touba
// decision contract. It does not coerce, remove unknown fields or salvage data.
function matches(schema, value) {
  if (schema.anyOf) return schema.anyOf.some(branch => matches(branch, value));
  if (Object.hasOwn(schema, "const") && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.minimum !== undefined && !(typeof value === "number" && value >= schema.minimum)) return false;
  if (schema.maximum !== undefined && !(typeof value === "number" && value <= schema.maximum)) return false;
  if (schema.pattern && (schema.pattern !== "^[0-9]+$" || typeof value !== "string" || !/^[0-9]+$/u.test(value))) return false;
  if (schema.minLength !== undefined && !(typeof value === "string" && Array.from(value).length >= schema.minLength)) return false;
  if (schema.maxLength !== undefined && !(typeof value === "string" && Array.from(value).length <= schema.maxLength)) return false;
  if (schema.minItems !== undefined && !(Array.isArray(value) && value.length >= schema.minItems)) return false;
  if (schema.maxItems !== undefined && !(Array.isArray(value) && value.length <= schema.maxItems)) return false;
  switch (schema.type) {
    case "object": return object(value)
      && (schema.required ?? []).every(key => Object.hasOwn(value, key))
      && Object.entries(value).every(([key, item]) => Object.hasOwn(schema.properties ?? {}, key) && matches(schema.properties[key], item));
    case "array": return Array.isArray(value) && value.every(item => matches(schema.items, item));
    case "string": return typeof value === "string" && (schema.format !== "date" || isIsoDate(value));
    case "boolean": return typeof value === "boolean";
    case "integer": return Number.isSafeInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    default: return false;
  }
}

function flatten(schema) {
  const inner = optionalValue(schema);
  if (inner) {
    const value = flatten(inner);
    return mergeable(inner)
      ? { ...value, properties: { present: { type: "boolean" }, ...value.properties }, required: ["present", ...value.required] }
      : { type: "object", properties: { present: { type: "boolean" }, value }, required: ["present", "value"], additionalProperties: false };
  }
  if (schema.anyOf) return { ...schema, anyOf: schema.anyOf.map(flatten) };
  if (schema.type === "array") return { ...schema, items: flatten(schema.items) };
  if (schema.type === "object") return { ...schema, properties: Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, flatten(value)])) };
  return structuredClone(schema);
}

function restore(schema, value) {
  const inner = optionalValue(schema);
  if (inner) {
    if (value.present === false) return { present: false };
    const { present, ...fields } = value;
    return { present: true, value: restore(inner, mergeable(inner) ? fields : value.value) };
  }
  if (schema.anyOf) {
    const branch = schema.anyOf.find(candidate => matches(flatten(candidate), value));
    if (!branch) invalid();
    return restore(branch, value);
  }
  if (schema.type === "array") return value.map(item => restore(schema.items, item));
  if (schema.type === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restore(schema.properties[key], item)]));
  return value;
}

export function decisionSchemaEncoding(model, encoding = "auto") {
  if (!["auto", "canonical", "flat_optionals"].includes(encoding)) {
    throw new ToubaAgentDecisionProviderError("InvalidDecisionProviderOptions", "schemaEncoding must be auto, canonical or flat_optionals");
  }
  return encoding === "auto" ? (/^anthropic(?:\.|$)/u.test(model?.provider ?? "") ? "flat_optionals" : "canonical") : encoding;
}

export const FLAT_OPTIONAL_INSTRUCTIONS = "Optional fields carry a boolean present flag. When absent, set present to false; the other fields must still match their schema and are ignored. When present, provide the declared value fields.";

export function createDecisionWireSchema(schema, encoding = "canonical") {
  const wire = encoding === "flat_optionals" ? flatten(schema) : schema;
  return { schema: wire, decode(value) {
    // The canonical path retains its existing semantic decision validator.
    // Transformations require a wire check before any information is removed.
    if (encoding !== "flat_optionals") return value;
    if (!matches(wire, value)) invalid();
    const result = restore(schema, value);
    if (!matches(schema, result)) invalid();
    return result;
  } };
}
