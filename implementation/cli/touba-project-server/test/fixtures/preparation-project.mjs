import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../../touba-project/src/project.mjs";
import { newPackage, addPackage, removePackage } from "../../../touba-project/src/packages.mjs";

export const preparationTool = "tool:example.records/Export";
export const preparationPolicy = { role: "reviewer", timeout_ms: 60000, distinct_from: "initiator" };
const json = file => JSON.parse(readFileSync(file, "utf8"));
export const savePreparationJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const declaration = approval => `module example.records
tool Export
    takes value as Text
    gives Text
${approval ? '    human.approve\n        with role as "reviewer"\n        with timeout_ms as 60000\n        with distinct_from as "initiator"\n' : ''}`;

// Synthetic, no SDK install/provider or handler execution. Caller owns cleanup.
export async function preparationFixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "touba-preparation-review-")));
  const source = newPackage("example.records", { root: directory }).path;
  const packagePath = join(source, "touba.package.json");
  const pkg = json(packagePath);
  Object.assign(pkg, { publisher: "test", license: "MIT", exports: { tools: [preparationTool] },
    handlers: [{ tool: preparationTool, path: "handlers/export.mjs", protocol: "touba-tool-handler-v1" }] });
  savePreparationJson(packagePath, pkg);
  const sourcePath = join(source, "src/example/records.tb");
  writeFileSync(sourcePath, declaration(true));
  mkdirSync(join(source, "handlers"));
  writeFileSync(join(source, "handlers/export.mjs"), "throw new Error('Preparation must never execute a handler');\n");
  const root = join(directory, "consumer"); initProject({ root });
  mkdirSync(join(root, "src/client"), { recursive: true });
  writeFileSync(join(root, "src/client/main.tb"), `module client.main
import tool Export from example.records
strategy Run
    takes value as Text
    gives Text
    uses Export
    do
        Export
            with value as value
            into result
        give result
`);
  await addPackage(source, { root });
  const configPath = join(root, "touba.project.json"), config = json(configPath);
  config.entry = "strategy:client.main/Run";
  config.configuration = { ...config.configuration, binding_fragments: ["bindings.json"] };
  savePreparationJson(configPath, config);
  const fragmentPath = join(root, "bindings.json");
  savePreparationJson(fragmentPath, { fragment_schema_version: "touba-binding-fragment-v1", source: { kind: "module", module: "example.records" },
    bindings: { [preparationTool]: { handler: { kind: "process", command: process.execPath, args: ["packages/example.records/handlers/export.mjs"], cwd: "." },
      grants: [], secrets: [], effect_contract: { kind: "none" }, timeout_ms: 5000, max_payload_bytes: 65536 } } });
  return { directory, root, configPath, fragmentPath, async removeApproval() {
    await removePackage("example.records", { root });
    const pkg = json(packagePath); pkg.version = "0.1.1"; savePreparationJson(packagePath, pkg);
    writeFileSync(sourcePath, declaration(false));
    await addPackage(source, { root });
  } };
}
