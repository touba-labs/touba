import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { preparePrivateSqliteFile } from "./private-sqlite-file.mjs";
import { costFail, validMicros, validCurrency, validCostId, validateCostQuote, validateCostUsage, validateCostCorrelation } from "./provider-cost-contract.mjs";

/** A host-owned, durable monetary budget. One stable id is shared by the
 * complete workload, including descendants and restarts. Never model input.
 * Decimal TEXT keeps monetary arithmetic exact beyond SQLite's int64 range.
 */
export function createSqliteProviderBudget({ filename, budgetId, currency, limitMicros } = {}) {
  if (typeof filename !== "string" || !filename || filename === ":memory:"
      || !validCostId(budgetId) || !validCurrency(currency) || !validMicros(limitMicros)) {
    costFail("InvalidProviderBudgetOptions", "a persistent filename, stable budget id, currency and integer micro-unit limit are required");
  }
  let db;
  try {
    preparePrivateSqliteFile(filename, () => costFail("ProviderBudgetStorageUnsafe", "budget storage must be private and without links"));
    db = new DatabaseSync(filename);
    db.exec(`PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS touba_provider_budgets (
        id TEXT PRIMARY KEY, protocol TEXT NOT NULL, currency TEXT NOT NULL,
        limit_micros TEXT NOT NULL, committed_micros TEXT NOT NULL, blocked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS touba_provider_cost_attempts (
        id TEXT PRIMARY KEY, budget_id TEXT NOT NULL, reserved_micros TEXT NOT NULL,
        cost_micros TEXT, status TEXT NOT NULL, tariff_id TEXT NOT NULL,
        tariff_date TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS touba_provider_cost_budget ON touba_provider_cost_attempts(budget_id);
      CREATE TABLE IF NOT EXISTS touba_provider_cost_context (
        attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, invocation_id TEXT NOT NULL,
        agent_ref TEXT NOT NULL, step_index INTEGER NOT NULL
      );`);
  } catch (error) {
    db?.close();
    if (error?.code === "ProviderBudgetStorageUnsafe") throw error;
    costFail("ProviderBudgetStorageUnavailable", "cannot open the durable provider budget");
  }
  const storage = fn => {
    try { return fn(); }
    catch (error) {
      if (error?.name === "ToubaAgentDecisionProviderError") throw error;
      costFail("ProviderBudgetStorageUnavailable", "provider budget storage operation failed");
    }
  };
  const transaction = fn => storage(() => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) {
      // A failed SQLite COMMIT may leave a transaction open. Preserve the
      // original diagnostic even if SQLite has already rolled it back.
      try { db.exec("ROLLBACK"); } catch { /* already rolled back or unavailable */ }
      throw error;
    }
  });
  const account = () => db.prepare("SELECT * FROM touba_provider_budgets WHERE id = ?").get(budgetId);
  const getAttempt = id => db.prepare("SELECT * FROM touba_provider_cost_attempts WHERE id = ? AND budget_id = ?").get(id, budgetId);
  const describe = row => row ? { id: row.id, status: row.status, reservedMicros: BigInt(row.reserved_micros),
    costMicros: row.cost_micros === null ? null : BigInt(row.cost_micros),
    tariffId: row.tariff_id, tariffDate: row.tariff_date, createdAt: row.created_at,
    context: db.prepare("SELECT run_id, invocation_id, agent_ref, step_index FROM touba_provider_cost_context WHERE attempt_id = ?").get(row.id) ?? null } : null;
  try {
    transaction(() => {
      const row = account();
      if (!row) {
        db.prepare("INSERT INTO touba_provider_budgets VALUES (?, 'touba-provider-budget-v1', ?, ?, '0', 0)")
          .run(budgetId, currency, String(limitMicros));
      } else {
        if (row.protocol !== "touba-provider-budget-v1" || row.currency !== currency) {
          costFail("ProviderBudgetMismatch", "persisted budget protocol or currency differs");
        }
        if (limitMicros < BigInt(row.limit_micros)) db.prepare("UPDATE touba_provider_budgets SET limit_micros = ? WHERE id = ?")
          .run(String(limitMicros), budgetId);
      }
    });
  } catch (error) { db.close(); throw error; }
  return Object.freeze({
    currency,
    reserve(quote, context) {
      const bound = validateCostQuote(quote, currency);
      const correlation = validateCostCorrelation(context);
      return transaction(() => {
        const row = account();
        if (row.blocked) costFail("ProviderBudgetBlocked", "a reported cost violated its reservation; this budget is blocked");
        const next = BigInt(row.committed_micros) + bound.maxCostMicros;
        if (next > BigInt(row.limit_micros)) costFail("ProviderCostBudgetExceeded", "provider request exceeds the remaining monetary budget");
        const id = randomUUID();
        db.prepare("INSERT INTO touba_provider_cost_attempts VALUES (?, ?, ?, NULL, 'pending', ?, ?, ?)")
          .run(id, budgetId, String(bound.maxCostMicros), bound.tariffId, bound.tariffDate, new Date().toISOString());
        if (correlation) db.prepare("INSERT INTO touba_provider_cost_context VALUES (?, ?, ?, ?, ?)")
          .run(id, correlation.run_id, correlation.invocation_id, correlation.agent_ref, correlation.step_index);
        db.prepare("UPDATE touba_provider_budgets SET committed_micros = ? WHERE id = ?").run(String(next), budgetId);
        return id;
      });
    },
    settle(attemptId, usage) {
      const value = validateCostUsage(usage);
      const violated = transaction(() => {
        const row = getAttempt(attemptId);
        if (!row) costFail("ProviderBudgetAttemptUnknown", "attempt does not belong to this budget");
        if (row.status === "reported") {
          if (value.kind === "reported" && String(value.costMicros) === row.cost_micros) return BigInt(row.cost_micros) > BigInt(row.reserved_micros);
          costFail("ProviderBudgetSettlementConflict", "reported usage cannot be replaced");
        }
        if (row.status === "estimated" && value.kind !== "reported"
            && (value.kind !== "estimated" || String(value.costMicros) !== row.cost_micros)) {
          costFail("ProviderBudgetSettlementConflict", "estimated usage can only be refined by reported usage");
        }
        const reserved = BigInt(row.reserved_micros), breached = value.kind === "reported" && value.costMicros > reserved;
        if (value.kind === "reported") {
          const used = BigInt(account().committed_micros) - reserved + value.costMicros;
          db.prepare("UPDATE touba_provider_budgets SET committed_micros = ?, blocked = MAX(blocked, ?) WHERE id = ?")
            .run(String(used), breached ? 1 : 0, budgetId);
        }
        db.prepare("UPDATE touba_provider_cost_attempts SET status = ?, cost_micros = ? WHERE id = ?")
          .run(value.kind, value.costMicros === null ? null : String(value.costMicros), attemptId);
        return breached;
      });
      // Commit the observation and block BEFORE surfacing the contract breach.
      if (violated) costFail("ProviderCostBoundViolated", "reported provider cost exceeds the reserved upper bound");
    },
    attempt(id) {
      return storage(() => describe(getAttempt(id)));
    },
    listAttempts({ status, afterId = "", limit = 100 } = {}) {
      if ((status !== undefined && !["pending", "reported", "estimated", "unknown"].includes(status))
          || (afterId !== "" && !validCostId(afterId)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
        costFail("InvalidProviderBudgetOptions", "invalid attempt filter or page size");
      }
      return storage(() => db.prepare(`SELECT * FROM touba_provider_cost_attempts
        WHERE budget_id = ? AND id > ? AND (? IS NULL OR status = ?) ORDER BY id LIMIT ?`)
        .all(budgetId, afterId, status ?? null, status ?? null, limit).map(describe));
    },
    snapshot() {
      return transaction(() => {
        const row = account(), limit = BigInt(row.limit_micros), committed = BigInt(row.committed_micros);
        const attempts = { pending: 0, reported: 0, estimated: 0, unknown: 0 };
        for (const entry of db.prepare("SELECT status, COUNT(*) AS n FROM touba_provider_cost_attempts WHERE budget_id = ? GROUP BY status").all(budgetId)) {
          attempts[entry.status] = entry.n;
        }
        return { budgetId, currency, limitMicros: limit, committedMicros: committed,
          remainingMicros: limit > committed ? limit - committed : 0n, blocked: row.blocked === 1, attempts };
      });
    },
    close() { storage(() => db.close()); },
  });
}
