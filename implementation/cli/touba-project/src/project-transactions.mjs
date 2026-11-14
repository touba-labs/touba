import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { validateImportFiles } from './import-files.mjs';

// Generic recoverable writes. Keep historical error codes for API clients.
const serviceError = (code, message) => Object.assign(new Error(message), { code });
const serviceDiagnostic = (code, message) => ({ code, message, severity: 'error', source_ref: null });
const sha256Buffer = value => createHash('sha256').update(value).digest('hex');
function safeProjectPath(root, path) {
  if (typeof path !== 'string' || !path || path.includes('\0') || isAbsolute(path)) throw serviceError('ToubaServeChangePathRejected', 'Invalid project path');
  const absolute = resolve(root, path), rel = relative(resolve(root), absolute);
  if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw serviceError('ToubaServeChangePathRejected', 'Path escapes project');
  validateImportFiles(resolve(root), [{ path: absolute }], { mode: 'plan' });
  return absolute;
}

export function applyChangeTargetsTransaction({ projectRoot, proposalId, targets, decidedAt, review_actor, reason, transaction_id, review_evidence }) {
  if (transaction_id !== undefined && !/^ownership-[a-f0-9-]{36}$/.test(transaction_id)) {
    throw serviceError('ToubaServeChangeInvalid', 'Invalid transaction identifier');
  }
  safeProjectPath(projectRoot, ".touba/change-transactions/preflight/journal.json");
  const toubaRoot = join(projectRoot, ".touba");
  const lockPath = join(toubaRoot, "project-change.lock");
  mkdirSync(toubaRoot, { recursive: true });
  try {
    mkdirSync(lockPath);
  } catch (cause) {
    if (cause?.code === "EEXIST") {
      throw serviceError("ToubaServeChangeProjectLocked", "another project change is being applied");
    }
    throw cause;
  }

  try {
  for (const target of targets) {
    const path = safeProjectPath(projectRoot, target.path);
    if (existsSync(path) !== target.base_content_exists || (target.base_content_exists
      && createHash('sha256').update(readFileSync(path)).digest('hex') !== target.base_content_sha256)) {
      throw serviceError('ToubaServeChangeConflict', 'A reviewed file changed before the transaction');
    }
  }
  const transactionId = transaction_id ?? `${proposalId.replace(/[^A-Za-z0-9_.-]/gu, "_")}-${Date.now()}`;
  const transactionRoot = join(toubaRoot, "change-transactions", transactionId);
  const stageRoot = join(transactionRoot, "stage");
  const backupRoot = join(transactionRoot, "backup");
  const journalPath = join(transactionRoot, "journal.json");
  const journal = {
    schema_version: "touba-project-change-transaction-v1",
    transaction_id: transactionId,
    proposal_id: proposalId,
    status: "preparing",
    prepared_at: decidedAt,
    ...(review_actor ? { review_actor, reason } : {}),
    ...(review_evidence ? { review_evidence } : {}),
    targets: targets.map((target) => ({
      path: target.path,
      content_sha256: target.content_sha256,
      base_content_exists: target.base_content_exists,
      base_content_sha256: target.base_content_sha256,
    })),
  };
  mkdirSync(dirname(transactionRoot), { recursive: true });
  mkdirSync(transactionRoot, { mode: 0o700 });
  mkdirSync(stageRoot);
  mkdirSync(backupRoot, { recursive: true });
  writeTransactionJournal(journalPath, journal);

  const entries = targets.map((target, index) => {
    const targetPath = safeProjectPath(projectRoot, target.path);
    const stagePath = join(stageRoot, `${index}.next`);
    const backupPath = join(backupRoot, `${index}.previous`);
    writeFileSync(stagePath, target.content, "utf8");
    if (target.base_content_exists) {
      writeFileSync(backupPath, readFileSync(targetPath));
    }
    return {
      target,
      targetPath,
      stagePath,
      backupPath,
    };
  });
  journal.status = "prepared";
  writeTransactionJournal(journalPath, journal);

  const committed = [];
  try {
    journal.status = "committing";
    writeTransactionJournal(journalPath, journal);
    for (const entry of entries) {
      mkdirSync(dirname(entry.targetPath), { recursive: true });
      replaceFileFromTemp(entry.stagePath, entry.targetPath);
      committed.push(entry);
    }
    journal.status = "committed";
    journal.committed_at = new Date().toISOString();
    writeTransactionJournal(journalPath, journal);
  } catch (cause) {
    const rollbackFailures = [];
    for (const entry of [...committed].reverse()) {
      try {
        if (entry.target.base_content_exists) {
          const restorePath = `${entry.targetPath}.touba-restore-${process.pid}-${Date.now()}`;
          writeFileSync(restorePath, readFileSync(entry.backupPath));
          replaceFileFromTemp(restorePath, entry.targetPath);
        } else {
          rmSync(entry.targetPath, { force: true });
        }
      } catch (rollbackCause) {
        rollbackFailures.push(`${entry.target.path}: ${rollbackCause.message}`);
      }
    }
    journal.status = rollbackFailures.length === 0 ? "rolled_back" : "rollback_failed";
    journal.failed_at = new Date().toISOString();
    journal.error = cause.message;
    journal.rollback_failures = rollbackFailures;
    writeTransactionJournal(journalPath, journal);
    const error = serviceError(
      rollbackFailures.length === 0
        ? "ToubaServeChangeTransactionRolledBack"
        : "ToubaServeChangeTransactionRecoveryRequired",
      rollbackFailures.length === 0
        ? "multi-file project change failed and was rolled back"
        : "multi-file project change requires operator recovery",
    );
    error.diagnostics = rollbackFailures.map((message) =>
      serviceDiagnostic("ToubaServeChangeRollbackFailed", message)
    );
    throw error;
  }

  return {
    write_mode: "recoverable_transaction",
    project_root: projectRoot,
    relative_path: targets[0].path,
    relative_paths: targets.map((target) => target.path),
    transaction_id: transactionId,
  };
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

export function recoverProjectChangeTransactions({
  projectRoot,
  recoveredAt = new Date().toISOString(),
}) {
  safeProjectPath(projectRoot, ".touba/change-transactions/preflight/journal.json");
  const toubaRoot = join(resolve(projectRoot), ".touba");
  const transactionsRoot = join(toubaRoot, "change-transactions");
  const lockPath = join(toubaRoot, "project-change.lock");
  if (!existsSync(transactionsRoot)) {
    rmSync(lockPath, { recursive: true, force: true });
    return { status: "clean", recovered: [] };
  }
  const recovered = [];
  const failures = [];
  for (const entry of readdirSync(transactionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const transactionRoot = join(transactionsRoot, entry.name);
    const journalPath = join(transactionRoot, "journal.json");
    if (!existsSync(journalPath)) continue;
    let journal;
    try {
      journal = JSON.parse(readFileSync(journalPath, "utf8"));
    } catch (cause) {
      failures.push(`${entry.name}: ${cause.message}`);
      continue;
    }
    if (
      journal.schema_version !== "touba-project-change-transaction-v1"
      || !Array.isArray(journal.targets)
    ) {
      failures.push(`${entry.name}: invalid transaction journal`);
      continue;
    }
    if (["committed", "rolled_back", "recovered"].includes(journal.status)) {
      continue;
    }
    const transactionFailures = [];
    if (["committing", "rollback_failed"].includes(journal.status)) {
      journal.targets.forEach((target, index) => {
        try {
          recoverProjectChangeTarget({
            projectRoot,
            target,
            backupPath: join(transactionRoot, "backup", `${index}.previous`),
          });
        } catch (cause) {
          transactionFailures.push(`${target.path}: ${cause.message}`);
        }
      });
    }
    if (transactionFailures.length === 0) {
      journal.status = "recovered";
      journal.recovered_at = recoveredAt;
      journal.rollback_failures = [];
      writeTransactionJournal(journalPath, journal);
      recovered.push(journal.transaction_id ?? entry.name);
    } else {
      journal.status = "rollback_failed";
      journal.rollback_failures = transactionFailures;
      writeTransactionJournal(journalPath, journal);
      failures.push(...transactionFailures.map((message) => `${entry.name}: ${message}`));
    }
  }
  if (failures.length > 0) {
    const error = serviceError(
      "ToubaServeChangeTransactionRecoveryRequired",
      "one or more interrupted project changes require operator recovery",
    );
    error.diagnostics = failures.map((message) =>
      serviceDiagnostic("ToubaServeChangeRollbackFailed", message)
    );
    throw error;
  }
  rmSync(lockPath, { recursive: true, force: true });
  return {
    status: recovered.length === 0 ? "clean" : "recovered",
    recovered,
  };
}

function recoverProjectChangeTarget({ projectRoot, target, backupPath }) {
  const targetPath = safeProjectPath(projectRoot, target.path);
  const targetExists = existsSync(targetPath);
  const currentDigest = targetExists ? sha256Buffer(readFileSync(targetPath)) : null;
  if (target.base_content_exists) {
    if (!existsSync(backupPath)) {
      throw serviceError("ToubaServeChangeBackupMissing", "transaction backup is missing");
    }
    const backup = readFileSync(backupPath);
    if (sha256Buffer(backup) !== target.base_content_sha256) {
      throw serviceError("ToubaServeChangeBackupInvalid", "transaction backup digest is invalid");
    }
    if (currentDigest === target.base_content_sha256) {
      return;
    }
    if (currentDigest !== target.content_sha256) {
      throw serviceError("ToubaServeChangeRecoveryConflict", "target changed after the interrupted transaction");
    }
    mkdirSync(dirname(targetPath), { recursive: true });
    const restorePath = `${targetPath}.touba-recovery-${process.pid}-${Date.now()}`;
    writeFileSync(restorePath, backup);
    replaceFileFromTemp(restorePath, targetPath);
    return;
  }
  if (!targetExists) return;
  if (currentDigest !== target.content_sha256) {
    throw serviceError("ToubaServeChangeRecoveryConflict", "new target changed after the interrupted transaction");
  }
  rmSync(targetPath, { force: true });
}

export function replaceFileFromTemp(tempPath, targetPath) {
  try {
    renameSync(tempPath, targetPath);
  } catch (cause) {
    if (!["EEXIST", "EPERM"].includes(cause?.code) || !existsSync(targetPath)) {
      throw cause;
    }
    const previousPath = `${targetPath}.touba-previous-${process.pid}-${Date.now()}`;
    renameSync(targetPath, previousPath);
    try {
      renameSync(tempPath, targetPath);
      rmSync(previousPath, { force: true });
    } catch (replaceCause) {
      if (!existsSync(targetPath) && existsSync(previousPath)) {
        renameSync(previousPath, targetPath);
      }
      throw replaceCause;
    }
  }
}

function writeTransactionJournal(path, journal) {
  const temporary = `${path}.next`;
  writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  replaceFileFromTemp(temporary, path);
}
