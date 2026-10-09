export {
  EFFECT_JOURNAL_SCHEMA_VERSION,
  createFileEffectJournal,
  loadEffectJournal,
} from "@touba/runtime/file-effect-journal";

/**
 * Return null when the scope has no uncertain effect. Otherwise all uncertain
 * effects must be protected by a real idempotency key before the queue may
 * retry. A mixed scope therefore fails closed.
 */
export function unknownEffectRetryDecision(entries) {
  const unknownEntries = entries.filter((entry) => entry.state === "unknown");
  if (unknownEntries.length === 0) {
    return null;
  }
  return unknownEntries.every((entry) => entry.retry_mode === "idempotency_key");
}
