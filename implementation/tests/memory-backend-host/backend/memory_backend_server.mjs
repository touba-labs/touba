import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "0.0.0.0";

export function createMemoryBackendServer({ secretValue, memory = new Map() } = {}) {
  if (typeof secretValue !== "string" || secretValue.length === 0) {
    throw new Error("MEMORY_BACKEND_TOKEN is required");
  }

  return createServer(async (request, response) => {
    try {
      await handleMemoryRequest({ request, response, secretValue, memory });
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "InternalBackendError" }));
    }
  });
}

export async function listenMemoryBackendServer(server, { host = "127.0.0.1", port = 0 } = {}) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return server;
}

export async function closeMemoryBackendServer(server) {
  if (!server) {
    return;
  }
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function handleMemoryRequest({ request, response, secretValue, memory }) {
  if (request.url === "/health" && request.method === "GET") {
    writeJson(response, { status: "ok" });
    return;
  }

  if (request.headers.authorization !== `Bearer ${secretValue}`) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  const url = new URL(request.url, "http://memory-backend");
  const match = /^\/notes\/([^/]+)$/.exec(url.pathname);
  if (!match) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "NotFound" }));
    return;
  }

  const customerId = decodeURIComponent(match[1]);
  if (request.method === "POST") {
    const body = await readJsonBody(request);
    if (typeof body.note !== "string" || body.note.trim() === "") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "InvalidNote" }));
      return;
    }
    memory.set(customerId, body.note);
    writeJson(response, { customer_id: customerId, stored_note: body.note });
    return;
  }

  if (request.method === "GET") {
    const note = memory.get(customerId);
    if (note === undefined) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "MissingNote" }));
      return;
    }
    writeJson(response, { customer_id: customerId, stored_note: note });
    return;
  }

  response.writeHead(405, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "MethodNotAllowed" }));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) {
      throw new Error("request body too large");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(response, body) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function main() {
  const server = createMemoryBackendServer({
    secretValue: process.env.MEMORY_BACKEND_TOKEN,
  });
  const host = process.env.HOST ?? DEFAULT_HOST;
  const port = Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  await listenMemoryBackendServer(server, { host, port });
  const address = server.address();
  const rendered = typeof address === "string" ? address : `${address.address}:${address.port}`;
  console.log(`memory-backend-host listening ${rendered}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
