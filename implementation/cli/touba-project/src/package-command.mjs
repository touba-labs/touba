import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { publishPackage } from "./package-publish.mjs";
import { publishRemotePackage } from "./package-publish-remote.mjs";
import { checkoutPackageDraft, submitPackageDraft } from "./package-drafts.mjs";
import { submitPackageSuite } from './package-suite.mjs';
import { updatePackageSet } from './package-update-set.mjs';
import { submitCiPackage } from "./package-ci.mjs";
import { requestPackagePublication } from "./package-automation.mjs";
import { authorIdentity, newPackage, testPackage, versionPackage } from "./package-author.mjs";
import { configureRegistry, registryOptions } from './package-registry-config.mjs';
import { authorizeRegistry, publicationUrl } from './package-identity.mjs';
import { packageLocale, packageSessionNotice, withPackageLocale } from './package-diagnostics.mjs';
import { auditPackageStatus } from './package-status.mjs';
import { packageReportText } from './package-text.mjs';
import { listRegistryPackages } from './registry.mjs';
import { createRegistryReader } from './package-fetch.mjs';
import { restorePackages } from './package-restore.mjs';
import { addPackage, addRegistryPackage, reviewPackageUpdate, updateRegistryPackage, checkPackage, checkPackageArchive, packPackage, removePackage } from "./packages.mjs";
import { PACKAGE_MANIFEST, PACKAGE_NAME, packageError } from "./package-contract.mjs";
import { findPackageWorkspace, inspectInstalledPackages, readPackageWorkspace, verifyInstalledPackages } from "./package-store.mjs";

export const PACKAGE_USAGE = `Usage: touba package new [name] [--org <organization>] [--description <text>] [--publisher <text>] [--license <license>] [--version <version>] [--lang fr|en] [--context] [--yes] [--root <parent>]
       touba package registry <URL> --trust <verified-keys.json> [--shared] [--root <workspace>]
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
       touba package add <name|directory|archive.tar.gz> [--accept <review_digest>] [--root <workspace>]
       touba package add <name>@<version> --registry <directory|URL> [--trust <keys.json>] [--accept <review_digest>] [--allow-draft] [--no-browser] [--root <workspace>]
       touba package list [--status] [--root <workspace>]
       touba package search [text] [--registry <URL>] [--trust <keys.json>] [--offset <number>] [--withdrawn] [--root <workspace>]
       touba package info <name> [--registry <URL>] [--trust <keys.json>] [--offset <number>] [--withdrawn] [--root <workspace>]
       touba package audit [--offline] [--registry <URL>] [--trust <keys.json>] [--no-browser] [--root <workspace>]
       touba package update <directory|archive.tar.gz|name@version> [--registry <URL>] [--allow-downgrade] [--accept <review_digest>] [--root <workspace>]
       touba package update-set <updates.json> [--accept <review_digest>] [--allow-downgrade] [--no-browser] [--session-only] [--root <workspace>]
       touba package remove <name> [--root <workspace>]
       touba package restore [name] [--registry <URL>] [--trust <keys.json>] [--no-browser] [--root <workspace>]
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
  allowed.registry = ["root", "trust", "shared"];
  allowed.login = ['registry', 'root', 'no-browser', 'read', 'session-only'];
  allowed.logout = ['registry', 'root', 'read'];
  for (const key of ['checkout', 'submit', 'publish', 'add']) allowed[key].push('session-only');
  allowed.add.push('accept');
  allowed.update = [...allowed.add, 'allow-downgrade'];
  allowed['update-set'] = ['root', 'accept', 'allow-downgrade', 'no-browser', 'session-only'];
  allowed.audit = ['root', 'registry', 'trust', 'no-browser', 'session-only', 'offline'];
  allowed.search = allowed.info = ['root', 'registry', 'trust', 'no-browser', 'session-only', 'offset', 'withdrawn'];
  allowed.restore = ['root', 'registry', 'trust', 'no-browser', 'session-only'];
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
    if (["json", "context", "yes", "publishing", "allow-draft", "no-browser", "automation", "read", "session-only", "offline", "status", "allow-downgrade", "withdrawn", "shared"].includes(key)) options[key] = true;
    else {
      if (!rest[i + 1] || rest[i + 1].startsWith("--")) throw packageError("PackageOptionInvalid", `missing value for ${arg}`);
      const value = rest[++i];
      if (key === "env") { options.env ??= []; options.env.push(value); }
      else options[key] = value;
    }
  }
  if (['list', 'audit'].includes(action) && target !== undefined) throw packageError("PackageOptionInvalid", `package ${action} does not take a target`);
  if (["add", "update", "update-set", "remove", "checkout"].includes(action) && !target) throw packageError("PackageTargetRequired", `package ${action} needs a target`);
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
  const fr = packageLocale() === 'fr';
  const interactive = process.stdin.isTTY && process.stderr.isTTY && !options.yes && !options.json;
  if (interactive) {
    const cancelled = await questionnaire(async ask => {
      if (!target || !PACKAGE_NAME.test(target)) {
        options.org ??= await ask(fr ? 'Organisation' : 'Organization');
        target ??= await ask(fr ? 'Nom du package' : 'Package name');
      }
      options.description ??= await ask("Description");
      options.publisher ??= options.org ?? await ask(fr ? 'Auteur ou organisation' : 'Author or organization');
      options.version ??= await ask(fr ? 'Version initiale' : 'Initial version', "0.1.0");
      options.license ??= await ask(fr ? 'Licence (laisser vide pour choisir plus tard)' : 'License (leave blank to choose later)');
      if (!options.context) {
        const content = await ask(fr ? 'Contenu initial : executable ou context' : 'Initial content: executable or context', "executable");
        if (!["executable", "context"].includes(content)) throw packageError("PackageInputInvalid", "choose executable or context; nothing created");
        options.context = content === "context";
      }
      const name = authorIdentity(target, options.org);
      const answer = await ask(fr ? `Créer ${name} dans ${name.split('.').at(-1)}/ ? oui/non` : `Create ${name} in ${name.split(".").at(-1)}/? yes/no`, fr ? 'non' : 'no');
      return !(fr ? /^(o|oui|y|yes)$/i : /^(y|yes)$/i).test(answer);
    });
    if (cancelled) return { status: "cancelled", command: "package new", notes: [fr ? 'Aucun fichier créé.' : 'Nothing created.'], exitCode: 1 };
  }
  return newPackage(target, options);
}

export async function packageCommand(args) {
  const languageIndex = args.indexOf('--lang');
  return withPackageLocale(languageIndex < 0 ? undefined : args[languageIndex + 1], () => {
    if (!args.length || args.includes('--help') || args.includes('-h')) return { text: packageHelp(args[0]), exitCode: 0 };
    const parsed = parse(args);
    return executePackageCommand(parsed);
  });
}

function packageHelp(action) {
  const fr = packageLocale() === 'fr';
  const lines = PACKAGE_USAGE.split('\n').filter(line => line.trim().replace(/^Usage: /, '').startsWith(`touba package ${action} `));
  const usage = lines.length ? lines.map(line => line.trim().replace(/^Usage: /, '')).join('\n') : PACKAGE_USAGE.split('\n').filter(line => line.includes('touba package ')).join('\n');
  const notes = {
    add: fr ? 'Utilisez nom@version avec une version exacte, ou un chemin local. Les étiquettes latest et les plages ne sont pas installées automatiquement.' : 'Use name@version with an exact version, or a local path. The latest tag and version ranges are not installed automatically.',
    search: fr ? 'Recherche dans le catalogue vérifié. Au plus 50 résultats par page ; poursuivez avec --offset. Aucun package installé.' : 'Search the verified catalog. At most 50 results per page; continue with --offset. No package is installed.',
    info: fr ? 'Affiche les versions d’un nom exact dans le catalogue vérifié. Ajoutez --withdrawn pour inclure les versions retirées.' : 'Show versions for an exact name in the verified catalog. Add --withdrawn to include withdrawn versions.',
    restore: fr ? 'Restaure uniquement les dossiers gérés absents depuis les versions et empreintes du verrou. Aucun dossier présent remplacé, aucun handler exécuté.' : 'Restore only missing managed directories from the locked versions and digests. No present directory is replaced and no handler is executed.',
    registry: fr ? 'Le fichier de clés publiques doit être vérifié. --shared enregistre une configuration versionnable et un chemin de confiance relatif au projet ; les identifiants restent locaux.' : 'Verify the public-key file first. --shared records a versionable configuration and project-relative trust path; credentials remain local.',
    remove: fr ? 'Retire un package géré. Les points d’entrée concernés sont signalés et restent à réviser explicitement dans le projet.' : 'Remove a managed package. Affected entry points are reported and still require explicit project review.',
  };
  return [usage, notes[action], fr ? 'Options communes : --lang fr|en, --json. Aide par commande : touba package <commande> --help.' : 'Common options: --lang fr|en, --json. Per-command help: touba package <command> --help.'].filter(Boolean).join('\n\n');
}

async function executePackageCommand({ action, target, options }) {
  if (['audit', 'search', 'info', 'restore'].includes(action) || action === 'list' && options.status) {
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
  else if (action === 'restore') report = await restorePackages(target, options);
  else if (['search', 'info'].includes(action)) {
    if (action === 'info' && !PACKAGE_NAME.test(target ?? '')) throw packageError('PackageNameInvalid', 'select an exact package name');
    if (options.offset !== undefined && !/^\d{1,6}$/.test(options.offset)) throw packageError('PackageOptionInvalid', 'offset must be a nonnegative integer');
    const reader = createRegistryReader(options.registry, { noBrowser: options['no-browser'], sessionOnly: options['session-only'] });
    try {
      const catalog = await listRegistryPackages({ registry: options.registry, trust: options.trust, readBytes: reader.readBytes,
        query: target ?? '', exact: action === 'info', offset: Number(options.offset ?? 0), includeWithdrawn: options.withdrawn === true });
      report = { command: `package ${action}`, status: 'success', ...catalog, packages: catalog.items,
        notes: [...(!catalog.items.length ? [packageLocale() === 'fr' ? 'Aucun résultat dans le catalogue accessible à ce compte.' : 'No results in the catalog accessible to this account.'] : []), packageLocale() === 'fr' ? 'Versions du catalogue vérifié. Choisissez une version exacte à installer ; aucune mise à jour automatique.'
          : 'Versions from the verified catalog. Choose an exact version to install; no automatic update.',
          ...(action === 'search' ? [packageLocale() === 'fr' ? 'Une ligne par package, version stable en premier. Consultez touba package info <nom> pour les versions et préversions.' : 'One row per package, stable versions first. Use touba package info <name> for versions and prereleases.'] : []),
          ...(catalog.next_offset === null ? [] : [`--offset ${catalog.next_offset}`])] };
    } finally { await reader.close(); }
  }
  else if (action === 'audit') report = await auditPackageStatus(options);
  else if (action === 'list' && options.status) report = { ...await auditPackageStatus({ ...options, offline: true }), command: 'package list' };
  else if (action === "new") report = await create(target, options);
  else if (action === "request-publication") report = await requestPackagePublication(target, options);
  else if (action === "checkout") report = await checkoutPackageDraft(target, options);
  else if (action === "submit") report = await (options.ci ? submitCiPackage : submitPackageDraft)(target, options);
  else if (action === 'submit-suite') report = await submitPackageSuite(target, options);
  else if (action === 'update-set') report = await updatePackageSet(target, options);
  else if (action === "version") {
    const root = findPackageWorkspace(options.root, { author: true });
    let next = target;
    if (!next) {
      if (options.json) throw packageError("PackageInputRequired", "provide patch, minor, major or an exact version with --json");
      const current = JSON.parse(readFileSync(join(root, PACKAGE_MANIFEST))).version;
      next = await questionnaire(ask => ask(packageLocale() === 'fr' ? `Version actuelle ${current}. Choisissez patch, minor, major ou une version exacte` : `Current ${current}. Choose patch, minor, major or an exact version`));
    }
    report = versionPackage(next, { root });
  } else if (action === 'update') report = await (options.registry ? updateRegistryPackage : reviewPackageUpdate)(target, options);
  else if (action === "list" || (action === "check" && !target && !existsSync(join(findPackageWorkspace(options.root), PACKAGE_MANIFEST)))) {
    const root = findPackageWorkspace(options.root), workspace = readPackageWorkspace(root);
    const inspected = action === 'list' ? inspectInstalledPackages(root, workspace.records, { allowMissing: true }) : null;
    const lock = inspected?.lock ?? verifyInstalledPackages(root, workspace.records);
    const packages = [];
    for (const record of workspace.records) {
      const installed = inspected?.packages.get(resolve(root, record.manifest));
      if (installed) {
        packages.push({ name: installed.document.name, version: installed.document.version, installed: true,
          ...(installed.restrictions.length ? { restrictions: installed.restrictions } : {}) });
        continue;
      }
      const checked = await checkPackage(join(root, record.manifest), { ...options, projectRoot: root });
      packages.push({ name: checked.package, version: checked.version, installed: lock.packages.some(pkg => pkg.name === checked.package) });
    }
    report = { status: packages.some(pkg => pkg.restrictions?.length) ? 'attention' : 'success', command: `package ${action}`, packages, notes: packages.length ? [] : [packageLocale() === 'fr' ? 'Aucun package enregistré.' : 'No registered packages.'] };
  } else report = await ({ check: target?.endsWith(".tar.gz") ? checkPackageArchive : checkPackage, test: testPackage, pack: packPackage, publish: /^https?:\/\//.test(options.registry ?? '') ? publishRemotePackage : publishPackage, add: options.registry ? addRegistryPackage : addPackage, remove: removePackage })[action](target, options);
  delete report.closure;
  const text = options.json ? JSON.stringify(report, null, 2) : packageReportText(report, packageLocale());
  return { text, exitCode: report.exitCode ?? (report.status === "success" ? 0 : 1) };
}
