import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  generateHandlerContractTestFromAirTool,
  generateHandlerStubFromAirTool,
} from "../../touba-manifest/src/stub.mjs";
import { toolNameToHandlerFile } from "../../touba-manifest/src/generate.mjs";

export const PROJECT_MANIFEST_VERSION = "touba-project-workflow-v1";
export const TOUBA_MANIFEST_VERSION = "touba-manifest-v1";
export const DEFAULT_SOURCE_ROOT = "src";
export const DEFAULT_HANDLER_ROOT = "handlers";
export const DEFAULT_AIR_ROOT = ".touba/air";
export const DEFAULT_PROJECT_CONFIG_PATH = "touba.project.json";
export const DEFAULT_SECRET_STORE_PATH = ".touba/secrets.local.json";
export const DEFAULT_DOTENV_PATH = ".env";
export const DEFAULT_DEV_SECRETS_PROFILE = "touba.secrets.dev.json";
export const DEFAULT_PROD_SECRETS_PROFILE = "touba.secrets.prod.json";
export const DEFAULT_HANDLER_EXTENSION = "mjs";
export const DEFAULT_HANDLER_COMMAND = process.execPath;
export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_MAX_PAYLOAD_BYTES = 1048576;
export const TOUBA_PROJECT_CONFIG_VERSION = "touba-project-v1";
export const TOUBA_LOCAL_SECRET_STORE_VERSION = "touba-secret-store-local-v1";
export const TOUBA_SECRETS_VERSION = "touba-secrets-v1";
export const DEFAULT_SUPPLY_CHAIN_LOCK_PATH = "touba.lock.json";
export const TOUBA_PACKAGE_SCHEMA_VERSION = "touba-package-v0.1";
export const TOUBA_AIR_JSON_PROFILE = "air-json-v0.1";
export const TOUBA_RUN_PLAN_SCHEMA_VERSION = "touba-run-plan-v0.1";
export const TOUBA_BINDING_FRAGMENT_SCHEMA_VERSION = "touba-binding-fragment-v0.1";
export const TOUBA_RESOURCE_BINDINGS_SCHEMA_VERSION = "touba-resource-bindings-v0.1";
export const TOUBA_OWNERSHIP_SCHEMA_VERSION = "touba-ownership-v0.1";
export const DEFAULT_RUN_PLAN_PATH = "touba.run-plan.json";

const MODULE_NAME_PATTERN = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)+$/;
const SECRET_HANDLE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const RUN_PROFILE_PATTERN = /^[a-z][a-z0-9_-]*$/;
const SEMVER_LIKE_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const NON_NEGATIVE_INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/;
const PAYLOAD_CONSTRAINT_PATH_PATTERN = /^(\$|[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*)$/;
const PAYLOAD_CONSTRAINT_OPERATORS = new Set([
  "non_empty",
  "max_length",
  "min",
  "max",
  "allowed_values",
  "min_items",
  "max_items",
]);
const RESOURCE_BINDING_KINDS = new Set(["memory_backend", "event_source", "decision_provider"]);
const RESOURCE_BINDING_KIND_PREFIX = Object.freeze({
  memory_backend: "memory:",
  event_source: "trigger:",
  decision_provider: "agent:",
});
const TEAM_REF_PATTERN = /^team:[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/;
const REVIEW_REF_PATTERN = /^review:[A-Za-z0-9_.:/-]+$/;
const OWNERSHIP_TARGET_REF_PATTERN = /^(package|module|tool|skill|strategy|agent|memory|trigger|binding_fragment|resource_bindings|run_plan|policy|lock):[^*\s]+$/;
const OWNERSHIP_REVIEW_SUBJECTS = new Set([
  "package_export",
  "tool_binding",
  "required_capability",
  "required_secret",
  "resource_binding",
  "agent_authority",
  "trigger_activation",
  "supply_chain_lock",
  "run_plan",
  "policy_expansion",
]);
const OWNERSHIP_REVIEW_DECISIONS = new Set(["approved", "rejected"]);
const OWNERSHIP_AUTHORITY_FIELDS = new Set([
  "backend",
  "binding",
  "bindings",
  "callable_by",
  "capability",
  "capabilities",
  "grant",
  "grants",
  "handler",
  "handlers",
  "manifest",
  "memory_scope",
  "memory_scopes",
  "permission",
  "permissions",
  "provider",
  "scope",
  "scopes",
  "secret",
  "secret_values",
  "secrets",
]);
const OWNERSHIP_SENSITIVE_FIELDS = new Set([
  "api_key",
  "connection_string",
  "content",
  "database_url",
  "dsn",
  "memory_content",
  "payload",
  "payload_raw",
  "prompt",
  "raw_payload",
  "secret_value",
  "token",
  "value",
]);
const OWNERSHIP_COMPLIANCE_FIELDS = new Set([
  "certified",
  "compliance",
  "compliant",
  "security_status",
  "unverified",
  "verified",
]);
const RESOURCE_BINDING_PAYLOAD_FORBIDDEN_FIELDS = new Set([
  "api_key",
  "connection_string",
  "database_url",
  "dsn",
  "payload",
  "payload_raw",
  "raw_payload",
  "secret_value",
  "secret_values",
  "token",
  "value",
]);
const PACKAGE_EXPORT_COLLECTIONS = Object.freeze({
  types: Object.freeze({ importKind: "type", definitionCollection: "types", refPrefix: "type:" }),
  defines: Object.freeze({ importKind: "define", definitionCollection: "constants", refPrefix: "constant:" }),
  functions: Object.freeze({ importKind: "function", definitionCollection: "functions", refPrefix: "function:" }),
  tools: Object.freeze({ importKind: "tool", definitionCollection: "tools", refPrefix: "tool:" }),
  skills: Object.freeze({ importKind: "skill", definitionCollection: "skills", refPrefix: "skill:" }),
  strategies: Object.freeze({ importKind: "strategy", definitionCollection: "strategies", refPrefix: "strategy:" }),
  agents: Object.freeze({ importKind: "agent", definitionCollection: "agents", refPrefix: "agent:" }),
  memories: Object.freeze({ importKind: "memory", definitionCollection: "memories", refPrefix: "memory:" }),
});
const PACKAGE_AUTHORITY_FIELDS = new Set([
  "binding",
  "bindings",
  "grant",
  "grants",
  "handler",
  "handlers",
  "manifest",
  "memory_scopes",
  "permissions",
  "secret_values",
  "secrets",
]);
const PACKAGE_REGISTRY_FIELDS = new Set([
  "registries",
  "registry",
  "registry_url",
]);
const RUN_PLAN_FORBIDDEN_FIELDS = new Set([
  "input",
  "inputs",
  "inputs_json",
  "payload",
  "prompt",
  "prompts",
  "secret",
  "secret_value",
  "secret_values",
  "secrets",
]);
const BINDING_FRAGMENT_AUTHORITY_FIELDS = new Set([
  "agent_scope",
  "agent_scopes",
  "authority",
  "callable_by",
  "caller",
  "callers",
  "memory_scope",
  "memory_scopes",
  "permission",
  "permissions",
  "policy",
  "policies",
  "security_status",
  "scope",
  "scopes",
  "unverified",
  "verified",
]);
const DEFAULT_PROJECT_LANGUAGE = "javascript";
const PROJECT_LANGUAGE_ALIASES = new Map([
  ["js", "javascript"],
  ["javascript", "javascript"],
  ["ts", "typescript"],
  ["typescript", "typescript"],
  ["py", "python"],
  ["python", "python"],
]);
const PROJECT_LANGUAGE_PROFILES = Object.freeze({
  javascript: Object.freeze({
    language: "javascript",
    sdk: "@touba/sdk",
    handlerCommand: DEFAULT_HANDLER_COMMAND,
    handlerExtension: DEFAULT_HANDLER_EXTENSION,
  }),
});
const RESERVED_PROJECT_LANGUAGES = new Set(["python", "typescript"]);
const DEFAULT_RUN_PROFILES = Object.freeze({
  dev: Object.freeze({
    require_supply_chain_lock: false,
  }),
  prod: Object.freeze({
    require_supply_chain_lock: true,
    supply_chain_lock: DEFAULT_SUPPLY_CHAIN_LOCK_PATH,
  }),
});

export function initProject(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const created = [];
  const preserved = [];
  const projectConfig = resolveProjectConfigForInit(root, options.language);

  for (const dir of [DEFAULT_SOURCE_ROOT, DEFAULT_HANDLER_ROOT, ".touba"]) {
    const path = join(root, dir);
    if (existsSync(path)) {
      preserved.push(path);
    } else {
      mkdirSync(path, { recursive: true });
      created.push(path);
    }
  }

  const gitignorePath = join(root, ".gitignore");
  ensureProjectGitignore(root, created, preserved);
  ensureProjectConfig(root, projectConfig.document, created, preserved);
  ensureLocalSecretSupport(root, created, preserved);

  return {
    workflow_version: PROJECT_MANIFEST_VERSION,
    command: "init",
    root,
    project_config_path: projectConfig.path,
    language: projectConfig.document.language,
    sdk: projectConfig.document.sdk,
    created,
    preserved,
    notes: [
      "No manifest is created until a project declares at least one tool.",
      "JavaScript is the only project language available in this V1; Python and TypeScript are reserved for future work.",
      "The runtime still receives manifests explicitly; project tooling only prepares artifacts.",
    ],
  };
}

export function newModule(moduleName, options = {}) {
  assertCanonicalModuleName(moduleName);
  const root = resolve(options.root ?? process.cwd());
  const sourcePath = options.sourcePath !== undefined
    ? resolve(root, options.sourcePath)
    : moduleNameToSourcePath(root, moduleName);

  if (existsSync(sourcePath) && options.force !== true) {
    throw new Error(`module source already exists: ${sourcePath}`);
  }

  mkdirSync(dirname(sourcePath), { recursive: true });
  const content = `module ${moduleName}\n`;
  writeFileSync(sourcePath, content, "utf8");

  return {
    workflow_version: PROJECT_MANIFEST_VERSION,
    command: "new module",
    root,
    module_name: moduleName,
    source_path: sourcePath,
    created: [sourcePath],
  };
}

export function setProjectSecret(handle, value, options = {}) {
  assertSecretHandle(handle);
  if (typeof value !== "string") {
    throw new Error("secret value must be a string");
  }
  const root = resolve(options.root ?? process.cwd());
  const storePath = secretStorePath(root, options.storePath);
  const store = readLocalSecretStore(storePath);
  store.secrets[handle] = value;
  writeLocalSecretStore(storePath, store);
  return secretReport("secret set", root, storePath, {
    handles: [handle],
    notes: [
      "The local touba_store is for development ergonomics; it is not a cryptographic vault.",
      "Values are never printed by this command.",
    ],
  });
}

export function listProjectSecrets(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const storePath = secretStorePath(root, options.storePath);
  const store = readLocalSecretStore(storePath);
  return secretReport("secret list", root, storePath, {
    handles: Object.keys(store.secrets).sort(),
  });
}

export function checkProjectSecret(handle, options = {}) {
  assertSecretHandle(handle);
  const root = resolve(options.root ?? process.cwd());
  const storePath = secretStorePath(root, options.storePath);
  const store = readLocalSecretStore(storePath);
  return secretReport("secret check", root, storePath, {
    handles: [handle],
    present: Object.hasOwn(store.secrets, handle),
  });
}

export function removeProjectSecret(handle, options = {}) {
  assertSecretHandle(handle);
  const root = resolve(options.root ?? process.cwd());
  const storePath = secretStorePath(root, options.storePath);
  const store = readLocalSecretStore(storePath);
  const removed = Object.hasOwn(store.secrets, handle);
  delete store.secrets[handle];
  writeLocalSecretStore(storePath, store);
  return secretReport("secret remove", root, storePath, {
    handles: [handle],
    removed,
  });
}

export async function prepareProject(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const mode = options.mode ?? "plan";
  if (!["plan", "check", "write"].includes(mode)) {
    throw new Error(`unsupported prepare mode: ${mode}`);
  }

  const projectConfigPath = resolve(root, DEFAULT_PROJECT_CONFIG_PATH);
  const manifestPath = resolve(root, options.manifestPath ?? "touba.manifest.json");
  const airPaths = normalizeAirPaths(root, options.airPaths);
  const sourcePaths = normalizeSourcePaths(root, options.sourcePaths, airPaths);

  const diagnostics = [];
  const actions = [];
  const airDocuments = [];
  const sources = [];
  const projectConfigResolution = resolveProjectConfigForPrepare(root, diagnostics);
  const languageProfile = projectConfigResolution.profile;

  for (const sourcePath of sourcePaths) {
    const expectedModuleName = expectedModuleNameForSource(root, sourcePath);
    let airDocument;
    try {
      airDocument = await compileSource(sourcePath, options);
    } catch (error) {
      diagnostics.push(errorDiagnostic("SourceCompileFailed", error.message, { source_path: sourcePath }));
      continue;
    }

    const actualModuleName = airDocument?.module?.name;
    const sourceRecord = {
      path: sourcePath,
      module_name: actualModuleName,
      expected_module_name: expectedModuleName,
    };
    sources.push(sourceRecord);

    if (expectedModuleName !== null) {
      if (!MODULE_NAME_PATTERN.test(expectedModuleName)) {
        diagnostics.push(errorDiagnostic(
          "ModulePathNotCanonical",
          "project source paths must follow src/<domain>/<module>.tb so module names contain at least two lowercase dotted segments",
          { source_path: sourcePath, expected_module_name: expectedModuleName },
        ));
      }
      if (expectedModuleName !== actualModuleName) {
        diagnostics.push(errorDiagnostic(
          "ModulePathMismatch",
          `module ${actualModuleName} does not match source path convention ${expectedModuleName}`,
          { source_path: sourcePath, module_name: actualModuleName, expected_module_name: expectedModuleName },
        ));
      }
    }

    airDocuments.push({ document: airDocument, sourcePath });
    const airPath = airOutputPath(root, actualModuleName);
    actions.push(action(mode === "write" ? "write_air" : "would_write_air", airPath, {
      module_name: actualModuleName,
      source_path: sourcePath,
    }));
  }

  for (const airPath of airPaths) {
    let airDocument;
    try {
      airDocument = JSON.parse(readFileSync(airPath, "utf8"));
    } catch (error) {
      diagnostics.push(errorDiagnostic("AirReadFailed", error.message, { air_path: airPath }));
      continue;
    }
    if (!airDocument?.module?.name || !airDocument?.definitions || !Array.isArray(airDocument.definitions.tools)) {
      diagnostics.push(errorDiagnostic("InvalidAirDocument", "AIR document must contain module.name and definitions.tools", {
        air_path: airPath,
      }));
      continue;
    }
    airDocuments.push({ document: airDocument, airPath });
  }

  if (sourcePaths.length === 0 && airPaths.length === 0) {
    diagnostics.push(errorDiagnostic("NoProjectSources", "no .tb source found under src/ and no --air path was provided", {
      root,
      source_root: join(root, DEFAULT_SOURCE_ROOT),
    }));
  }

  const projectModuleNames = airDocuments
    .map((entry) => entry.document?.module?.name)
    .filter((moduleName) => typeof moduleName === "string" && moduleName.length > 0);
  const packageResolution = await loadLocalPackages({
    root,
    projectPackageRecords: projectConfigResolution.document?.packages ?? [],
    optionPackagePaths: options.packagePaths ?? [],
    projectModuleNames,
    compileOptions: options,
  });
  diagnostics.push(...packageResolution.diagnostics);

  const assembly = assemblePrepareAirDocuments([...airDocuments, ...packageResolution.entries], {
    rootModuleNames: projectModuleNames,
    packageMembership: packageResolution.packageMembership,
    packageExportsByModule: packageResolution.packageExportsByModule,
  });
  diagnostics.push(...assembly.diagnostics);
  const preparedAirDocuments = assembly.entries;

  let expectedManifest = buildExpectedManifest(preparedAirDocuments.map((entry) => entry.document), {
    handlerRoot: options.handlerRoot ?? DEFAULT_HANDLER_ROOT,
    handlerCommand: options.handlerCommand ?? languageProfile.handlerCommand,
    handlerExtension: options.handlerExtension ?? languageProfile.handlerExtension,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxPayloadBytes: options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
  });
  const bindingFragmentPaths = normalizeBindingFragmentPaths(root, options.bindingFragmentPaths);
  const bindingFragmentComposition = composeBindingFragments({
    fragmentPaths: bindingFragmentPaths,
    expectedManifest,
    diagnostics,
    actions,
    mode,
  });
  expectedManifest = bindingFragmentComposition.manifest;
  const resourceBindingsPaths = normalizeResourceBindingsPaths(root, options.resourceBindingsPaths);
  const resourceBindingsValidation = validateResourceBindingsForAir({
    resourceBindingsPaths,
    airDocuments: preparedAirDocuments.map((entry) => entry.document),
    diagnostics,
    actions,
    mode,
    requireAll: options.requireResourceBindings === true,
  });
  const expectedToolRefs = Object.keys(expectedManifest.bindings);
  const expectedSecretHandles = collectRequiredSecretHandles(preparedAirDocuments.map((entry) => entry.document));
  const stubs = expectedStubs(preparedAirDocuments.map((entry) => entry.document), {
    root,
    handlerRoot: options.handlerRoot ?? DEFAULT_HANDLER_ROOT,
    handlerExtension: options.handlerExtension ?? languageProfile.handlerExtension,
    sdkImport: languageProfile.sdk,
  });
  const secretProfiles = expectedSecretProfiles(root, expectedSecretHandles, {
    secretStorePath: DEFAULT_SECRET_STORE_PATH,
  });
  const runPlanPath = options.runPlanPath !== undefined
    ? resolve(root, options.runPlanPath)
    : null;
  const expectedRunPlan = runPlanPath === null
    ? null
    : buildExpectedRunPlan({
      root,
      runPlanPath,
      preparedAirDocuments,
      entryRef: options.entryRef,
      manifestPath,
      expectedToolRefs,
      secretProfiles,
      projectConfig: projectConfigResolution.document ?? expectedProjectConfigDocument(languageProfile),
      profile: options.runProfile ?? "dev",
      diagnostics,
    });
  const ownershipPath = options.ownershipPath !== undefined
    ? resolve(root, options.ownershipPath)
    : null;
  const ownershipValidation = validateOwnershipForPrepare({
    ownershipPath,
    requireOwnership: options.requireOwnership === true,
    profile: options.runProfile ?? "dev",
    preparedAirDocuments,
    packages: packageResolution.packages,
    bindingFragments: bindingFragmentComposition.fragments,
    resourceBindings: resourceBindingsValidation.documents,
    runPlanPath,
    expectedRunPlan,
    diagnostics,
    actions,
    mode,
  });

  let currentManifest = null;
  if (existsSync(manifestPath)) {
    try {
      currentManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      diagnostics.push(errorDiagnostic("ManifestReadFailed", error.message, { manifest_path: manifestPath }));
    }
  }

  inspectProjectConfig({
    currentProjectConfig: projectConfigResolution.document,
    expectedProjectConfig: expectedProjectConfigDocument(languageProfile),
    projectConfigPath,
    diagnostics,
    actions,
    mode,
    required: expectedToolRefs.length > 0,
  });
  inspectManifest({
    currentManifest,
    expectedManifest,
    manifestPath,
    diagnostics,
    actions,
    mode,
  });
  inspectStubs({ stubs, diagnostics, actions, mode });
  inspectSecretProfiles({ secretProfiles, diagnostics, actions, mode });
  if (expectedRunPlan !== null) {
    inspectRunPlan({
      currentRunPlan: readRunPlan(runPlanPath, diagnostics),
      expectedRunPlan,
      runPlanPath,
      diagnostics,
      actions,
      mode,
    });
  }

  if (mode === "write" && !hasErrorDiagnostics(diagnostics)) {
    if (expectedToolRefs.length > 0 && projectConfigResolution.document === null) {
      writeProjectConfig(projectConfigPath, expectedProjectConfigDocument(languageProfile));
    }
    for (const { document, sourcePath } of preparedAirDocuments) {
      if (sourcePath === undefined) {
        continue;
      }
      const outputPath = airOutputPath(root, document.module.name);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    }
    if (expectedToolRefs.length > 0) {
      const mergedManifest = mergeManifest(currentManifest, expectedManifest, diagnostics, manifestPath);
      if (!hasErrorDiagnostics(diagnostics)) {
        mkdirSync(dirname(manifestPath), { recursive: true });
        writeFileSync(manifestPath, `${JSON.stringify(mergedManifest, null, 2)}\n`, "utf8");
      }
    }
    for (const stub of stubs) {
      if (existsSync(stub.path)) {
        continue;
      }
      mkdirSync(dirname(stub.path), { recursive: true });
      writeFileSync(stub.path, stub.content, "utf8");
    }
    if (expectedSecretHandles.length > 0) {
      ensureProjectGitignore(root, [], []);
      ensureLocalSecretSupport(root, [], []);
      for (const profile of secretProfiles) {
        const mergedProfile = mergeSecretProfile(readSecretProfile(profile.path, diagnostics), profile.document);
        mkdirSync(dirname(profile.path), { recursive: true });
        writeFileSync(profile.path, `${JSON.stringify(mergedProfile, null, 2)}\n`, "utf8");
      }
    }
    if (expectedRunPlan !== null) {
      mkdirSync(dirname(runPlanPath), { recursive: true });
      writeFileSync(runPlanPath, `${JSON.stringify(expectedRunPlan, null, 2)}\n`, "utf8");
    }
  }

  const status = computeStatus(mode, diagnostics, actions);
  return {
    workflow_version: PROJECT_MANIFEST_VERSION,
    command: "prepare",
    mode,
    status,
    root,
    project_config_path: projectConfigPath,
    language: languageProfile.language,
    sdk: languageProfile.sdk,
    manifest_path: manifestPath,
    binding_fragments: bindingFragmentComposition.fragments,
    resource_bindings: resourceBindingsValidation.documents,
    run_plan_path: runPlanPath,
    ownership: ownershipValidation.summary,
    secret_profiles: secretProfiles.map((profile) => profile.path),
    sources,
    air_inputs: airPaths,
    packages: packageResolution.packages,
    modules: preparedAirDocuments.map((entry) => entry.document.module.name),
    imports: assembly.imports,
    tools: expectedToolRefs,
    actions,
    diagnostics,
  };
}

export function renderReport(report) {
  const lines = [];
  lines.push(`Touba project ${report.command} (${report.mode ?? "ok"})`);
  lines.push(`Status: ${report.status ?? "success"}`);
  lines.push(`Root: ${report.root}`);
  if (report.manifest_path) {
    lines.push(`Manifest: ${report.manifest_path}`);
  }
  if (report.project_config_path) {
    lines.push(`Project config: ${report.project_config_path}`);
  }
  if (report.run_plan_path) {
    lines.push(`Run plan: ${report.run_plan_path}`);
  }
  if (report.skill_pack_path) {
    lines.push(`Skill pack: ${report.skill_pack_path}`);
  }
  if (report.skill_pack_ref) {
    lines.push(`Skill pack ref: ${report.skill_pack_ref}`);
  }
  if (report.ownership?.path) {
    lines.push(`Ownership: ${report.ownership.path}`);
  }
  if (report.language) {
    lines.push(`Language: ${report.language}`);
  }
  if (report.sdk) {
    lines.push(`SDK: ${report.sdk}`);
  }
  if (report.store_path) {
    lines.push(`Secret store: ${report.store_path}`);
  }
  if (report.secret_profiles?.length > 0) {
    lines.push(`Secret profiles: ${report.secret_profiles.join(", ")}`);
  }
  if (report.modules?.length > 0) {
    lines.push(`Modules: ${report.modules.join(", ")}`);
  }
  if (report.imports?.length > 0) {
    lines.push("Imports:");
    for (const item of report.imports) {
      lines.push(`- ${item.status} ${item.target_ref} for ${item.module_name}`);
    }
  }
  if (report.packages?.length > 0) {
    lines.push("Packages:");
    for (const item of report.packages) {
      lines.push(`- ${item.name}@${item.version} ${item.manifest_path}`);
    }
  }
  if (report.skill_packs?.length > 0) {
    lines.push("Skill packs:");
    for (const item of report.skill_packs) {
      lines.push(`- ${item.ref} ${item.path} (${item.resource_count} resources)`);
    }
  }
  if (report.binding_fragments?.length > 0) {
    lines.push("Binding fragments:");
    for (const item of report.binding_fragments) {
      lines.push(`- ${item.path} (${item.binding_count} bindings)`);
    }
  }
  if (report.resource_bindings?.length > 0) {
    lines.push("Resource bindings:");
    for (const item of report.resource_bindings) {
      lines.push(`- ${item.path} (${item.resource_count} resources)`);
    }
  }
  if (report.ownership?.path) {
    lines.push(`Ownership profile: ${report.ownership.profile}`);
    lines.push(`Ownership teams: ${report.ownership.team_count}`);
    lines.push(`Ownership owners: ${report.ownership.owner_count}`);
    lines.push(`Ownership reviews: ${report.ownership.review_count}`);
    if (report.ownership.active_gate_subjects?.length > 0) {
      lines.push(`Ownership gate subjects: ${report.ownership.active_gate_subjects.join(", ")}`);
    }
  }
  if (report.tools?.length > 0) {
    lines.push(`Tools: ${report.tools.join(", ")}`);
  }
  if (report.handles?.length > 0) {
    lines.push(`Secret handles: ${report.handles.join(", ")}`);
  }
  if (typeof report.present === "boolean") {
    lines.push(`Present: ${report.present ? "yes" : "no"}`);
  }
  if (typeof report.removed === "boolean") {
    lines.push(`Removed: ${report.removed ? "yes" : "no"}`);
  }
  if (report.notes?.length > 0) {
    lines.push("Notes:");
    for (const note of report.notes) {
      lines.push(`- ${note}`);
    }
  }
  if (report.actions?.length > 0) {
    lines.push("Actions:");
    for (const item of report.actions) {
      const target = item.path ?? item.tool_ref ?? item.module_name ?? "";
      lines.push(`- ${item.kind}${target ? ` ${target}` : ""}`);
    }
  }
  if (report.diagnostics?.length > 0) {
    lines.push("Diagnostics:");
    for (const diagnostic of report.diagnostics) {
      lines.push(`- ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function normalizeSourcePaths(root, sourcePaths, airPaths) {
  if (sourcePaths !== undefined && sourcePaths.length > 0) {
    return sourcePaths.map((path) => resolve(root, path));
  }
  if (airPaths.length > 0) {
    return [];
  }
  const sourceRoot = join(root, DEFAULT_SOURCE_ROOT);
  if (!existsSync(sourceRoot)) {
    return [];
  }
  return findToubaSources(sourceRoot);
}

function normalizeAirPaths(root, airPaths) {
  return (airPaths ?? []).map((path) => resolve(root, path));
}

function normalizeBindingFragmentPaths(root, fragmentPaths) {
  return (fragmentPaths ?? []).map((path) => resolve(root, path));
}

function normalizeResourceBindingsPaths(root, resourceBindingsPaths) {
  return (resourceBindingsPaths ?? []).map((path) => resolve(root, path));
}

async function loadLocalPackages({
  root,
  projectPackageRecords,
  optionPackagePaths,
  projectModuleNames,
  compileOptions,
}) {
  const diagnostics = [];
  const entries = [];
  const packages = [];
  const packageMembership = new Map();
  const packageExportsByModule = new Map();
  const projectModuleSet = new Set(projectModuleNames);
  const loadedModuleSet = new Set();
  const loadedPackageNames = new Set();
  const loadedManifestPaths = new Set();
  const records = [
    ...projectPackageRecords.map((record, index) => ({
      origin: "project_config",
      index,
      record,
    })),
    ...(optionPackagePaths ?? []).map((manifest, index) => ({
      origin: "cli",
      index,
      record: { manifest },
    })),
  ];

  for (const entry of records) {
    const manifestPath = packageManifestPath(root, entry.record, entry, diagnostics);
    if (manifestPath === null) {
      continue;
    }
    if (loadedManifestPaths.has(manifestPath)) {
      continue;
    }
    loadedManifestPaths.add(manifestPath);

    const loaded = await loadOneLocalPackage({
      root,
      manifestPath,
      record: entry.record,
      diagnostics,
      compileOptions,
    });
    if (loaded === null) {
      continue;
    }
    if (loadedPackageNames.has(loaded.name)) {
      diagnostics.push(errorDiagnostic("PackageNameConflict", `package ${loaded.name} is loaded more than once`, {
        package_name: loaded.name,
        manifest_path: manifestPath,
      }));
      continue;
    }
    loadedPackageNames.add(loaded.name);

    const acceptedEntries = [];
    for (const packageEntry of loaded.entries) {
      const moduleName = packageEntry.document.module.name;
      if (projectModuleSet.has(moduleName) || loadedModuleSet.has(moduleName)) {
        diagnostics.push(errorDiagnostic("PackageNameConflict", `package module ${moduleName} conflicts with an existing project or package module`, {
          package_name: loaded.name,
          module_name: moduleName,
          manifest_path: manifestPath,
        }));
        continue;
      }
      loadedModuleSet.add(moduleName);
      packageMembership.set(moduleName, loaded.name);
      packageExportsByModule.set(moduleName, new Set(loaded.exports_by_module[moduleName] ?? []));
      acceptedEntries.push(packageEntry);
    }
    entries.push(...acceptedEntries);
    packages.push({
      name: loaded.name,
      version: loaded.version,
      manifest_path: manifestPath,
      root: loaded.root,
      modules: acceptedEntries.map((packageEntry) => packageEntry.document.module.name).sort(),
      exports: loaded.exports,
      contract_tests: loaded.contract_tests,
    });
  }

  return {
    diagnostics,
    entries,
    packages: packages.sort((left, right) => left.name.localeCompare(right.name)),
    packageMembership,
    packageExportsByModule,
  };
}

function packageManifestPath(root, record, entry, diagnostics) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    diagnostics.push(errorDiagnostic("PackageSchemaMismatch", "project package entries must be objects", {
      origin: entry.origin,
      index: entry.index,
    }));
    return null;
  }
  if (hasRegistryClaim(record)) {
    diagnostics.push(errorDiagnostic("PackageRegistryForbidden", "local package entries cannot declare a registry", {
      origin: entry.origin,
      index: entry.index,
    }));
  }
  if (typeof record.manifest !== "string" || record.manifest.trim() === "") {
    diagnostics.push(errorDiagnostic("PackageSchemaMismatch", "project package entries must declare a non-empty manifest path", {
      origin: entry.origin,
      index: entry.index,
    }));
    return null;
  }
  return resolve(root, record.manifest);
}

async function loadOneLocalPackage({
  root,
  manifestPath,
  record,
  diagnostics,
  compileOptions,
}) {
  let document;
  try {
    document = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    diagnostics.push(errorDiagnostic("PackageSchemaMismatch", `cannot read package manifest: ${error.message}`, {
      manifest_path: manifestPath,
    }));
    return null;
  }

  const metadata = validatePackageManifest(document, {
    manifestPath,
    record,
    diagnostics,
  });
  if (metadata === null) {
    return null;
  }

  const moduleNames = packageExportModuleNames(metadata.exports);
  const packageEntries = [];
  for (const moduleName of moduleNames) {
    let sourcePath;
    try {
      sourcePath = moduleNameToSourcePath(metadata.root, moduleName);
    } catch (error) {
      diagnostics.push(errorDiagnostic("PackageExportUnknownRef", error.message, {
        package_name: metadata.name,
        module_name: moduleName,
        manifest_path: manifestPath,
      }));
      continue;
    }
    if (!existsSync(sourcePath)) {
      diagnostics.push(errorDiagnostic("PackageExportUnknownRef", `package export module ${moduleName} has no source file`, {
        package_name: metadata.name,
        module_name: moduleName,
        source_path: sourcePath,
        manifest_path: manifestPath,
      }));
      continue;
    }
    let airDocument;
    try {
      airDocument = await compileSource(sourcePath, compileOptions);
    } catch (error) {
      diagnostics.push(errorDiagnostic("PackageExportUnknownRef", `package source ${sourcePath} could not be compiled: ${error.message}`, {
        package_name: metadata.name,
        module_name: moduleName,
        source_path: sourcePath,
        manifest_path: manifestPath,
      }));
      continue;
    }
    if (airDocument?.module?.name !== moduleName) {
      diagnostics.push(errorDiagnostic("PackageNameConflict", `package source ${sourcePath} produced module ${airDocument?.module?.name ?? "<missing>"} instead of ${moduleName}`, {
        package_name: metadata.name,
        expected_module_name: moduleName,
        actual_module_name: airDocument?.module?.name,
        source_path: sourcePath,
        manifest_path: manifestPath,
      }));
      continue;
    }
    if (typeof airDocument.air_json_profile === "string" && airDocument.air_json_profile !== TOUBA_AIR_JSON_PROFILE) {
      diagnostics.push(errorDiagnostic("PackageAirProfileIncompatible", `package module ${moduleName} uses AIR profile ${airDocument.air_json_profile}`, {
        package_name: metadata.name,
        module_name: moduleName,
        expected_air_profile: TOUBA_AIR_JSON_PROFILE,
        actual_air_profile: airDocument.air_json_profile,
        manifest_path: manifestPath,
      }));
      continue;
    }
    packageEntries.push({
      document: airDocument,
      packageSourcePath: sourcePath,
      packageName: metadata.name,
      packageVersion: metadata.version,
    });
  }

  const documents = packageEntries.map((entry) => entry.document);
  for (const [collectionName, refs] of Object.entries(metadata.exports)) {
    const descriptor = PACKAGE_EXPORT_COLLECTIONS[collectionName];
    for (const targetRef of refs) {
      if (!packageDeclarationExists(documents, descriptor.importKind, targetRef)) {
        diagnostics.push(errorDiagnostic("PackageExportUnknownRef", `package export ${targetRef} is not declared by package ${metadata.name}`, {
          package_name: metadata.name,
          export_collection: collectionName,
          target_ref: targetRef,
          manifest_path: manifestPath,
        }));
      }
    }
  }

  return {
    ...metadata,
    entries: packageEntries,
  };
}

function validatePackageManifest(document, {
  manifestPath,
  record,
  diagnostics,
}) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    diagnostics.push(errorDiagnostic("PackageSchemaMismatch", "package manifest must be a JSON object", {
      manifest_path: manifestPath,
    }));
    return null;
  }
  if (document.package_schema_version !== TOUBA_PACKAGE_SCHEMA_VERSION) {
    diagnostics.push(errorDiagnostic("PackageSchemaMismatch", `package_schema_version must be ${TOUBA_PACKAGE_SCHEMA_VERSION}`, {
      manifest_path: manifestPath,
      actual: document.package_schema_version,
    }));
    return null;
  }
  if (hasRegistryClaim(document)) {
    diagnostics.push(errorDiagnostic("PackageRegistryForbidden", "package manifest cannot declare registry authority", {
      manifest_path: manifestPath,
    }));
  }
  const authorityField = firstAuthorityField(document);
  if (authorityField !== null) {
    diagnostics.push(errorDiagnostic("PackageAuthorityFieldForbidden", `package manifest cannot declare authority field ${authorityField}`, {
      manifest_path: manifestPath,
      field: authorityField,
    }));
  }

  if (typeof document.name !== "string" || !MODULE_NAME_PATTERN.test(document.name)) {
    diagnostics.push(errorDiagnostic("PackageSchemaMismatch", "package name must be a qualified lowercase dotted identifier", {
      manifest_path: manifestPath,
      package_name: document.name,
    }));
    return null;
  }
  if (typeof document.version !== "string" || !SEMVER_LIKE_PATTERN.test(document.version)) {
    diagnostics.push(errorDiagnostic("PackageSchemaMismatch", "package version must be a semver-like string", {
      manifest_path: manifestPath,
      package_name: document.name,
      version: document.version,
    }));
    return null;
  }
  if (typeof record.version === "string" && record.version !== document.version) {
    diagnostics.push(errorDiagnostic("PackageVersionIncompatible", `package ${document.name} version ${document.version} does not match requested ${record.version}`, {
      manifest_path: manifestPath,
      package_name: document.name,
      expected_version: record.version,
      actual_version: document.version,
    }));
  }
  if (typeof document.root !== "string" || document.root.trim() === "") {
    diagnostics.push(errorDiagnostic("PackageSchemaMismatch", "package root must be a non-empty string", {
      manifest_path: manifestPath,
      package_name: document.name,
    }));
    return null;
  }
  if (document.touba?.air_profile !== TOUBA_AIR_JSON_PROFILE) {
    diagnostics.push(errorDiagnostic("PackageAirProfileIncompatible", `package ${document.name} must target AIR profile ${TOUBA_AIR_JSON_PROFILE}`, {
      manifest_path: manifestPath,
      package_name: document.name,
      expected_air_profile: TOUBA_AIR_JSON_PROFILE,
      actual_air_profile: document.touba?.air_profile,
    }));
    return null;
  }
  if (typeof document.touba?.runtime_compatibility !== "string" || document.touba.runtime_compatibility.trim() === "") {
    diagnostics.push(errorDiagnostic("PackageSchemaMismatch", "package touba.runtime_compatibility must be a non-empty string", {
      manifest_path: manifestPath,
      package_name: document.name,
    }));
    return null;
  }

  const packageRoot = resolve(dirname(manifestPath), document.root);
  const exports = normalizePackageExports(document.exports, diagnostics, manifestPath, document.name);
  const contractTests = normalizePackageContractTests(document.contract_tests, diagnostics, manifestPath, document.name);

  return {
    name: document.name,
    version: document.version,
    root: packageRoot,
    exports,
    exports_by_module: packageExportsByModule(exports),
    contract_tests: contractTests.map((testPath) => resolve(packageRoot, testPath)),
  };
}

function normalizePackageExports(exports, diagnostics, manifestPath, packageName) {
  if (!exports || typeof exports !== "object" || Array.isArray(exports)) {
    diagnostics.push(errorDiagnostic("PackageSchemaMismatch", "package exports must be an object", {
      manifest_path: manifestPath,
      package_name: packageName,
    }));
    return emptyPackageExports();
  }
  const normalized = emptyPackageExports();
  for (const [collectionName, descriptor] of Object.entries(PACKAGE_EXPORT_COLLECTIONS)) {
    const refs = exports[collectionName] ?? [];
    if (!Array.isArray(refs)) {
      diagnostics.push(errorDiagnostic("PackageSchemaMismatch", `package exports.${collectionName} must be an array`, {
        manifest_path: manifestPath,
        package_name: packageName,
      }));
      continue;
    }
    const seenRefs = new Set();
    for (const targetRef of refs) {
      if (typeof targetRef !== "string" || targetRef.trim() === "") {
        diagnostics.push(errorDiagnostic("PackageExportUnknownRef", `package exports.${collectionName} contains an invalid ref`, {
          manifest_path: manifestPath,
          package_name: packageName,
          export_collection: collectionName,
        }));
        continue;
      }
      if (!targetRef.startsWith(descriptor.refPrefix)) {
        diagnostics.push(errorDiagnostic("PackageExportUnknownRef", `package export ${targetRef} is not a canonical ${descriptor.refPrefix} AIR ref`, {
          manifest_path: manifestPath,
          package_name: packageName,
          export_collection: collectionName,
          target_ref: targetRef,
        }));
        continue;
      }
      if (seenRefs.has(targetRef)) {
        diagnostics.push(errorDiagnostic("PackageNameConflict", `package export ${targetRef} is declared more than once`, {
          manifest_path: manifestPath,
          package_name: packageName,
          export_collection: collectionName,
          target_ref: targetRef,
        }));
        continue;
      }
      seenRefs.add(targetRef);
      normalized[collectionName].push(targetRef);
    }
    normalized[collectionName].sort();
  }
  for (const key of Object.keys(exports)) {
    if (PACKAGE_EXPORT_COLLECTIONS[key] === undefined) {
      diagnostics.push(errorDiagnostic("PackageSchemaMismatch", `package exports.${key} is not supported`, {
        manifest_path: manifestPath,
        package_name: packageName,
        export_collection: key,
      }));
    }
  }
  return normalized;
}

function emptyPackageExports() {
  return Object.fromEntries(Object.keys(PACKAGE_EXPORT_COLLECTIONS).map((collectionName) => [collectionName, []]));
}

function normalizePackageContractTests(contractTests, diagnostics, manifestPath, packageName) {
  if (contractTests === undefined) {
    return [];
  }
  if (!Array.isArray(contractTests)) {
    diagnostics.push(errorDiagnostic("PackageSchemaMismatch", "package contract_tests must be an array when present", {
      manifest_path: manifestPath,
      package_name: packageName,
    }));
    return [];
  }
  return contractTests.filter((testPath) => {
    if (typeof testPath === "string" && testPath.trim() !== "") {
      return true;
    }
    diagnostics.push(errorDiagnostic("PackageSchemaMismatch", "package contract_tests entries must be non-empty strings", {
      manifest_path: manifestPath,
      package_name: packageName,
    }));
    return false;
  });
}

function packageExportModuleNames(exports) {
  const moduleNames = new Set();
  for (const refs of Object.values(exports)) {
    for (const targetRef of refs) {
      const moduleName = moduleNameFromQualifiedRef(targetRef);
      if (moduleName !== null) {
        moduleNames.add(moduleName);
      }
    }
  }
  return [...moduleNames].sort();
}

function packageExportsByModule(exports) {
  const byModule = {};
  for (const refs of Object.values(exports)) {
    for (const targetRef of refs) {
      const moduleName = moduleNameFromQualifiedRef(targetRef);
      if (moduleName === null) {
        continue;
      }
      if (byModule[moduleName] === undefined) {
        byModule[moduleName] = [];
      }
      byModule[moduleName].push(targetRef);
    }
  }
  for (const moduleName of Object.keys(byModule)) {
    byModule[moduleName].sort();
  }
  return byModule;
}

function moduleNameFromQualifiedRef(targetRef) {
  const match = /^[a-z]+:([^/]+)\//u.exec(targetRef);
  return match?.[1] ?? null;
}

function packageDeclarationExists(documents, kind, targetRef) {
  return documents.some((document) => declarationExists(document, kind, targetRef));
}

function hasRegistryClaim(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  for (const field of PACKAGE_REGISTRY_FIELDS) {
    if (Object.hasOwn(value, field)) {
      return true;
    }
  }
  return value.provenance?.kind === "registry";
}

function firstAuthorityField(value, path = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (PACKAGE_AUTHORITY_FIELDS.has(key)) {
      return [...path, key].join(".");
    }
    if (key === "touba" || key === "exports" || key === "provenance") {
      const nested = firstAuthorityField(child, [...path, key]);
      if (nested !== null) {
        return nested;
      }
    }
  }
  return null;
}

function findToubaSources(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...findToubaSources(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".tb")) {
      result.push(fullPath);
    }
  }
  return result.sort();
}

function assertCanonicalModuleName(moduleName) {
  if (!MODULE_NAME_PATTERN.test(moduleName)) {
    throw new Error("module name must contain at least two lowercase dotted segments, for example domain.module");
  }
}

function assertSecretHandle(handle) {
  if (!SECRET_HANDLE_PATTERN.test(handle)) {
    throw new Error("secret handles must match [A-Z][A-Z0-9_]*");
  }
}

function secretStorePath(root, storePath = DEFAULT_SECRET_STORE_PATH) {
  return resolve(root, storePath);
}

function ensureProjectGitignore(root, created, preserved) {
  const gitignorePath = join(root, ".gitignore");
  const requiredEntries = [
    ".touba/",
    "*.air.json",
    "*.trace.json",
    ".env",
  ];
  const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  const currentLines = new Set(current.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missing = requiredEntries.filter((entry) => !currentLines.has(entry));
  if (missing.length > 0) {
    const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    writeFileSync(gitignorePath, `${current}${prefix}${missing.join("\n")}\n`, "utf8");
    created.push(gitignorePath);
  } else {
    preserved.push(gitignorePath);
  }
}

function ensureLocalSecretSupport(root, created, preserved) {
  const storePath = secretStorePath(root);
  if (existsSync(storePath)) {
    preserved.push(storePath);
  } else {
    writeLocalSecretStore(storePath, {
      store_version: TOUBA_LOCAL_SECRET_STORE_VERSION,
      secrets: {},
    });
    created.push(storePath);
  }

  const dotenvPath = resolve(root, DEFAULT_DOTENV_PATH);
  if (existsSync(dotenvPath)) {
    preserved.push(dotenvPath);
  } else {
    writeFileSync(dotenvPath, [
      "# Local dotenv secrets for explicit Touba dotenv profiles.",
      "# Prefer touba_store for local development when possible.",
      "",
    ].join("\n"), { encoding: "utf8", mode: 0o600 });
    chmodSync(dotenvPath, 0o600);
    created.push(dotenvPath);
  }
}

function readLocalSecretStore(path) {
  if (!existsSync(path)) {
    return {
      store_version: TOUBA_LOCAL_SECRET_STORE_VERSION,
      secrets: {},
    };
  }
  let document;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read local secret store ${path}: ${error.message}`);
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`local secret store must be an object: ${path}`);
  }
  if (document.store_version !== TOUBA_LOCAL_SECRET_STORE_VERSION) {
    throw new Error(`local secret store version must be ${TOUBA_LOCAL_SECRET_STORE_VERSION}`);
  }
  if (!document.secrets || typeof document.secrets !== "object" || Array.isArray(document.secrets)) {
    throw new Error(`local secret store secrets must be an object: ${path}`);
  }
  const secrets = {};
  for (const [handle, value] of Object.entries(document.secrets)) {
    assertSecretHandle(handle);
    if (typeof value !== "string") {
      throw new Error(`local secret store value must be a string for ${handle}`);
    }
    secrets[handle] = value;
  }
  return {
    store_version: TOUBA_LOCAL_SECRET_STORE_VERSION,
    secrets,
  };
}

function writeLocalSecretStore(path, store) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function secretReport(command, root, storePath, extras = {}) {
  return {
    workflow_version: PROJECT_MANIFEST_VERSION,
    command,
    root,
    store_path: storePath,
    ...extras,
  };
}

function moduleNameToSourcePath(root, moduleName) {
  assertCanonicalModuleName(moduleName);
  const segments = moduleName.split(".");
  const fileName = `${segments.pop()}.tb`;
  return join(root, DEFAULT_SOURCE_ROOT, ...segments, fileName);
}

function resolveProjectConfigForInit(root, requestedLanguage) {
  const path = resolve(root, DEFAULT_PROJECT_CONFIG_PATH);
  const existing = readProjectConfig(path);
  if (existing !== null) {
    const profile = projectLanguageProfile(existing.language);
    if (requestedLanguage !== undefined) {
      const requested = normalizeProjectLanguage(requestedLanguage);
      if (requested !== profile.language) {
        throw new Error(
          `project is already configured for language ${profile.language}; requested ${requested}`,
        );
      }
    }
    return {
      path,
      document: expectedProjectConfigDocument(profile),
    };
  }

  const profile = projectLanguageProfile(requestedLanguage ?? DEFAULT_PROJECT_LANGUAGE);
  return {
    path,
    document: expectedProjectConfigDocument(profile),
  };
}

function resolveProjectConfigForPrepare(root, diagnostics) {
  const path = resolve(root, DEFAULT_PROJECT_CONFIG_PATH);
  try {
    const document = readProjectConfig(path);
    if (document === null) {
      const profile = projectLanguageProfile(DEFAULT_PROJECT_LANGUAGE);
      return { path, document: null, profile };
    }
    const profile = projectLanguageProfile(document.language);
    return { path, document, profile };
  } catch (error) {
    diagnostics.push(errorDiagnostic("ProjectConfigInvalid", error.message, {
      project_config_path: path,
    }));
    return {
      path,
      document: null,
      profile: projectLanguageProfile(DEFAULT_PROJECT_LANGUAGE),
    };
  }
}

function normalizeProjectLanguage(language) {
  if (typeof language !== "string" || language.trim() === "") {
    throw new Error("project language must be a non-empty string");
  }
  const normalized = PROJECT_LANGUAGE_ALIASES.get(language.trim().toLowerCase()) ?? language.trim().toLowerCase();
  return normalized;
}

function projectLanguageProfile(language) {
  const normalized = normalizeProjectLanguage(language);
  const profile = PROJECT_LANGUAGE_PROFILES[normalized];
  if (profile !== undefined) {
    return profile;
  }
  if (RESERVED_PROJECT_LANGUAGES.has(normalized)) {
    throw new Error(`project language ${normalized} is not available in this V1; choose javascript`);
  }
  throw new Error(`unsupported project language ${normalized}; supported language: javascript`);
}

function expectedProjectConfigDocument(profile) {
  return {
    project_version: TOUBA_PROJECT_CONFIG_VERSION,
    language: profile.language,
    sdk: profile.sdk,
    run_profiles: cloneJson(DEFAULT_RUN_PROFILES),
  };
}

function readProjectConfig(path) {
  if (!existsSync(path)) {
    return null;
  }
  let document;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read project config ${path}: ${error.message}`);
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`project config must be an object: ${path}`);
  }
  if (document.project_version !== TOUBA_PROJECT_CONFIG_VERSION) {
    throw new Error(`project config project_version must be ${TOUBA_PROJECT_CONFIG_VERSION}`);
  }
  if (typeof document.language !== "string" || document.language.trim() === "") {
    throw new Error("project config language must be a non-empty string");
  }
  const profile = projectLanguageProfile(document.language);
  if (document.sdk !== profile.sdk) {
    throw new Error(`project config sdk must be ${profile.sdk} for language ${profile.language}`);
  }
  return {
    project_version: TOUBA_PROJECT_CONFIG_VERSION,
    language: profile.language,
    sdk: profile.sdk,
    run_profiles: normalizeRunProfiles(document.run_profiles),
    packages: normalizeProjectPackages(document.packages),
  };
}

function normalizeProjectPackages(packages) {
  if (packages === undefined) {
    return [];
  }
  if (!Array.isArray(packages)) {
    throw new Error("project config packages must be an array");
  }
  return packages.map((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`project config package ${index} must be an object`);
    }
    return { ...record };
  });
}

export function applyRunProfileToArgs(rawArgs, options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const { profileName, args } = extractRunProfile(rawArgs);
  if (profileName === undefined) {
    return [...rawArgs];
  }
  const projectConfigPath = resolve(root, DEFAULT_PROJECT_CONFIG_PATH);
  const projectConfig = readProjectConfig(projectConfigPath);
  if (projectConfig === null) {
    throw new Error(`run profile ${profileName} requires ${DEFAULT_PROJECT_CONFIG_PATH} in ${root}`);
  }
  const profile = projectConfig.run_profiles[profileName];
  if (profile === undefined) {
    throw new Error(`unknown run profile ${profileName}; available profiles: ${Object.keys(projectConfig.run_profiles).sort().join(", ")}`);
  }

  const nextArgs = [...args];
  if (profile.require_supply_chain_lock === true) {
    if (!hasLongOption(nextArgs, "--supply-chain-lock")) {
      nextArgs.push("--supply-chain-lock", resolve(root, profile.supply_chain_lock));
    }
    if (!hasLongOption(nextArgs, "--require-supply-chain-lock")) {
      nextArgs.push("--require-supply-chain-lock");
    }
  }
  return nextArgs;
}

function extractRunProfile(rawArgs) {
  const args = [];
  let profileName;
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--profile") {
      if (profileName !== undefined) {
        throw new Error("--profile cannot be provided more than once");
      }
      index += 1;
      if (index >= rawArgs.length || rawArgs[index].startsWith("--")) {
        throw new Error("--profile requires a value");
      }
      profileName = rawArgs[index];
      continue;
    }
    if (arg.startsWith("--profile=")) {
      if (profileName !== undefined) {
        throw new Error("--profile cannot be provided more than once");
      }
      profileName = arg.slice("--profile=".length);
      continue;
    }
    args.push(arg);
  }
  if (profileName !== undefined && !RUN_PROFILE_PATTERN.test(profileName)) {
    throw new Error("run profile names must match [a-z][a-z0-9_-]*");
  }
  return { profileName, args };
}

function hasLongOption(args, option) {
  return args.some((arg) => arg === option || arg.startsWith(`${option}=`));
}

function normalizeRunProfiles(runProfiles) {
  if (runProfiles === undefined) {
    return cloneJson(DEFAULT_RUN_PROFILES);
  }
  if (!runProfiles || typeof runProfiles !== "object" || Array.isArray(runProfiles)) {
    throw new Error("project config run_profiles must be an object");
  }
  const normalized = {};
  for (const [name, profile] of Object.entries(runProfiles)) {
    if (!RUN_PROFILE_PATTERN.test(name)) {
      throw new Error(`run profile name is invalid: ${name}`);
    }
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      throw new Error(`run profile ${name} must be an object`);
    }
    const requireLock = profile.require_supply_chain_lock === true;
    if (profile.require_supply_chain_lock !== undefined && typeof profile.require_supply_chain_lock !== "boolean") {
      throw new Error(`run profile ${name} require_supply_chain_lock must be boolean`);
    }
    const normalizedProfile = {
      require_supply_chain_lock: requireLock,
    };
    if (profile.supply_chain_lock !== undefined) {
      if (typeof profile.supply_chain_lock !== "string" || profile.supply_chain_lock.trim() === "") {
        throw new Error(`run profile ${name} supply_chain_lock must be a non-empty string`);
      }
      normalizedProfile.supply_chain_lock = profile.supply_chain_lock;
    }
    if (requireLock && normalizedProfile.supply_chain_lock === undefined) {
      throw new Error(`run profile ${name} requires supply_chain_lock when require_supply_chain_lock is true`);
    }
    normalized[name] = normalizedProfile;
  }
  if (Object.keys(normalized).length === 0) {
    throw new Error("project config run_profiles must declare at least one profile");
  }
  return normalized;
}

function ensureProjectConfig(root, document, created, preserved) {
  const path = resolve(root, DEFAULT_PROJECT_CONFIG_PATH);
  if (existsSync(path)) {
    const current = readProjectConfig(path);
    if (current.language !== document.language) {
      throw new Error(
        `project config language ${current.language} does not match requested language ${document.language}`,
      );
    }
    preserved.push(path);
    return;
  }
  writeProjectConfig(path, document);
  created.push(path);
}

function writeProjectConfig(path, document) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

function expectedModuleNameForSource(root, sourcePath) {
  const sourceRoot = join(root, DEFAULT_SOURCE_ROOT);
  const relativePath = relative(sourceRoot, sourcePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath) || !sourcePath.endsWith(".tb")) {
    return null;
  }
  const withoutExtension = relativePath.slice(0, -".tb".length);
  return withoutExtension.split(sep).join(".");
}

async function compileSource(sourcePath, options) {
  if (typeof options.compileSource === "function") {
    return options.compileSource(sourcePath);
  }
  return compileSourceWithCargo(sourcePath, options);
}

function compileSourceWithCargo(sourcePath, options = {}) {
  const implementationRoot = options.implementationRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const configuredCompiler = options.compileCommand ?? process.env.TOUBA_COMPILE_BIN;
  if (configuredCompiler) {
    return compileSourceWithCommand(configuredCompiler, [sourcePath], {
      cwd: options.cwd ?? process.cwd(),
    });
  }

  const executableName = process.platform === "win32" ? "touba-compile.exe" : "touba-compile";
  const localCompiler = newestExistingCompiler([
    join(implementationRoot, "target", "release", executableName),
    join(implementationRoot, "target", "debug", executableName),
  ]);
  if (existsSync(localCompiler)) {
    return compileSourceWithCommand(localCompiler, [sourcePath], {
      cwd: implementationRoot,
    });
  }

  const cargo = options.cargoCommand ?? process.env.CARGO ?? "cargo";
  return compileSourceWithCommand(cargo, [
    "run",
    "-p",
    "touba-cli",
    "--bin",
    "touba-compile",
    "--quiet",
    "--",
    sourcePath,
  ], {
    cwd: implementationRoot,
  });
}

function newestExistingCompiler(paths) {
  let selected = paths[0];
  let selectedMtime = -1;
  for (const candidate of paths) {
    if (!existsSync(candidate)) {
      continue;
    }
    const mtime = statSync(candidate).mtimeMs;
    if (mtime > selectedMtime) {
      selected = candidate;
      selectedMtime = mtime;
    }
  }
  return selected;
}

function compileSourceWithCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || "").trim();
    throw new Error(details || `touba-compile exited with code ${result.status}`);
  }
  return JSON.parse(result.stdout);
}

function airOutputPath(root, moduleName) {
  const segments = String(moduleName).split(".");
  const fileName = `${segments.pop()}.air.json`;
  return join(root, DEFAULT_AIR_ROOT, ...segments, fileName);
}

function assemblePrepareAirDocuments(entries, options = {}) {
  const diagnostics = [];
  const imports = [];
  const byModule = new Map();
  const rootModuleNames = new Set(options.rootModuleNames ?? []);
  const packageMembership = options.packageMembership ?? new Map();
  const packageExportsByModule = options.packageExportsByModule ?? new Map();

  for (const entry of entries) {
    const moduleName = entry.document?.module?.name;
    if (!moduleName) {
      diagnostics.push(errorDiagnostic("InvalidAirDocument", "AIR document must contain module.name"));
      continue;
    }
    if (byModule.has(moduleName)) {
      diagnostics.push(errorDiagnostic("DuplicateProjectModule", `duplicate AIR module ${moduleName}`, {
        module_name: moduleName,
      }));
      continue;
    }
    byModule.set(moduleName, entry.document);
  }

  const effectiveRootModuleNames = rootModuleNames.size > 0
    ? rootModuleNames
    : new Set(entries.map((entry) => entry.document?.module?.name).filter(Boolean));
  const assembledEntries = entries.filter((entry) => effectiveRootModuleNames.has(entry.document?.module?.name)).map((entry) => {
    const result = assembleEntryAirDocument(entry.document, byModule, {
      packageMembership,
      packageExportsByModule,
    });
    diagnostics.push(...result.diagnostics);
    imports.push(...result.imports);
    return {
      ...entry,
      document: result.document ?? entry.document,
    };
  });

  return {
    entries: assembledEntries,
    imports: imports.sort((left, right) => {
      const moduleCompare = left.module_name.localeCompare(right.module_name);
      return moduleCompare === 0 ? left.target_ref.localeCompare(right.target_ref) : moduleCompare;
    }),
    diagnostics,
  };
}

function assembleEntryAirDocument(entryDocument, byModule, options = {}) {
  const diagnostics = [];
  const imports = [];
  const activeModules = [];
  const visitedModules = new Set();

  validateAirImports(entryDocument, byModule, diagnostics, activeModules, visitedModules, {
    packageMembership: options.packageMembership ?? new Map(),
    packageExportsByModule: options.packageExportsByModule ?? new Map(),
  });
  if (hasErrorDiagnostics(diagnostics)) {
    return { document: null, imports, diagnostics };
  }

  const assembled = cloneJson(entryDocument);
  if (!Array.isArray(assembled.imports)) {
    assembled.imports = [];
  }
  if (!Array.isArray(assembled.execution_graphs)) {
    assembled.execution_graphs = [];
  }
  if (!Array.isArray(assembled.trace_points)) {
    assembled.trace_points = [];
  }
  for (const collection of ["types", "constants", "functions", "tools", "skills", "agents", "strategies", "memories", "triggers"]) {
    ensureDefinitionArray(assembled.definitions, collection);
  }
  const seenDefinitions = localDefinitionIds(assembled.definitions);
  const seenGraphs = new Set((assembled.execution_graphs ?? []).map((graph) => graph.id));
  const seenTracePoints = new Set((assembled.trace_points ?? []).map((trace) => trace.id));
  const seenImports = new Set((assembled.imports ?? []).map((item) => item.target_ref));
  const activeRefs = [];

  function includeModuleImports(document) {
    for (const item of document.imports ?? []) {
      if (seenImports.has(item.target_ref) === false) {
        seenImports.add(item.target_ref);
        assembled.imports.push(cloneJson(item));
      }
      imports.push({
        status: "resolved",
        module_name: entryDocument.module.name,
        import_name: item.name,
        import_kind: item.kind,
        from_module: item.from_module,
        target_ref: item.target_ref,
      });
      includeRef(item.target_ref, item.source_ref);
      const sourceDocument = byModule.get(item.from_module);
      if (sourceDocument) {
        includeModuleImports(sourceDocument);
      }
    }
  }

  function includeRef(targetRef, sourceRef) {
    if (seenDefinitions.has(targetRef)) {
      return;
    }
    if (activeRefs.includes(targetRef)) {
      diagnostics.push(errorDiagnostic("ImportCycleDetected", `definition dependency cycle detected at ${targetRef}`, {
        target_ref: targetRef,
        source_ref: sourceRef,
      }));
      return;
    }
    activeRefs.push(targetRef);
    if (targetRef.startsWith("type:")) {
      includeType(targetRef, sourceRef);
    } else if (targetRef.startsWith("constant:")) {
      includeConstant(targetRef, sourceRef);
    } else if (targetRef.startsWith("function:")) {
      includeFunction(targetRef, sourceRef);
    } else if (targetRef.startsWith("tool:")) {
      includeTool(targetRef, sourceRef);
    } else if (targetRef.startsWith("skill:")) {
      includeSkill(targetRef, sourceRef);
    } else if (targetRef.startsWith("agent:")) {
      includeAgent(targetRef, sourceRef);
    } else if (targetRef.startsWith("strategy:")) {
      includeStrategy(targetRef, sourceRef);
    } else if (targetRef.startsWith("memory:")) {
      includeMemory(targetRef, sourceRef);
    }
    activeRefs.pop();
  }

  function includeType(targetRef, sourceRef) {
    const located = findDefinitionByRef(byModule, "types", targetRef);
    if (!located) {
      pushMissingDependency(diagnostics, targetRef, sourceRef);
      return;
    }
    for (const field of located.definition.fields ?? []) {
      includeTypeRef(field.type_ref, field.source_ref);
    }
    if (!seenDefinitions.has(located.definition.id)) {
      seenDefinitions.add(located.definition.id);
      assembled.definitions.types.push(cloneJson(located.definition));
    }
    includeModuleImports(located.document);
  }

  function includeConstant(targetRef, sourceRef) {
    const located = findDefinitionByRef(byModule, "constants", targetRef);
    if (!located) {
      pushMissingDependency(diagnostics, targetRef, sourceRef);
      return;
    }
    includeTypeRef(located.definition.type_ref, located.definition.source_ref);
    if (!seenDefinitions.has(located.definition.id)) {
      seenDefinitions.add(located.definition.id);
      ensureDefinitionArray(assembled.definitions, "constants").push(cloneJson(located.definition));
    }
    includeModuleImports(located.document);
  }

  function includeFunction(targetRef, sourceRef) {
    const located = findDefinitionByRef(byModule, "functions", targetRef);
    if (!located) {
      pushMissingDependency(diagnostics, targetRef, sourceRef);
      return;
    }
    const signature = located.definition.signature ?? {};
    for (const input of signature.inputs ?? []) {
      includeTypeRef(input.type_ref, input.source_ref);
    }
    includeTypeRef(signature.output_type, located.definition.source_ref);

    const graph = (located.document.execution_graphs ?? [])
      .find((candidate) => candidate.id === located.definition.body_graph_ref);
    if (!graph) {
      pushMissingDependency(diagnostics, located.definition.body_graph_ref, located.definition.source_ref);
      return;
    }
    validateImportedFunctionPurity(located.definition, graph, diagnostics);
    includeGraphDependencies(graph);

    if (!seenDefinitions.has(located.definition.id)) {
      seenDefinitions.add(located.definition.id);
      assembled.definitions.functions.push(cloneJson(located.definition));
    }
    includeGraph(graph, located.document);
    includeModuleImports(located.document);
  }

  function includeTool(targetRef, sourceRef) {
    const located = findDefinitionByRef(byModule, "tools", targetRef);
    if (!located) {
      pushMissingDependency(diagnostics, targetRef, sourceRef);
      return;
    }
    const signature = located.definition.signature ?? {};
    includeSignature(signature, located.definition.source_ref);
    includeMemoryAccesses(located.definition.memory_accesses ?? []);

    if (!seenDefinitions.has(located.definition.id)) {
      seenDefinitions.add(located.definition.id);
      ensureDefinitionArray(assembled.definitions, "tools").push(cloneJson(located.definition));
    }
    includeModuleImports(located.document);
  }

  function includeSkill(targetRef, sourceRef) {
    const located = findDefinitionByRef(byModule, "skills", targetRef);
    if (!located) {
      pushMissingDependency(diagnostics, targetRef, sourceRef);
      return;
    }
    includeSignature(located.definition.signature ?? {}, located.definition.source_ref);
    includeUseRefs(located.definition.use_refs ?? []);
    includeMemoryScopes(located.definition.memory_scopes ?? []);

    const graph = (located.document.execution_graphs ?? [])
      .find((candidate) => candidate.id === located.definition.flow_graph_ref);
    if (!graph) {
      pushMissingDependency(diagnostics, located.definition.flow_graph_ref, located.definition.source_ref);
      return;
    }
    includeGraphDependencies(graph);

    if (!seenDefinitions.has(located.definition.id)) {
      seenDefinitions.add(located.definition.id);
      ensureDefinitionArray(assembled.definitions, "skills").push(cloneJson(located.definition));
    }
    includeGraph(graph, located.document);
    includeModuleImports(located.document);
  }

  function includeAgent(targetRef, sourceRef) {
    const located = findDefinitionByRef(byModule, "agents", targetRef);
    if (!located) {
      pushMissingDependency(diagnostics, targetRef, sourceRef);
      return;
    }
    includeUseRefs(located.definition.use_refs ?? []);
    includeMemoryScopes(located.definition.memory_scopes ?? []);
    validateCallableByRefs(located.definition);

    if (!seenDefinitions.has(located.definition.id)) {
      seenDefinitions.add(located.definition.id);
      ensureDefinitionArray(assembled.definitions, "agents").push(cloneJson(located.definition));
    }
    includeModuleImports(located.document);
  }

  function includeStrategy(targetRef, sourceRef) {
    const located = findDefinitionByRef(byModule, "strategies", targetRef);
    if (!located) {
      pushMissingDependency(diagnostics, targetRef, sourceRef);
      return;
    }
    if (located.definition.signature) {
      includeSignature(located.definition.signature, located.definition.source_ref);
    }
    includeUseRefs(located.definition.use_refs ?? []);
    includeMemoryScopes(located.definition.memory_scopes ?? []);

    const graph = (located.document.execution_graphs ?? [])
      .find((candidate) => candidate.id === located.definition.flow_graph_ref);
    if (!graph) {
      pushMissingDependency(diagnostics, located.definition.flow_graph_ref, located.definition.source_ref);
      return;
    }
    includeGraphDependencies(graph);

    if (!seenDefinitions.has(located.definition.id)) {
      seenDefinitions.add(located.definition.id);
      ensureDefinitionArray(assembled.definitions, "strategies").push(cloneJson(located.definition));
    }
    includeGraph(graph, located.document);
    includeModuleImports(located.document);
  }

  function includeMemory(targetRef, sourceRef) {
    const located = findDefinitionByRef(byModule, "memories", targetRef);
    if (!located) {
      pushMissingDependency(diagnostics, targetRef, sourceRef);
      return;
    }
    if (!seenDefinitions.has(located.definition.id)) {
      seenDefinitions.add(located.definition.id);
      ensureDefinitionArray(assembled.definitions, "memories").push(cloneJson(located.definition));
    }
    includeModuleImports(located.document);
  }

  function includeSignature(signature, sourceRef) {
    for (const input of signature.inputs ?? []) {
      includeTypeRef(input.type_ref, input.source_ref);
    }
    includeTypeRef(signature.output_type, sourceRef);
  }

  function includeUseRefs(useRefs) {
    for (const usage of useRefs) {
      includeRef(usage.target_ref, usage.source_ref);
    }
  }

  function includeMemoryScopes(scopes) {
    for (const scope of scopes) {
      includeRef(scope.memory_ref, scope.source_ref);
    }
  }

  function includeMemoryAccesses(accesses) {
    for (const access of accesses) {
      includeRef(access.memory_ref, access.source_ref);
    }
  }

  function validateCallableByRefs(agent) {
    for (const caller of agent.callable_by ?? []) {
      if (!declarationExistsByRef(byModule, caller.caller_ref)) {
        diagnostics.push(errorDiagnostic("ImportDeclarationNotFound", `agent ${agent.id} declares callable_by caller ${caller.caller_ref} that is not present in the assembled project`, {
          agent_ref: agent.id,
          caller_ref: caller.caller_ref,
          source_ref: caller.source_ref,
        }));
      }
    }
  }

  function validateAgentCallAuthority(callerRef, agentRef, sourceRef) {
    const located = findDefinitionByRef(byModule, "agents", agentRef);
    if (!located) {
      return;
    }
    const allowed = (located.definition.callable_by ?? [])
      .some((rule) => rule.caller_ref === callerRef);
    if (!allowed) {
      diagnostics.push(errorDiagnostic("AgentCallerNotAllowed", `${callerRef} cannot call agent ${agentRef} without a matching callable_by rule`, {
        caller_ref: callerRef,
        agent_ref: agentRef,
        source_ref: sourceRef,
      }));
    }
  }

  function ownerMemoryScopes(ownerRef) {
    for (const document of byModule.values()) {
      const owner = [
        ...(document.definitions?.skills ?? []),
        ...(document.definitions?.agents ?? []),
        ...(document.definitions?.strategies ?? []),
      ].find((candidate) => candidate.id === ownerRef);
      if (owner) {
        return owner.memory_scopes ?? [];
      }
    }
    return [];
  }

  function validateToolMemoryAccess(ownerRef, toolRef, sourceRef) {
    const located = findDefinitionByRef(byModule, "tools", toolRef);
    if (!located) {
      return;
    }
    const accesses = located.definition.memory_accesses ?? [];
    if (accesses.length === 0) {
      return;
    }
    const scopes = ownerMemoryScopes(ownerRef);
    for (const access of accesses) {
      const allowed = scopes.some((scope) => (
        scope.memory_ref === access.memory_ref && scope.access === access.access
      ));
      if (!allowed) {
        diagnostics.push(errorDiagnostic("OwnerMemoryScopeMissing", `${ownerRef} cannot access ${access.memory_ref} with ${access.access} without an explicit memory scope`, {
          owner_ref: ownerRef,
          tool_ref: toolRef,
          memory_ref: access.memory_ref,
          access: access.access,
          source_ref: sourceRef,
        }));
      }
    }
  }

  function validateTriggerArguments(trigger) {
    const located = findDefinitionByRef(byModule, "strategies", trigger.target_ref);
    if (!located) {
      return;
    }
    const inputs = located.definition.signature?.inputs ?? [];
    const byName = new Set();
    for (const argument of trigger.arguments ?? []) {
      if (byName.has(argument.input)) {
        diagnostics.push(errorDiagnostic("DuplicateTriggerArgument", `trigger argument ${argument.input} is provided more than once`, {
          trigger_ref: trigger.id,
          input: argument.input,
          source_ref: argument.source_ref,
        }));
      }
      byName.add(argument.input);
      if (!inputs.some((input) => input.name === argument.input)) {
        diagnostics.push(errorDiagnostic("UnknownTriggerArgument", `trigger argument ${argument.input} does not match target strategy ${trigger.target_ref}`, {
          trigger_ref: trigger.id,
          target_ref: trigger.target_ref,
          input: argument.input,
          source_ref: argument.source_ref,
        }));
      }
    }
    for (const input of inputs) {
      const argument = (trigger.arguments ?? []).find((candidate) => candidate.input === input.name);
      if (!argument) {
        diagnostics.push(errorDiagnostic("MissingTriggerArgument", `trigger ${trigger.name} must provide strategy argument ${input.name}`, {
          trigger_ref: trigger.id,
          target_ref: trigger.target_ref,
          input: input.name,
          source_ref: trigger.source_ref,
        }));
        continue;
      }
      const actualType = triggerValueRefType(argument.value_ref);
      if (actualType && !triggerArgumentAssignable(actualType, input.type_ref)) {
        diagnostics.push(errorDiagnostic("InvalidTriggerArgument", `trigger argument ${input.name} has type ${actualType} but target strategy expects ${input.type_ref}`, {
          trigger_ref: trigger.id,
          input: input.name,
          actual_type: actualType,
          expected_type: input.type_ref,
          source_ref: argument.source_ref,
        }));
      }
    }
  }

  function includeGraphDependencies(graph) {
    for (const node of graph.nodes ?? []) {
      if (node.kind === "call_agent" && typeof node.target_ref === "string") {
        validateAgentCallAuthority(graph.owner_ref, node.target_ref, node.source_ref);
      }
      if (node.kind === "call_tool" && typeof node.target_ref === "string") {
        validateToolMemoryAccess(graph.owner_ref, node.target_ref, node.source_ref);
      }
      includeValueRef(node.target_ref, node.source_ref);
      for (const argument of node.arguments ?? []) {
        includeValueRef(argument, node.source_ref);
      }
      includeValueRef(node.condition_ref, node.source_ref);
    }
    for (const expression of graph.expressions ?? []) {
      includeValueRef(expression.value_ref, expression.source_ref);
      includeTypeRef(expression.type_ref, expression.source_ref);
      for (const operand of expression.operands ?? []) {
        includeValueRef(operand, expression.source_ref);
      }
    }
  }

  function includeGraph(graph, sourceDocument) {
    if (!seenGraphs.has(graph.id)) {
      seenGraphs.add(graph.id);
      assembled.execution_graphs.push(cloneJson(graph));
    }
    for (const trace of sourceDocument.trace_points ?? []) {
      if (trace.owner_ref === graph.id && !seenTracePoints.has(trace.id)) {
        seenTracePoints.add(trace.id);
        assembled.trace_points.push(cloneJson(trace));
      }
    }
  }

  function includeTypeRef(typeRef, sourceRef) {
    if (typeof typeRef !== "string") {
      return;
    }
    if (typeRef.startsWith("list:")) {
      includeTypeRef(typeRef.slice("list:".length), sourceRef);
      return;
    }
    if (typeRef.startsWith("type:")) {
      includeRef(typeRef, sourceRef);
    }
  }

  function includeValueRef(valueRef, sourceRef) {
    if (typeof valueRef !== "string") {
      return;
    }
    if (
      valueRef.startsWith("type:")
      || valueRef.startsWith("constant:")
      || valueRef.startsWith("function:")
      || valueRef.startsWith("tool:")
      || valueRef.startsWith("skill:")
      || valueRef.startsWith("agent:")
      || valueRef.startsWith("strategy:")
      || valueRef.startsWith("memory:")
    ) {
      includeRef(valueRef, sourceRef);
    }
  }

  includeModuleImports(entryDocument);
  for (const graph of entryDocument.execution_graphs ?? []) {
    includeGraphDependencies(graph);
  }
  for (const trigger of entryDocument.definitions?.triggers ?? []) {
    includeRef(trigger.target_ref, trigger.source_ref);
    validateTriggerArguments(trigger);
  }

  return {
    document: hasErrorDiagnostics(diagnostics) ? null : assembled,
    imports,
    diagnostics,
  };
}

function validateAirImports(document, byModule, diagnostics, activeModules, visitedModules, options = {}) {
  const moduleName = document?.module?.name;
  if (!moduleName || activeModules.includes(moduleName)) {
    return;
  }
  if (visitedModules.has(moduleName)) {
    return;
  }
  visitedModules.add(moduleName);
  activeModules.push(moduleName);

  for (const item of document.imports ?? []) {
    if (!["type", "define", "function", "tool", "skill", "agent", "strategy", "memory"].includes(item.kind)) {
      diagnostics.push(errorDiagnostic("ImportKindUnsupported", `import kind ${item.kind} is outside supported project imports`, {
        module_name: moduleName,
        import_name: item.name,
      }));
      continue;
    }
    const sourceDocument = byModule.get(item.from_module);
    if (!sourceDocument) {
      diagnostics.push(errorDiagnostic("ImportModuleNotFound", `import ${item.name} references missing module ${item.from_module}`, {
        module_name: moduleName,
        import_name: item.name,
        from_module: item.from_module,
        target_ref: item.target_ref,
      }));
      continue;
    }
    if (activeModules.includes(sourceDocument.module.name)) {
      diagnostics.push(errorDiagnostic("ImportCycleDetected", `import ${item.name} creates an unsupported IM-1 module cycle through ${sourceDocument.module.name}`, {
        module_name: moduleName,
        import_name: item.name,
        from_module: item.from_module,
        target_ref: item.target_ref,
      }));
      continue;
    }
    const sourcePackage = options.packageMembership?.get(item.from_module);
    const importerPackage = options.packageMembership?.get(moduleName);
    if (sourcePackage !== undefined && sourcePackage !== importerPackage) {
      const exportsForModule = options.packageExportsByModule?.get(item.from_module) ?? new Set();
      if (!exportsForModule.has(item.target_ref)) {
        diagnostics.push(errorDiagnostic("PackageExportMissing", `import ${item.name} references ${item.target_ref}, but package ${sourcePackage} does not export it`, {
          module_name: moduleName,
          import_name: item.name,
          from_module: item.from_module,
          package_name: sourcePackage,
          target_ref: item.target_ref,
        }));
        continue;
      }
    }
    if (!declarationExists(sourceDocument, item.kind, item.target_ref)) {
      if (declarationNameExists(sourceDocument, item.name)) {
        diagnostics.push(errorDiagnostic("ImportKindMismatch", `import ${item.name} requests kind ${item.kind} but the source declaration has a different kind`, {
          module_name: moduleName,
          import_name: item.name,
          from_module: item.from_module,
          target_ref: item.target_ref,
        }));
      } else {
        diagnostics.push(errorDiagnostic("ImportDeclarationNotFound", `import ${item.name} references no ${item.kind} declaration in module ${item.from_module}`, {
          module_name: moduleName,
          import_name: item.name,
          from_module: item.from_module,
          target_ref: item.target_ref,
        }));
      }
      continue;
    }
    validateAirImports(sourceDocument, byModule, diagnostics, activeModules, visitedModules, options);
  }

  activeModules.pop();
}

function validateImportedFunctionPurity(functionDeclaration, graph, diagnostics) {
  const allowed = new Set(["call_function", "bind", "branch", "loop", "give", "stop"]);
  for (const node of graph.nodes ?? []) {
    if (!allowed.has(node.kind)) {
      diagnostics.push(errorDiagnostic("ImportFunctionNotPure", `imported function ${functionDeclaration.id} is not pure enough for IM-1 because its graph contains ${node.kind}`, {
        function_ref: functionDeclaration.id,
        node_id: node.id,
      }));
    }
  }
}

function declarationExists(document, kind, targetRef) {
  const collection = kind === "type"
    ? "types"
    : kind === "define"
      ? "constants"
      : kind === "function"
        ? "functions"
        : kind === "tool"
          ? "tools"
          : kind === "skill"
            ? "skills"
            : kind === "agent"
              ? "agents"
              : kind === "strategy"
                ? "strategies"
                : kind === "memory"
                  ? "memories"
                  : null;
  return collection !== null && (document.definitions?.[collection] ?? []).some((item) => item.id === targetRef);
}

function declarationExistsByRef(byModule, targetRef) {
  const collection = typeof targetRef === "string" && targetRef.startsWith("type:")
    ? "types"
    : typeof targetRef === "string" && targetRef.startsWith("constant:")
      ? "constants"
      : typeof targetRef === "string" && targetRef.startsWith("function:")
        ? "functions"
        : typeof targetRef === "string" && targetRef.startsWith("tool:")
          ? "tools"
          : typeof targetRef === "string" && targetRef.startsWith("skill:")
            ? "skills"
            : typeof targetRef === "string" && targetRef.startsWith("agent:")
              ? "agents"
              : typeof targetRef === "string" && targetRef.startsWith("strategy:")
                ? "strategies"
                : typeof targetRef === "string" && targetRef.startsWith("memory:")
                  ? "memories"
                  : null;
  if (collection === null) {
    return false;
  }
  for (const document of byModule.values()) {
    if ((document.definitions?.[collection] ?? []).some((item) => item.id === targetRef)) {
      return true;
    }
  }
  return false;
}

function declarationNameExists(document, name) {
  return ["types", "constants", "functions", "tools", "skills", "agents", "strategies", "memories"].some((collection) => (
    document.definitions?.[collection] ?? []
  ).some((item) => item.name === name));
}

function triggerValueRefType(valueRef) {
  if (typeof valueRef !== "string") {
    return null;
  }
  if (valueRef.startsWith("literal:string:")) return "builtin:Text";
  if (valueRef.startsWith("literal:bool:")) return "builtin:Boolean";
  if (valueRef.startsWith("literal:int:")) return "builtin:Int";
  if (valueRef.startsWith("literal:float:")) return "builtin:Float";
  return null;
}

function triggerArgumentAssignable(actualType, expectedType) {
  return actualType === expectedType || (actualType === "builtin:Int" && expectedType === "builtin:Float");
}

function findDefinitionByRef(byModule, collection, targetRef) {
  for (const document of byModule.values()) {
    const definition = (document.definitions?.[collection] ?? [])
      .find((candidate) => candidate.id === targetRef);
    if (definition) {
      return { document, definition };
    }
  }
  return null;
}

function pushMissingDependency(diagnostics, targetRef, sourceRef) {
  diagnostics.push(errorDiagnostic("ImportDeclarationNotFound", `project AIR assembly cannot resolve dependency ${targetRef}`, {
    target_ref: targetRef,
    source_ref: sourceRef,
  }));
}

function localDefinitionIds(definitions) {
  const ids = new Set();
  for (const collection of ["types", "constants", "functions", "tools", "skills", "agents", "strategies", "memories", "triggers"]) {
    for (const item of definitions?.[collection] ?? []) {
      if (typeof item.id === "string") {
        ids.add(item.id);
      }
    }
  }
  return ids;
}

function ensureDefinitionArray(definitions, collection) {
  if (!Array.isArray(definitions[collection])) {
    definitions[collection] = [];
  }
  return definitions[collection];
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function findForbiddenBindingFragmentAuthorityField(value, path = []) {
  if (!value || typeof value !== "object") {
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (BINDING_FRAGMENT_AUTHORITY_FIELDS.has(key)) {
      return [...path, key].join(".");
    }
    const nested = findForbiddenBindingFragmentAuthorityField(child, [...path, key]);
    if (nested !== null) {
      return nested;
    }
  }
  return null;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0 && POSITIVE_INTEGER_PATTERN.test(String(value));
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 && NON_NEGATIVE_INTEGER_PATTERN.test(String(value));
}

function buildExpectedManifest(airDocuments, options) {
  const bindings = {};
  for (const document of airDocuments) {
    for (const tool of document.definitions.tools) {
      bindings[tool.id] = expectedBindingForTool(tool, options);
    }
  }
  const manifest = {
    manifest_version: TOUBA_MANIFEST_VERSION,
    bindings: Object.fromEntries(Object.entries(bindings).sort(([a], [b]) => a.localeCompare(b))),
  };
  const agentSecretScopes = inferAgentSecretScopes(airDocuments);
  if (Object.keys(agentSecretScopes).length > 0) {
    manifest.agent_secret_scopes = agentSecretScopes;
  }
  return manifest;
}

function inferAgentSecretScopes(airDocuments) {
  const toolSecrets = new Map();
  const usesByRef = new Map();
  const agents = [];

  for (const document of airDocuments) {
    for (const tool of document.definitions.tools ?? []) {
      const secrets = normalizeStringArray(tool.required_secrets);
      toolSecrets.set(tool.id, secrets);
    }
    for (const collection of ["functions", "tools", "skills", "strategies", "agents"]) {
      for (const definition of document.definitions?.[collection] ?? []) {
        if (typeof definition.id === "string") {
          usesByRef.set(definition.id, normalizeUseRefs(definition));
        }
      }
    }
    for (const agent of document.definitions?.agents ?? []) {
      if (typeof agent.id === "string") {
        agents.push(agent);
      }
    }
  }

  const scopes = {};
  for (const agent of agents) {
    const secrets = collectReachableToolSecrets(agent.id, usesByRef, toolSecrets);
    if (secrets.length > 0) {
      scopes[agent.id] = secrets;
    }
  }
  return Object.fromEntries(Object.entries(scopes).sort(([a], [b]) => a.localeCompare(b)));
}

function normalizeUseRefs(definition) {
  const refs = [];
  for (const ref of normalizeStringArray(definition.uses)) {
    refs.push(ref);
  }
  if (Array.isArray(definition.use_refs)) {
    for (const record of definition.use_refs) {
      if (record && typeof record === "object" && typeof record.target_ref === "string") {
        refs.push(record.target_ref);
      }
    }
  }
  return [...new Set(refs)].sort();
}

function collectReachableToolSecrets(rootRef, usesByRef, toolSecrets) {
  const pending = [...(usesByRef.get(rootRef) ?? [])];
  const visited = new Set([rootRef]);
  const secrets = new Set();

  while (pending.length > 0) {
    const ref = pending.shift();
    if (typeof ref !== "string" || visited.has(ref)) {
      continue;
    }
    visited.add(ref);

    for (const secret of toolSecrets.get(ref) ?? []) {
      secrets.add(secret);
    }
    for (const nextRef of usesByRef.get(ref) ?? []) {
      if (!visited.has(nextRef)) {
        pending.push(nextRef);
      }
    }
  }

  return [...secrets].sort();
}

function composeBindingFragments({ fragmentPaths, expectedManifest, diagnostics, actions, mode }) {
  const manifest = cloneJson(expectedManifest);
  const knownToolRefs = new Set(Object.keys(expectedManifest.bindings));
  const seenBindings = new Map();
  const fragments = [];

  for (const fragmentPath of fragmentPaths) {
    const fragment = readBindingFragment(fragmentPath, diagnostics);
    if (fragment === null) {
      continue;
    }

    const bindingEntries = Object.entries(fragment.bindings);
    fragments.push({
      path: fragmentPath,
      source: fragment.source,
      binding_count: bindingEntries.length,
    });
    actions.push(action(mode === "write" ? "compose_binding_fragment" : "would_compose_binding_fragment", fragmentPath, {
      binding_count: bindingEntries.length,
    }));

    for (const [toolRef, binding] of bindingEntries) {
      if (!knownToolRefs.has(toolRef)) {
        diagnostics.push(errorDiagnostic("BindingFragmentUnknownTool", `binding fragment targets unknown tool ${toolRef}`, {
          fragment_path: fragmentPath,
          tool_ref: toolRef,
        }));
        continue;
      }

      const previous = seenBindings.get(toolRef);
      if (previous !== undefined) {
        const code = stableJson(previous.binding) === stableJson(binding)
          ? "BindingFragmentDuplicateBinding"
          : "BindingFragmentConflictingBinding";
        diagnostics.push(errorDiagnostic(code, `binding fragment repeats binding for ${toolRef}`, {
          fragment_path: fragmentPath,
          previous_fragment_path: previous.path,
          tool_ref: toolRef,
        }));
        continue;
      }

      validateBindingFragmentBinding(binding, expectedManifest.bindings[toolRef], diagnostics, fragmentPath, toolRef);
      seenBindings.set(toolRef, { path: fragmentPath, binding: cloneJson(binding) });
      manifest.bindings[toolRef] = cloneJson(binding);
    }
  }

  return {
    manifest: {
      ...manifest,
      bindings: Object.fromEntries(Object.entries(manifest.bindings).sort(([a], [b]) => a.localeCompare(b))),
    },
    fragments,
  };
}

function readBindingFragment(fragmentPath, diagnostics) {
  let document;
  try {
    document = JSON.parse(readFileSync(fragmentPath, "utf8"));
  } catch (error) {
    diagnostics.push(errorDiagnostic("BindingFragmentReadFailed", error.message, {
      fragment_path: fragmentPath,
    }));
    return null;
  }

  if (!document || typeof document !== "object" || Array.isArray(document)) {
    diagnostics.push(errorDiagnostic("BindingFragmentSchemaMismatch", "binding fragment must be a JSON object", {
      fragment_path: fragmentPath,
    }));
    return null;
  }
  if (document.fragment_schema_version !== TOUBA_BINDING_FRAGMENT_SCHEMA_VERSION) {
    diagnostics.push(errorDiagnostic("BindingFragmentSchemaMismatch", `fragment_schema_version must be ${TOUBA_BINDING_FRAGMENT_SCHEMA_VERSION}`, {
      fragment_path: fragmentPath,
      actual: document.fragment_schema_version,
    }));
    return null;
  }

  const forbiddenField = findForbiddenBindingFragmentAuthorityField(document);
  if (forbiddenField !== null) {
    diagnostics.push(errorDiagnostic("BindingFragmentAuthorityFieldForbidden", `binding fragment cannot declare authority field ${forbiddenField}`, {
      fragment_path: fragmentPath,
      field: forbiddenField,
    }));
    return null;
  }

  if (!document.source || typeof document.source !== "object" || Array.isArray(document.source)) {
    diagnostics.push(errorDiagnostic("BindingFragmentSchemaMismatch", "binding fragment source must be an object", {
      fragment_path: fragmentPath,
    }));
    return null;
  }
  const sourceKind = document.source.kind;
  if (!["module", "package_local", "project"].includes(sourceKind)) {
    diagnostics.push(errorDiagnostic("BindingFragmentSchemaMismatch", "binding fragment source.kind is unsupported", {
      fragment_path: fragmentPath,
      source_kind: sourceKind,
    }));
    return null;
  }
  if (sourceKind === "module" && (typeof document.source.module !== "string" || document.source.module.trim() === "")) {
    diagnostics.push(errorDiagnostic("BindingFragmentSchemaMismatch", "module binding fragments must declare source.module", {
      fragment_path: fragmentPath,
    }));
    return null;
  }
  if (!document.bindings || typeof document.bindings !== "object" || Array.isArray(document.bindings)) {
    diagnostics.push(errorDiagnostic("BindingFragmentSchemaMismatch", "binding fragment bindings must be an object", {
      fragment_path: fragmentPath,
    }));
    return null;
  }

  return document;
}

function validateBindingFragmentBinding(binding, expected, diagnostics, fragmentPath, toolRef) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    diagnostics.push(errorDiagnostic("BindingFragmentSchemaMismatch", `binding ${toolRef} must be an object`, {
      fragment_path: fragmentPath,
      tool_ref: toolRef,
    }));
    return;
  }
  validateManifestBindingShape(binding, diagnostics, fragmentPath, toolRef);
  validateBindingFragmentCoverage(binding, expected, diagnostics, fragmentPath, toolRef);
  validateBindingFragmentPayloadConstraints(binding.payload_constraints, diagnostics, fragmentPath, toolRef);
}

function validateManifestBindingShape(binding, diagnostics, fragmentPath, toolRef) {
  if (!binding.handler || typeof binding.handler !== "object" || Array.isArray(binding.handler)) {
    diagnostics.push(errorDiagnostic("BindingFragmentSchemaMismatch", `binding ${toolRef} handler must be an object`, {
      fragment_path: fragmentPath,
      tool_ref: toolRef,
    }));
  } else {
    if (binding.handler.kind !== "process") {
      diagnostics.push(errorDiagnostic("BindingFragmentSchemaMismatch", `binding ${toolRef} handler.kind must be process`, {
        fragment_path: fragmentPath,
        tool_ref: toolRef,
      }));
    }
    if (typeof binding.handler.command !== "string" || binding.handler.command.trim() === "") {
      diagnostics.push(errorDiagnostic("BindingFragmentSchemaMismatch", `binding ${toolRef} handler.command must be a non-empty string`, {
        fragment_path: fragmentPath,
        tool_ref: toolRef,
      }));
    }
    if (!Array.isArray(binding.handler.args) || binding.handler.args.some((arg) => typeof arg !== "string" || arg.trim() === "")) {
      diagnostics.push(errorDiagnostic("BindingFragmentSchemaMismatch", `binding ${toolRef} handler.args must contain non-empty strings`, {
        fragment_path: fragmentPath,
        tool_ref: toolRef,
      }));
    }
    if (binding.handler.cwd !== undefined && typeof binding.handler.cwd !== "string") {
      diagnostics.push(errorDiagnostic("BindingFragmentSchemaMismatch", `binding ${toolRef} handler.cwd must be a string`, {
        fragment_path: fragmentPath,
        tool_ref: toolRef,
      }));
    }
  }

  if (!Array.isArray(binding.grants) || binding.grants.some((grant) => typeof grant !== "string" || grant.trim() === "")) {
    diagnostics.push(errorDiagnostic("BindingFragmentSchemaMismatch", `binding ${toolRef} grants must contain non-empty strings`, {
      fragment_path: fragmentPath,
      tool_ref: toolRef,
    }));
  }
  if (binding.secrets !== undefined && (!Array.isArray(binding.secrets) || binding.secrets.some((secret) => typeof secret !== "string" || secret.trim() === ""))) {
    diagnostics.push(errorDiagnostic("BindingFragmentSchemaMismatch", `binding ${toolRef} secrets must contain non-empty strings`, {
      fragment_path: fragmentPath,
      tool_ref: toolRef,
    }));
  }
  if (binding.memories !== undefined && (!Array.isArray(binding.memories) || binding.memories.some((memory) => !memory || typeof memory.ref !== "string" || typeof memory.access !== "string"))) {
    diagnostics.push(errorDiagnostic("BindingFragmentSchemaMismatch", `binding ${toolRef} memories must contain ref/access objects`, {
      fragment_path: fragmentPath,
      tool_ref: toolRef,
    }));
  }
  if (!isPositiveInteger(binding.timeout_ms)) {
    diagnostics.push(errorDiagnostic("BindingFragmentSchemaMismatch", `binding ${toolRef} timeout_ms must be a positive integer`, {
      fragment_path: fragmentPath,
      tool_ref: toolRef,
    }));
  }
  if (!isPositiveInteger(binding.max_payload_bytes)) {
    diagnostics.push(errorDiagnostic("BindingFragmentSchemaMismatch", `binding ${toolRef} max_payload_bytes must be a positive integer`, {
      fragment_path: fragmentPath,
      tool_ref: toolRef,
    }));
  }
}

function validateBindingFragmentCoverage(binding, expected, diagnostics, fragmentPath, toolRef) {
  for (const grant of expected.grants) {
    if (!binding.grants?.includes(grant)) {
      diagnostics.push(errorDiagnostic("BindingFragmentMissingGrant", `binding fragment ${toolRef} does not grant ${grant}`, {
        fragment_path: fragmentPath,
        tool_ref: toolRef,
        grant,
      }));
    }
  }
  for (const secret of expected.secrets ?? []) {
    if (!binding.secrets?.includes(secret)) {
      diagnostics.push(errorDiagnostic("BindingFragmentMissingSecret", `binding fragment ${toolRef} does not list secret handle ${secret}`, {
        fragment_path: fragmentPath,
        tool_ref: toolRef,
        secret,
      }));
    }
  }
  for (const memory of expected.memories ?? []) {
    const found = binding.memories?.some((candidate) => candidate.ref === memory.ref && candidate.access === memory.access);
    if (!found) {
      diagnostics.push(errorDiagnostic("BindingFragmentMemoryAccessMissing", `binding fragment ${toolRef} does not list memory ${memory.ref} ${memory.access}`, {
        fragment_path: fragmentPath,
        tool_ref: toolRef,
        memory_ref: memory.ref,
        access: memory.access,
      }));
    }
  }
}

function validateBindingFragmentPayloadConstraints(payloadConstraints, diagnostics, fragmentPath, toolRef) {
  if (payloadConstraints === undefined) {
    return;
  }
  if (!payloadConstraints || typeof payloadConstraints !== "object" || Array.isArray(payloadConstraints)) {
    diagnostics.push(errorDiagnostic("BindingFragmentConstraintInvalid", "payload_constraints must be an object", {
      fragment_path: fragmentPath,
      tool_ref: toolRef,
    }));
    return;
  }
  for (const direction of ["input", "output"]) {
    const constraints = payloadConstraints[direction];
    if (constraints === undefined) {
      continue;
    }
    if (!constraints || typeof constraints !== "object" || Array.isArray(constraints)) {
      diagnostics.push(errorDiagnostic("BindingFragmentConstraintInvalid", `payload_constraints.${direction} must be an object`, {
        fragment_path: fragmentPath,
        tool_ref: toolRef,
      }));
      continue;
    }
    for (const [path, constraint] of Object.entries(constraints)) {
      validateBindingFragmentPayloadConstraintEntry(constraint, diagnostics, fragmentPath, toolRef, direction, path);
    }
  }
}

function validateBindingFragmentPayloadConstraintEntry(constraint, diagnostics, fragmentPath, toolRef, direction, path) {
  if (typeof path !== "string" || !PAYLOAD_CONSTRAINT_PATH_PATTERN.test(path)) {
    diagnostics.push(errorDiagnostic("BindingFragmentConstraintInvalid", "payload constraint path is invalid", {
      fragment_path: fragmentPath,
      tool_ref: toolRef,
      direction,
      path,
    }));
    return;
  }
  if (!constraint || typeof constraint !== "object" || Array.isArray(constraint)) {
    diagnostics.push(errorDiagnostic("BindingFragmentConstraintInvalid", "payload constraint entry must be an object", {
      fragment_path: fragmentPath,
      tool_ref: toolRef,
      direction,
      path,
    }));
    return;
  }
  const operators = Object.keys(constraint);
  const unknownOperators = operators.filter((operator) => !PAYLOAD_CONSTRAINT_OPERATORS.has(operator));
  if (unknownOperators.length > 0 || operators.length === 0) {
    diagnostics.push(errorDiagnostic("BindingFragmentConstraintInvalid", "payload constraint operators are invalid", {
      fragment_path: fragmentPath,
      tool_ref: toolRef,
      direction,
      path,
      unknown_operators: unknownOperators,
    }));
    return;
  }
  if (constraint.non_empty !== undefined && typeof constraint.non_empty !== "boolean") {
    diagnostics.push(errorDiagnostic("BindingFragmentConstraintInvalid", "payload constraint non_empty must be boolean", {
      fragment_path: fragmentPath,
      tool_ref: toolRef,
      direction,
      path,
    }));
  }
  if (constraint.max_length !== undefined && !isPositiveInteger(constraint.max_length)) {
    diagnostics.push(errorDiagnostic("BindingFragmentConstraintInvalid", "payload constraint max_length must be a positive integer", {
      fragment_path: fragmentPath,
      tool_ref: toolRef,
      direction,
      path,
    }));
  }
  if (constraint.min !== undefined && !Number.isFinite(constraint.min)) {
    diagnostics.push(errorDiagnostic("BindingFragmentConstraintInvalid", "payload constraint min must be finite", {
      fragment_path: fragmentPath,
      tool_ref: toolRef,
      direction,
      path,
    }));
  }
  if (constraint.max !== undefined && !Number.isFinite(constraint.max)) {
    diagnostics.push(errorDiagnostic("BindingFragmentConstraintInvalid", "payload constraint max must be finite", {
      fragment_path: fragmentPath,
      tool_ref: toolRef,
      direction,
      path,
    }));
  }
  if (constraint.allowed_values !== undefined) {
    validateBindingFragmentAllowedValues(constraint.allowed_values, diagnostics, fragmentPath, toolRef, direction, path);
  }
  if (constraint.min_items !== undefined && !isNonNegativeInteger(constraint.min_items)) {
    diagnostics.push(errorDiagnostic("BindingFragmentConstraintInvalid", "payload constraint min_items must be a non-negative integer", {
      fragment_path: fragmentPath,
      tool_ref: toolRef,
      direction,
      path,
    }));
  }
  if (constraint.max_items !== undefined && !isNonNegativeInteger(constraint.max_items)) {
    diagnostics.push(errorDiagnostic("BindingFragmentConstraintInvalid", "payload constraint max_items must be a non-negative integer", {
      fragment_path: fragmentPath,
      tool_ref: toolRef,
      direction,
      path,
    }));
  }
  if (Number.isFinite(constraint.min) && Number.isFinite(constraint.max) && constraint.min > constraint.max) {
    diagnostics.push(errorDiagnostic("BindingFragmentConstraintInvalid", "payload constraint min must not exceed max", {
      fragment_path: fragmentPath,
      tool_ref: toolRef,
      direction,
      path,
    }));
  }
  if (
    isNonNegativeInteger(constraint.min_items)
    && isNonNegativeInteger(constraint.max_items)
    && constraint.min_items > constraint.max_items
  ) {
    diagnostics.push(errorDiagnostic("BindingFragmentConstraintInvalid", "payload constraint min_items must not exceed max_items", {
      fragment_path: fragmentPath,
      tool_ref: toolRef,
      direction,
      path,
    }));
  }
}

function validateBindingFragmentAllowedValues(values, diagnostics, fragmentPath, toolRef, direction, path) {
  if (!Array.isArray(values) || values.length === 0) {
    diagnostics.push(errorDiagnostic("BindingFragmentConstraintInvalid", "payload constraint allowed_values must be a non-empty array", {
      fragment_path: fragmentPath,
      tool_ref: toolRef,
      direction,
      path,
    }));
    return;
  }
  const seen = new Set();
  for (const value of values) {
    if (!isPortablePayloadConstraintScalar(value)) {
      diagnostics.push(errorDiagnostic("BindingFragmentConstraintInvalid", "payload constraint allowed_values must contain only Text, Boolean, Int or Float JSON scalars", {
        fragment_path: fragmentPath,
        tool_ref: toolRef,
        direction,
        path,
      }));
      return;
    }
    const key = `${typeof value}:${String(value)}`;
    if (seen.has(key)) {
      diagnostics.push(errorDiagnostic("BindingFragmentConstraintInvalid", "payload constraint allowed_values must not contain duplicates", {
        fragment_path: fragmentPath,
        tool_ref: toolRef,
        direction,
        path,
      }));
      return;
    }
    seen.add(key);
  }
}

function isPortablePayloadConstraintScalar(value) {
  if (typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  return typeof value === "number" && Number.isFinite(value);
}

function validateResourceBindingsForAir({ resourceBindingsPaths, airDocuments, diagnostics, actions, mode, requireAll }) {
  const inventory = buildResourceInventory(airDocuments);
  const documents = [];
  const boundResources = new Set();

  for (const resourceBindingsPath of resourceBindingsPaths) {
    const document = readResourceBindingsDocument(resourceBindingsPath, diagnostics);
    if (document === null) {
      continue;
    }

    const entries = Object.entries(document.resources);
    documents.push({
      path: resourceBindingsPath,
      resource_count: entries.length,
    });
    actions.push(action(mode === "write" ? "validate_resource_bindings" : "would_validate_resource_bindings", resourceBindingsPath, {
      resource_count: entries.length,
    }));

    for (const [resourceRef, binding] of entries) {
      validateResourceBindingEntry(resourceRef, binding, inventory, diagnostics, resourceBindingsPath);
      if (binding?.active !== false) {
        boundResources.add(resourceRef);
      }
    }
  }

  validateRequiredMemoryScopes(inventory, diagnostics, resourceBindingsPaths);

  if (requireAll) {
    for (const resourceRef of inventory.requiredResourceRefs) {
      if (!boundResources.has(resourceRef)) {
        diagnostics.push(errorDiagnostic("ResourceBindingMissing", `resource ${resourceRef} requires an active resource binding`, {
          resource_ref: resourceRef,
        }));
      }
    }
  }

  return { documents };
}

function readResourceBindingsDocument(resourceBindingsPath, diagnostics) {
  let document;
  try {
    document = JSON.parse(readFileSync(resourceBindingsPath, "utf8"));
  } catch (error) {
    diagnostics.push(errorDiagnostic("ResourceBindingsReadFailed", error.message, {
      resource_bindings_path: resourceBindingsPath,
    }));
    return null;
  }

  if (!document || typeof document !== "object" || Array.isArray(document)) {
    diagnostics.push(errorDiagnostic("ResourceBindingsSchemaMismatch", "resource bindings must be a JSON object", {
      resource_bindings_path: resourceBindingsPath,
    }));
    return null;
  }
  if (document.resource_bindings_schema_version !== TOUBA_RESOURCE_BINDINGS_SCHEMA_VERSION) {
    diagnostics.push(errorDiagnostic("ResourceBindingsSchemaMismatch", `resource_bindings_schema_version must be ${TOUBA_RESOURCE_BINDINGS_SCHEMA_VERSION}`, {
      resource_bindings_path: resourceBindingsPath,
      actual: document.resource_bindings_schema_version,
    }));
    return null;
  }
  const forbiddenField = findForbiddenResourceBindingPayloadField(document);
  if (forbiddenField !== null) {
    diagnostics.push(errorDiagnostic("ResourceBindingPayloadForbidden", `resource binding cannot contain payload or secret value field ${forbiddenField}`, {
      resource_bindings_path: resourceBindingsPath,
      field: forbiddenField,
    }));
    return null;
  }
  if (!document.resources || typeof document.resources !== "object" || Array.isArray(document.resources)) {
    diagnostics.push(errorDiagnostic("ResourceBindingsSchemaMismatch", "resource bindings resources must be an object", {
      resource_bindings_path: resourceBindingsPath,
    }));
    return null;
  }
  return document;
}

function validateResourceBindingEntry(resourceRef, binding, inventory, diagnostics, resourceBindingsPath) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    diagnostics.push(errorDiagnostic("ResourceBindingsSchemaMismatch", `resource binding ${resourceRef} must be an object`, {
      resource_bindings_path: resourceBindingsPath,
      resource_ref: resourceRef,
    }));
    return;
  }
  const kind = binding.kind;
  if (!RESOURCE_BINDING_KINDS.has(kind)) {
    diagnostics.push(errorDiagnostic("ResourceBindingUnsupportedKind", `resource binding kind ${kind} is not supported by RB-1`, {
      resource_bindings_path: resourceBindingsPath,
      resource_ref: resourceRef,
      kind,
    }));
    return;
  }
  if (!resourceRef.startsWith(RESOURCE_BINDING_KIND_PREFIX[kind])) {
    diagnostics.push(errorDiagnostic("ResourceBindingsSchemaMismatch", `resource ${resourceRef} is not compatible with kind ${kind}`, {
      resource_bindings_path: resourceBindingsPath,
      resource_ref: resourceRef,
      kind,
    }));
  }
  if (!inventory.knownResourceRefs.has(resourceRef)) {
    diagnostics.push(errorDiagnostic("ResourceBindingUnknownResource", `resource ${resourceRef} is absent from prepared AIR`, {
      resource_bindings_path: resourceBindingsPath,
      resource_ref: resourceRef,
    }));
  }
  if (binding.active === false) {
    diagnostics.push(errorDiagnostic("ResourceBindingInactive", `resource binding ${resourceRef} is inactive`, {
      resource_bindings_path: resourceBindingsPath,
      resource_ref: resourceRef,
    }));
  } else if (binding.active !== undefined && typeof binding.active !== "boolean") {
    diagnostics.push(errorDiagnostic("ResourceBindingsSchemaMismatch", `resource binding ${resourceRef} active must be boolean`, {
      resource_bindings_path: resourceBindingsPath,
      resource_ref: resourceRef,
    }));
  }
  if (typeof binding.provider !== "string" || binding.provider.trim() === "") {
    diagnostics.push(errorDiagnostic("ResourceBindingsSchemaMismatch", `resource binding ${resourceRef} provider must be a non-empty string`, {
      resource_bindings_path: resourceBindingsPath,
      resource_ref: resourceRef,
    }));
  }
  if (!Array.isArray(binding.grants) || binding.grants.some((grant) => typeof grant !== "string" || grant.trim() === "")) {
    diagnostics.push(errorDiagnostic("ResourceBindingsSchemaMismatch", `resource binding ${resourceRef} grants must contain non-empty strings`, {
      resource_bindings_path: resourceBindingsPath,
      resource_ref: resourceRef,
    }));
  }
  if (binding.secrets !== undefined && (!Array.isArray(binding.secrets) || binding.secrets.some((secret) => typeof secret !== "string" || secret.trim() === ""))) {
    diagnostics.push(errorDiagnostic("ResourceBindingsSchemaMismatch", `resource binding ${resourceRef} secrets must contain non-empty handles`, {
      resource_bindings_path: resourceBindingsPath,
      resource_ref: resourceRef,
    }));
  }
  if (binding.required_secrets !== undefined && (!Array.isArray(binding.required_secrets) || binding.required_secrets.some((secret) => typeof secret !== "string" || secret.trim() === ""))) {
    diagnostics.push(errorDiagnostic("ResourceBindingsSchemaMismatch", `resource binding ${resourceRef} required_secrets must contain non-empty handles`, {
      resource_bindings_path: resourceBindingsPath,
      resource_ref: resourceRef,
    }));
  }
  for (const secret of binding.required_secrets ?? []) {
    if (!binding.secrets?.includes(secret)) {
      diagnostics.push(errorDiagnostic("ResourceBindingSecretMissing", `resource binding ${resourceRef} is missing secret handle ${secret}`, {
        resource_bindings_path: resourceBindingsPath,
        resource_ref: resourceRef,
        secret,
      }));
    }
  }
  for (const grant of inventory.requiredGrantsByResource.get(resourceRef) ?? []) {
    if (!binding.grants?.includes(grant)) {
      diagnostics.push(errorDiagnostic("ResourceBindingGrantMissing", `resource binding ${resourceRef} is missing grant ${grant}`, {
        resource_bindings_path: resourceBindingsPath,
        resource_ref: resourceRef,
        grant,
      }));
    }
  }
  validateResourceBindingLimits(binding.limits, diagnostics, resourceBindingsPath, resourceRef);
}

function validateResourceBindingLimits(limits, diagnostics, resourceBindingsPath, resourceRef) {
  if (limits === undefined) {
    return;
  }
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    diagnostics.push(errorDiagnostic("ResourceBindingsSchemaMismatch", `resource binding ${resourceRef} limits must be an object`, {
      resource_bindings_path: resourceBindingsPath,
      resource_ref: resourceRef,
    }));
    return;
  }
  if (limits.max_payload_bytes !== undefined && !isPositiveInteger(limits.max_payload_bytes)) {
    diagnostics.push(errorDiagnostic("ResourceBindingsSchemaMismatch", `resource binding ${resourceRef} limits.max_payload_bytes must be a positive integer`, {
      resource_bindings_path: resourceBindingsPath,
      resource_ref: resourceRef,
    }));
  }
}

function buildResourceInventory(airDocuments) {
  const knownResourceRefs = new Set();
  const requiredResourceRefs = new Set();
  const requiredGrantsByResource = new Map();
  const ownersByRef = new Map();
  const toolsByRef = new Map();
  const graphOwners = [];

  for (const document of airDocuments) {
    for (const memory of document.definitions?.memories ?? []) {
      knownResourceRefs.add(memory.id);
    }
    for (const trigger of document.definitions?.triggers ?? []) {
      knownResourceRefs.add(trigger.id);
      requiredResourceRefs.add(trigger.id);
    }
    for (const agent of document.definitions?.agents ?? []) {
      knownResourceRefs.add(agent.id);
    }
    for (const collection of ["skills", "agents", "strategies", "functions"]) {
      for (const owner of document.definitions?.[collection] ?? []) {
        ownersByRef.set(owner.id, owner);
      }
    }
    for (const tool of document.definitions?.tools ?? []) {
      toolsByRef.set(tool.id, tool);
      for (const access of tool.memory_accesses ?? []) {
        requiredResourceRefs.add(access.memory_ref);
        addResourceGrant(requiredGrantsByResource, access.memory_ref, access.access === "write" ? "memory.write" : "memory.read");
      }
    }
    for (const graph of document.execution_graphs ?? []) {
      graphOwners.push(graph);
    }
  }

  return {
    knownResourceRefs,
    requiredResourceRefs,
    requiredGrantsByResource,
    ownersByRef,
    toolsByRef,
    graphOwners,
  };
}

function validateRequiredMemoryScopes(inventory, diagnostics, resourceBindingsPaths) {
  for (const graph of inventory.graphOwners) {
    const owner = inventory.ownersByRef.get(graph.owner_ref);
    const scopes = owner?.memory_scopes ?? [];
    for (const node of graph.nodes ?? []) {
      if (node.kind !== "call_tool") {
        continue;
      }
      const tool = inventory.toolsByRef.get(node.target_ref);
      for (const access of tool?.memory_accesses ?? []) {
        const found = scopes.some((scope) => scope.memory_ref === access.memory_ref && scope.access === access.access);
        if (!found) {
          diagnostics.push(errorDiagnostic("ResourceBindingScopeMissing", `${graph.owner_ref} lacks memory scope for ${access.memory_ref} ${access.access}`, {
            resource_bindings_path: resourceBindingsPaths[0],
            owner_ref: graph.owner_ref,
            resource_ref: access.memory_ref,
            access: access.access,
          }));
        }
      }
    }
  }
}

function addResourceGrant(map, resourceRef, grant) {
  const grants = map.get(resourceRef) ?? new Set();
  grants.add(grant);
  map.set(resourceRef, grants);
}

function findForbiddenResourceBindingPayloadField(value, path = []) {
  if (!value || typeof value !== "object") {
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (RESOURCE_BINDING_PAYLOAD_FORBIDDEN_FIELDS.has(key)) {
      return [...path, key].join(".");
    }
    const nested = findForbiddenResourceBindingPayloadField(child, [...path, key]);
    if (nested !== null) {
      return nested;
    }
  }
  return null;
}

function validateOwnershipForPrepare({
  ownershipPath,
  requireOwnership,
  profile,
  preparedAirDocuments,
  packages,
  bindingFragments,
  resourceBindings,
  runPlanPath,
  expectedRunPlan,
  diagnostics,
  actions,
  mode,
}) {
  if (ownershipPath === null) {
    if (requireOwnership) {
      diagnostics.push(errorDiagnostic("OwnershipMissing", "ownership artifact is required but --ownership was not provided"));
    }
    return { summary: null };
  }

  const document = readOwnershipDocument(ownershipPath, diagnostics);
  if (document === null) {
    return {
      summary: {
        path: ownershipPath,
        profile,
        team_count: 0,
        owner_count: 0,
        gate_count: 0,
        review_count: 0,
        active_gate_subjects: [],
      },
    };
  }

  actions.push(action(mode === "write" ? "validate_ownership" : "would_validate_ownership", ownershipPath, {
    profile,
  }));

  const targets = buildOwnershipTargets({
    preparedAirDocuments,
    packages,
    bindingFragments,
    resourceBindings,
    runPlanPath,
    expectedRunPlan,
  });
  const teamRefs = validateOwnershipTeams(document, diagnostics, ownershipPath);
  const ownerRefs = validateOwnershipOwners(document, teamRefs, targets.knownTargetRefs, diagnostics, ownershipPath);
  const reviewGate = validateOwnershipReviewGates(document, teamRefs, profile, diagnostics, ownershipPath);
  validateOwnershipReviews(document, teamRefs, targets.knownTargetRefs, reviewGate, profile, diagnostics, ownershipPath);

  if (reviewGate !== null) {
    enforceOwnershipReviewGate({
      reviewGate,
      owners: ownerRefs,
      reviews: document.reviews ?? [],
      targetsBySubject: targets.bySubject,
      diagnostics,
      ownershipPath,
      profile,
    });
  }

  return {
    summary: {
      path: ownershipPath,
      profile,
      team_count: teamRefs.size,
      owner_count: ownerRefs.size,
      gate_count: Object.keys(document.review_gates ?? {}).length,
      review_count: Array.isArray(document.reviews) ? document.reviews.length : 0,
      active_gate_subjects: reviewGate?.subjects ?? [],
    },
  };
}

function readOwnershipDocument(ownershipPath, diagnostics) {
  let document;
  try {
    document = JSON.parse(readFileSync(ownershipPath, "utf8"));
  } catch (error) {
    diagnostics.push(errorDiagnostic("OwnershipSchemaMismatch", error.message, {
      ownership_path: ownershipPath,
    }));
    return null;
  }

  if (!document || typeof document !== "object" || Array.isArray(document)) {
    diagnostics.push(errorDiagnostic("OwnershipSchemaMismatch", "ownership artifact must be a JSON object", {
      ownership_path: ownershipPath,
    }));
    return null;
  }
  if (document.ownership_schema_version !== TOUBA_OWNERSHIP_SCHEMA_VERSION) {
    diagnostics.push(errorDiagnostic("OwnershipSchemaMismatch", `ownership_schema_version must be ${TOUBA_OWNERSHIP_SCHEMA_VERSION}`, {
      ownership_path: ownershipPath,
      actual: document.ownership_schema_version,
    }));
    return null;
  }

  const authorityField = findForbiddenOwnershipField(document, OWNERSHIP_AUTHORITY_FIELDS);
  if (authorityField !== null) {
    diagnostics.push(errorDiagnostic("OwnershipAuthorityFieldForbidden", `ownership artifact cannot declare runtime authority field ${authorityField}`, {
      ownership_path: ownershipPath,
      field: authorityField,
    }));
  }
  const sensitiveField = findForbiddenOwnershipField(document, OWNERSHIP_SENSITIVE_FIELDS);
  if (sensitiveField !== null) {
    diagnostics.push(errorDiagnostic("OwnershipSensitiveValueForbidden", `ownership artifact cannot contain sensitive payload field ${sensitiveField}`, {
      ownership_path: ownershipPath,
      field: sensitiveField,
    }));
  }
  const complianceField = findForbiddenOwnershipField(document, OWNERSHIP_COMPLIANCE_FIELDS);
  if (complianceField !== null) {
    diagnostics.push(errorDiagnostic("OwnershipComplianceClaimForbidden", `ownership artifact cannot claim compliance or verification field ${complianceField}`, {
      ownership_path: ownershipPath,
      field: complianceField,
    }));
  }

  if (!document.teams || typeof document.teams !== "object" || Array.isArray(document.teams)) {
    diagnostics.push(errorDiagnostic("OwnershipSchemaMismatch", "ownership teams must be an object", {
      ownership_path: ownershipPath,
    }));
  }
  if (document.owners !== undefined && (!document.owners || typeof document.owners !== "object" || Array.isArray(document.owners))) {
    diagnostics.push(errorDiagnostic("OwnershipSchemaMismatch", "ownership owners must be an object", {
      ownership_path: ownershipPath,
    }));
  }
  if (document.review_gates !== undefined && (!document.review_gates || typeof document.review_gates !== "object" || Array.isArray(document.review_gates))) {
    diagnostics.push(errorDiagnostic("OwnershipSchemaMismatch", "ownership review_gates must be an object", {
      ownership_path: ownershipPath,
    }));
  }
  if (document.reviews !== undefined && (!Array.isArray(document.reviews))) {
    diagnostics.push(errorDiagnostic("OwnershipSchemaMismatch", "ownership reviews must be an array", {
      ownership_path: ownershipPath,
    }));
  }
  return document;
}

function validateOwnershipTeams(document, diagnostics, ownershipPath) {
  const teamRefs = new Set();
  for (const [teamRef, metadata] of Object.entries(document.teams ?? {})) {
    if (!TEAM_REF_PATTERN.test(teamRef)) {
      diagnostics.push(errorDiagnostic("OwnershipSchemaMismatch", `team ref ${teamRef} is invalid`, {
        ownership_path: ownershipPath,
        team_ref: teamRef,
      }));
      continue;
    }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      diagnostics.push(errorDiagnostic("OwnershipSchemaMismatch", `team ${teamRef} metadata must be an object`, {
        ownership_path: ownershipPath,
        team_ref: teamRef,
      }));
      continue;
    }
    teamRefs.add(teamRef);
  }
  return teamRefs;
}

function validateOwnershipOwners(document, teamRefs, knownTargetRefs, diagnostics, ownershipPath) {
  const owners = new Map();
  for (const [targetRef, ownerTeams] of Object.entries(document.owners ?? {})) {
    validateOwnershipTargetRef(targetRef, knownTargetRefs, diagnostics, ownershipPath);
    if (!Array.isArray(ownerTeams) || ownerTeams.length === 0) {
      diagnostics.push(errorDiagnostic("OwnershipSchemaMismatch", `ownership target ${targetRef} owners must be a non-empty team array`, {
        ownership_path: ownershipPath,
        target_ref: targetRef,
      }));
      continue;
    }
    const normalizedTeams = [];
    for (const teamRef of ownerTeams) {
      if (!teamRefs.has(teamRef)) {
        diagnostics.push(errorDiagnostic("OwnershipTeamUnknown", `owner team ${teamRef} is not declared`, {
          ownership_path: ownershipPath,
          target_ref: targetRef,
          team_ref: teamRef,
        }));
        continue;
      }
      normalizedTeams.push(teamRef);
    }
    owners.set(targetRef, normalizedTeams);
  }
  return owners;
}

function validateOwnershipReviewGates(document, teamRefs, profile, diagnostics, ownershipPath) {
  let activeGate = null;
  for (const [gateProfile, gate] of Object.entries(document.review_gates ?? {})) {
    if (!RUN_PROFILE_PATTERN.test(gateProfile)) {
      diagnostics.push(errorDiagnostic("OwnershipSchemaMismatch", `review gate profile ${gateProfile} is invalid`, {
        ownership_path: ownershipPath,
        profile: gateProfile,
      }));
      continue;
    }
    if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
      diagnostics.push(errorDiagnostic("OwnershipSchemaMismatch", `review gate ${gateProfile} must be an object`, {
        ownership_path: ownershipPath,
        profile: gateProfile,
      }));
      continue;
    }
    const subjects = normalizeReviewGateSubjects(gate.requires_review_for, diagnostics, ownershipPath, gateProfile);
    const reviewers = normalizeReviewGateReviewers(gate.reviewers, teamRefs, diagnostics, ownershipPath, gateProfile);
    if (gateProfile === profile) {
      activeGate = {
        profile: gateProfile,
        subjects,
        reviewers,
      };
    }
  }
  return activeGate;
}

function normalizeReviewGateSubjects(values, diagnostics, ownershipPath, profile) {
  if (!Array.isArray(values) || values.length === 0) {
    diagnostics.push(errorDiagnostic("OwnershipSchemaMismatch", `review gate ${profile} requires_review_for must be a non-empty array`, {
      ownership_path: ownershipPath,
      profile,
    }));
    return [];
  }
  const subjects = [];
  for (const subject of values) {
    if (!OWNERSHIP_REVIEW_SUBJECTS.has(subject)) {
      diagnostics.push(errorDiagnostic("ReviewGateSubjectUnknown", `review gate subject ${subject} is unknown`, {
        ownership_path: ownershipPath,
        profile,
        subject,
      }));
      continue;
    }
    if (!subjects.includes(subject)) {
      subjects.push(subject);
    }
  }
  return subjects;
}

function normalizeReviewGateReviewers(values, teamRefs, diagnostics, ownershipPath, profile) {
  if (!Array.isArray(values) || values.length === 0) {
    diagnostics.push(errorDiagnostic("ReviewReviewerUnknown", `review gate ${profile} reviewers must be a non-empty team array`, {
      ownership_path: ownershipPath,
      profile,
    }));
    return [];
  }
  const reviewers = [];
  for (const teamRef of values) {
    if (!teamRefs.has(teamRef)) {
      diagnostics.push(errorDiagnostic("ReviewReviewerUnknown", `review gate reviewer ${teamRef} is not declared`, {
        ownership_path: ownershipPath,
        profile,
        reviewer: teamRef,
      }));
      continue;
    }
    if (!reviewers.includes(teamRef)) {
      reviewers.push(teamRef);
    }
  }
  return reviewers;
}

function validateOwnershipReviews(document, teamRefs, knownTargetRefs, reviewGate, profile, diagnostics, ownershipPath) {
  for (const review of document.reviews ?? []) {
    if (!review || typeof review !== "object" || Array.isArray(review)) {
      diagnostics.push(errorDiagnostic("OwnershipSchemaMismatch", "ownership review must be an object", {
        ownership_path: ownershipPath,
      }));
      continue;
    }
    if (typeof review.review_id !== "string" || !REVIEW_REF_PATTERN.test(review.review_id)) {
      diagnostics.push(errorDiagnostic("OwnershipSchemaMismatch", "ownership review_id must be a review:* ref", {
        ownership_path: ownershipPath,
        review_id: review.review_id,
      }));
    }
    if (typeof review.profile !== "string" || !RUN_PROFILE_PATTERN.test(review.profile)) {
      diagnostics.push(errorDiagnostic("OwnershipSchemaMismatch", "ownership review profile is invalid", {
        ownership_path: ownershipPath,
        profile: review.profile,
      }));
    }
    if (typeof review.target_ref !== "string") {
      diagnostics.push(errorDiagnostic("OwnershipTargetUnknown", "ownership review target_ref must be a string", {
        ownership_path: ownershipPath,
      }));
    } else {
      validateOwnershipTargetRef(review.target_ref, knownTargetRefs, diagnostics, ownershipPath);
    }
    if (!teamRefs.has(review.reviewer)) {
      diagnostics.push(errorDiagnostic("ReviewReviewerUnknown", `reviewer ${review.reviewer} is not declared`, {
        ownership_path: ownershipPath,
        reviewer: review.reviewer,
      }));
    }
    if (!OWNERSHIP_REVIEW_DECISIONS.has(review.decision)) {
      diagnostics.push(errorDiagnostic("OwnershipSchemaMismatch", "ownership review decision must be approved or rejected", {
        ownership_path: ownershipPath,
        review_id: review.review_id,
        decision: review.decision,
      }));
    }
    if (review.decision === "rejected") {
      diagnostics.push(errorDiagnostic("ReviewRejected", `review ${review.review_id} rejected ${review.target_ref}`, {
        ownership_path: ownershipPath,
        review_id: review.review_id,
        target_ref: review.target_ref,
      }));
    }
    if (review.profile === profile && reviewGate !== null && !reviewGate.reviewers.includes(review.reviewer)) {
      diagnostics.push(errorDiagnostic("ReviewReviewerUnknown", `reviewer ${review.reviewer} is not allowed by review gate ${profile}`, {
        ownership_path: ownershipPath,
        profile,
        reviewer: review.reviewer,
        review_id: review.review_id,
      }));
    }
    if (review.evidence_ref !== undefined && (typeof review.evidence_ref !== "string" || review.evidence_ref.trim() === "")) {
      diagnostics.push(errorDiagnostic("OwnershipSchemaMismatch", "ownership review evidence_ref must be a non-empty string when present", {
        ownership_path: ownershipPath,
        review_id: review.review_id,
      }));
    }
  }
}

function enforceOwnershipReviewGate({ reviewGate, owners, reviews, targetsBySubject, diagnostics, ownershipPath, profile }) {
  for (const subject of reviewGate.subjects) {
    for (const targetRef of targetsBySubject.get(subject) ?? []) {
      if (!owners.has(targetRef)) {
        diagnostics.push(errorDiagnostic("OwnershipMissing", `ownership target ${targetRef} requires an owner for ${subject}`, {
          ownership_path: ownershipPath,
          profile,
          subject,
          target_ref: targetRef,
        }));
      }
      const hasApprovedReview = reviews.some((review) => (
        review?.profile === profile
        && review.target_ref === targetRef
        && review.decision === "approved"
        && reviewGate.reviewers.includes(review.reviewer)
      ));
      if (!hasApprovedReview) {
        diagnostics.push(errorDiagnostic("ReviewGateMissing", `ownership target ${targetRef} requires an approved ${profile} review for ${subject}`, {
          ownership_path: ownershipPath,
          profile,
          subject,
          target_ref: targetRef,
        }));
      }
    }
  }
}

function validateOwnershipTargetRef(targetRef, knownTargetRefs, diagnostics, ownershipPath) {
  if (typeof targetRef !== "string" || !OWNERSHIP_TARGET_REF_PATTERN.test(targetRef)) {
    diagnostics.push(errorDiagnostic("OwnershipTargetUnknown", `ownership target ${targetRef} is not a complete artifact ref`, {
      ownership_path: ownershipPath,
      target_ref: targetRef,
    }));
    return;
  }
  if (targetRef.includes("*")) {
    diagnostics.push(errorDiagnostic("OwnershipWildcardForbidden", `ownership target ${targetRef} cannot contain wildcard`, {
      ownership_path: ownershipPath,
      target_ref: targetRef,
    }));
    return;
  }
  if (/^(module|package):[^/]+$/u.test(targetRef) && !knownTargetRefs.has(targetRef)) {
    diagnostics.push(errorDiagnostic("OwnershipModuleAuthorityForbidden", `ownership target ${targetRef} cannot act as a module or package authority shortcut`, {
      ownership_path: ownershipPath,
      target_ref: targetRef,
    }));
    return;
  }
  if (!knownTargetRefs.has(targetRef)) {
    diagnostics.push(errorDiagnostic("OwnershipTargetUnknown", `ownership target ${targetRef} is absent from prepared artifacts`, {
      ownership_path: ownershipPath,
      target_ref: targetRef,
    }));
  }
}

function buildOwnershipTargets({
  preparedAirDocuments,
  packages,
  bindingFragments,
  resourceBindings,
  runPlanPath,
  expectedRunPlan,
}) {
  const bySubject = new Map();
  const knownTargetRefs = new Set();

  function addKnown(ref) {
    if (typeof ref === "string" && ref.length > 0) {
      knownTargetRefs.add(ref);
    }
  }

  function addSubject(subject, ref) {
    addKnown(ref);
    const refs = bySubject.get(subject) ?? new Set();
    refs.add(ref);
    bySubject.set(subject, refs);
  }

  for (const entry of preparedAirDocuments) {
    const document = entry.document;
    addKnown(document.module?.id);
    for (const collection of ["types", "constants", "functions", "skills", "strategies", "memories"]) {
      for (const item of document.definitions?.[collection] ?? []) {
        addKnown(item.id);
      }
    }
    for (const tool of document.definitions?.tools ?? []) {
      addSubject("tool_binding", tool.id);
      if (normalizeStringArray(tool.required_capabilities).length > 0 || normalizeMemoryAccesses(tool.memory_accesses).length > 0) {
        addSubject("required_capability", tool.id);
      }
      if (normalizeStringArray(tool.required_secrets).length > 0) {
        addSubject("required_secret", tool.id);
      }
    }
    for (const agent of document.definitions?.agents ?? []) {
      addKnown(agent.id);
      if (Array.isArray(agent.callable_by) && agent.callable_by.length > 0) {
        addSubject("agent_authority", agent.id);
      }
    }
    for (const trigger of document.definitions?.triggers ?? []) {
      addSubject("trigger_activation", trigger.id);
    }
  }

  for (const packageInfo of packages ?? []) {
    if (typeof packageInfo.name === "string") {
      addSubject("package_export", `package:${packageInfo.name}`);
    }
  }
  for (const fragment of bindingFragments ?? []) {
    const ref = bindingFragmentOwnershipRef(fragment);
    addSubject("tool_binding", ref);
  }
  for (const resourceBinding of resourceBindings ?? []) {
    const ref = `resource_bindings:${artifactStem(resourceBinding.path)}`;
    addSubject("resource_binding", ref);
  }
  if (runPlanPath !== null) {
    addSubject("run_plan", `run_plan:${artifactStem(runPlanPath)}`);
  }
  if (typeof expectedRunPlan?.supply_chain_lock === "string") {
    addSubject("supply_chain_lock", `lock:${basename(expectedRunPlan.supply_chain_lock)}`);
  }

  return { bySubject, knownTargetRefs };
}

function bindingFragmentOwnershipRef(fragment) {
  if (fragment?.source?.kind === "module" && typeof fragment.source.module === "string") {
    return `binding_fragment:${fragment.source.module}`;
  }
  if (fragment?.source?.kind === "package_local" && typeof fragment.source.package === "string") {
    return `binding_fragment:${fragment.source.package}`;
  }
  return `binding_fragment:${artifactStem(fragment.path)}`;
}

function artifactStem(path) {
  const fileName = basename(path);
  return fileName.replace(/(\.json|\.lock)$/u, "");
}

function findForbiddenOwnershipField(value, forbiddenFields, path = []) {
  if (!value || typeof value !== "object") {
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenFields.has(key)) {
      return [...path, key].join(".");
    }
    const nested = findForbiddenOwnershipField(child, forbiddenFields, [...path, key]);
    if (nested !== null) {
      return nested;
    }
  }
  return null;
}

function collectRequiredSecretHandles(airDocuments) {
  const handles = new Set();
  for (const document of airDocuments) {
    for (const tool of document.definitions.tools) {
      for (const handle of normalizeStringArray(tool.required_secrets)) {
        handles.add(handle);
      }
    }
  }
  return [...handles].sort();
}

function expectedSecretProfiles(root, handles, options) {
  if (handles.length === 0) {
    return [];
  }
  return [
    {
      kind: "dev",
      path: resolve(root, DEFAULT_DEV_SECRETS_PROFILE),
      document: expectedSecretProfileDocument(handles, (handle) => ({
        source: "touba_store",
        path: options.secretStorePath,
        name: handle,
      })),
    },
    {
      kind: "prod",
      path: resolve(root, DEFAULT_PROD_SECRETS_PROFILE),
      document: expectedSecretProfileDocument(handles, (handle) => ({
        source: "env",
        name: handle,
      })),
    },
  ];
}

function expectedSecretProfileDocument(handles, recordForHandle) {
  const secrets = {};
  for (const handle of handles) {
    secrets[handle] = recordForHandle(handle);
  }
  return {
    secrets_version: TOUBA_SECRETS_VERSION,
    secrets,
  };
}

function buildExpectedRunPlan({
  root,
  runPlanPath,
  preparedAirDocuments,
  entryRef,
  manifestPath,
  expectedToolRefs,
  secretProfiles,
  projectConfig,
  profile,
  diagnostics,
}) {
  if (!RUN_PROFILE_PATTERN.test(profile)) {
    diagnostics.push(errorDiagnostic("RunPlanSchemaMismatch", "run plan profile name is invalid", {
      profile,
      run_plan_path: runPlanPath,
    }));
    return null;
  }

  const runProfiles = projectConfig.run_profiles ?? cloneJson(DEFAULT_RUN_PROFILES);
  const runProfile = runProfiles[profile];
  if (runProfile === undefined) {
    diagnostics.push(errorDiagnostic("RunPlanSchemaMismatch", `run profile ${profile} is not declared by project config`, {
      profile,
      run_plan_path: runPlanPath,
    }));
    return null;
  }

  const entry = resolveRunPlanEntry(preparedAirDocuments, entryRef, diagnostics, runPlanPath);
  if (entry === null) {
    return null;
  }

  const document = {
    run_plan_schema_version: TOUBA_RUN_PLAN_SCHEMA_VERSION,
    entry_ref: entry.ref,
    air: relativeRunPlanPath(runPlanPath, runPlanAirPathForEntry(root, entry.entry)),
    profile,
    outputs: {
      mode: "show",
    },
  };

  if (expectedToolRefs.length > 0) {
    document.manifest = relativeRunPlanPath(runPlanPath, manifestPath);
  }

  if (secretProfiles.length > 0) {
    const matchingProfile = secretProfiles.find((candidate) => candidate.kind === profile);
    if (matchingProfile === undefined) {
      diagnostics.push(errorDiagnostic("RunPlanSecretsProfileMissing", `run profile ${profile} has no generated secrets profile`, {
        profile,
        run_plan_path: runPlanPath,
      }));
    } else {
      document.secrets_profile = relativeRunPlanPath(runPlanPath, matchingProfile.path);
    }
  }

  if (runProfile.require_supply_chain_lock === true) {
    if (typeof runProfile.supply_chain_lock !== "string" || runProfile.supply_chain_lock.trim() === "") {
      diagnostics.push(errorDiagnostic("RunPlanSupplyChainLockRequired", `run profile ${profile} requires a supply_chain_lock`, {
        profile,
        run_plan_path: runPlanPath,
      }));
    } else {
      document.supply_chain_lock = relativeRunPlanPath(runPlanPath, resolve(root, runProfile.supply_chain_lock));
    }
  }

  return document;
}

function resolveRunPlanEntry(entries, entryRef, diagnostics, runPlanPath) {
  if (typeof entryRef === "string" && entryRef.trim() !== "") {
    for (const entry of entries) {
      if (entryRefsForDocument(entry.document).includes(entryRef)) {
        return { ref: entryRef, entry };
      }
    }
    diagnostics.push(errorDiagnostic("RunPlanEntryUnknown", `entry_ref ${entryRef} is not declared by prepared AIR`, {
      entry_ref: entryRef,
      run_plan_path: runPlanPath,
    }));
    return null;
  }

  const strategyCandidates = [];
  const executableCandidates = [];
  for (const entry of entries) {
    for (const strategy of entry.document.definitions?.strategies ?? []) {
      strategyCandidates.push({ ref: strategy.id, entry });
      executableCandidates.push({ ref: strategy.id, entry });
    }
    for (const collection of ["skills", "agents", "functions"]) {
      for (const declaration of entry.document.definitions?.[collection] ?? []) {
        executableCandidates.push({ ref: declaration.id, entry });
      }
    }
  }

  if (strategyCandidates.length === 1) {
    return strategyCandidates[0];
  }
  if (executableCandidates.length === 1) {
    return executableCandidates[0];
  }

  diagnostics.push(errorDiagnostic("RunPlanEntryUnknown", "run plan entry_ref must be explicit when prepare cannot infer a single executable entry", {
    run_plan_path: runPlanPath,
    candidate_count: executableCandidates.length,
  }));
  return null;
}

function entryRefsForDocument(document) {
  const refs = [];
  for (const collection of ["strategies", "skills", "agents", "functions"]) {
    for (const declaration of document.definitions?.[collection] ?? []) {
      if (typeof declaration.id === "string") {
        refs.push(declaration.id);
      }
    }
  }
  return refs;
}

function runPlanAirPathForEntry(root, entry) {
  if (entry.sourcePath !== undefined) {
    return airOutputPath(root, entry.document.module.name);
  }
  if (entry.airPath !== undefined) {
    return entry.airPath;
  }
  return airOutputPath(root, entry.document.module.name);
}

function relativeRunPlanPath(runPlanPath, targetPath) {
  const path = relative(dirname(runPlanPath), targetPath);
  return toPosixPath(path === "" ? "." : path);
}

function expectedBindingForTool(tool, options) {
  const handlerPath = handlerRelativePathForTool(tool, options);
  const binding = {
    handler: {
      kind: "process",
      command: options.handlerCommand,
      args: [handlerPath],
      cwd: ".",
    },
    grants: normalizeStringArray(tool.required_capabilities),
    timeout_ms: options.timeoutMs,
    max_payload_bytes: options.maxPayloadBytes,
  };
  const secrets = normalizeStringArray(tool.required_secrets);
  if (secrets.length > 0) {
    binding.secrets = secrets;
  }
  const memories = normalizeMemoryAccesses(tool.memory_accesses);
  if (memories.length > 0) {
    binding.memories = memories;
  }
  return binding;
}

function expectedStubs(airDocuments, options) {
  const stubs = [];
  const seenToolRefs = new Set();
  for (const document of airDocuments) {
    for (const tool of document.definitions.tools) {
      if (seenToolRefs.has(tool.id)) {
        continue;
      }
      seenToolRefs.add(tool.id);
      const relativePath = handlerRelativePathForTool(tool, options);
      stubs.push({
        artifact_kind: "handler_stub",
        tool_ref: tool.id,
        path: join(options.root, relativePath),
        relative_path: relativePath,
        content: generateHandlerStubFromAirTool(tool, {
          sdkImport: options.sdkImport,
        }),
      });
      const contractRelativePath = handlerContractTestRelativePath(relativePath);
      stubs.push({
        artifact_kind: "handler_contract_test",
        tool_ref: tool.id,
        path: join(options.root, contractRelativePath),
        relative_path: contractRelativePath,
        content: generateHandlerContractTestFromAirTool(tool, {
          sdkImport: options.sdkImport,
          handlerImport: `./${relativePath.split("/").at(-1)}`,
        }),
      });
    }
  }
  return stubs.sort((left, right) => left.path.localeCompare(right.path));
}

function handlerContractTestRelativePath(handlerPath) {
  return handlerPath.replace(/\.handler\.([^.]+)$/u, ".handler.contract.test.$1");
}

function handlerRelativePathForTool(tool, options) {
  const { moduleName, toolName } = parseToolRef(tool.id);
  const handlerRoot = options.handlerRoot ?? DEFAULT_HANDLER_ROOT;
  const extension = options.handlerExtension ?? DEFAULT_HANDLER_EXTENSION;
  return toPosixPath(join(
    handlerRoot,
    ...moduleName.split("."),
    toolNameToHandlerFile(tool.name ?? toolName, extension),
  ));
}

function parseToolRef(toolRef) {
  const match = /^tool:([^/]+)\/(.+)$/.exec(toolRef);
  if (!match) {
    throw new Error(`invalid tool ref: ${toolRef}`);
  }
  return { moduleName: match[1], toolName: match[2] };
}

function inspectManifest({ currentManifest, expectedManifest, manifestPath, diagnostics, actions, mode }) {
  const expectedToolRefs = Object.keys(expectedManifest.bindings);
  if (expectedToolRefs.length === 0) {
    if (currentManifest?.bindings && Object.keys(currentManifest.bindings).length > 0) {
      diagnostics.push(errorDiagnostic("ManifestHasUnexpectedBindings", "manifest has bindings but project AIR declares no tools", {
        manifest_path: manifestPath,
      }));
    }
    return;
  }

  if (currentManifest === null) {
    actions.push(action(mode === "write" ? "create_manifest" : "would_create_manifest", manifestPath));
    if (mode === "check") {
      diagnostics.push(errorDiagnostic("ManifestMissing", "project manifest is missing", { manifest_path: manifestPath }));
    }
    return;
  }

  if (currentManifest.manifest_version !== TOUBA_MANIFEST_VERSION) {
    diagnostics.push(errorDiagnostic("ManifestVersionInvalid", `manifest_version must be ${TOUBA_MANIFEST_VERSION}`, {
      manifest_path: manifestPath,
      actual: currentManifest.manifest_version,
    }));
    return;
  }
  if (!currentManifest.bindings || typeof currentManifest.bindings !== "object" || Array.isArray(currentManifest.bindings)) {
    diagnostics.push(errorDiagnostic("ManifestBindingsInvalid", "manifest bindings must be an object", { manifest_path: manifestPath }));
    return;
  }

  const expectedSet = new Set(expectedToolRefs);
  for (const toolRef of Object.keys(currentManifest.bindings).sort()) {
    if (!expectedSet.has(toolRef)) {
      diagnostics.push(errorDiagnostic("ManifestBindingObsolete", `manifest binding ${toolRef} is not declared by current project AIR`, {
        manifest_path: manifestPath,
        tool_ref: toolRef,
      }));
    }
  }

  for (const toolRef of expectedToolRefs) {
    const actual = currentManifest.bindings[toolRef];
    const expected = expectedManifest.bindings[toolRef];
    if (actual === undefined) {
      actions.push(action(mode === "write" ? "add_manifest_binding" : "would_add_manifest_binding", manifestPath, { tool_ref: toolRef }));
      if (mode === "check") {
        diagnostics.push(errorDiagnostic("ManifestBindingMissing", `manifest binding missing for ${toolRef}`, {
          manifest_path: manifestPath,
          tool_ref: toolRef,
        }));
      }
      continue;
    }
    validateBindingCoverage(actual, expected, diagnostics, manifestPath, toolRef);
  }
  validateAgentSecretScopes(currentManifest, expectedManifest, diagnostics, actions, mode, manifestPath);
}

function validateBindingCoverage(actual, expected, diagnostics, manifestPath, toolRef) {
  if (!actual?.handler || actual.handler.kind !== "process") {
    diagnostics.push(errorDiagnostic("ManifestHandlerInvalid", `binding ${toolRef} must declare a process handler`, {
      manifest_path: manifestPath,
      tool_ref: toolRef,
    }));
    return;
  }
  if (!Array.isArray(actual.handler.args) || actual.handler.args[0] !== expected.handler.args[0]) {
    diagnostics.push(errorDiagnostic("ManifestHandlerPathMismatch", `binding ${toolRef} handler path does not follow project convention`, {
      manifest_path: manifestPath,
      tool_ref: toolRef,
      expected: expected.handler.args[0],
      actual: actual.handler.args?.[0],
    }));
  }
  for (const grant of expected.grants) {
    if (!actual.grants?.includes(grant)) {
      diagnostics.push(errorDiagnostic("ManifestGrantMissing", `binding ${toolRef} does not grant ${grant}`, {
        manifest_path: manifestPath,
        tool_ref: toolRef,
        grant,
      }));
    }
  }
  for (const secret of expected.secrets ?? []) {
    if (!actual.secrets?.includes(secret)) {
      diagnostics.push(errorDiagnostic("ManifestSecretMissing", `binding ${toolRef} does not list secret handle ${secret}`, {
        manifest_path: manifestPath,
        tool_ref: toolRef,
        secret,
      }));
    }
  }
  for (const memory of expected.memories ?? []) {
    const found = actual.memories?.some((candidate) => candidate.ref === memory.ref && candidate.access === memory.access);
    if (!found) {
      diagnostics.push(errorDiagnostic("ManifestMemoryAccessMissing", `binding ${toolRef} does not list memory ${memory.ref} ${memory.access}`, {
        manifest_path: manifestPath,
        tool_ref: toolRef,
        memory_ref: memory.ref,
        access: memory.access,
      }));
    }
  }
}

function validateAgentSecretScopes(actualManifest, expectedManifest, diagnostics, actions, mode, manifestPath) {
  for (const [agentRef, secrets] of Object.entries(expectedManifest.agent_secret_scopes ?? {})) {
    const actualSecrets = actualManifest.agent_secret_scopes?.[agentRef];
    if (!Array.isArray(actualSecrets)) {
      actions.push(action(mode === "write" ? "add_agent_secret_scope" : "would_add_agent_secret_scope", manifestPath, {
        agent_ref: agentRef,
        secrets,
      }));
      if (mode === "check") {
        diagnostics.push(errorDiagnostic("ManifestAgentSecretScopeMissing", `manifest does not grant secret handles to ${agentRef}`, {
          manifest_path: manifestPath,
          agent_ref: agentRef,
        }));
      }
      continue;
    }
    for (const secret of secrets) {
      if (!actualSecrets.includes(secret)) {
        actions.push(action(mode === "write" ? "add_agent_secret_scope_secret" : "would_add_agent_secret_scope_secret", manifestPath, {
          agent_ref: agentRef,
          secret,
        }));
        if (mode === "check") {
          diagnostics.push(errorDiagnostic("ManifestAgentSecretScopeSecretMissing", `manifest does not grant ${secret} to ${agentRef}`, {
            manifest_path: manifestPath,
            agent_ref: agentRef,
            secret,
          }));
        }
      }
    }
  }
}

function inspectProjectConfig({
  currentProjectConfig,
  expectedProjectConfig,
  projectConfigPath,
  diagnostics,
  actions,
  mode,
  required,
}) {
  if (currentProjectConfig === null) {
    if (required) {
      actions.push(action(mode === "write" ? "create_project_config" : "would_create_project_config", projectConfigPath, {
        language: expectedProjectConfig.language,
        sdk: expectedProjectConfig.sdk,
      }));
      if (mode === "check") {
        diagnostics.push(errorDiagnostic("ProjectConfigMissing", "project config is missing for generated handlers", {
          project_config_path: projectConfigPath,
          language: expectedProjectConfig.language,
          sdk: expectedProjectConfig.sdk,
        }));
      }
    }
    return;
  }
  if (currentProjectConfig.language !== expectedProjectConfig.language) {
    diagnostics.push(errorDiagnostic("ProjectConfigLanguageMismatch", "project config language mismatch", {
      project_config_path: projectConfigPath,
      expected: expectedProjectConfig.language,
      actual: currentProjectConfig.language,
    }));
  }
  if (currentProjectConfig.sdk !== expectedProjectConfig.sdk) {
    diagnostics.push(errorDiagnostic("ProjectConfigSdkMismatch", "project config SDK mismatch", {
      project_config_path: projectConfigPath,
      expected: expectedProjectConfig.sdk,
      actual: currentProjectConfig.sdk,
    }));
  }
}

function inspectStubs({ stubs, diagnostics, actions, mode }) {
  for (const stub of stubs) {
    if (existsSync(stub.path)) {
      const stat = statSync(stub.path);
      if (!stat.isFile()) {
        diagnostics.push(errorDiagnostic("HandlerStubPathInvalid", `handler path is not a file: ${stub.path}`, {
          tool_ref: stub.tool_ref,
          path: stub.path,
        }));
      }
      continue;
    }
    const createKind = stub.artifact_kind === "handler_contract_test"
      ? "create_handler_contract_test"
      : "create_handler_stub";
    actions.push(action(mode === "write" ? createKind : `would_${createKind}`, stub.path, {
      tool_ref: stub.tool_ref,
    }));
    if (mode === "check") {
      const code = stub.artifact_kind === "handler_contract_test"
        ? "HandlerContractTestMissing"
        : "HandlerStubMissing";
      const label = stub.artifact_kind === "handler_contract_test" ? "handler contract test" : "handler stub";
      diagnostics.push(errorDiagnostic(code, `${label} missing for ${stub.tool_ref}`, {
        tool_ref: stub.tool_ref,
        path: stub.path,
      }));
    }
  }
}

function inspectSecretProfiles({ secretProfiles, diagnostics, actions, mode }) {
  for (const profile of secretProfiles) {
    const currentProfile = readSecretProfile(profile.path, diagnostics);
    if (currentProfile === null) {
      actions.push(action(mode === "write" ? "create_secret_profile" : "would_create_secret_profile", profile.path, {
        profile: profile.kind,
      }));
      if (mode === "check") {
        diagnostics.push(errorDiagnostic("SecretProfileMissing", `secret profile ${profile.kind} is missing`, {
          profile: profile.kind,
          path: profile.path,
        }));
      }
      continue;
    }
    validateSecretProfileCoverage(currentProfile, profile, diagnostics, actions, mode);
  }
}

function readSecretProfile(path, diagnostics) {
  if (!existsSync(path)) {
    return null;
  }
  let document;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    diagnostics.push(errorDiagnostic("SecretProfileReadFailed", error.message, { path }));
    return null;
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    diagnostics.push(errorDiagnostic("SecretProfileInvalid", "secret profile must be a JSON object", { path }));
    return null;
  }
  if (document.secrets_version !== TOUBA_SECRETS_VERSION) {
    diagnostics.push(errorDiagnostic("SecretProfileVersionInvalid", `secrets_version must be ${TOUBA_SECRETS_VERSION}`, {
      path,
      actual: document.secrets_version,
    }));
    return null;
  }
  if (!document.secrets || typeof document.secrets !== "object" || Array.isArray(document.secrets)) {
    diagnostics.push(errorDiagnostic("SecretProfileSecretsInvalid", "secret profile secrets must be an object", { path }));
    return null;
  }
  for (const [handle, record] of Object.entries(document.secrets)) {
    try {
      assertSecretHandle(handle);
      validateSecretSourceRecord(record, path, handle);
    } catch (error) {
      diagnostics.push(errorDiagnostic("SecretProfileEntryInvalid", error.message, { path, handle }));
    }
  }
  return document;
}

function validateSecretProfileCoverage(currentProfile, expectedProfile, diagnostics, actions, mode) {
  for (const handle of Object.keys(expectedProfile.document.secrets)) {
    if (currentProfile.secrets[handle] !== undefined) {
      continue;
    }
    actions.push(action(mode === "write" ? "add_secret_profile_handle" : "would_add_secret_profile_handle", expectedProfile.path, {
      profile: expectedProfile.kind,
      handle,
    }));
    if (mode === "check") {
      diagnostics.push(errorDiagnostic("SecretProfileHandleMissing", `secret profile ${expectedProfile.kind} does not resolve ${handle}`, {
        profile: expectedProfile.kind,
        path: expectedProfile.path,
        handle,
      }));
    }
  }
}

function validateSecretSourceRecord(record, path, handle) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`secret record for ${handle} must be an object in ${path}`);
  }
  if (!["env", "dotenv", "touba_store"].includes(record.source)) {
    throw new Error(`secret record for ${handle} has unsupported source ${record.source}`);
  }
  if (typeof record.name !== "string" || record.name.length === 0) {
    throw new Error(`secret record for ${handle} must declare name`);
  }
  if ((record.source === "dotenv" || record.source === "touba_store")
    && (typeof record.path !== "string" || record.path.length === 0)) {
    throw new Error(`secret record for ${handle} must declare path for ${record.source}`);
  }
}

function readRunPlan(path, diagnostics) {
  if (!existsSync(path)) {
    return null;
  }
  let document;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    diagnostics.push(errorDiagnostic("RunPlanSchemaMismatch", error.message, { run_plan_path: path }));
    return null;
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    diagnostics.push(errorDiagnostic("RunPlanSchemaMismatch", "run plan must be a JSON object", { run_plan_path: path }));
    return null;
  }
  return document;
}

function inspectRunPlan({ currentRunPlan, expectedRunPlan, runPlanPath, diagnostics, actions, mode }) {
  if (currentRunPlan === null) {
    actions.push(action(mode === "write" ? "create_run_plan" : "would_create_run_plan", runPlanPath));
    if (mode === "check") {
      diagnostics.push(errorDiagnostic("RunPlanMissing", "run plan is missing", { run_plan_path: runPlanPath }));
    }
    return;
  }

  const shapeOk = validateRunPlanShape(currentRunPlan, runPlanPath, diagnostics);
  if (!shapeOk) {
    return;
  }

  if (!runPlanEquivalent(currentRunPlan, expectedRunPlan)) {
    actions.push(action(mode === "write" ? "update_run_plan" : "would_update_run_plan", runPlanPath));
    if (mode === "check") {
      diagnostics.push(errorDiagnostic("RunPlanDrift", "run plan does not match prepared project artifacts", {
        run_plan_path: runPlanPath,
      }));
    }
  }

  if (mode === "check") {
    validateRunPlanResolvedFiles(currentRunPlan, runPlanPath, diagnostics);
  }
}

function validateRunPlanShape(document, runPlanPath, diagnostics) {
  let ok = true;
  if (document.run_plan_schema_version !== TOUBA_RUN_PLAN_SCHEMA_VERSION) {
    diagnostics.push(errorDiagnostic("RunPlanSchemaMismatch", `run_plan_schema_version must be ${TOUBA_RUN_PLAN_SCHEMA_VERSION}`, {
      run_plan_path: runPlanPath,
      actual: document.run_plan_schema_version,
    }));
    ok = false;
  }
  const forbiddenField = findForbiddenRunPlanField(document);
  if (forbiddenField !== null) {
    diagnostics.push(errorDiagnostic("RunPlanSensitivePayloadForbidden", `run plan cannot contain sensitive payload field ${forbiddenField}`, {
      run_plan_path: runPlanPath,
      field: forbiddenField,
    }));
    ok = false;
  }
  if (typeof document.entry_ref !== "string" || document.entry_ref.trim() === "") {
    diagnostics.push(errorDiagnostic("RunPlanEntryUnknown", "run plan must declare entry_ref", {
      run_plan_path: runPlanPath,
    }));
    ok = false;
  }
  if (typeof document.air !== "string" || document.air.trim() === "") {
    diagnostics.push(errorDiagnostic("RunPlanAirMissing", "run plan must point to an AIR file", {
      run_plan_path: runPlanPath,
    }));
    ok = false;
  }
  for (const field of ["manifest", "secrets_profile", "supply_chain_lock", "trigger_manifest"]) {
    if (document[field] !== undefined && (typeof document[field] !== "string" || document[field].trim() === "")) {
      diagnostics.push(errorDiagnostic("RunPlanSchemaMismatch", `run plan ${field} must be a non-empty string`, {
        run_plan_path: runPlanPath,
        field,
      }));
      ok = false;
    }
  }
  if (document.profile !== undefined && !RUN_PROFILE_PATTERN.test(String(document.profile))) {
    diagnostics.push(errorDiagnostic("RunPlanSchemaMismatch", "run plan profile name is invalid", {
      run_plan_path: runPlanPath,
      profile: document.profile,
    }));
    ok = false;
  }
  if (!validateRunPlanOutputsShape(document.outputs, runPlanPath, diagnostics)) {
    ok = false;
  }
  return ok;
}

function validateRunPlanOutputsShape(outputs, runPlanPath, diagnostics) {
  if (outputs === undefined) {
    return true;
  }
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) {
    diagnostics.push(errorDiagnostic("RunPlanSchemaMismatch", "run plan outputs must be an object", { run_plan_path: runPlanPath }));
    return false;
  }
  if (outputs.mode !== undefined && !["show", "result", "trace", "all", "run-summary"].includes(outputs.mode)) {
    diagnostics.push(errorDiagnostic("RunPlanSchemaMismatch", "run plan outputs.mode must be one of show, result, trace, all, run-summary", {
      run_plan_path: runPlanPath,
    }));
    return false;
  }
  if (outputs.trace_out !== undefined && (typeof outputs.trace_out !== "string" || outputs.trace_out.trim() === "")) {
    diagnostics.push(errorDiagnostic("RunPlanSchemaMismatch", "run plan outputs.trace_out must be a non-empty string", {
      run_plan_path: runPlanPath,
    }));
    return false;
  }
  return true;
}

function validateRunPlanResolvedFiles(document, runPlanPath, diagnostics) {
  const baseDir = dirname(runPlanPath);
  const files = [
    ["air", "RunPlanAirMissing"],
    ["manifest", "RunPlanManifestMissing"],
    ["secrets_profile", "RunPlanSecretsProfileMissing"],
    ["trigger_manifest", "RunPlanTriggerManifestMissing"],
  ];
  for (const [field, code] of files) {
    if (typeof document[field] === "string" && !existsSync(resolve(baseDir, document[field]))) {
      diagnostics.push(errorDiagnostic(code, `run plan ${field} does not exist`, {
        run_plan_path: runPlanPath,
        field,
        path: resolve(baseDir, document[field]),
      }));
    }
  }
  if (typeof document.supply_chain_lock === "string" && !existsSync(resolve(baseDir, document.supply_chain_lock))) {
    diagnostics.push(errorDiagnostic("RunPlanSupplyChainLockRequired", "run plan supply_chain_lock does not exist", {
      run_plan_path: runPlanPath,
      field: "supply_chain_lock",
      path: resolve(baseDir, document.supply_chain_lock),
    }));
  }
}

function runPlanEquivalent(actual, expected) {
  return JSON.stringify(canonicalRunPlan(actual)) === JSON.stringify(canonicalRunPlan(expected));
}

function canonicalRunPlan(document) {
  return {
    run_plan_schema_version: document.run_plan_schema_version,
    entry_ref: document.entry_ref,
    air: document.air,
    ...(document.manifest !== undefined ? { manifest: document.manifest } : {}),
    ...(document.secrets_profile !== undefined ? { secrets_profile: document.secrets_profile } : {}),
    profile: document.profile,
    ...(document.supply_chain_lock !== undefined ? { supply_chain_lock: document.supply_chain_lock } : {}),
    ...(document.trigger_manifest !== undefined ? { trigger_manifest: document.trigger_manifest } : {}),
    ...(document.run_limits !== undefined ? { run_limits: document.run_limits } : {}),
    ...(document.outputs !== undefined ? { outputs: document.outputs } : {}),
  };
}

function findForbiddenRunPlanField(value, path = []) {
  if (!value || typeof value !== "object") {
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (RUN_PLAN_FORBIDDEN_FIELDS.has(key)) {
      return [...path, key].join(".");
    }
    const nested = findForbiddenRunPlanField(child, [...path, key]);
    if (nested !== null) {
      return nested;
    }
  }
  return null;
}

function mergeManifest(currentManifest, expectedManifest, diagnostics, manifestPath) {
  if (currentManifest === null) {
    return expectedManifest;
  }
  if (currentManifest.manifest_version !== TOUBA_MANIFEST_VERSION || !currentManifest.bindings) {
    diagnostics.push(errorDiagnostic("ManifestCannotMerge", "existing manifest is invalid and cannot be updated safely", {
      manifest_path: manifestPath,
    }));
    return currentManifest;
  }
  const merged = {
    ...currentManifest,
    bindings: { ...currentManifest.bindings },
  };
  for (const [toolRef, expectedBinding] of Object.entries(expectedManifest.bindings)) {
    if (merged.bindings[toolRef] === undefined) {
      merged.bindings[toolRef] = expectedBinding;
    }
  }
  for (const [agentRef, secrets] of Object.entries(expectedManifest.agent_secret_scopes ?? {})) {
    if (merged.agent_secret_scopes === undefined) {
      merged.agent_secret_scopes = {};
    }
    const currentSecrets = Array.isArray(merged.agent_secret_scopes[agentRef])
      ? merged.agent_secret_scopes[agentRef]
      : [];
    merged.agent_secret_scopes[agentRef] = [...new Set([...currentSecrets, ...secrets])].sort();
  }
  return merged;
}

function mergeSecretProfile(currentProfile, expectedProfile) {
  if (currentProfile === null) {
    return expectedProfile;
  }
  const merged = {
    ...currentProfile,
    secrets: { ...currentProfile.secrets },
  };
  for (const [handle, record] of Object.entries(expectedProfile.secrets)) {
    if (merged.secrets[handle] === undefined) {
      merged.secrets[handle] = record;
    }
  }
  return merged;
}

function computeStatus(mode, diagnostics, actions) {
  if (hasErrorDiagnostics(diagnostics)) {
    return "error";
  }
  if (mode === "plan" && actions.length > 0) {
    return "needs_changes";
  }
  return "success";
}

function hasErrorDiagnostics(diagnostics) {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

function normalizeStringArray(values) {
  if (values === undefined) {
    return [];
  }
  if (!Array.isArray(values)) {
    throw new Error("AIR tool list field must be an array when present");
  }
  return values.map((value) => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error("AIR tool list entries must be non-empty strings");
    }
    return value;
  });
}

function normalizeMemoryAccesses(values) {
  if (values === undefined) {
    return [];
  }
  if (!Array.isArray(values)) {
    throw new Error("AIR tool memory_accesses must be an array when present");
  }
  return values.map((memory) => ({
    ref: memory.memory_ref,
    access: memory.access,
  }));
}

function action(kind, path, extra = {}) {
  return { kind, path, ...extra };
}

function errorDiagnostic(code, message, extra = {}) {
  return { severity: "error", code, message, ...extra };
}

function toPosixPath(path) {
  return path.split(sep).join("/");
}
