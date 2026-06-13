// @ts-check

import { normalizeAirRunLimits } from "./runtime-budgets.mjs";
import { ToubaRuntimeError } from "./runtime-errors.mjs";

export const AIR_SCHEMA_VERSION = "air-minimal-v0.1";
export const AIR_JSON_PROFILE = "air-json-v0.1";

export const AIR_DEFINITION_COLLECTIONS = Object.freeze([
  "types",
  "constants",
  "functions",
  "tools",
  "memories",
  "skills",
  "agents",
  "strategies",
  "triggers",
]);

/**
 * @typedef {Record<string, any>} AirRecord
 * @typedef {{
 *   types: Map<string, AirRecord>,
 *   constants: Map<string, AirRecord>,
 *   functions: Map<string, AirRecord>,
 *   tools: Map<string, AirRecord>,
 *   memories: Map<string, AirRecord>,
 *   skills: Map<string, AirRecord>,
 *   agents: Map<string, AirRecord>,
 *   strategies: Map<string, AirRecord>,
 *   triggers: Map<string, AirRecord>,
 *   graphs: Map<string, AirRecord>,
 *   tracePoints: Map<string, AirRecord>,
 * }} AirRuntimeIndexes
 */

/**
 * @param {unknown} document
 * @returns {asserts document is AirRecord}
 */
export function validateAirDocument(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new ToubaRuntimeError("InvalidAirDocument", "AIR JSON must decode to an object");
  }
  const record = /** @type {AirRecord} */ (document);
  if (record.air_schema_version !== AIR_SCHEMA_VERSION) {
    throw new ToubaRuntimeError(
      "UnsupportedAirSchemaVersion",
      `expected ${AIR_SCHEMA_VERSION}`,
      { actual: record.air_schema_version },
    );
  }
  if (typeof record.module?.id !== "string" || record.module.id.trim() === "") {
    throw new ToubaRuntimeError("InvalidAirDocument", "AIR module id is required");
  }
  if (!record.definitions || typeof record.definitions !== "object") {
    throw new ToubaRuntimeError("InvalidAirDocument", "AIR definitions are required");
  }
  validateAirDefinitionCollections(record.definitions);
  if (!Array.isArray(record.execution_graphs)) {
    throw new ToubaRuntimeError("InvalidAirDocument", "AIR execution_graphs must be an array");
  }
  if (!Array.isArray(record.trace_points)) {
    throw new ToubaRuntimeError("InvalidAirDocument", "AIR trace_points must be an array");
  }
  validateAirBudgets(record.budgets);
}

/**
 * @param {unknown} definitions
 */
export function validateAirDefinitionCollections(definitions) {
  if (!definitions || typeof definitions !== "object" || Array.isArray(definitions)) {
    throw new ToubaRuntimeError("InvalidAirDocument", "AIR definitions must be an object");
  }
  const record = /** @type {AirRecord} */ (definitions);
  for (const collection of AIR_DEFINITION_COLLECTIONS) {
    if (record[collection] !== undefined && !Array.isArray(record[collection])) {
      throw new ToubaRuntimeError(
        "InvalidAirDocument",
        `AIR definitions.${collection} must be an array`,
        { collection },
      );
    }
  }
}

/**
 * @param {unknown} budgets
 */
export function validateAirBudgets(budgets) {
  if (budgets === undefined) {
    return;
  }
  if (!budgets || typeof budgets !== "object" || Array.isArray(budgets)) {
    throw new ToubaRuntimeError("InvalidAirDocument", "AIR budgets must be an object");
  }
  const record = /** @type {AirRecord} */ (budgets);
  const unknownTopLevel = Object.keys(record).filter((key) => key !== "run");
  if (unknownTopLevel.length > 0) {
    throw new ToubaRuntimeError("InvalidAirDocument", "AIR budgets contains unknown sections", {
      unknownBudgetSections: unknownTopLevel,
    });
  }
  normalizeAirRunLimits(record.run, "AIR budgets.run");
}

/**
 * @param {AirRecord} document
 * @returns {AirRuntimeIndexes}
 */
export function indexAirDocument(document) {
  const definitions = /** @type {AirRecord} */ (document.definitions);
  return {
    types: indexById(definitions.types ?? []),
    constants: indexById(definitions.constants ?? []),
    functions: indexById(definitions.functions ?? []),
    tools: indexById(definitions.tools ?? []),
    memories: indexById(definitions.memories ?? []),
    skills: indexById(definitions.skills ?? []),
    agents: indexById(definitions.agents ?? []),
    strategies: indexById(definitions.strategies ?? []),
    triggers: indexById(definitions.triggers ?? []),
    graphs: indexById(document.execution_graphs),
    tracePoints: indexById(document.trace_points),
  };
}

/**
 * @param {unknown} items
 * @returns {Map<string, AirRecord>}
 */
export function indexById(items) {
  if (!Array.isArray(items)) {
    throw new ToubaRuntimeError("InvalidAirDocument", "AIR index source must be an array");
  }
  const index = new Map();
  for (const item of items) {
    const record = /** @type {AirRecord | null | undefined} */ (item);
    if (typeof record?.id !== "string" || record.id.trim() === "") {
      throw new ToubaRuntimeError("InvalidAirDocument", "AIR item without id");
    }
    if (index.has(record.id)) {
      throw new ToubaRuntimeError("InvalidAirDocument", `duplicate AIR id ${record.id}`);
    }
    index.set(record.id, record);
  }
  return index;
}
