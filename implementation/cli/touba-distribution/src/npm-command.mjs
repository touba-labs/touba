import { existsSync } from "node:fs";
import { win32 } from "node:path";

// Invoke npm's actual entry point on Windows: no batch launcher, shell, or
// string interpolation that could split a project/archive path with spaces.
export function npmCommand(args, { platform = process.platform, node = process.execPath, exists = existsSync } = {}) {
  if (platform !== "win32") return { command: "npm", args };
  const script = win32.join(win32.dirname(node), "node_modules", "npm", "bin", "npm-cli.js");
  if (!exists(script)) throw new Error("npm is missing from the Node.js installation: " + script);
  return { command: node, args: [script, ...args] };
}
