import { createHash } from "node:crypto";

// Memoize pure validation by a SHA-256 fingerprint, never authorization or
// mutable records. Keep at most 16K witnesses (2 MiB of UTF-16 hex keys, plus
// bounded Set overhead), regardless of the size of the validated documents.
// As with stored integrity digests, reuse relies on SHA-256 collision resistance.
// Each read still parses current text into a fresh object. Writes always
// validate the original object: JSON.stringify is lossy (NaN/undefined/toJSON).
export function validatedRecordCodec(validate, { maxEntries = 16384, maxBytes = 2 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("validation cache limits must be nonnegative safe integers");
  }
  const entries = new Set();
  const capacity = Math.min(maxEntries, Math.floor(maxBytes / 128));
  function parse(content, ...context) {
    if (typeof content !== "string") throw new TypeError("stored record must be JSON text");
    const value = JSON.parse(content);
    // UTF-16 retains every JS code unit: UTF-8 would alias a raw unpaired
    // surrogate with U+FFFD before hashing, despite different JSON values.
    const fingerprint = capacity > 0 ? createHash("sha256").update(content, "utf16le").digest("hex") : null;
    if (entries.has(fingerprint)) {
      entries.delete(fingerprint);
      entries.add(fingerprint);
      return value;
    }
    validate(value, ...context);
    if (capacity < 1) return value;
    if (entries.size >= capacity) entries.delete(entries.values().next().value);
    entries.add(fingerprint);
    return value;
  }
  return Object.freeze({ validate, parse });
}
