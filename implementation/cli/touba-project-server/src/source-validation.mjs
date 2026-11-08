import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { compilerInputsForFile } from "../../touba-project/src/project.mjs";

const cli = fileURLToPath(new URL("../../touba-project/src/main.mjs", import.meta.url));
const fail = message => { throw Object.assign(new Error(message), { code: "ToubaServeSourceContextInvalid" }); };

// Stage only compiler source inputs, never handlers, credentials or runtime
// state. Package admission is checked by the same discovery used by the CLI.
export function compileProposedSources({ projectRoot, targets }) {
  const root = realpathSync(projectRoot);
  const proposed = targets.filter(item => item.path.endsWith(".tb"));
  if (!proposed.length) return { air: null, diagnostics: [] };
  const stage = realpathSync(mkdtempSync(join(tmpdir(), "touba-source-review-")));
  const portable = text => String(text).split(`${stage}${sep}`).join("").split(`${root}${sep}`).join("");
  try {
    const confined = path => {
      const name = relative(root, resolve(root, path));
      if (!name || name === ".." || name.startsWith(`..${sep}`) || isAbsolute(name)) fail("source path must remain inside the project");
      return name;
    };
    const context = compilerInputsForFile(join(root, confined(proposed[0].path)));
    if (context.diagnostics.some(item => item.severity === "error")) {
      return { air: null, diagnostics: context.diagnostics.map(({ code, message, severity }) => ({ code, message: portable(message), severity })) };
    }
    const sources = new Map();
    let bytes = 0;
    const put = (path, content) => {
      if (sources.has(path)) bytes -= Buffer.byteLength(sources.get(path));
      bytes += Buffer.byteLength(content);
      sources.set(path, content);
      if (sources.size > 2000 || bytes > 32 * 1024 * 1024) fail("source review exceeds 2000 files or 32 MiB");
    };
    const walk = (path, depth = 0) => {
      if (depth > 32) fail("source directory nesting exceeds 32 levels");
      if (!existsSync(path)) return;
      const info = lstatSync(path);
      if (info.isSymbolicLink()) fail("source review does not follow symbolic links");
      if (info.isDirectory()) {
        for (const name of readdirSync(path)) if (!name.startsWith(".") && name !== "node_modules") walk(join(path, name), depth + 1);
      } else if (info.isFile() && path.endsWith(".tb")) {
        if (info.size > 4 * 1024 * 1024) fail("a source file exceeds 4 MiB");
        put(confined(path), readFileSync(path, "utf8"));
      }
    };
    for (const sourceRoot of context.sourceRoots) { confined(sourceRoot); walk(sourceRoot); }
    // A standalone module may precede touba init in a new project.
    if (!context.sourceRoots.length) walk(join(root, "src"));
    for (const target of proposed) {
      const name = confined(target.path);
      if (name.split(sep).some(part => [".git", ".touba", "packages", "node_modules"].includes(part))) fail("installed packages and private state are not editable source targets");
      put(name, target.content);
    }
    for (const [name, content] of sources) {
      mkdirSync(dirname(join(stage, name)), { recursive: true });
      writeFileSync(join(stage, name), content, "utf8");
    }
    const entry = confined(proposed[0].path);
    const loaded = new Set([
      ...[...sources.keys()].filter(name => !name.startsWith(`packages${sep}`)),
      ...context.moduleSourcePaths.map(path => confined(path)),
    ]);
    loaded.delete(entry);
    const result = spawnSync(process.execPath, [cli, "compile", join(stage, entry), "--stdout", "--json",
      ...context.sourceRoots.flatMap(path => ["--source-root", join(stage, confined(path))]),
      ...[...loaded].flatMap(name => ["--module-source", join(stage, name)]),
    ], { encoding: "utf8", cwd: stage, timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
    let report;
    try { report = JSON.parse(result.stdout); } catch { /* compiler start failure */ }
    if (report?.ok === true && report.air?.air_schema_version === "touba-air-v1" && result.status === 0) {
      return { air: report.air, diagnostics: [] };
    }
    const diagnostics = report?.diagnostics?.map(item => {
      const location = item.source_ref;
      const prefix = location ? `${portable(location.source_id)}:${location.start_line + 1}:${location.start_column + 1}: ` : "";
      return { code: item.code, severity: "error", message: `${prefix}${portable(item.message)}` };
    });
    return { air: null, diagnostics: diagnostics?.length ? diagnostics : [{
      code: "ToubaServeChangeToubaCompileFailed", severity: "error",
      message: result.error?.code === "ETIMEDOUT" ? "Project compilation exceeded 15 seconds" : portable(String(result.stderr || "Project compilation failed").trim()).slice(0, 2048),
    }] };
  } catch (error) {
    return { air: null, diagnostics: [{ code: error.code ?? "ToubaServeSourceContextInvalid", severity: "error", message: portable(error.message) }] };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
