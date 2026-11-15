import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { publishPackage } from "./package-publish.mjs";
import { publishRemotePackage } from "./package-publish-remote.mjs";
import { checkoutPackageDraft, submitPackageDraft } from "./package-drafts.mjs";
import { submitPackageSuite } from './package-suite.mjs';
import { submitCiPackage } from "./package-ci.mjs";
import { requestPackagePublication } from "./package-automation.mjs";
import { authorIdentity, newPackage, testPackage, versionPackage } from "./package-author.mjs";
import { configureRegistry, registryOptions } from './package-registry-config.mjs';
import { authorizeRegistry, publicationUrl } from './package-identity.mjs';
import { packageSessionNotice, withPackageLocale } from './package-diagnostics.mjs';
import { auditPackageStatus } from './package-status.mjs';
import { addPackage, addRegistryPackage, reviewPackageUpdate, updateRegistryPackage, checkPackage, checkPackageArchive, packPackage, removePackage } from "./packages.mjs";
import { PACKAGE_MANIFEST, PACKAGE_NAME, packageError } from "./package-contract.mjs";
import { findPackageWorkspace, readPackageWorkspace, verifyInstalledPackages } from "./package-store.mjs";

export const PACKAGE_USAGE = `Usage: touba package new [name] [--org <organization>] [--description <text>] [--publisher <text>] [--license <license>] [--version <version>] [--lang fr|en] [--context] [--yes] [--root <parent>]
       touba package registry <URL> --trust <verified-keys.json> [--root <workspace>]
       touba package login [--registry <URL>] [--read] [--no-browser] [--root <workspace>]
       touba package logout [--registry <URL>] [--read] [--root <workspace>]
       touba package check [directory|archive.tar.gz] [--publishing] [--root <workspace>]
       touba package test [directory] [--env <NAME> ...] [--root <author>]
       touba package version [patch|minor|major|version] [--root <author>]
       touba package pack [directory] [--output <archive.tar.gz>] [--root <author>]
       touba package publish [directory] --registry <directory|URL> [--no-browser] [--root <author>]
       touba package checkout <draft-id> --registry <URL> [--no-browser] [--root <parent>]
       touba package submit [directory] [--registry <URL>] [--draft <draft-id> | --presentation-from <publication-id>] [--no-browser] [--root <author>]
       touba package submit [directory] --ci <authorization-id> --registry <URL> [--root <author>]
       touba package submit [directory] --automation --registry <URL> --request-id <unique-id> [--draft <id>]
       touba package submit-suite <suite.json> --registry <URL> [--max-packages <1..32>] [--max-bytes <bytes>] [--timeout-seconds <1..1800>] [--no-browser] [--root <directory>]
       touba package checkout <draft-id> --automation --registry <URL> [--root <parent>]
       touba package request-publication <draft-id> --automation --registry <URL> --revision <number> --request-id <unique-id>
       touba package add <name|directory|archive.tar.gz> [--root <workspace>]
       touba package add <name>@<version> --registry <directory|URL> [--trust <keys.json>] [--allow-draft] [--no-browser] [--root <workspace>]
       touba package list [--status] [--root <workspace>]
       touba package audit [--offline] [--registry <URL>] [--trust <keys.json>] [--no-browser] [--root <workspace>]
       touba package update <directory|archive.tar.gz|name@version> [--registry <URL>] [--allow-downgrade] [--accept <review_digest>] [--root <workspace>]
       touba package remove <name> [--root <workspace>]
All commands support --json. new and version ask questions only in an interactive terminal.
Author and private-read operations support --session-only to avoid saving a credential.
Installation registry and trust options may be omitted after package registry configuration.
Every package command accepts --lang fr|en for messages and browser authentication.
Creation is offline. Package tests execute reviewed host code, never during check/add/pack.`;

function parse(args) {
  const [action, ...rest] = args;
  const allowed = { new: ["context", "yes", "root", "org", "description", "publisher", "license", "version"], check: ["root", "publishing"], test: ["root", "env"], version: ["root"], pack: ["root", "output"], publish: ["root", "registry", "no-browser"], checkout: ["root", "registry", "no-browser"], submit: ["root", "registry", "draft", "no-browser", "ci"], add: ["root", "registry", "trust", "version", "allow-draft", "no-browser"], list: ["root"], remove: ["root"] };
  allowed.checkout.push("automation");
  allowed['submit-suite'] = ['root', 'registry', 'no-browser', 'session-only', 'max-packages', 'max-bytes', 'timeout-seconds'];
  allowed.new.push("lang");
  allowed.registry = ["root", "trust"];
  allowed.login = ['registry', 'root', 'no-browser', 'read', 'session-only'];
  allowed.logout = ['registry', 'root', 'read'];
  for (const key of ['checkout', 'submit', 'publish', 'add']) allowed[key].push('session-only');
  allowed.update = [...allowed.add, 'accept', 'allow-downgrade'];
  allowed.audit = ['root', 'registry', 'trust', 'no-browser', 'session-only', 'offline'];
  allowed.list.push('status');
  allowed.submit.push("automation", "request-id", "presentation-from");
  allowed["request-publication"] = ["automation", "registry", "revision", "request-id"];
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
    if (!["json", "lang"].includes(key) && !allowed[action].includes(key)) throw packageError("PackageOptionInvalid", `option not valid for package ${action}: ${arg}`);
    if (Object.hasOwn(options, key) && key !== "env") throw packageError("PackageOptionInvalid", `duplicate option ${arg}`);
    if (["json", "context", "yes", "publishing", "allow-draft", "no-browser", "automation", "read", "session-only", "offline", "status", "allow-downgrade"].includes(key)) options[key] = true;
    else {
      if (!rest[i + 1] || rest[i + 1].startsWith("--")) throw packageError("PackageOptionInvalid", `missing value for ${arg}`);
      const value = rest[++i];
      if (key === "env") { options.env ??= []; options.env.push(value); }
      else options[key] = value;
    }
  }
  if (['list', 'audit'].includes(action) && target !== undefined) throw packageError("PackageOptionInvalid", `package ${action} does not take a target`);
  if (["add", "update", "remove", "checkout"].includes(action) && !target) throw packageError("PackageTargetRequired", `package ${action} needs a target`);
  if (["add", "update"].includes(action) && target.includes("@") && !target.includes("/") && !target.includes("\\")) {
    if (options.version || target.split("@").length !== 2 || target.endsWith("@")) throw packageError("PackageOptionInvalid", "specify exactly one nonempty version");
    [target, options.version] = target.split("@");
  }
  if ((options.automation && (options.ci || options['no-browser'] || options['session-only'])) || (options.ci && options['session-only'])) throw packageError("PackageOptionInvalid", "choose automation, CI, or interactive identity explicitly");
  if (options['request-id'] && !options.automation) throw packageError("PackageOptionInvalid", "--request-id requires --automation");
  if (options['presentation-from'] && (options.ci || options.automation || options.draft)) throw packageError("PackageOptionInvalid", "presentation reuse requires an interactive new-version submission");
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
  const parsed = parse(args);
  return withPackageLocale(parsed.options.lang, () => executePackageCommand(parsed));
}

async function executePackageCommand({ action, target, options }) {
  if (action === 'audit' || action === 'list' && options.status) {
    Object.assign(options, registryOptions(options));
    if (!options.registry) throw packageError('RegistryConfigurationRequired', 'select a registry explicitly or configure this workspace');
  }
  if (['add', 'update'].includes(action) && (options.version || options.registry || (PACKAGE_NAME.test(target ?? '') && !existsSync(resolve(target))))) {
    Object.assign(options, registryOptions(options));
    if (options.version && !options.registry) throw packageError('RegistryConfigurationRequired', 'configure this project with touba package registry <url> --trust <verified-file>, or pass --registry and --trust');
  }
  if (options['allow-draft'] && !options.registry) throw packageError('PackageOptionInvalid', '--allow-draft requires a registry');
  let report;
  if (action === 'login' || action === 'logout') {
    if (target) throw packageError('PackageOptionInvalid', 'use --registry to select the registry');
    const registry = publicationUrl(options.registry ?? registryOptions(options).registry);
    const identity = await authorizeRegistry(registry, { access: options.read ? 'read' : 'publication', forceLogin: action === 'login', logout: action === 'logout', noBrowser: options['no-browser'] === true, sessionOnly: options['session-only'] === true });
    await identity.revoke();
    report = { command: `package ${action}`, status: 'success', registry,
      notes: [packageSessionNotice({ logout: action === 'logout', persistent: identity.persistent, read: options.read,
        minutes: Math.floor((identity.session_max_age_seconds ?? 600) / 60) })] };
  }
  else if (action === 'registry') report = configureRegistry(target, options);
  else if (action === 'audit') report = await auditPackageStatus(options);
  else if (action === 'list' && options.status) report = { ...await auditPackageStatus({ ...options, offline: true }), command: 'package list' };
  else if (action === "new") report = await create(target, options);
  else if (action === "request-publication") report = await requestPackagePublication(target, options);
  else if (action === "checkout") report = await checkoutPackageDraft(target, options);
  else if (action === "submit") report = await (options.ci ? submitCiPackage : submitPackageDraft)(target, options);
  else if (action === 'submit-suite') report = await submitPackageSuite(target, options);
  else if (action === "version") {
    const root = findPackageWorkspace(options.root, { author: true });
    let next = target;
    if (!next) {
      if (options.json) throw packageError("PackageInputRequired", "provide patch, minor, major or an exact version with --json");
      const current = JSON.parse(readFileSync(join(root, PACKAGE_MANIFEST))).version;
      next = await questionnaire(ask => ask(`Current ${current}. Choose patch, minor, major or an exact version`));
    }
    report = versionPackage(next, { root });
  } else if (action === 'update') report = await (options.registry ? updateRegistryPackage : reviewPackageUpdate)(target, options);
  else if (action === "list" || (action === "check" && !target && !existsSync(join(findPackageWorkspace(options.root), PACKAGE_MANIFEST)))) {
    const root = findPackageWorkspace(options.root), workspace = readPackageWorkspace(root);
    const lock = verifyInstalledPackages(root, workspace.records);
    const packages = [];
    for (const record of workspace.records) {
      const checked = await checkPackage(join(root, record.manifest), { ...options, projectRoot: root });
      packages.push({ name: checked.package, version: checked.version, installed: lock.packages.some(pkg => pkg.name === checked.package) });
    }
    report = { status: "success", command: `package ${action}`, packages, notes: packages.length ? [] : ["No registered packages."] };
  } else report = await ({ check: target?.endsWith(".tar.gz") ? checkPackageArchive : checkPackage, test: testPackage, pack: packPackage, publish: /^https?:\/\//.test(options.registry ?? '') ? publishRemotePackage : publishPackage, add: options.registry ? addRegistryPackage : addPackage, remove: removePackage })[action](target, options);
  delete report.closure;
  const text = options.json ? JSON.stringify(report, null, 2) : [report.command + ": " + report.status, report.path ?? report.output ?? report.package ?? "", ...(report.previous ? [`${report.previous} -> ${report.version}`] : []), ...(report.notes ?? []), ...(Array.isArray(report.packages) ? report.packages.map(pkg => `${pkg.name}@${pkg.version}`) : []), report.stdout ?? "", report.stderr ?? ""].filter(Boolean).join("\n");
  return { text, exitCode: report.exitCode ?? (report.status === "success" ? 0 : 1) };
}
