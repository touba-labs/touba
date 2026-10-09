// @ts-check

import { RuntimeFailure } from "./runtime-errors.mjs";

const ISSUED_COMPENSATION_CONTEXTS = new WeakSet();

/**
 * Issue an internal-only execution context. The module is deliberately not
 * exported by the package so a normal runtime caller cannot opt into the V3
 * handler protocol by crafting a similarly shaped object.
 *
 * @param {Record<string, any>} value
 * @returns {Readonly<Record<string, any>>}
 */
export function issueCompensationExecutionContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidContext();
  }
  const context = deepFreeze({ ...value });
  ISSUED_COMPENSATION_CONTEXTS.add(context);
  return context;
}

/**
 * @param {unknown} value
 * @returns {Readonly<Record<string, any>> | null}
 */
export function normalizeInternalCompensationContext(value) {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "object"
    || Array.isArray(value)
    || !ISSUED_COMPENSATION_CONTEXTS.has(value)
  ) {
    throw invalidContext();
  }
  return /** @type {Readonly<Record<string, any>>} */ (value);
}

function invalidContext() {
  return new RuntimeFailure(
    "compensation execution context is reserved to the COMP-1 coordinator",
    {},
    "CompensationContextRequired",
  );
}

/** @param {any} value @returns {any} */
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
