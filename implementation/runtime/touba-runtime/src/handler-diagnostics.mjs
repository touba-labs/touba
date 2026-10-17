import { closeSync, constants, fchmodSync, openSync, writeSync } from "node:fs";

const classes = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "URIError", "EvalError"]);

/** @param {string} raw @param {{index: number, path: string}[]} sources */
export function validatedHandlerDiagnostic(raw, sources) {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).some(key => !["error_class", "handler_arg_index", "line", "column"].includes(key))
        || !classes.has(value.error_class)) return null;
    const location = ["handler_arg_index", "line", "column"].filter(key => Object.hasOwn(value, key));
    if (location.length !== 0 && (location.length !== 3
        || !sources.some(source => source.index === value.handler_arg_index)
        || !Number.isSafeInteger(value.line) || value.line <= 0 || value.line > 10000000
        || !Number.isSafeInteger(value.column) || value.column <= 0 || value.column > 10000000)) return null;
    return value;
  } catch { return null; }
}

/** @param {string} path */
export function openLocalHandlerDiagnostics(path) {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { fchmodSync(fd, 0o600); } catch (error) { closeSync(fd); throw error; }
  let bytes = 0;
  let count = 0;
  let closed = false;
  let incomplete = false;
  return {
    get incomplete() { return incomplete; },
    markIncomplete() { incomplete = true; },
    /** @param {Record<string, unknown>} entry */
    record(entry) {
      const data = Buffer.from(`${JSON.stringify(entry)}\n`);
      if (closed || count >= 128 || bytes + data.length > 65536) { incomplete = true; return; }
      try {
        let offset = 0;
        while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
        bytes += data.length;
        count += 1;
      } catch { incomplete = true; }
    },
    close() { if (!closed) { closed = true; closeSync(fd); } },
  };
}
