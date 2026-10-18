import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { publishPackage } from "./package-publish.mjs";
import { authorIdentity, newPackage, testPackage, versionPackage } from "./package-author.mjs";
import { addPackage, addRegistryPackage, checkPackage, packPackage, removePackage } from "./packages.mjs";
import { PACKAGE_MANIFEST, PACKAGE_NAME, packageError } from "./package-contract.mjs";
import { findPackageWorkspace, readPackageWorkspace, verifyInstalledPackages } from "./package-store.mjs";

export const PACKAGE_USAGE = `Usage: touba package new [name] [--org <organization>] [--description <text>] [--publisher <text>] [--license <license>] [--version <version>] [--context] [--yes] [--root <parent>]
       touba package check [directory] [--publishing] [--root <workspace>]
       touba package test [directory] [--env <NAME> ...] [--root <author>]
       touba package version [patch|minor|major|version] [--root <author>]
       touba package pack [directory] [--output <archive.tar.gz>] [--root <author>]
       touba package publish [directory] --registry <local-directory> [--root <author>]
       touba package add <name|directory|archive.tar.gz> [--root <workspace>]
       touba package add <name>@<version> --registry <directory|URL> [--allow-draft] [--root <workspace>]
       touba package list [--root <workspace>]
       touba package remove <name> [--root <workspace>]
All commands support --json. new and version ask questions only in an interactive terminal.
Creation is offline. Package tests execute reviewed host code, never during check/add/pack.`;

function parse(args) {
  const [action, ...rest] = args;
  const allowed = { new: ["context", "yes", "root", "org", "description", "publisher", "license", "version"], check: ["root", "publishing"], test: ["root", "env"], version: ["root"], pack: ["root", "output"], publish: ["root", "registry"], add: ["root", "registry", "version", "allow-draft"], list: ["root"], remove: ["root"] };
  if (!Object.hasOwn(allowed, action)) throw packageError("PackageCommandInvalid", PACKAGE_USAGE);
  let target;
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      if (target !== undefined) throw packageError("PackageOptionInvalid", "only one target is accepted");
      target = arg; continue;
    }
    const key = arg.slice(2);
    if (key !== "json" && !allowed[action].includes(key)) throw packageError("PackageOptionInvalid", `option not valid for package ${action}: ${arg}`);
    if (Object.hasOwn(options, key) && key !== "env") throw packageError("PackageOptionInvalid", `duplicate option ${arg}`);
    if (["json", "context", "yes", "publishing", "allow-draft"].includes(key)) options[key] = true;
    else {
      if (!rest[i + 1] || rest[i + 1].startsWith("--")) throw packageError("PackageOptionInvalid", `missing value for ${arg}`);
      const value = rest[++i];
      if (key === "env") { options.env ??= []; options.env.push(value); }
      else options[key] = value;
    }
  }
  if (action === "list" && target !== undefined) throw packageError("PackageOptionInvalid", "package list does not take a target");
  if (["add", "remove"].includes(action) && !target) throw packageError("PackageTargetRequired", `package ${action} needs a target`);
  if (action === "add" && target.includes("@") && !target.includes("/") && !target.includes("\\")) {
    if (options.version || target.split("@").length !== 2 || target.endsWith("@")) throw packageError("PackageOptionInvalid", "specify exactly one nonempty version");
    [target, options.version] = target.split("@");
  }
  if (action === "add" && options.version && !options.registry) throw packageError("PackageOptionInvalid", "a version selection requires --registry; local content has its own exact version");
  if (options["allow-draft"] && !options.registry) throw packageError("PackageOptionInvalid", "--allow-draft requires --registry");
  return { action, target, options };
}

async function questionnaire(callback) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw packageError("PackageInputRequired", "provide the missing arguments; interactive input requires a terminal");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const abort = new AbortController();
  const cancel = () => abort.abort();
  rl.on("SIGINT", cancel); rl.on("close", cancel);
  const ask = async (label, fallback = "") => {
    try { return (await rl.question(`${label}${fallback ? ` [${fallback}]` : ""}: `, { signal: abort.signal })).trim() || fallback; }
    catch { throw packageError("PackageCreationCancelled", "cancelled; no files were changed"); }
  };
  try { return await callback(ask); } finally { rl.close(); }
}

async function create(target, options) {
  const interactive = process.stdin.isTTY && process.stderr.isTTY && !options.yes && !options.json;
  if (interactive) {
    const cancelled = await questionnaire(async ask => {
      if (!target || !PACKAGE_NAME.test(target)) {
        options.org ??= await ask("Organization");
        target ??= await ask("Package name");
      }
      options.description ??= await ask("Description");
      options.publisher ??= options.org ?? await ask("Author or organization");
      options.version ??= await ask("Initial version", "0.1.0");
      options.license ??= await ask("License (leave blank to choose later)");
      if (!options.context) {
        const content = await ask("Initial content: executable or context", "executable");
        if (!["executable", "context"].includes(content)) throw packageError("PackageInputInvalid", "choose executable or context; nothing created");
        options.context = content === "context";
      }
      const name = authorIdentity(target, options.org);
      return !/^(y|yes)$/i.test(await ask(`Create ${name} in ${name.split(".").at(-1)}/? yes/no`, "no"));
    });
    if (cancelled) return { status: "cancelled", command: "package new", notes: ["Nothing created."], exitCode: 1 };
  }
  return newPackage(target, options);
}

export async function packageCommand(args) {
  if (!args.length || args.includes("--help") || args[0] === "-h") return { text: PACKAGE_USAGE, exitCode: 0 };
  const { action, target, options } = parse(args);
  let report;
  if (action === "new") report = await create(target, options);
  else if (action === "version") {
    const root = findPackageWorkspace(options.root, { author: true });
    let next = target;
    if (!next) {
      if (options.json) throw packageError("PackageInputRequired", "provide patch, minor, major or an exact version with --json");
      const current = JSON.parse(readFileSync(join(root, PACKAGE_MANIFEST))).version;
      next = await questionnaire(ask => ask(`Current ${current}. Choose patch, minor, major or an exact version`));
    }
    report = versionPackage(next, { root });
  } else if (action === "list" || (action === "check" && !target && !existsSync(join(findPackageWorkspace(options.root), PACKAGE_MANIFEST)))) {
    const root = findPackageWorkspace(options.root), workspace = readPackageWorkspace(root);
    const lock = verifyInstalledPackages(root, workspace.records);
    const packages = [];
    for (const record of workspace.records) {
      const checked = await checkPackage(join(root, record.manifest), { ...options, projectRoot: root });
      packages.push({ name: checked.package, version: checked.version, installed: lock.packages.some(pkg => pkg.name === checked.package) });
    }
    report = { status: "success", command: `package ${action}`, packages, notes: packages.length ? [] : ["No registered packages."] };
  } else report = await ({ check: checkPackage, test: testPackage, pack: packPackage, publish: publishPackage, add: options.registry ? addRegistryPackage : addPackage, remove: removePackage })[action](target, options);
  delete report.closure;
  const text = options.json ? JSON.stringify(report, null, 2) : [report.command + ": " + report.status, report.path ?? report.output ?? report.package ?? "", ...(report.previous ? [`${report.previous} -> ${report.version}`] : []), ...(report.notes ?? []), ...(Array.isArray(report.packages) ? report.packages.map(pkg => `${pkg.name}@${pkg.version}`) : []), report.stdout ?? "", report.stderr ?? ""].filter(Boolean).join("\n");
  return { text, exitCode: report.exitCode ?? (report.status === "success" ? 0 : 1) };
}
