import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";

// Resolve only the standard, explicit Python module invocation. No import,
// interpreter startup or ambient search-path discovery during lock creation.
export function pythonModuleEntrypoint(command, args, cwd, fs = { existsSync, statSync }) {
  if (!/^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(basename(command))) return null;
  if (!Array.isArray(args) || args[0] !== "-m") return null;
  const name = args[1];
  if (typeof name !== "string" || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(name)) {
    throw new Error("Python module handler needs an explicit dotted module name after -m");
  }
  const parts = name.split(".");
  for (let count = 1; count < parts.length; count++) {
    const init = join(cwd, ...parts.slice(0, count), "__init__.py");
    if (!fs.existsSync(init) || !fs.statSync(init).isFile()) throw new Error("Python module handler parents require local __init__.py files");
  }
  const base = join(cwd, ...parts);
  const isPackage = fs.existsSync(join(base, "__init__.py"));
  const entrypoint = isPackage ? join(base, "__main__.py") : `${base}.py`;
  if (!fs.existsSync(entrypoint) || !fs.statSync(entrypoint).isFile()) throw new Error("Python module handler is missing from its working directory");
  return { entrypoint, moduleName: isPackage ? `${name}.__main__` : name, searchRoot: cwd };
}
