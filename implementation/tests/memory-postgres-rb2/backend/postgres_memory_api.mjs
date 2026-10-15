import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import pg from "pg";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8788;
const MAX_BODY_BYTES = 16384;

const { Pool } = pg;

async function createApp() {
  const token = requiredEnv("POSTGRES_MEMORY_TOKEN");
  const pool = new Pool({
    connectionString: requiredEnv("DATABASE_URL"),
  });
  await initialize(pool);

  return {
    server: createServer((request, response) => {
      handleRequest({ request, response, pool, token }).catch(() => {
        writeJson(response, 500, { error: "InternalPostgresMemoryError" });
      });
    }),
    pool,
  };
}

async function initialize(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_memory (
      customer_id text PRIMARY KEY,
      stored_note text NOT NULL,
      write_count bigint NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function handleRequest({ request, response, pool, token }) {
  if (request.method === "GET" && request.url === "/health") {
    await pool.query("SELECT 1");
    writeJson(response, 200, { status: "ok", backend: "postgres" });
    return;
  }

  if (request.headers.authorization !== `Bearer ${token}`) {
    writeJson(response, 401, { error: "Unauthorized" });
    return;
  }

  const url = new URL(request.url, "http://postgres-memory-api");
  const match = /^\/notes\/([^/]+)$/.exec(url.pathname);
  if (!match) {
    writeJson(response, 404, { error: "NotFound" });
    return;
  }

  const customerId = decodeURIComponent(match[1]);
  if (request.method === "POST") {
    const body = await readJsonBody(request);
    if (typeof body.note !== "string" || body.note.trim() === "") {
      writeJson(response, 400, { error: "InvalidNote" });
      return;
    }
    const result = await pool.query(
      `INSERT INTO customer_memory (customer_id, stored_note, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (customer_id)
       DO UPDATE SET stored_note = excluded.stored_note, updated_at = now(),
         write_count = customer_memory.write_count + 1
       RETURNING customer_id, stored_note`,
      [customerId, body.note],
    );
    writeJson(response, 200, result.rows[0]);
    return;
  }

  if (request.method === "GET") {
    const result = await pool.query(
      "SELECT customer_id, stored_note FROM customer_memory WHERE customer_id = $1",
      [customerId],
    );
    if (result.rowCount === 0) {
      writeJson(response, 404, { error: "MissingNote" });
      return;
    }
    writeJson(response, 200, result.rows[0]);
    return;
  }

  writeJson(response, 405, { error: "MethodNotAllowed" });
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("request body too large");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function main() {
  const app = await createApp();
  const host = process.env.HOST ?? DEFAULT_HOST;
  const port = Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(port, host, resolve);
  });
  console.log(`postgres-memory-api listening ${host}:${port}`);

  const close = async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await app.pool.end();
  };
  process.once("SIGTERM", () => {
    close().finally(() => process.exit(0));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
