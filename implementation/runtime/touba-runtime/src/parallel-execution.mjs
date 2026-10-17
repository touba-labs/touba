// @ts-check
// Structured local concurrency. Journals are private continuations, not traces.
import { RuntimeFailure, RuntimeStop } from "./runtime-errors.mjs";
import { canonicalDigest } from "./execution-checkpoints.mjs";

export class ParallelSuspend extends RuntimeStop {
  constructor() { super("parallel group suspended", { reason: "parallel_suspended" }); }
}

/** @param {any} options */
export function createParallelRuntime(options) {
  /** @type {Record<string, number>} */
  const limits = { maxBranches: 1024, maxExternalCalls: 16, maxDepth: 64,
    maxConcurrency: 1024, maxItems: 1024, maxJournalEntries: 100000, maxCheckpointBytes: 16777216 };
  for (const [key, value] of Object.entries(options.parallelLimits ?? {})) {
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value < 1) {
      throw new RuntimeFailure("invalid parallel host limit", { limit: key }, "InvalidRuntimeOption");
    }
    limits[key] = value;
  }
  if (options.parallelCheckpointObserver != null && typeof options.parallelCheckpointObserver !== "function") {
    throw new RuntimeFailure("parallel checkpoint observer must be a function", {}, "InvalidRuntimeOption");
  }
  return { limits, alive: 0, external: 0, waiters: [], locks: new Map(), inFlight: new Set(),
    nextGroup: 1, observer: options.parallelCheckpointObserver ?? null };
}

/** @param {any} context */
export function parallelBoundary(context) {
  const branch = context.parallelBranch;
  if (!branch) return;
  const control = branch.control;
  if (control.failure) throw new ParallelSuspend();
  // A consumed prefix only reconstructs pure control. It cannot dispatch.
  if (control.paused && branch.cursor >= branch.state.journal.length) throw new ParallelSuspend();
}

/** @param {any} context @param {string} kind @param {any} identity */
export function parallelRecord(context, kind, identity) {
  const branch = context.parallelBranch;
  if (!branch || context.parallelOperation) return null;
  if (kind === "human" && !branch.control.failure) {
    // An already-returned provider review is itself a serializable wait, not
    // a new effect. Keep concurrent review requests as distinct occurrences.
  } else parallelBoundary(context);
  const key = canonicalDigest(JSON.parse(JSON.stringify(identity)));
  const index = branch.cursor++;
  const existing = branch.state.journal[index];
  branch.replaying = Boolean(existing);
  if (existing) {
    if (existing.kind !== kind || existing.key !== key) {
      throw new RuntimeFailure("parallel continuation diverged from its recorded execution", {}, "ParallelContinuationMismatch");
    }
    return { entry: existing, replay: true, index };
  }
  if (++branch.control.entries > context.parallelRuntime.limits.maxJournalEntries) {
    throw new RuntimeFailure("parallel journal limit exceeded", {}, "ParallelJournalLimitExceeded");
  }
  const entry = { kind, key, state: "pending" };
  branch.state.journal.push(entry);
  return { entry, replay: false, index };
}

/** @param {any} context @param {any} identity @param {() => void} reserve */
export function parallelBudget(context, identity, reserve) {
  const record = parallelRecord(context, "budget", identity);
  if (record?.replay) {
    if (record.entry.state !== "done") throw new RuntimeFailure("incomplete budget reservation", {}, "InvalidParallelCheckpoint");
    return;
  }
  reserve();
  if (record) record.entry.state = "done";
}

/** Fair bounded transport admission plus canonical read/write memory locks.
 * @param {any} context @param {any[]} accesses @returns {Promise<() => void>} */
async function acquire(context, accesses) {
  const runtime = context.parallelRuntime;
  const modes = new Map();
  for (const access of accesses) {
    const mode = access.access === "read" ? "read" : "write";
    if (modes.get(access.memory_ref) !== "write") modes.set(access.memory_ref, mode);
  }
  const requested = [...modes].sort(([a], [b]) => a.localeCompare(b));
  const ready = () => runtime.external < runtime.limits.maxExternalCalls && requested.every(([key, mode]) => {
    const lock = runtime.locks.get(key);
    return !lock || (!lock.writer && mode === "read");
  });
  /** @type {any} */
  const ticket = {};
  runtime.waiters.push(ticket);
  try {
    while (runtime.waiters[0] !== ticket || !ready()) {
      parallelBoundary(context);
      context.parallelCheckRun();
      // Wake on release, pause/failure, or host cancellation/time budget.
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 10);
        ticket.wake = () => { clearTimeout(timer); resolve(undefined); };
      });
    }
    parallelBoundary(context);
    context.parallelCheckRun();
    runtime.external++;
    for (const [key, mode] of requested) {
      const lock = runtime.locks.get(key) ?? { readers: 0, writer: false };
      if (mode === "read") lock.readers++; else lock.writer = true;
      runtime.locks.set(key, lock);
    }
  } finally {
    runtime.waiters.splice(runtime.waiters.indexOf(ticket), 1);
    for (const waiter of runtime.waiters) waiter.wake?.();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    runtime.external--;
    for (const [key, mode] of requested) {
      const lock = runtime.locks.get(key);
      if (mode === "read") lock.readers--; else lock.writer = false;
      if (!lock.readers && !lock.writer) runtime.locks.delete(key);
    }
    for (const waiter of runtime.waiters) waiter.wake?.();
  };
}

/** Track actual transport lifetime, including after a logical timeout.
 * @param {any} context @param {Promise<any>} promise */
export function trackParallelTransport(context, promise) {
  if (!context.parallelTransport) return promise;
  const settled = Promise.resolve(promise).then(() => undefined, () => undefined);
  context.parallelTransport.push(settled);
  return promise;
}

/** @param {any} context @param {string} kind @param {any} identity
 * @param {any[]} accesses @param {(entry: any) => Promise<any>} execute */
export async function parallelExternal(context, kind, identity, accesses, execute) {
  const record = parallelRecord(context, kind, identity);
  if (!record) return execute(null);
  const { entry } = record;
  if (!record.replay) entry.state = "ready";
  if (record.replay) {
    if (entry.state === "done") return structuredClone(entry.value);
    if (entry.state === "failed") throw new RuntimeFailure(entry.error.message, entry.error.details, entry.error.code);
    // A persisted in-flight operation is not evidence of failure or permission
    // to repeat an effect. External writes can reconcile via their journal.
    if (entry.state === "pending" && !(kind === "tool" && entry.effect_index)) {
      throw new RuntimeFailure("interrupted external call has an unknown outcome", {}, "ParallelOutcomeUnknown");
    }
  }
  const release = await acquire(context, accesses);
  /** @type {Promise<any>[]} */
  const transports = [];
  context.parallelTransport = transports;
  context.parallelOperation = entry;
  try {
    entry.state = "pending";
    context.parallelCheckRun();
    await context.parallelBranch.control.persist();
    context.parallelCheckRun();
    const value = await execute(entry);
    context.parallelCheckValue(value);
    entry.value = JSON.parse(JSON.stringify(value));
    entry.state = "done";
    await context.parallelBranch.control.persist();
    return value;
  } catch (error) {
    if (error instanceof ParallelSuspend && !entry.dispatched) entry.state = "ready";
    else if (!(error instanceof ParallelSuspend)) {
      entry.state = "failed";
      const failure = /** @type {any} */ (error);
      entry.error = { code: failure.code ?? "RuntimeFailure", message: failure.message, details: failure.details ?? {} };
    }
    throw error;
  } finally {
    context.parallelOperation = null;
    context.parallelTransport = null;
    const settled = Promise.all(transports).then(release);
    context.parallelRuntime.inFlight.add(settled);
    settled.finally(() => context.parallelRuntime.inFlight.delete(settled));
    if (!transports.length) release();
  }
}

/** Human decisions address one branch occurrence, never a shared source node.
 * @param {any} context @param {any} metadata @param {(decision: string) => any} execute */
export function parallelHuman(context, metadata, execute) {
  const record = parallelRecord(context, "human", metadata);
  if (!record) throw new RuntimeFailure("parallel approval requires a branch", {}, "InvalidParallelCheckpoint");
  const { entry, index } = record;
  const ref = `${metadata.approval_ref}:parallel:${context.parallelBranch.state.id}:${index}`;
  if (record.replay && entry.approval_ref !== ref) throw new RuntimeFailure("invalid parallel approval identity", {}, "InvalidParallelCheckpoint");
  entry.approval_ref = ref;
  entry.metadata = metadata;
  if (entry.state === "done") return execute(entry.value);
  const decision = context.parallelDecisions.get(ref);
  if (!decision) {
    entry.state = "waiting";
    context.parallelBranch.control.paused = true;
    context.trace.push("human_approval_requested", { payload: { approval_ref: ref, mode: metadata.mode,
      caller_ref: metadata.caller_ref, agent_ref: metadata.agent_ref } });
    context.trace.push("human_approval_paused", { payload: { approval_ref: ref, mode: metadata.mode } });
    throw new ParallelSuspend();
  }
  context.parallelDecisions.delete(ref);
  entry.value = decision;
  entry.state = "done";
  return execute(decision);
}

/** @param {any} group @returns {any[]} */
export function pendingParallelApprovals(group) {
  const pending = [];
  for (const branch of group.branches) for (const entry of branch.journal) {
    if (entry.kind === "human" && entry.state === "waiting") pending.push(entry);
    if (entry.kind === "group" && entry.group) pending.push(...pendingParallelApprovals(entry.group));
  }
  return pending;
}

/** Refuse an uncertain continuation before dispatching any of its siblings.
 * @param {any} group */
export function assertParallelOutcomesKnown(group) {
  for (const branch of group.branches) for (const entry of branch.journal) {
    if (entry.kind === "group") assertParallelOutcomesKnown(entry.group);
    if (entry.state === "pending" && ["provider", "tool", "input"].includes(entry.kind)
      && !(entry.kind === "tool" && Number.isSafeInteger(entry.effect_index))) {
      throw new RuntimeFailure("interrupted external call has an unknown outcome", {}, "ParallelOutcomeUnknown");
    }
  }
}

/** @param {any} state @param {any} limits */
export function validateParallelState(state, limits) {
  let entries = 0, branches = 0;
  const ids = new Set();
  const invalid = () => { throw new RuntimeFailure("invalid parallel checkpoint tree", {}, "InvalidParallelCheckpoint"); };
  /** @param {any} group @param {number} depth */
  const visit = (group, depth) => {
    if (!group || depth > Math.min(64, limits.maxDepth) || !Array.isArray(group.branches)
      || typeof group.id !== "string" || typeof group.node_id !== "string" || typeof group.graph_ref !== "string"
      || !Number.isSafeInteger(group.max_concurrency) || group.max_concurrency < 1
      || !Number.isSafeInteger(group.max_items) || group.max_items < group.max_concurrency
      || group.branches.length > group.max_items || ids.has(group.id)) invalid();
    ids.add(group.id);
    for (const [index, branch] of group.branches.entries()) {
      if (++branches > limits.maxBranches || branch.id !== `${group.id}/${index}`
        || !["queued", "running", "suspended", "done"].includes(branch.status)
        || !Array.isArray(branch.arguments) || !Array.isArray(branch.journal) || !Array.isArray(branch.messages)) invalid();
      for (const entry of branch.journal) {
        if (++entries > limits.maxJournalEntries || !entry || typeof entry.key !== "string"
          || !["budget", "tool", "provider", "input", "human", "group", "agent_invocation"].includes(entry.kind)
          || !["ready", "pending", "waiting", "done", "failed"].includes(entry.state)) invalid();
        if (entry.kind === "group") visit(entry.group, depth + 1);
        if (entry.kind === "agent_invocation" && (entry.state !== "done"
          || typeof entry.invocation_id !== "string" || !/^invocation:[0-9a-f-]{36}$/.test(entry.invocation_id))) invalid();
        if (entry.kind === "human" && (typeof entry.approval_ref !== "string" || !entry.metadata
          || (entry.state === "done" && !["approved", "rejected", "expired", "cancelled"].includes(entry.value)))) invalid();
      }
    }
  };
  visit(state, 1);
  if (Buffer.byteLength(JSON.stringify(state)) > limits.maxCheckpointBytes) invalid();
  return { entries, branches };
}

/** Bounded progressive admission, all-join, deterministic output order.
 * @param {any} state @param {any} context @param {any} control
 * @param {(branch: any, index: number) => Promise<any>} execute */
export async function runParallelGroup(state, context, control, execute) {
  const runtime = context.parallelRuntime;
  const pending = state.branches.filter(/** @param {any} branch */ branch => branch.status !== "done");
  if (runtime.alive + pending.length > runtime.limits.maxBranches) {
    throw new RuntimeFailure("global parallel branch limit exceeded", {}, "ParallelBranchLimitExceeded");
  }
  runtime.alive += pending.length;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(state.max_concurrency, runtime.limits.maxConcurrency, pending.length) }, async () => {
    while (cursor < pending.length && !control.failure && !control.paused) {
      const branch = pending[cursor++];
      const index = state.branches.indexOf(branch);
      branch.status = "running";
      context.trace.push("parallel_branch_started", { payload: { group_id: state.id, branch_id: branch.id, index } });
      try {
        branch.result = structuredClone(await execute(branch, index));
        branch.status = "done";
        context.trace.push("parallel_branch_completed", { payload: { group_id: state.id, branch_id: branch.id, index } });
        await control.persist();
      } catch (error) {
        branch.status = "suspended";
        if (!(error instanceof ParallelSuspend) && !control.failure) {
          control.failure = error;
          control.failedBranch = branch.id;
        }
        context.trace.push("parallel_branch_suspended", { payload: { group_id: state.id, branch_id: branch.id, index } });
      }
    }
  });
  try { await Promise.all(workers); }
  finally { runtime.alive -= pending.length; }
  if (control.failure) throw control.failure;
  if (state.branches.some(/** @param {any} branch */ branch => branch.status !== "done")) throw new ParallelSuspend();
  return state.branches.map(/** @param {any} branch */ branch => structuredClone(branch.result));
}
