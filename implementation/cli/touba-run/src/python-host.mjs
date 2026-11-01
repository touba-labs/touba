import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { providerDiagnosticDetails } from "../../../runtime/touba-handler-sdk/src/provider-diagnostics.mjs";
import { openLocalHandlerDiagnostics, validatedHandlerDiagnostic } from "../../../runtime/touba-runtime/src/handler-diagnostics.mjs";

const MAX_BYTES = 8 * 1024 * 1024;
const service = fileURLToPath(new URL("../../../runtime/touba-handler-sdk/src/python-service.mjs", import.meta.url));
const failure = (code, details) => Object.assign(new Error("Python host transport failed; inspect the trusted host locally"),
  { name: "ToubaAgentDecisionProviderError", code, details: providerDiagnosticDetails(details) });

function interpreter(filename) {
  if (process.env.TOUBA_HOST_PYTHON) return process.env.TOUBA_HOST_PYTHON;
  for (const start of [dirname(filename), process.cwd()]) {
    for (let dir = start; ; dir = dirname(dir)) {
      const candidate = join(dir, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
      if (existsSync(candidate)) return candidate;
      if (dirname(dir) === dir) break;
    }
  }
  throw new Error("Install the Python SDK with touba sdk install python, or set TOUBA_HOST_PYTHON to its interpreter");
}

/** Trusted host modules only. No model-supplied path, code or identity. */
export async function loadPythonHost(filename, options = {}) {
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) throw new TypeError("timeoutMs must be a positive safe integer");
  filename = resolve(filename);
  const python = interpreter(filename);
  const diagnosticPath = options.diagnosticsPath ?? process.env.TOUBA_PYTHON_HOST_DIAGNOSTICS;
  const diagnostics = diagnosticPath ? openLocalHandlerDiagnostics(resolve(diagnosticPath)) : null;
  const sources = [{ path: filename, index: 0 }];
  const child = spawn(python, ["-I", "-B", "-m", "touba_sdk._host", filename], {
    stdio: ["pipe", "pipe", "pipe", diagnostics ? "pipe" : "ignore"], windowsHide: true,
    env: { ...process.env, PYTHONUNBUFFERED: "1", TOUBA_SDK_SERVICE_COMMAND: JSON.stringify([process.execPath, service]),
      TOUBA_LOCAL_DIAGNOSTIC_FD: diagnostics ? "3" : "", TOUBA_LOCAL_DIAGNOSTIC_SOURCES: JSON.stringify(sources) },
  });
  let diagnosticBuffer = "", diagnosticBytes = 0;
  child.stdio[3]?.on("data", chunk => {
    diagnosticBytes += chunk.length;
    if (diagnosticBytes > 65536) { diagnostics.markIncomplete(); return; }
    diagnosticBuffer += chunk.toString("utf8");
    let end;
    while ((end = diagnosticBuffer.indexOf("\n")) >= 0) {
      const value = validatedHandlerDiagnostic(diagnosticBuffer.slice(0, end), sources);
      diagnosticBuffer = diagnosticBuffer.slice(end + 1);
      if (value) diagnostics.record({ kind: "python_host", ...value }); else diagnostics.markIncomplete();
    }
  });
  child.once("close", () => diagnostics?.close());
  let buffer = Buffer.alloc(0), stderrBytes = 0, nextId = 0, closed = false;
  const pending = new Map();
  const send = value => {
    const data = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(data) > MAX_BYTES || closed) throw failure("PythonHostPayloadInvalid");
    child.stdin.write(data);
  };
  const stop = (code = "PythonHostUnavailable") => {
    if (closed) return;
    closed = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.cleanup?.(); item.reject(failure(code)); }
    pending.clear(); child.stdin.end();
    // The host exits on stdin EOF and closes its provider backend. Bound teardown.
    const timer = setTimeout(() => child.kill("SIGKILL"), 1000); timer.unref();
    child.once("exit", () => clearTimeout(timer));
  };
  child.on("error", () => stop()); child.on("exit", () => stop());
  child.stdin.on("error", () => stop());
  child.stderr.on("data", data => { stderrBytes += data.length; if (stderrBytes > MAX_BYTES) stop("PythonHostPayloadInvalid"); });
  child.stdout.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    let end;
    while ((end = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
      if (line.length > MAX_BYTES) { stop("PythonHostPayloadInvalid"); return; }
      try {
        const value = JSON.parse(line.toString("utf8")), entry = pending.get(value.id);
        if (!entry || value.protocol !== "touba-python-host-v1") throw new Error();
        if (["provider_cost", "provider_metadata"].includes(value.event)) {
          const observer = value.event === "provider_cost" ? entry.execution?.recordProviderCost : entry.execution?.recordProviderMetadata;
          const accepted = observer?.(value.value) ?? true;
          send({ protocol: "touba-python-host-v1", event_reply: value.event_id, accepted });
        } else {
          pending.delete(value.id); clearTimeout(entry.timer); entry.cleanup?.();
          if (value.error) entry.reject(failure(/^[A-Za-z][A-Za-z0-9]{0,100}$/.test(value.error.code) ? value.error.code : "PythonHostUnavailable", value.error.details));
          else if (Object.hasOwn(value, "result")) entry.resolve(value.result);
          else throw new Error();
        }
      } catch { stop("PythonHostPayloadInvalid"); return; }
    }
    if (buffer.length > MAX_BYTES) stop("PythonHostPayloadInvalid");
  });
  function call(method, request = null, execution) {
    if (execution?.signal?.aborted) return Promise.reject(failure("ProviderRequestAborted"));
    if (closed || pending.size >= 32) return Promise.reject(failure("PythonHostUnavailable"));
    return new Promise((resolveCall, reject) => {
      const id = ++nextId, timer = setTimeout(() => stop("PythonHostTimeout"), options.timeoutMs ?? 120000);
      pending.set(id, { resolve: resolveCall, reject, timer, execution });
      const abort = () => stop("ProviderRequestAborted");
      execution?.signal?.addEventListener("abort", abort, { once: true });
      pending.get(id).cleanup = () => execution?.signal?.removeEventListener("abort", abort);
      try { send({ protocol: "touba-python-host-v1", id, method, request }); }
      catch (error) { pending.get(id)?.cleanup?.(); pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  try {
    const metadata = await call("describe");
    return { metadata, decide: (request, execution) => call("decide", request, execution),
      attest: request => call("attest", request), resolveInitiator: request => call("resolve_initiator", request), close: stop };
  } catch (error) { stop(); throw error; }
}
