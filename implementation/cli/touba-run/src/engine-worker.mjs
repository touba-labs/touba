import { createWriteStream } from "node:fs";
import { executeRunCommand } from "./command.mjs";
import { resolveProjectRunArgs } from "../../touba-project/src/project.mjs";
import { projectAdmissionFailure } from "../../touba-project/src/run-admission.mjs";

const VERSION = "touba-engine-v1";
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_ACTIVE = 4;
const MAX_QUEUED = 16;

function captureOutput() {
  let bytes = 0;
  const chunks = [];
  return {
    write(chunk, callback) {
      const value = String(chunk);
      bytes += Buffer.byteLength(value);
      if (bytes > MAX_OUTPUT_BYTES) throw Object.assign(new Error("bounded Engine output exceeded"), { code: "EngineOutputLimitExceeded" });
      chunks.push(value);
      callback?.();
      return true;
    },
    text() { return chunks.join(""); },
  };
}

/** Internal SDK transport; stdin carries requests, descriptor 3 carries replies. */
export async function startEngineWorker() {
  const responses = createWriteStream(null, { fd: 3, autoClose: false });
  responses.on("error", () => process.exit(1));
  const active = new Map();
  const queue = [];
  let closing = false;
  let closeTimer;
  const send = value => new Promise(resolve => responses.write(JSON.stringify({ protocol: VERSION, ...value }) + "\n", resolve));
  const finish = () => {
    if (closing && active.size === 0) {
      clearTimeout(closeTimer);
      responses.end(() => process.exit(0));
    }
  };
  const execute = async request => {
    const controller = new AbortController();
    active.set(request.id, controller);
    const stdout = captureOutput(), stderr = captureOutput();
    try {
      let args;
      try { args = resolveProjectRunArgs(request.args); }
      catch (error) {
        const refusal = projectAdmissionFailure(error);
        if (!refusal) throw error;
        await send({ id: request.id, status: 2, stdout: JSON.stringify(refusal), stderr: "" });
        return;
      }
      const status = await executeRunCommand(args, { stdout, stderr, signal: controller.signal });
      await send({ id: request.id, status, stdout: stdout.text(), stderr: stderr.text(),
        metrics: { rss_bytes: process.memoryUsage().rss, cpu_us: process.cpuUsage() } });
    } catch (error) {
      await send({ id: request.id, error: error?.code === "EngineOutputLimitExceeded" ? error.code : "EngineExecutionFailed" });
    } finally {
      active.delete(request.id);
      pump();
      finish();
    }
  };
  const pump = () => {
    while (!closing && active.size < MAX_ACTIVE && queue.length) void execute(queue.shift());
  };
  const receive = async request => {
    if (!request || request.protocol !== VERSION || typeof request.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(request.id)) {
      throw new Error("invalid Engine protocol");
    }
    if (request.type === "cancel") {
      active.get(request.id)?.abort();
      const index = queue.findIndex(item => item.id === request.id);
      if (index >= 0) { queue.splice(index, 1); await send({ id: request.id, error: "EngineCancelled" }); }
      return;
    }
    if (request.type !== "run" || !Array.isArray(request.args) || request.args.length > 256
      || request.args.some(arg => typeof arg !== "string" || arg.includes("\0"))
      || request.args.includes("--interactive-user-inputs")) throw new Error("invalid Engine request");
    if (active.has(request.id) || queue.some(item => item.id === request.id)) throw new Error("duplicate Engine request");
    if (queue.length >= MAX_QUEUED) { await send({ id: request.id, error: "EngineCapacityExceeded" }); return; }
    queue.push(request); pump();
  };
  await send({ type: "ready", pid: process.pid, max_active: MAX_ACTIVE, max_queued: MAX_QUEUED });
  let buffer = Buffer.alloc(0);
  try {
    for await (const chunk of process.stdin) {
      buffer = Buffer.concat([buffer, chunk]);
      let boundary;
      while ((boundary = buffer.indexOf(10)) >= 0) {
        if (boundary > MAX_REQUEST_BYTES) throw new Error("oversized Engine request");
        const line = buffer.subarray(0, boundary); buffer = buffer.subarray(boundary + 1);
        await receive(JSON.parse(line.toString("utf8")));
      }
      if (buffer.length > MAX_REQUEST_BYTES) throw new Error("oversized Engine request");
    }
  } catch { /* Invalid framing closes the private transport; no invocation is retried. */ }
  closing = true;
  queue.length = 0;
  for (const controller of active.values()) controller.abort();
  closeTimer = setTimeout(() => process.exit(1), 5000);
  finish();
}
