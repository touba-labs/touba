import { writeSync } from "node:fs";
import { pathToFileURL } from "node:url";

// No exception text crosses the private channel. Only exact host-selected
// file positions and a closed class vocabulary are projected from the stack.
export function emitLocalHandlerDiagnostic(error) {
  if (process.env.TOUBA_LOCAL_DIAGNOSTIC_FD !== "3") return;
  try {
    const sources = JSON.parse(process.env.TOUBA_LOCAL_DIAGNOSTIC_SOURCES ?? "[]");
    if (!Array.isArray(sources) || sources.length > 8) return;
    const errorClass = [TypeError, RangeError, SyntaxError, ReferenceError, URIError, EvalError]
      .find(Type => error instanceof Type)?.name ?? "Error";
    const frames = typeof error?.stack === "string" ? error.stack.slice(0, 65536).split("\n").slice(1, 32) : [];
    let location;
    for (const frame of frames) {
      for (const source of sources) {
        if (typeof source.path !== "string" || !Number.isSafeInteger(source.index)) continue;
        for (const path of [source.path, pathToFileURL(source.path).href]) {
          // Match a whole stack location, never a substring of exception text.
          const text = frame.trim();
          const offset = text.startsWith(`at ${path}:`) ? 3 : text.indexOf(` (${path}:`) + 2;
          if (offset < 2) continue;
          if (!text.slice(offset).startsWith(`${path}:`)) continue;
          const match = /^:(\d+):(\d+)\)?$/u.exec(text.slice(offset + path.length));
          if (match) location = { handler_arg_index: source.index, line: Number(match[1]), column: Number(match[2]) };
          if (location) break;
        }
        if (location) break;
      }
      if (location) break;
    }
    writeSync(3, `${JSON.stringify({ error_class: errorClass, ...(location ?? {}) })}\n`);
  } catch { /* Diagnostics never replace the original handler outcome. */ }
}
