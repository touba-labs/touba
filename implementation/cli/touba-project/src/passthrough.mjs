import { spawn } from "node:child_process";
import { constants } from "node:os";

// Do not block the event loop while a foreground command is running: a signal
// sent to the CLI's PID must reach its direct child, not orphan that child.
export async function runPassthrough(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    // Keep terminal input and stream arbitrarily large output without buffering.
    stdio: "inherit",
  });
  const signals = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  const forwarders = signals.map(signal => [signal, () => { child.kill(signal); }]);
  for (const [signal, forward] of forwarders) process.on(signal, forward);
  try {
    const [code, signal] = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve([code, signal]));
    });
    return {
      passthrough: true,
      exitCode: code ?? (128 + constants.signals[signal]),
      signal,
    };
  } finally {
    for (const [signal, forward] of forwarders) process.off(signal, forward);
  }
}
