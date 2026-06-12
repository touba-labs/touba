import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const implementationRoot = path.resolve(projectRoot, "../..");
const sourcePath = path.join(projectRoot, "src/program.tb");
const manifestTemplatePath = path.join(projectRoot, "touba.manifest.template.json");
const secretsPath = path.join(projectRoot, "touba.secrets.prod.json");
const tmpRoot = mkdtempSync(path.join(tmpdir(), "touba-v1-workflow-"));
const airPath = path.join(tmpRoot, "program.air.json");
const manifestPath = path.join(tmpRoot, "touba.manifest.json");
const cargo = process.env.CARGO ?? "cargo";
const demoSecret = process.env.TOUBA_DEMO_API_KEY ?? "fixture-secret-not-in-trace";

try {
  const manifest = JSON.parse(readFileSync(manifestTemplatePath, "utf8"));
  const binding = manifest.bindings["tool:examples.v1_developer_project/FetchProfile"];
  binding.handler.command = process.execPath;
  binding.handler.cwd = projectRoot;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const compileResult = spawnSync(
    cargo,
    ["run", "-p", "touba-cli", "--bin", "touba-compile", "--quiet", "--", sourcePath],
    {
      cwd: implementationRoot,
      encoding: "utf8",
    },
  );
  assertSuccess("compile", compileResult);
  writeFileSync(airPath, compileResult.stdout, "utf8");

  const runResult = spawnSync(
    process.execPath,
    [
      path.join(implementationRoot, "cli/touba-run/src/run.mjs"),
      airPath,
      "--manifest",
      manifestPath,
      "--secrets",
      secretsPath,
      "--inputs-json",
      JSON.stringify({ request: { query: "workflow" } }),
      "--output",
      "trace",
    ],
    {
      cwd: implementationRoot,
      env: {
        ...process.env,
        TOUBA_DEMO_API_KEY: demoSecret,
      },
      encoding: "utf8",
    },
  );
  assertSuccess("run", runResult);

  const trace = JSON.parse(runResult.stdout);
  const completed = trace.events?.find((event) => event.kind === "run_completed");
  const status = completed?.payload?.status;
  if (status !== "success") {
    throw new Error(`expected trace status success, got ${status}`);
  }
  if (runResult.stdout.includes(demoSecret)) {
    throw new Error("secret value leaked into workflow trace");
  }
  if (!runResult.stdout.includes("DEMO_API_KEY")) {
    throw new Error("secret handle was not visible in trace");
  }
  console.log("workflow:v1-developer-project status=success secret_value_absent=true");
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

function assertSuccess(label, result) {
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${label} failed with code ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}
