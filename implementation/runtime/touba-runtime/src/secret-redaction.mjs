// @ts-check

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
