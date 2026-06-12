import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const composeFile = path.join(fixtureRoot, "docker/docker-compose.memory-backend.yml");
const projectName = `touba-memory-backend-host-${process.pid}`;
const hostPort = Number.parseInt(process.env.TOUBA_MEMORY_BACKEND_PORT ?? "18787", 10);
const secretValue = process.env.MEMORY_BACKEND_TOKEN ?? "memory-backend-token-secret";
const endpoint = `http://127.0.0.1:${hostPort}`;
const dockerEnv = {
  ...process.env,
  MEMORY_BACKEND_TOKEN: secretValue,
  TOUBA_MEMORY_BACKEND_PORT: String(hostPort),
};

try {
  await dockerCompose(["up", "--build", "-d"]);
  await waitForHealth();
  const validation = await runProcess(process.execPath, [
    path.join(fixtureRoot, "validate.mjs"),
    "--external-endpoint",
    endpoint,
  ], {
    cwd: path.resolve(fixtureRoot, "../.."),
    env: {
      ...process.env,
      MEMORY_BACKEND_TOKEN: secretValue,
    },
  });
  assertSuccess("memory backend docker validation", validation);
  process.stdout.write(validation.stdout);
  console.log("memory-backend-host: docker=status=success image=node:24.15.0-alpine");
} finally {
  await dockerCompose(["down", "-v"], { allowFailure: true });
}

async function dockerCompose(args, options = {}) {
  const result = await runProcess("docker", [
    "compose",
    "-f",
    composeFile,
    "-p",
    projectName,
    ...args,
  ], {
    cwd: fixtureRoot,
    env: dockerEnv,
  });
  if (options.allowFailure !== true) {
    assertSuccess(`docker compose ${args.join(" ")}`, result);
  }
  return result;
}

async function waitForHealth() {
  const deadline = Date.now() + 30000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/health`);
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`memory backend Docker healthcheck failed: ${lastError}`);
}

function runProcess(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ status: 1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function assertSuccess(label, result) {
  if (result.status !== 0) {
    throw new Error(
      `${label} failed with code ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}
