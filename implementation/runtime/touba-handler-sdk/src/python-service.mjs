// Private SDK backend shared with the Python facade. Not a second runtime,
// not a network listener, and never an interface exposed to model tool calls.
import { AsyncLocalStorage } from "node:async_hooks";
import { pathToFileURL } from "node:url";
import { createAiSdkDecisionProvider, createOpenAiDecisionProvider, createOllamaDecisionProvider,
  createMemoryDecisionHistoryStore, createProviderTokenCostAdapter } from "./index.mjs";
import { createSqliteDecisionHistoryStore } from "./sqlite-decision-history.mjs";
import { createSqliteProviderBudget } from "./sqlite-provider-budget.mjs";

const MAX_BYTES = 8 * 1024 * 1024;
const scope = new AsyncLocalStorage();
const failure = code => Object.assign(new Error("SDK backend operation failed"), { name: "ToubaAgentDecisionProviderError", code });

export async function servePythonSdk({ input = process.stdin, output = process.stdout } = {}) {
  const objects = new Map(), callbacks = new Map(), active = new Set();
  let sequence = 0, buffer = Buffer.alloc(0), closed = false;
  const write = value => {
    const data = JSON.stringify(value) + "\n";
    if (closed || Buffer.byteLength(data) > MAX_BYTES) throw failure("PythonHostPayloadInvalid");
    output.write(data);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    for (const item of callbacks.values()) { clearTimeout(item.timer); item.reject(failure("PythonHostUnavailable")); }
    callbacks.clear();
    for (const { value, resources } of objects.values()) {
      try { value.close?.(); } catch { /* local teardown only */ }
      for (const resource of resources) { try { resource.close(); } catch { /* local teardown only */ } }
    }
    objects.clear();
  };
  const callback = async (target, args) => {
    // HTTP adapters receive a bounded snapshot, not a serialised JS object
    // with lost methods. These are trusted callbacks, never model messages.
    const portable = await Promise.all(args.map(async value => {
      if (!(value instanceof Request) && !(value instanceof Response)) return value;
      const reader = value.clone().body?.getReader(), chunks = [];
      let size = 0;
      try {
        if (reader) while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          size += chunk.byteLength;
          if (size > MAX_BYTES) throw failure("PythonHostPayloadInvalid");
          chunks.push(chunk);
        }
      } finally { if (reader) void reader.cancel().catch(() => {}); }
      return { ...(value instanceof Request ? { url: value.url, method: value.method } : { status: value.status }),
        headers: Object.fromEntries(value.headers), body: Buffer.concat(chunks).toString("utf8") };
    }));
    return new Promise((resolve, reject) => {
    if (callbacks.size >= 32 || closed) { reject(failure("PythonHostUnavailable")); return; }
    const id = ++sequence, parent = scope.getStore();
    const timer = setTimeout(() => { callbacks.delete(id); reject(failure("PythonHostTimeout")); }, 180000);
    callbacks.set(id, { resolve, reject, timer });
    try { write({ callback: id, parent, target, args: encode(portable) }); }
    catch (error) { callbacks.delete(id); clearTimeout(timer); reject(error); }
    });
  };
  // Tagged syntax at EVERY node; ordinary data can never impersonate a handle.
  function decode(node, depth = 0) {
    if (!node || depth > 100) throw failure("PythonHostPayloadInvalid");
    if (node.t === "value" && (node.v === null || ["string", "boolean", "number"].includes(typeof node.v))) return node.v;
    if (node.t === "integer" && /^-?\d{1,128}$/.test(node.v)) return BigInt(node.v);
    if (node.t === "array" && Array.isArray(node.v)) return node.v.map(item => decode(item, depth + 1));
    if (node.t === "object" && Array.isArray(node.v)) {
      const pairs = node.v.map(([key, value]) => {
        if (typeof key !== "string") throw failure("PythonHostPayloadInvalid");
        return [key, decode(value, depth + 1)];
      });
      if (new Set(pairs.map(([key]) => key)).size !== pairs.length) throw failure("PythonHostPayloadInvalid");
      return Object.fromEntries(pairs);
    }
    if (node.t === "callback" && Number.isSafeInteger(node.v)) return (...args) => callback(node.v, args);
    if (node.t === "handle" && objects.has(node.v)) return objects.get(node.v).value;
    throw failure("PythonHostPayloadInvalid");
  }
  function encode(value, depth = 0) {
    if (depth > 100) throw failure("PythonHostPayloadInvalid");
    if (value === undefined) return { t: "value", v: null };
    if (typeof value === "bigint") return { t: "integer", v: String(value) };
    if (value === null || ["string", "boolean"].includes(typeof value) || (typeof value === "number" && Number.isFinite(value))) return { t: "value", v: value };
    if (Array.isArray(value)) return { t: "array", v: value.map(item => encode(item, depth + 1)) };
    if (typeof value === "object") return { t: "object", v: Object.entries(value).map(([key, item]) => [key, encode(item, depth + 1)]) };
    throw failure("PythonHostPayloadInvalid");
  }
  const factories = {
    ai: { create: createAiSdkDecisionProvider, methods: ["invoke"] },
    openai: { create: createOpenAiDecisionProvider, methods: ["invoke"] },
    ollama: { create: createOllamaDecisionProvider, methods: ["invoke"] },
    memory: { create: createMemoryDecisionHistoryStore, methods: ["read", "transact", "delete"] },
    sqlite: { create: createSqliteDecisionHistoryStore, methods: ["read", "transact", "delete", "recover", "close"] },
  };
  async function perform(message) {
    const { id } = message;
    try {
      let result;
      if (message.method === "create") {
        const factory = factories[message.kind];
        if (!factory || objects.size >= 256) throw failure("InvalidDecisionProviderOptions");
        const options = decode(message.options), resources = [];
        let value;
        try {
          for (const key of ["fetch", "countFetch"]) if (options[key] !== undefined) {
            if (!["openai", "ollama"].includes(message.kind) || typeof options[key] !== "function") throw failure("InvalidDecisionProviderOptions");
            const transport = options[key];
            options[key] = async (input, init) => {
              const response = await transport(new Request(input, init));
              if (!response || typeof response !== "object" || Array.isArray(response)
                || Object.keys(response).some(key => !["status", "headers", "body"].includes(key))
                || !Number.isInteger(response.status) || response.status < 200 || response.status > 599
                || typeof response.body !== "string" || Buffer.byteLength(response.body) > MAX_BYTES
                || !response.headers || typeof response.headers !== "object" || Array.isArray(response.headers)
                || Object.values(response.headers).some(value => typeof value !== "string")) throw failure("PythonHostPayloadInvalid");
              return new Response([204, 205, 304].includes(response.status) && response.body === "" ? null : response.body,
                { status: response.status, headers: response.headers });
            };
          }
          // Opening the shared ledger and validating the adapter are one owned
          // acquisition: a malformed tariff must not leak a database handle.
          if (options.tokenCost) {
            const { budget, counting, ...adapter } = options.tokenCost;
            const ledger = createSqliteProviderBudget(budget); resources.push(ledger);
            options.cost = { budget: ledger, ...createProviderTokenCostAdapter(adapter), ...(counting ? { counting } : {}) };
            delete options.tokenCost;
          }
          value = factory.create(options);
        } catch (error) { for (const resource of resources) resource.close(); throw error; }
        const handle = ++sequence;
        objects.set(handle, { value, methods: factory.methods, resources }); result = handle;
      } else if (message.method === "release") {
        const item = objects.get(message.handle);
        if (!item) throw failure("InvalidDecisionProviderOptions");
        item.value.close?.(); for (const resource of item.resources) resource.close();
        objects.delete(message.handle); result = null;
      } else if (message.method === "call") {
        const item = objects.get(message.handle), args = decode(message.args);
        if (!item || !item.methods.includes(message.operation) || !Array.isArray(args)) throw failure("InvalidDecisionProviderOptions");
        if (message.operation === "invoke") {
          // The execution hook is transported separately from the model request.
          const execution = message.execution ? { recordProviderCost: value => callback("cost", [value]) } : undefined;
          result = await item.value(...args, ...(execution ? [execution] : []));
        } else result = await item.value[message.operation](...args);
      } else throw failure("PythonHostPayloadInvalid");
      write({ id, result: encode(result) });
    } catch (error) {
      const code = typeof error?.code === "string" && /^[A-Za-z][A-Za-z0-9]{0,100}$/.test(error.code) ? error.code : "PythonHostUnavailable";
      write({ id, error: { code } });
    } finally { active.delete(id); }
  }
  await new Promise((resolveDone, reject) => {
    const finish = () => { close(); resolveDone(); };
    input.on("end", finish); input.on("error", error => { close(); reject(error); });
    output.on("error", finish);
    input.on("data", chunk => {
      try {
        buffer = Buffer.concat([buffer, chunk]); let end;
        while ((end = buffer.indexOf(10)) !== -1) {
          if (end > MAX_BYTES) throw failure("PythonHostPayloadInvalid");
          const message = JSON.parse(buffer.subarray(0, end).toString("utf8")); buffer = buffer.subarray(end + 1);
          if (message.callback_reply !== undefined) {
            const item = callbacks.get(message.callback_reply);
            if (!item) throw failure("PythonHostPayloadInvalid");
            callbacks.delete(message.callback_reply); clearTimeout(item.timer);
            if (message.error) item.reject(failure(message.error.code ?? "PythonHostUnavailable")); else item.resolve(decode(message.result));
          } else {
            if (!Number.isSafeInteger(message.id) || active.has(message.id) || active.size >= 32) throw failure("PythonHostPayloadInvalid");
            active.add(message.id);
            scope.run(message.id, () => perform(message)).catch(() => { close(); input.destroy(); });
          }
        }
        if (buffer.length > MAX_BYTES) throw failure("PythonHostPayloadInvalid");
      } catch { close(); input.destroy(); resolveDone(); }
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await servePythonSdk();
  // Dedicated worker: EOF is terminal, even while an HTTP peer has not replied.
  // Pending SQLite reservations are retained, never reclassified as free calls.
  process.exit(0);
}
