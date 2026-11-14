import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { hostname, release } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { canonicalizeMachineValue } from '../../../contracts/machine/contracts.mjs';
import { handlerSandboxPaths } from './handler-sandbox-policy.mjs';

/** @param {string} value */
const digest = value => createHash('sha256').update(value).digest('hex');
const files = new Map();
const FORMAT = 'touba-handler-isolation-observation-v1';
/** @param {import('node:fs').BigIntStats} stat */
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(':');

// Evidence is optional and bounded. A missing observation never disables the
// sandbox or prevents a business result from being recorded. Cache only exact
// host file identities; ctime invalidates a write even if mtime was restored.
/** @param {string} path */
function fileDigest(path) {
  const canonical = realpathSync(path), before = statSync(canonical, { bigint: true });
  if (!before.isFile() || before.size > 512n * 1024n * 1024n) throw new Error('unavailable evidence file');
  const signature = stamp(before), previous = files.get(canonical);
  if (previous?.signature === signature) return [canonical, previous.digest];
  const fd = openSync(canonical, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    if (stamp(fstatSync(fd, { bigint: true })) !== signature) throw new Error('changed evidence file');
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536); let size = 0;
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      size += count; if (size > 512 * 1024 * 1024) throw new Error('evidence file limit');
      hash.update(buffer.subarray(0, count));
    }
    if (stamp(fstatSync(fd, { bigint: true })) !== signature || BigInt(size) !== before.size) throw new Error('changed evidence file');
    const value = hash.digest('hex');
    if (files.size >= 4096) files.delete(files.keys().next().value);
    files.set(canonical, { signature, digest: value });
    return [canonical, value];
  } finally { closeSync(fd); }
}

/** @param {any} binding @param {import('./handler-protocol.mjs').HandlerSandboxPlan} plan */
export function handlerIsolationIdentity(binding, plan) {
  if (!binding?.sandbox?.required || !plan?.enabled) return null;
  try {
    const command = binding.handler.command === 'node' ? process.execPath : binding.handler.command;
    if (!isAbsolute(command) || !isAbsolute(plan.command)) return null;
    // A custom executable can emit any protocol response. Only the OS launcher
    // is evidence for this backend; its override remains usable but unverified.
    if (plan.mechanism === 'sandbox-exec' && realpathSync(plan.command) !== '/usr/bin/sandbox-exec') return null;
    const inventory = handlerSandboxPaths(binding, command);
    const paths = [...new Set([...inventory.code, ...(plan.evidenceFiles ?? []), plan.command])].sort();
    if (paths.length > 4096) return null;
    let total = 0;
    for (const path of paths) { total += statSync(path).size; if (total > 2 * 1024 * 1024 * 1024) return null; }
    const inventoryDigest = digest(canonicalizeMachineValue(paths.map(fileDigest)));
    const bindingDigest = digest(canonicalizeMachineValue({ handler: binding.handler, sandbox: binding.sandbox,
      grants: binding.grants, limits: binding.limits, approval: binding.approvalPolicy ?? null,
      effect: binding.effectContract ?? null, secrets: binding.secrets ?? [] }));
    const policyDigest = digest(canonicalizeMachineValue({ command: plan.command, args: plan.args,
      seccomp: plan.seccomp?.toString('base64') ?? null, policy: plan.policy?.toString('base64') ?? null,
      environment: plan.environment ?? null }));
    const hostDigest = digest(canonicalizeMachineValue({ hostname: hostname(), platform: process.platform,
      arch: process.arch, release: release(), node: process.version, uid: process.getuid?.() ?? null,
      cwd: realpathSync(resolve(binding.handler.cwd ?? process.cwd())) }));
    return { format: FORMAT, platform: process.platform, mechanism: plan.mechanism,
      binding_digest: bindingDigest, inventory_digest: inventoryDigest, policy_digest: policyDigest, host_digest: hostDigest };
  } catch { return null; }
}

/** @param {any} value */
export function validHandlerIsolationObservation(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 9 && value.format === FORMAT
    && ['darwin', 'linux', 'win32'].includes(value.platform)
    && ['sandbox-exec', 'bubblewrap-seccomp-landlock', 'windows-lpac-job'].includes(value.mechanism)
    && ['binding_digest', 'inventory_digest', 'policy_digest', 'host_digest'].every(key => /^[0-9a-f]{64}$/u.test(value[key] ?? ''))
    && typeof value.protocol_observed === 'boolean'
    && ['completed', 'failed'].includes(value.outcome);
}

/** @param {any} observation @param {any} current */
export function sameHandlerIsolationIdentity(observation, current) {
  return validHandlerIsolationObservation(observation) && current
    && Object.keys(current).every(key => observation[key] === current[key]);
}
