import { lstat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { publicRunResultMetadata } from "../../../contracts/run-outcome.mjs";

// Await each write: a slow pipe or file must not become an unbounded queue.
export async function writeChunks(stream, chunks) {
  for (const chunk of chunks) {
    await new Promise((resolve, reject) => stream.write(chunk, error => error ? reject(error) : resolve()));
  }
}

export function* traceOutputChunks(result, mode) {
  if (mode === "json") {
    yield JSON.stringify(publicRunResultMetadata(result)).slice(0, -1) + ',"trace":';
  } else if (mode === "all") {
    if (result.messages?.length) yield `[show]\n${result.messages.map(message => message.text).join("\n")}\n\n`;
    yield `[result]\n${JSON.stringify(result.result ?? null, null, 2)}\n\n[trace]\n`;
  } else if (mode !== "trace") throw new TypeError("streamed output mode must be json, all or trace");
  yield* result.traceReader.json();
  yield mode === "json" ? "}\n" : "\n";
}

export async function writeTraceFile(filename, reader) {
  const target = resolve(filename);
  try { if (!(await lstat(target)).isFile()) throw new Error("trace target must be a regular file"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    for (const chunk of reader.json()) await file.writeFile(chunk);
    await file.writeFile("\n");
    await file.sync();
    await file.close(); file = undefined;
    await rename(temporary, target);
    if (process.platform !== "win32") {
      const directory = await open(dirname(target), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await file?.close();
    try { await unlink(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
