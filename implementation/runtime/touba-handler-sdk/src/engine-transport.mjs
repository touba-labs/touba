import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const VERSION = "touba-engine-v1";
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_REPLY_BYTES = 128 * 1024 * 1024;
const failure = code => Object.assign(new Error(code), { code });

/** One private worker per Engine; no automatic retry of a submitted run. */
export class PersistentEngineTransport {
  constructor({ command, args, cwd, env }) {
    this.options = { command, args, cwd, env };
    this.pending = new Map();
    this.child = null;
    this.starting = null;
    this.closed = false;
    this.metrics = null;
  }

  get pid() { return this.child?.pid ?? null; }

  reference(ref) {
    const method = ref ? "ref" : "unref";
    this.child?.[method]();
    for (const stream of this.child?.stdio ?? []) stream?.[method]?.();
  }

  async start() {
    if (this.closed) throw failure("EngineClosed");
    if (this.starting) return this.starting;
    const { command, args, cwd, env } = this.options;
    const child = spawn(command, [...args, "engine-worker"], { cwd, env, shell: false,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout.resume(); child.stderr.resume(); // Host logs never form protocol replies.
    let buffer = Buffer.alloc(0);
    let ready = false;
    this.starting = new Promise((resolve, reject) => {
      const startupTimer = setTimeout(() => terminate("EngineWorkerStartupTimeout"), 10000);
      const terminate = code => {
        clearTimeout(startupTimer);
        if (!ready) reject(failure(code));
        if (this.child === child) this.kill();
      };
      child.once("error", error => terminate(/^E[A-Z]+$/.test(error?.code ?? "") ? error.code : "EngineWorkerLaunchFailed"));
      child.stdin.on("error", () => terminate("EngineWorkerDisconnected"));
      child.stdio[3].on("error", () => terminate("EngineWorkerDisconnected"));
      child.stdio[3].on("data", chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        let boundary;
        while ((boundary = buffer.indexOf(10)) >= 0) {
          if (boundary > MAX_REPLY_BYTES) return terminate("EngineWorkerReplyInvalid");
          let reply;
          try { reply = JSON.parse(buffer.subarray(0, boundary).toString("utf8")); }
          catch { return terminate("EngineWorkerReplyInvalid"); }
          buffer = buffer.subarray(boundary + 1);
          if (reply.protocol !== VERSION) return terminate("EngineWorkerProtocolMismatch");
          if (!ready) {
            if (reply.type !== "ready" || reply.pid !== child.pid) return terminate("EngineWorkerProtocolMismatch");
            clearTimeout(startupTimer); ready = true; resolve();
            if (!this.pending.size) this.reference(false);
            continue;
          }
          const pending = this.pending.get(reply.id);
          if (!pending) return terminate("EngineWorkerReplyInvalid");
          this.pending.delete(reply.id); pending.cleanup();
          if (reply.error) pending.reject(failure(reply.error));
          else if (!Number.isInteger(reply.status) || typeof reply.stdout !== "string" || typeof reply.stderr !== "string") {
            pending.reject(failure("EngineWorkerReplyInvalid"));
            return terminate("EngineWorkerReplyInvalid");
          } else {
            if (Number.isSafeInteger(reply.metrics?.rss_bytes)
              && Number.isSafeInteger(reply.metrics?.cpu_us?.user) && Number.isSafeInteger(reply.metrics?.cpu_us?.system)) {
              this.metrics = structuredClone(reply.metrics);
            }
            pending.resolve({ status: reply.status, stdout: reply.stdout, stderr: reply.stderr, signal: null });
          }
          if (!this.pending.size) this.reference(false);
        }
        if (buffer.length > MAX_REPLY_BYTES) terminate("EngineWorkerReplyInvalid");
      });
      child.once("close", () => {
        clearTimeout(startupTimer);
        if (!ready) reject(failure("EngineWorkerLaunchFailed"));
        for (const pending of this.pending.values()) {
          pending.cleanup(); pending.reject(failure("EngineWorkerInterrupted"));
        }
        this.pending.clear();
        if (this.child === child) { this.child = null; this.starting = null; }
      });
    });
    return this.starting;
  }

  async run(args, { signal } = {}) {
    if (signal?.aborted) throw failure("EngineCancelled");
    await this.start();
    if (signal?.aborted) throw failure("EngineCancelled");
    if (this.closed) throw failure("EngineClosed");
    if (this.pending.size >= 20) throw failure("EngineCapacityExceeded");
    const id = randomUUID();
    const frame = JSON.stringify({ protocol: VERSION, type: "run", id, args }) + "\n";
    if (Buffer.byteLength(frame) > MAX_REQUEST_BYTES) throw failure("EngineRequestLimitExceeded");
    this.reference(true);
    return new Promise((resolve, reject) => {
      let timer;
      const onAbort = () => {
        if (timer) return;
        this.child?.stdin.write(JSON.stringify({ protocol: VERSION, type: "cancel", id }) + "\n");
        // A blocked trusted provider may not cooperate. Stop the whole dedicated
        // worker after grace; other in-flight calls fail, never silently retry.
        timer = setTimeout(() => this.kill(), 5000);
      };
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.child.stdin.write(frame);
      if (signal?.aborted) onAbort();
    });
  }

  kill() {
    const child = this.child;
    if (!child) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch { child.kill("SIGKILL"); }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (!child) return;
    this.reference(true);
    await new Promise(resolve => {
      const timer = setTimeout(() => this.kill(), 5500);
      child.once("close", () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
  }
}
