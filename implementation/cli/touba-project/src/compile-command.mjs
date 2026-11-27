import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotCompilerPackageInterfaces } from "./compiler-package-interfaces.mjs";
import { runPassthrough } from "./passthrough.mjs";
import { compilerInputsForFile } from "./project.mjs";

const implementationRoot = fileURLToPath(new URL("../../..", import.meta.url));

export async function compileCommand(rawArgs, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const options = parseCompileOptions(rawArgs);
  if (options.help === true) {
    return { text: compileUsage(), exitCode: 0 };
  }
  if (options.out !== undefined && options.stdout === true) {
    throw new Error("touba compile cannot combine --out and --stdout");
  }
  let sourceIndex = -1;
  let packageInterfaces = [];
  for (let index = 0; index < options.compilerArgs.length; index += 1) {
    const arg = options.compilerArgs[index];
    if (["--source-root", "--module-source", "--package-interfaces"].includes(arg)) { index += 1; continue; }
    // Leave unknown options to the selected compiler, including an explicit
    // host compiler override whose command-line contract may differ.
    if (arg.startsWith("-") && !["--json", "--stdin", "--module"].includes(arg)) break;
    if (!arg.startsWith("-")) { sourceIndex = index; break; }
  }
  if (sourceIndex !== -1) {
    const source = resolve(options.compilerArgs[sourceIndex]);
    const context = compilerInputsForFile(source);
    if (context.diagnostics.some(diagnostic => diagnostic.severity === "error")) {
      if (options.compilerArgs.includes("--json")) stdout.write(JSON.stringify({ ok: false, air: null, diagnostics: context.diagnostics }) + "\n");
      else for (const diagnostic of context.diagnostics) stderr.write(`${diagnostic.code}: ${diagnostic.message}\n`);
      return { passthrough: true, exitCode: 1 };
    }
    packageInterfaces = context.packageInterfaces;
    options.compilerArgs[sourceIndex] = source;
    options.compilerArgs.push(...context.sourceRoots.flatMap(root => ["--source-root", root]),
      ...context.moduleSourcePaths.flatMap(path => ["--module-source", path]));
  }
  if (options.out === undefined && options.stdout !== true) {
    throw new Error("touba compile requires an explicit output mode: use --out <program.air.json> or --stdout");
  }

  if (options.out !== undefined) assertCompileOutputPath(options.out);
  const snapshot = snapshotCompilerPackageInterfaces(packageInterfaces);
  let result;
  try {
    const args = [...options.compilerArgs, ...snapshot.args];
    if (options.stdout === true) return await runCompilerPassthrough(args);
    const compiler = compileCommandSpec(args);
    result = spawnSync(compiler.command, compiler.args, {
      cwd: compiler.cwd ?? process.cwd(),
      env: process.env,
      stdio: ["inherit", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } finally {
    snapshot.dispose();
  }

  if (result.error) {
    throw result.error;
  }
  if (result.stderr) {
    stderr.write(result.stderr);
  }
  if ((result.status ?? 1) !== 0) {
    return { passthrough: true, exitCode: result.status ?? 1 };
  }

  assertAirJsonOutput(result.stdout ?? "");
  const outputPath = resolve(options.out);
  mkdirSync(dirname(outputPath), { recursive: true });
  // Stage beside the destination so concurrent readers never see truncated AIR.
  const staged = mkdtempSync(join(dirname(outputPath), ".touba-compile-"));
  try {
    const candidate = join(staged, "output.air.json");
    writeFileSync(candidate, ensureTrailingNewline(result.stdout ?? ""), {
      encoding: "utf8", mode: existsSync(outputPath) ? statSync(outputPath).mode & 0o777 : 0o666,
    });
    assertCompileOutputPath(outputPath);
    renameSync(candidate, outputPath);
  } finally { rmSync(staged, { recursive: true, force: true }); }
  return {
    text: `wrote AIR JSON ${outputPath}`,
    exitCode: 0,
  };
}

function runCompilerPassthrough(rawArgs) {
  const compiler = compileCommandSpec(rawArgs);
  return runPassthrough(compiler.command, compiler.args, { cwd: compiler.cwd });
}

function compileCommandSpec(rawArgs) {
  if (process.env.TOUBA_COMPILE_BIN) {
    return { command: process.env.TOUBA_COMPILE_BIN, args: rawArgs };
  }

  const localCompiler = newestExistingCompiler([
    join(implementationRoot, "..", "bin", process.platform === "win32" ? "touba-compile.exe" : "touba-compile"),
    join(implementationRoot, "target", "release", process.platform === "win32" ? "touba-compile.exe" : "touba-compile"),
    join(implementationRoot, "target", "debug", process.platform === "win32" ? "touba-compile.exe" : "touba-compile"),
  ]);
  if (existsSync(localCompiler)) {
    return { command: localCompiler, args: rawArgs };
  }

  return {
    command: process.env.CARGO ?? "cargo",
    args: [
      "run",
      "-q",
      "-p",
      "touba-cli",
      "--bin",
      "touba-compile",
      "--",
      ...rawArgs,
    ],
    cwd: implementationRoot,
  };
}

function parseCompileOptions(rawArgs) {
  const compilerArgs = [];
  let out;
  let stdout = false;
  let help = false;
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--out" || arg === "-o") {
      if (out !== undefined) {
        throw new Error("touba compile accepts only one --out");
      }
      out = rawArgs[++index];
      if (out === undefined || out.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
    } else if (arg.startsWith("--out=")) {
      if (out !== undefined) {
        throw new Error("touba compile accepts only one --out");
      }
      out = arg.slice("--out=".length);
      if (out.length === 0) {
        throw new Error("--out requires a value");
      }
    } else if (arg === "--stdout") {
      stdout = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else {
      compilerArgs.push(arg);
    }
  }
  return { compilerArgs, out, stdout, help };
}

function assertCompileOutputPath(path) {
  if (!path.endsWith(".air.json")) {
    throw new Error("touba compile --out requires a .air.json output path");
  }
  if (existsSync(path) && statSync(path).isDirectory()) {
    throw new Error("touba compile --out must target a file, not a directory");
  }
  try {
    if (!lstatSync(path).isFile()) throw new Error("touba compile --out must target a regular file, not a symbolic link or special file");
    accessSync(path, constants.W_OK);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}

function assertAirJsonOutput(text) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error("compiler output is not valid JSON; refusing to write --out");
  }
  if (!document || typeof document !== "object" || typeof document.air_schema_version !== "string") {
    throw new Error("compiler output is not an AIR JSON document; refusing to write --out");
  }
}

function ensureTrailingNewline(text) {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function compileUsage() {
  return [
    "Usage: touba compile <source.tb> --out <program.air.json>",
    "       touba compile <source.tb> --stdout",
    "",
    "Use --out for normal project work. It validates the .air.json extension and AIR JSON output before writing.",
    "Use --stdout only for explicit pipelines or advanced tooling.",
    "Inside a project, installed package imports are resolved and checked automatically.",
  ].join("\n");
}

function newestExistingCompiler(paths) {
  let selected = null;
  for (const path of paths) {
    if (!existsSync(path)) {
      continue;
    }
    const stat = statSync(path);
    if (!selected || stat.mtimeMs > selected.mtimeMs) {
      selected = { path, mtimeMs: stat.mtimeMs };
    }
  }
  return selected?.path ?? paths[0];
}
