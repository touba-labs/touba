import { parse } from "acorn";
import { isBuiltin } from "node:module";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

// Resolve literal local ESM/CJS imports without evaluating the handler. Bare
// packages remain governed by their dependency lock, not guessed from a name.
export function localImportClosure(entrypoint, { maxFiles = 4096, maxBytes = 16 * 1024 * 1024 } = {}) {
  const visited = new Set(), files = []; let bytes = 0;
  function visit(file) {
    file = resolve(file);
    const physical = realpathSync(file);
    if (visited.has(physical)) return;
    visited.add(physical); files.push(file);
    if (visited.size > maxFiles || !statSync(file).isFile()) fail("HandlerImportInvalid", "handler import closure exceeds its file limit or contains a non-file");
    const content = readFileSync(file); bytes += content.length;
    if (bytes > maxBytes) fail("HandlerImportInvalid", "handler import closure exceeds its byte limit");
    if (!/\.(?:mjs|cjs|js)$/.test(file)) return;
    let tree;
    try { tree = parse(content.toString("utf8"), { ecmaVersion: "latest", sourceType: extname(file) === ".cjs" ? "commonjs" : "module" }); }
    catch { fail("HandlerImportInvalid", "handler JavaScript cannot be parsed; build it before locking its imports"); }
    function dependency(node, cjs = false) {
      if (node?.type !== "Literal" || typeof node.value !== "string") fail("HandlerImportDynamic", "computed handler imports cannot be locked automatically; bundle the handler into explicit local modules");
      const specifier = node.value;
      if (isBuiltin(specifier)) return;
      if (!specifier.startsWith(".") && !isAbsolute(specifier)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) fail("HandlerImportInvalid", "URL handler imports are not a local lockable dependency");
        return;
      }
      const base = resolve(dirname(file), specifier);
      const candidates = cjs ? [base, base + ".js", base + ".json", base + ".node", join(base, "index.js"), join(base, "index.json")] : [base];
      const target = candidates.find(path => existsSync(path) && statSync(path).isFile());
      if (!target) fail("HandlerImportMissing", "a literal local handler import is missing");
      visit(target);
    }
    function walk(node) {
      if (!node || typeof node !== "object") return;
      if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source) dependency(node.source);
      if (node.type === "ImportExpression") dependency(node.source);
      if (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "require") dependency(node.arguments[0], true);
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === "object") walk(value);
      }
    }
    walk(tree);
  }
  visit(entrypoint);
  return files.sort();
}
