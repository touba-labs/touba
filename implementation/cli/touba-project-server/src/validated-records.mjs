// Memoize pure validation of exact JSON bytes, never authorization. Each read
// parses its current bytes into a fresh object. Writes always validate the
// original object: JSON.stringify is lossy (NaN/null, undefined/missing, toJSON).
export function validatedRecordCodec(validate, { maxEntries = 512, maxBytes = 32 * 1024 * 1024 } = {}) {
  const entries = new Map();
  let bytes = 0;
  function parse(content, ...context) {
    if (typeof content !== "string") throw new TypeError("stored record must be JSON text");
    const value = JSON.parse(content);
    if (entries.has(content)) {
      const size = entries.get(content);
      entries.delete(content);
      entries.set(content, size);
      return value;
    }
    validate(value, ...context);
    const size = Buffer.byteLength(content, "utf8");
    if (size > maxBytes || maxEntries < 1) return value;
    while (entries.size >= maxEntries || bytes + size > maxBytes) {
      const oldest = entries.keys().next().value;
      bytes -= entries.get(oldest);
      entries.delete(oldest);
    }
    entries.set(content, size);
    bytes += size;
    return value;
  }
  return Object.freeze({ validate, parse });
}
