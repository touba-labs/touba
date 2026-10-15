// @ts-check

import { containsResolvedSecretValue } from "./execution-checkpoints.mjs";
import { RuntimeFailure } from "./runtime-errors.mjs";

/** Refuse, never silently rewrite, a business result containing a known secret.
 * @param {unknown} value
 * @param {SecretStore | null | undefined} secretStore
 */
export function assertResultHasNoResolvedSecret(value, secretStore) {
  const refused = resolvedSecretEntries(secretStore)
    .filter(entry => containsResolvedSecretValue(value, [entry.value]))
    .map(entry => entry.handle);
  if (refused.length === 0) return;
  throw new RuntimeFailure("result contains a resolved secret value", {
    secretHandlesRefused: refused,
  }, "SecretValueInResult");
}

/**
 * @typedef {object} ResolvedSecretEntry
 * @property {string} handle
 * @property {string} value
 *
 * @typedef {object} SecretStore
 * @property {(handle: string) => string | undefined=} valueFor
 * @property {() => ResolvedSecretEntry[]=} resolvedSecretEntries
 */

/**
 * @param {SecretStore | null | undefined} secretStore
 * @returns {string[]}
 */
export function secretValuesForRedaction(secretStore) {
  return resolvedSecretEntries(secretStore)
    .map((entry) => entry.value)
    .filter((value) => value.length > 0);
}

/**
 * @param {SecretStore | null | undefined} secretStore
 * @returns {ResolvedSecretEntry[]}
 */
export function resolvedSecretEntries(secretStore) {
  if (typeof secretStore?.resolvedSecretEntries !== "function") {
    return [];
  }
  return secretStore.resolvedSecretEntries();
}

/**
 * @param {unknown} value
 * @param {string[]} secretValues
 * @returns {string}
 */
export function redactSecrets(value, secretValues) {
  let redacted = typeof value === "string" ? value : String(value);
  for (const secretValue of secretValues) {
    if (secretValue.length === 0) {
      continue;
    }
    redacted = redacted.split(secretValue).join("[redacted-secret]");
  }
  return redacted;
}
