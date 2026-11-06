import { closeSync, constants, fchmodSync, openSync, writeSync } from "node:fs";
import { pathToFileURL } from "node:url";

const classes = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "URIError", "EvalError",
  "ModuleNotFoundError", "ImportError", "PermissionError", "FileNotFoundError", "OSError", "RuntimeError", "ValueError"]);

// A module can fail before the SDK loads and emits its private FD message.
// Project only a closed class and an exact host-selected file position.
/** @param {string} stderr @param {{index: number, path: string}[]} sources */
export function startupHandlerDiagnostic(stderr, sources) {
  const lines = stderr.slice(0, 65536).split("\n");
  const errorClass = lines.map(line => /^([A-Za-z]+)(?: \[[A-Z_]+\])?:/.exec(line)?.[1]).filter(name => name !== undefined && classes.has(name)).at(-1);
  if (!errorClass) return null;
  for (const source of sources) for (const path of [source.path, pathToFileURL(source.path).href]) {
    for (const line of lines) {
      const text = line.trim();
      const python = /^File "([^"]+)", line (\d+)(?:, in .*)?$/.exec(text);
      if (python?.[1] === path) return validatedHandlerDiagnostic(JSON.stringify({ error_class: errorClass,
        handler_arg_index: source.index, line: Number(python[2]), column: 1 }), sources);
      const offset = text.startsWith(path + ":") ? 0 : text.startsWith("at " + path + ":") ? 3 : text.indexOf(" (" + path + ":") + 2;
      if (offset < 0 || !text.slice(offset).startsWith(path + ":")) continue;
      const match = /^:(\d+)(?::(\d+))?\)?$/.exec(text.slice(offset + path.length));
      if (!match) continue;
      const value = { error_class: errorClass, handler_arg_index: source.index, line: Number(match[1]), column: Number(match[2] ?? 1) };
      return validatedHandlerDiagnostic(JSON.stringify(value), sources);
    }
  }
  return { error_class: errorClass };
}

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
