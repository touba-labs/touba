// @ts-check
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { hostname } from "node:os";
import { indexedStore } from "./sqlite-record-store.mjs";
import { canonicalDigest } from "./execution-checkpoints.mjs";
import { RuntimeFailure } from "./runtime-errors.mjs";

const SCHEMA = "touba-human-checkpoint-custody-v1";
/** @typedef {{id: string, generation: number, state: string, owner: string, digest: string, owner_pid: number, owner_host: string, recoverable: boolean}} CustodyRecord */
/** @typedef {{id: string, owner: string, original: CustodyRecord | null}} Ticket */
/** @param {string} code @param {string} message @returns {never} */
const fail = (code, message) => { throw new RuntimeFailure(message, {}, code); };
/** @param {any} value */
const digest = value => canonicalDigest(value);
// SQLite custody is local to one host. A restored/moved database must only be
// opened after the original executor has been stopped (cold recovery).
/** @param {CustodyRecord} row */
function ownerHasExited(row) {
  if (row.owner_host !== hostname()) return false;
  try { process.kill(row.owner_pid, 0); return false; }
  catch (error) { return /** @type {NodeJS.ErrnoException} */ (error).code === "ESRCH"; }
}

/** Host-owned authority; checkpoint files never select the database or create records. */
export function createSqliteHumanCheckpointStore(filename = resolve(".touba/approval-checkpoints.sqlite")) {
  const db = indexedStore({ path: filename, schemaVersion: SCHEMA, keyOf: row => row.id,
    /** @param {any} row */
    validate(row) {
      if (!row || typeof row.id !== "string" || !Number.isSafeInteger(row.generation) || row.generation < 1
        || !["running", "ready", "consumed"].includes(row.state)
        || typeof row.owner !== "string" || !/^sha256:[a-f0-9]{64}$/.test(row.digest)
        || !Number.isSafeInteger(row.owner_pid) || row.owner_pid < 1
        || typeof row.owner_host !== "string" || typeof row.recoverable !== "boolean") {
        fail("HumanApprovalCheckpointStoreInvalid", "checkpoint custody record is invalid");
      }
    },
  });
  /** @param {string} id @returns {CustodyRecord[]} */
  function read(id) { return db.read([{ id }]); }
  /** @param {CustodyRecord[]} rows */
  function write(rows) {
    try { db.write(rows); }
    catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ToubaStoreWriteConflict") fail("HumanApprovalCheckpointBusy", "another process changed this checkpoint");
      throw error;
    }
  }
  /** @param {Ticket} ticket */
  function owned(ticket) {
    const rows = read(ticket.id), row = rows[0];
    if (!row || row.owner !== ticket.owner || row.state !== "running") {
      fail("HumanApprovalCheckpointBusy", "checkpoint execution no longer owns its reservation");
    }
    return rows;
  }
  return Object.freeze({
    /** Read-only eligibility check. It neither claims nor rearms a checkpoint.
     * @param {any} checkpoint */
    ready(checkpoint) {
      const proof = checkpoint?.custody;
      if (!proof || typeof proof.id !== "string") return false;
      const row = read(proof.id)[0];
      return Boolean(row && row.state === "ready" && row.generation === proof.generation && row.digest === digest(checkpoint));
    },
    /** @param {any} checkpoint */
    claim(checkpoint) {
      const proof = checkpoint?.custody;
      if (!proof || typeof proof.id !== "string" || !Number.isSafeInteger(proof.generation)) {
        fail("HumanApprovalCheckpointUntrusted", "checkpoint has no trusted custody record; preserve it and reconcile the pending operation before creating a new approval");
      }
      const rows = read(proof.id), row = rows[0];
      if (!row || row.generation !== proof.generation || row.digest !== digest(checkpoint)) {
        fail("HumanApprovalCheckpointIntegrityMismatch", "checkpoint differs from its trusted snapshot or has been superseded");
      }
      if (row.state === "consumed") fail("HumanApprovalCheckpointAlreadyConsumed", "this checkpoint has already completed; do not repeat its effects");
      if (row.state !== "ready" && !(row.recoverable && checkpoint.kind === "parallel_group" && ownerHasExited(row))) {
        fail("HumanApprovalCheckpointBusy", "checkpoint is running or its outcome needs reconciliation after an interruption");
      }
      const ticket = { id: row.id, owner: randomUUID(), original: structuredClone(row) };
      row.state = "running"; row.owner = ticket.owner;
      row.owner_pid = process.pid; row.owner_host = hostname();
      write(rows);
      return ticket;
    },
    /** @param {any} checkpoint @param {Ticket | null} ticket */
    protect(checkpoint, ticket) {
      // Custody binds the portable JSON document, including all continuation
      // state, rather than optional undefined properties of an in-process object.
      const next = JSON.parse(JSON.stringify(checkpoint));
      if (!ticket) {
        ticket = { id: randomUUID(), owner: randomUUID(), original: null };
        // A new selection is needed: indexedStore binds writes to the exact read.
        const fresh = read(ticket.id);
        fresh.push({ id: ticket.id, generation: 1, state: "running", owner: ticket.owner, digest: "",
          owner_pid: process.pid, owner_host: hostname(), recoverable: next.kind === "parallel_group" });
        next.custody = { id: ticket.id, generation: 1 };
        if (next.kind === "parallel_group") { delete next.parallel_digest; next.parallel_digest = digest(next); }
        fresh[0].digest = digest(next);
        write(fresh);
        return { checkpoint: next, ticket };
      }
      const rows = owned(ticket);
      const row = rows[0];
      next.custody = { id: ticket.id, generation: row.generation };
      if (next.kind === "parallel_group") { delete next.parallel_digest; next.parallel_digest = digest(next); }
      // Publishing the same pause through both observer and return envelope
      // must not invalidate the file already persisted by the observer.
      if (row.digest === digest(next)) return { checkpoint: next, ticket };
      row.generation++;
      if (!Number.isSafeInteger(row.generation)) fail("HumanApprovalCheckpointStoreInvalid", "checkpoint generation limit reached");
      next.custody = { id: ticket.id, generation: row.generation };
      if (next.kind === "parallel_group") { delete next.parallel_digest; next.parallel_digest = digest(next); }
      row.digest = digest(next);
      row.recoverable = next.kind === "parallel_group";
      write(rows);
      return { checkpoint: next, ticket };
    },
    /** @param {Ticket} ticket @param {{parallel?: boolean}} options */
    markActivity(ticket, { parallel = false } = {}) {
      if (parallel) return; // The parallel journal reserves before dispatch and reconciles uncertain outcomes.
      const rows = owned(ticket);
      if (rows[0].recoverable) { rows[0].recoverable = false; write(rows); }
    },
    /** @param {Ticket} ticket @param {{pending?: boolean, retryable?: boolean}} options */
    finish(ticket, { pending = false, retryable = false } = {}) {
      const rows = owned(ticket), row = rows[0];
      if (retryable && ticket.original && row.generation === ticket.original.generation) {
        rows[0] = ticket.original;
      } else {
        row.state = pending ? "ready" : "consumed";
      }
      write(rows);
    },
  });
}

/** Per-execution reservation. Unknown sequential outcomes are never rearmed.
 * @param {any} options */
export function createHumanCheckpointCustody(options = {}) {
  const store = options.humanCheckpointStore ?? createSqliteHumanCheckpointStore(options.humanCheckpointStorePath);
  if (!["claim", "protect", "markActivity", "finish"].every(key => typeof store?.[key] === "function")) {
    fail("InvalidRuntimeOption", "humanCheckpointStore must implement claim, protect, markActivity and finish");
  }
  /** @type {Ticket | null} */
  let ticket = null;
  let activity = false;
  /** @param {() => any} operation */
  function access(operation) {
    try { return operation(); }
    catch (error) {
      if (error instanceof RuntimeFailure) throw error;
      fail("HumanApprovalCheckpointStoreUnavailable", "checkpoint custody could not be read or persisted; preserve its state before retrying");
    }
  }
  return {
    /** @param {{parallel?: boolean}} options */
    markActivity(options) { activity = true; if (ticket) access(() => store.markActivity(ticket, options)); },
    /** @param {any} checkpoint */
    claim(checkpoint) { ticket = access(() => store.claim(checkpoint)); },
    /** @param {any} checkpoint */
    protect(checkpoint) {
      const protectedState = access(() => store.protect(checkpoint, ticket));
      ticket = protectedState.ticket;
      return protectedState.checkpoint;
    },
    /** @param {{pending: boolean, retryable: boolean}} options */
    finish(options) {
      if (ticket) {
        access(() => store.finish(ticket, { ...options, retryable: options.retryable && !activity }));
        ticket = null;
      }
    },
  };
}

// Accepted authority state is supplied only by trusted in-process host code.
// The checkpoint itself still has to match the original custody snapshot.
const acceptedStates = new WeakMap();
/** @param {any} checkpoint */
export function bindAcceptedHumanApproval(checkpoint) {
  const original = structuredClone(checkpoint);
  const state = original.approval_state;
  const requestId = state?.requests?.[original.approval_ref]?.request_id;
  if (requestId) state.receipts = state.receipts.filter(/** @param {any} receipt */ receipt => receipt.request_id !== requestId);
  if (original.kind === "parallel_group") { delete original.parallel_digest; original.parallel_digest = digest(original); }
  acceptedStates.set(original, structuredClone(checkpoint.approval_state));
  return original;
}
/** @param {any} checkpoint */
export function acceptedHumanApprovalState(checkpoint) { return acceptedStates.get(checkpoint); }
