import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export async function startLocalReservationService({ statePath, token, dropFirstCreateResponse = false }) {
  const behavior = { dropFirstCreateResponse };
  const observations = [];
  const server = createServer(async (request, response) => {
    try {
      observations.push({ method: request.method, url: request.url, authorized: request.headers.authorization === `Bearer ${token}` });
      if (request.headers.authorization !== `Bearer ${token}`) return send(response, 403, { code: "Forbidden" });
      if (request.method === "GET" && request.url === "/state") return send(response, 200, loadState(statePath));
      if (request.method === "GET" && request.url?.startsWith("/operations/")) {
        const key = decodeURIComponent(request.url.slice("/operations/".length));
        const operation = loadState(statePath).operations[key];
        return operation ? send(response, 200, operation) : send(response, 404, { code: "NotFound" });
      }
      const body = await readBody(request);
      observations.at(-1).body = body;
      if (request.method === "POST" && request.url === "/reservations") {
        return createReservation(response, statePath, body, behavior);
      }
      if (request.method === "POST" && request.url === "/releases") {
        return releaseReservation(response, statePath, body);
      }
      return send(response, 404, { code: "NotFound" });
    } catch {
      return send(response, 400, { code: "InvalidRequest" });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    observations,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function createReservation(response, statePath, body, behavior) {
  if (!bounded(body.reservation_id) || !bounded(body.idempotency_key)) return send(response, 422, { code: "InvalidReservation" });
  const state = loadState(statePath);
  const existing = state.operations[body.idempotency_key];
  if (existing) {
    if (existing.kind !== "create" || existing.reservation_id !== body.reservation_id) {
      return send(response, 409, { code: "IdempotencyConflict" });
    }
    return send(response, 200, { ...existing.response, replayed: true });
  }
  const payload = {
    reservation_id: body.reservation_id,
    receipt_ref: `reservation:${body.reservation_id}`,
    status: "active",
  };
  state.reservations[body.reservation_id] = { status: "active", receipt_ref: payload.receipt_ref };
  state.operations[body.idempotency_key] = {
    kind: "create",
    reservation_id: body.reservation_id,
    outcome: "applied",
    response: payload,
  };
  saveState(statePath, state);
  if (behavior.dropFirstCreateResponse) {
    behavior.dropFirstCreateResponse = false;
    response.destroy();
    return;
  }
  return send(response, 201, { ...payload, replayed: false });
}

function releaseReservation(response, statePath, body) {
  if (!bounded(body.receipt_ref) || !bounded(body.idempotency_key)) return send(response, 422, { code: "InvalidRelease" });
  const state = loadState(statePath);
  const existing = state.operations[body.idempotency_key];
  if (existing) {
    if (existing.kind !== "release" || existing.receipt_ref !== body.receipt_ref) {
      return send(response, 409, { code: "IdempotencyConflict" });
    }
    return send(response, 200, { ...existing.response, replayed: true });
  }
  const reservationId = body.receipt_ref.startsWith("reservation:")
    ? body.receipt_ref.slice("reservation:".length)
    : null;
  const reservation = reservationId ? state.reservations[reservationId] : null;
  if (!reservation) return send(response, 404, { code: "ReservationNotFound" });
  reservation.status = "released";
  const payload = {
    reservation_id: reservationId,
    status: "released",
    release_receipt_ref: `release:${reservationId}`,
  };
  state.operations[body.idempotency_key] = {
    kind: "release",
    receipt_ref: body.receipt_ref,
    outcome: "applied",
    response: payload,
  };
  saveState(statePath, state);
  return send(response, 200, { ...payload, replayed: false });
}

function loadState(path) {
  if (!existsSync(path)) return { schema_version: "local-reservation-state-v1", reservations: {}, operations: {} };
  const state = JSON.parse(readFileSync(path, "utf8"));
  if (state.schema_version !== "local-reservation-state-v1") throw new Error("invalid state");
  return state;
}

function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

async function readBody(request) {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (Buffer.byteLength(text, "utf8") > 16384) throw new Error("too large");
  }
  return JSON.parse(text || "{}");
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function bounded(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}
