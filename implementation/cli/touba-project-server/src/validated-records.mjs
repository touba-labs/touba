// Memoize only pure structural/integrity validation, never authorization.
// Callers still read and parse the current durable bytes on every operation.
// A hit requires identical serialized content, not an id, mtime or digest.
export function validatedRecords(validate, { maxEntries = 512, maxBytes = 32 * 1024 * 1024 } = {}) {
  const validateContent = validatedContent(validate, { maxEntries, maxBytes });
  return (record, ...context) => validateContent(JSON.stringify(record), record, ...context);
}

// Return a fresh parsed object even on a hit: callers mutate their own snapshot.
// Disk bytes are always read by the caller, never replaced with a cached store.
export function validatedJson(validate, options) {
  const validateContent = validatedContent(validate, options);
  return (content, ...context) => {
    const value = JSON.parse(content);
    validateContent(content, value, ...context);
    return value;
  };
}

function validatedContent(validate, { maxEntries = 512, maxBytes = 32 * 1024 * 1024 } = {}) {
  const entries = new Map();
  let bytes = 0;
  return (content, record, ...context) => {
    if (entries.has(content)) {
      const size = entries.get(content);
      entries.delete(content);
      entries.set(content, size);
      return;
    }
    validate(record, ...context);
    const size = Buffer.byteLength(content ?? "", "utf8");
    if (size > maxBytes || maxEntries < 1) return;
    while (entries.size >= maxEntries || bytes + size > maxBytes) {
      const oldest = entries.keys().next().value;
      bytes -= entries.get(oldest);
      entries.delete(oldest);
    }
    entries.set(content, size);
    bytes += size;
  };
}
