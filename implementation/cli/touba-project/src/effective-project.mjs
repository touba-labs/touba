import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

export const EFFECTIVE_PROJECT_SCHEMA_VERSION = "touba-effective-project-v1";

export function buildEffectiveProjectDocument(options) {
  const {
    root,
    profile,
    projectConfigPath,
    projectConfig,
    preparedAirDocuments,
    sources,
    airRoot,
    manifestPath,
    expectedManifest,
    bindingFragmentPaths,
    resourceBindingsPaths,
    ownershipPath,
    runPlanPath,
    expectedRunPlan,
    expectedSecretHandles,
    evidenceRoot,
  } = options;
  const documents = preparedAirDocuments.map((entry) => entry.document);
  const modules = documents.map((document) => document.module.name).sort();
  const sourcePaths = sources.map((source) => relativePath(root, source.path)).sort();
  const airPaths = documents
    .map((document) => `${relativePath(root, airRoot)}/${document.module.name.split(".").join("/")}.air.json`)
    .sort();
  const toolBindings = Object.entries(expectedManifest.bindings ?? {})
    .sort(([left], [right]) => left.localeCompare(right));
  const inputRecords = [
    declaredInput(root, "project", projectConfigPath),
    ...sources.map((source) => declaredInput(root, "source", source.path)),
    ...bindingFragmentPaths.map((item) => declaredInput(root, "binding_fragment", item)),
    ...resourceBindingsPaths.map((item) => declaredInput(root, "resource_bindings", item)),
    ...(ownershipPath ? [declaredInput(root, "ownership", ownershipPath)] : []),
    ...documents.map((document) => derivedInput(
      root,
      "air",
      resolve(root, airRoot, ...document.module.name.split(".")) + ".air.json",
      document,
    )),
    ...(toolBindings.length > 0
      ? [derivedInput(root, "manifest", manifestPath, expectedManifest)]
      : []),
    ...(expectedRunPlan && runPlanPath
      ? [derivedInput(root, "run_plan", runPlanPath, expectedRunPlan)]
      : []),
  ].filter(Boolean);
  const lockPath = expectedRunPlan?.supply_chain_lock && runPlanPath
    ? resolve(dirname(runPlanPath), expectedRunPlan.supply_chain_lock)
    : null;
  if (lockPath && existsSync(lockPath)) {
    inputRecords.push(declaredInput(root, "supply_chain_lock", lockPath));
  }

  return {
    schema_version: EFFECTIVE_PROJECT_SCHEMA_VERSION,
    artifact_role: "derived_non_authoritative",
    project: {
      artifact_layout: projectConfig.artifact_layout,
      profile,
    },
    inputs: inputRecords.sort(compareInputs),
    contract: {
      sources: projection("declared", sourcePaths, { modules, paths: sourcePaths }),
      air: projection("derived", sourcePaths, { modules, paths: airPaths }),
      entry: expectedRunPlan
        ? projection("effective", [relativePath(root, runPlanPath)], { ref: expectedRunPlan.entry_ref })
        : projection("absent", [], { reason: "no entry is declared for this profile" }),
      handlers: toolBindings.length > 0
        ? projection("effective", [relativePath(root, manifestPath)], {
          bindings: toolBindings.map(([toolRef, binding]) => ({
            tool_ref: toolRef,
            kind: binding.handler?.kind ?? "unknown",
          })),
        })
        : projection("non_applicable", [], { reason: "the prepared AIR declares no tool" }),
      grants: toolBindings.length > 0
        ? projection("effective", [relativePath(root, manifestPath)], {
          bindings: toolBindings.map(([toolRef, binding]) => ({
            tool_ref: toolRef,
            capabilities: sortedStrings(binding.grants?.capabilities ?? binding.grants),
          })),
        })
        : projection("non_applicable", [], { reason: "the prepared AIR declares no tool" }),
      secrets: expectedSecretHandles.length > 0
        ? projection("declared", sourcePaths, { handles: sortedStrings(expectedSecretHandles) })
        : projection("non_applicable", [], { reason: "no secret handle is required" }),
      memory_scopes: memoryScopeProjection(documents, sourcePaths),
      callers: callerProjection(documents, sourcePaths),
      budgets: budgetProjection(documents, sourcePaths),
      sandbox: projection("absent", [], { reason: "no project sandbox contract is declared in V1" }),
      lock: lockPath
        ? projection("declared", [relativePath(root, lockPath)], {
          path: relativePath(root, lockPath),
          available: existsSync(lockPath),
        })
        : projection(profile === "prod" ? "absent" : "non_applicable", [], {
          reason: profile === "prod" ? "no supply-chain lock was resolved" : "profile does not require a supply-chain lock",
        }),
      triggers: triggerProjection(documents, sourcePaths),
      evidence: evidenceProjection(root, evidenceRoot),
    },
  };
}

export function assertEffectiveProjectSafe(document) {
  const forbiddenKeys = new Set([
    "content",
    "memory_content",
    "payload",
    "prompt",
    "result",
    "secret_value",
    "secret_values",
    "token",
    "value",
  ]);
  walk(document, (key) => {
    if (forbiddenKeys.has(key)) {
      throw new Error(`effective project projection contains forbidden sensitive field ${key}`);
    }
  });
  return document;
}

function projection(status, sources, details) {
  return {
    provenance: {
      status,
      sources: [...new Set(sources)].sort(),
    },
    ...details,
  };
}

function memoryScopeProjection(documents, sources) {
  const scopes = [];
  for (const document of documents) {
    for (const collection of ["skills", "agents", "strategies"]) {
      for (const owner of document.definitions?.[collection] ?? []) {
        for (const scope of owner.memory_scopes ?? []) {
          scopes.push({
            memory_ref: scope.memory_ref,
            owner_ref: owner.id,
            access: sortedStrings(Array.isArray(scope.access) ? scope.access : [scope.access]),
          });
        }
      }
    }
  }
  return scopes.length > 0
    ? projection("derived", sources, { scopes: scopes.sort(compareJson) })
    : projection("non_applicable", [], { reason: "no memory scope is declared" });
}

function callerProjection(documents, sources) {
  const agents = [];
  for (const document of documents) {
    for (const agent of document.definitions?.agents ?? []) {
      agents.push({
        agent_ref: agent.id,
        caller_refs: sortedStrings((agent.callable_by ?? []).map((item) => item.caller_ref ?? item)),
      });
    }
  }
  return agents.length > 0
    ? projection("declared", sources, { agents: agents.sort(compareJson) })
    : projection("non_applicable", [], { reason: "no agent is declared" });
}

function budgetProjection(documents, sources) {
  const budgets = [];
  for (const document of documents) {
    for (const [kind, budget] of Object.entries(document.budgets?.run ?? {})) {
      budgets.push({
        kind,
        limit: budget?.value,
      });
    }
  }
  return budgets.length > 0
    ? projection("derived", sources, { budgets: budgets.sort(compareJson) })
    : projection("absent", [], { reason: "no run budget is declared" });
}

function triggerProjection(documents, sources) {
  const triggers = [];
  for (const document of documents) {
    for (const trigger of document.definitions?.triggers ?? []) {
      triggers.push({
        trigger_ref: trigger.id,
        target_ref: trigger.target_ref ?? trigger.runs?.target_ref ?? null,
        event_kind: trigger.event?.kind ?? trigger.event_kind ?? "unknown",
      });
    }
  }
  return triggers.length > 0
    ? projection("derived", sources, { triggers: triggers.sort(compareJson) })
    : projection("non_applicable", [], { reason: "no trigger is declared" });
}

function evidenceProjection(root, evidenceRoot) {
  const files = collectFiles(evidenceRoot).map((item) => ({
    path: relativePath(root, item),
    digest_sha256: digestBytes(readFileSync(item)),
  }));
  return files.length > 0
    ? projection("effective", files.map((item) => item.path), { artifacts: files })
    : projection("absent", [], { reason: "no local evidence artifact is available" });
}

function collectFiles(root) {
  if (!root || !existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(fullPath));
    else if (entry.isFile() && statSync(fullPath).size >= 0) files.push(fullPath);
  }
  return files.sort();
}

function declaredInput(root, kind, path) {
  if (!path || !existsSync(path)) return null;
  return {
    kind,
    path: relativePath(root, path),
    digest_sha256: digestBytes(readFileSync(path)),
    provenance: "declared",
  };
}

function derivedInput(root, kind, path, document) {
  return {
    kind,
    path: relativePath(root, path),
    digest_sha256: digestBytes(Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8")),
    provenance: "derived",
  };
}

function digestBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function relativePath(root, path) {
  return relative(root, path).split(sep).join("/") || ".";
}

function sortedStrings(values = []) {
  return [...new Set((values ?? []).filter((item) => typeof item === "string"))].sort();
}

function compareInputs(left, right) {
  return `${left.kind}:${left.path}`.localeCompare(`${right.kind}:${right.path}`);
}

function compareJson(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function walk(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    visit(key, child);
    walk(child, visit);
  }
}
