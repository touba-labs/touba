// Contextual skill runtime projection. Authors declare only touba.package.json;
// the runtime protocol is derived, never a second author manifest.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PACKAGE_RUNTIME_VERSION, packageDigest, packageError, packageFile, readPackage } from "./package-contract.mjs";
import { verifyInstalledPackages } from "./package-store.mjs";

export function loadSkillPack(selection, air) {
  const [path, id, extra] = selection.split("#");
  if (extra !== undefined) throw packageError("PackageContextInvalid", "use <package-path>#<context-id>");
  const pkg = readPackage(path, { runtimeVersion: PACKAGE_RUNTIME_VERSION });
  let project = pkg.root;
  while (!existsSync(join(project, "touba.project.json")) && dirname(project) !== project) project = dirname(project);
  if (existsSync(join(project, "touba.project.json"))) {
    const config = JSON.parse(readFileSync(join(project, "touba.project.json"), "utf8"));
    verifyInstalledPackages(project, config.packages ?? []);
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
    name: context.id, description: context.description, version: pkg.document.version, tags: [], source: "project",
    activation: { model_invocable: true, user_invocable: true, ...context.activation }, resources,
    execution_links: context.execution_links ?? [] };
}
