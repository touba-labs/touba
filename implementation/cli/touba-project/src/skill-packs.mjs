// Contextual skill runtime projection. Authors declare only touba.package.json;
// the runtime protocol is derived, never a second author manifest.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PACKAGE_NAME, PACKAGE_RUNTIME_VERSION, packageDigest, packageError, packageFile, readPackage } from "./package-contract.mjs";
import { verifyInstalledPackages } from "./package-store.mjs";

export function projectContextSelections(projectRoot) {
  const file = join(projectRoot, "touba.project.json");
  if (!existsSync(file)) return [];
  const entries = normalizeProjectContexts(JSON.parse(readFileSync(file, "utf8")).configuration?.contexts);
  return entries.map(entry => ({ selection: `${join(projectRoot, "packages", entry.package)}#${entry.context}`,
    ref: `skill_pack:${entry.package}/${entry.context}`, active: entry.active }));
}

export function normalizeProjectContexts(entries = []) {
  if (!Array.isArray(entries) || entries.length > 32) throw packageError("PackageContextInvalid", "configuration.contexts must contain at most 32 entries");
  const seen = new Set();
  return entries.map(entry => {
    if (!entry || Object.keys(entry).some(key => !["package", "context", "active"].includes(key))
        || !PACKAGE_NAME.test(entry.package ?? "") || !/^[a-z][a-z0-9-]*$/.test(entry.context ?? "")
        || (entry.active !== undefined && typeof entry.active !== "boolean")) throw packageError("PackageContextInvalid", "project context requires package, context and optional boolean active");
    const ref = `skill_pack:${entry.package}/${entry.context}`;
    if (seen.has(ref)) throw packageError("PackageContextInvalid", "duplicate project context");
    seen.add(ref);
    return { package: entry.package, context: entry.context, active: entry.active === true };
  });
}

export function loadProjectContexts(projectRoot, air) {
  const selected = projectContextSelections(projectRoot);
  return { skillPacks: selected.map(({ selection }) => loadSkillPack(selection, air, { projectRoot })),
    activeSkillPackRefs: selected.filter(entry => entry.active).map(entry => entry.ref) };
}

export function loadSkillPack(selection, air, { projectRoot } = {}) {
  const [path, id, extra] = selection.split("#");
  if (extra !== undefined) throw packageError("PackageContextInvalid", "use <package-path>#<context-id>");
  const pkg = readPackage(path, { runtimeVersion: PACKAGE_RUNTIME_VERSION });
  let project = projectRoot ? realpathSync(projectRoot) : pkg.root;
  while (!existsSync(join(project, "touba.project.json")) && dirname(project) !== project) project = dirname(project);
  let source = "author";
  if (existsSync(join(project, "touba.project.json"))) {
    const config = JSON.parse(readFileSync(join(project, "touba.project.json"), "utf8"));
    const lock = verifyInstalledPackages(project, config.packages ?? []);
    const installed = lock.packages.find(entry => entry.name === pkg.document.name);
    if (!installed || resolve(project, installed.manifest) !== pkg.manifestPath) {
      throw packageError("PackageNotInstalled", "context must come from the registered package in this project; use touba package add before activation");
    }
    if (installed.digest !== pkg.digest || installed.version !== pkg.document.version) throw packageError("PackageIntegrityMismatch", "context does not match the installed package lock");
    source = "project";
  } else if (projectRoot) {
    throw packageError("PackageProjectRequired", "context activation requires an initialized consuming project");
  }
  const contexts = pkg.document.contexts ?? [];
  const context = id ? contexts.find(c => c.id === id) : contexts.length === 1 ? contexts[0] : undefined;
  if (!context) throw packageError("PackageContextInvalid", "select one declared context with <package-path>#<context-id>");
  for (const link of context.execution_links ?? []) {
    const kind = link.target_ref.startsWith("tool:") ? "tools" : "skills";
    if (air && !(air.definitions?.[kind] ?? []).some(item => item.id === link.target_ref)) throw packageError("SkillPackExecutionLinkUnauthorized", `execution target is absent from the consuming program: ${link.target_ref}`);
  }
  const resources = [{ name: "procedure", path: context.procedure, kind: "procedure", description: context.description, loadable_as_context: true }, ...(context.resources ?? [])].map(resource => {
    const bytes = readFileSync(packageFile(pkg.root, resource.path));
    const expected = pkg.files.find(file => file.path === resource.path);
    const digest = packageDigest(bytes);
    if (expected?.digest !== digest) throw packageError("PackageIntegrityMismatch", "context changed during loading");
    const loadable = resource.kind !== "script" && resource.loadable_as_context !== false;
    return { ref: `resource:${context.id}/${resource.name}`, path: resource.path, kind: resource.kind,
      description: resource.description, loadable_as_context: loadable, executable_by_pack: false, digest,
      ...(loadable ? { content: bytes.toString("utf8") } : {}) };
  });
  return { skill_pack_schema_version: "touba-skill-pack-v1", ref: `skill_pack:${pkg.document.name}/${context.id}`,
    name: context.id, description: context.description, version: pkg.document.version, tags: [], source,
    activation: { model_invocable: true, user_invocable: true, ...context.activation }, resources,
    execution_links: context.execution_links ?? [] };
}
