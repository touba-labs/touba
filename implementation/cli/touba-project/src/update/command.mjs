import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { installToolchainPayload, withInstallationLock } from '../../../touba-distribution/src/install-toolchain-payload.mjs';
import { toolchainBuildIdentity } from '../../../touba-distribution/src/build-identity.mjs';
import { chooseRelease, fail, hashPattern, validatePolicy, verifyCatalogue } from './protocol.mjs';
import { download, extractPayload } from './transfer.mjs';
import { atomicJson, ensureIdle, ensureSpace, installation, payloadSize, readJson, regular, verifyRuntime } from './platform.mjs';

const policyPath = root => join(root, 'lib/cli/touba-project/src/update/trust.json');
const help = 'Usage: touba update [--check | --rollback] [--yes] [--json]';

export function parseUpdateOptions(args) {
  const options = {};
  for (const arg of args) {
    const name = arg === '-h' ? 'help' : arg.slice(2);
    if ((!arg.startsWith('--') && arg !== '-h') || !['check', 'rollback', 'yes', 'json', 'help'].includes(name) || options[name]) {
      fail('UpdateOptionInvalid', `Unknown or repeated update option: ${arg}`);
    }
    options[name] = true;
  }
  if (options.check && (options.rollback || options.yes)) fail('UpdateOptionInvalid', '--check cannot be combined with --rollback or --yes.');
  return options;
}

function readState(prefix) {
  const state = readJson(join(prefix, '.update-state.json'), true);
  if (!state) return { schema: 'touba-update-state-v1', highest_build: 0, catalogue: null, previous: null };
  if (state.schema !== 'touba-update-state-v1' || !Number.isSafeInteger(state.highest_build) || state.highest_build < 0
      || (state.catalogue && (!Number.isSafeInteger(state.catalogue.sequence) || state.catalogue.sequence < 1 || !hashPattern.test(state.catalogue.digest)))) {
    fail('UpdateLocalMetadataInvalid');
  }
  return state;
}

async function confirm(message, options, signal) {
  if (options.yes) return;
  if (!process.stdin.isTTY || !process.stderr.isTTY || options.json) {
    fail('UpdateConfirmationRequired', 'Run touba update interactively, or use --yes to confirm the installation.');
  }
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    if (!/^y(?:es)?$/i.test((await prompt.question(`${message} [y/N] `, { signal })).trim())) fail('UpdateCancelled', 'Update cancelled.');
  } finally { prompt.close(); }
}

function verifyPayload(root, expected, policy) {
  const metadata = readJson(join(root, 'TOOLCHAIN.json'));
  if (metadata.platform !== expected.platform || metadata.touba_version !== expected.version
      || metadata.build?.id !== expected.build_id || toolchainBuildIdentity(root).id !== expected.build_id) fail('UpdateBuildIdentityMismatch');
  const nextPolicy = validatePolicy(readJson(policyPath(root)));
  if (nextPolicy.build_sequence !== expected.build_sequence || nextPolicy.catalogue_url !== policy.catalogue_url
      || nextPolicy.channel !== policy.channel) fail('UpdateBuildMetadataMismatch');
  return metadata;
}

function activate({ candidate, installed, release, state, lock, validate, idle }) {
  const { root, prefix, receipt, metadata } = installed;
  const previousPolicy = validatePolicy(readJson(policyPath(root)));
  const previousSize = payloadSize(root);
  const receiptPath = join(prefix, 'INSTALLATION.json');
  const statePath = join(prefix, '.update-state.json');
  const beforeState = readJson(statePath, true);
  let committed = false;
  try {
    return installToolchainPayload({
      source: candidate, prefix, force: true, lock,
      validate: location => validate(location, release),
      beforeActivate: () => idle(root),
      commit: report => {
        const nextState = {
          ...state,
          highest_build: Math.max(state.highest_build, previousPolicy.build_sequence, release.build_sequence),
          previous: {
            path: relative(prefix, report.preserved_build), platform: metadata.platform,
            version: metadata.touba_version, build_id: metadata.build.id, build_sequence: previousPolicy.build_sequence, expanded_size: previousSize,
          },
        };
        atomicJson(receiptPath, { ...receipt, touba_version: release.version, build: readJson(join(root, 'TOOLCHAIN.json')).build,
          update_policy: 'signed-catalogue', updated_at: new Date().toISOString() });
        atomicJson(statePath, nextState);
        committed = true;
      },
    });
  } catch (error) {
    // The payload installer restores the prior directory on a handled failure.
    // Restore its associated receipts too; never claim success after a partial commit.
    if (!committed) {
      atomicJson(receiptPath, receipt);
      if (beforeState) atomicJson(statePath, beforeState);
      else rmSync(statePath, { force: true });
    }
    throw error;
  }
}

/** Dependencies are injectable for isolated tests, never through CLI options or environment URLs. */
export async function performUpdate(root, options, dependencies = {}) {
  const { fetcher = fetch, now = Date.now, validate = verifyRuntime, idle = ensureIdle, space = ensureSpace,
    confirmation = confirm, signal } = dependencies;
  const installed = installation(root);
  const { prefix, metadata } = installed;
  root = installed.root;
  const policy = validatePolicy(readJson(policyPath(root)));
  const identity = () => {
    if (toolchainBuildIdentity(root).id !== metadata.build.id) fail('UpdateInstallationModified', 'This installation was modified. Reinstall from Touba Downloads before updating.');
  };
  return withInstallationLock(prefix, async lock => {
    let state = readState(prefix);
    const base = { schema: 'touba-update-result-v1', platform: metadata.platform, installed_version: metadata.touba_version, installed_build: metadata.build.id };
    let release, retained;
    if (options.rollback) {
      release = state.previous;
      if (!release || typeof release.path !== 'string' || isAbsolute(release.path) || !hashPattern.test(release.build_id)
          || release.platform !== metadata.platform) fail('UpdateRollbackUnavailable', 'No previous build is recorded for this installation.');
      retained = resolve(prefix, release.path);
      regular(join(prefix, 'builds'), true);
      regular(retained, true);
      const rel = relative(realpathSync(join(prefix, 'builds')), realpathSync(retained));
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) fail('UpdateRollbackUnavailable');
      verifyPayload(retained, release, policy);
    } else {
      const bytes = await download(policy.catalogue_url, { policy, fetcher, signal });
      const verified = verifyCatalogue(bytes, policy, { now: now(), previous: state.catalogue });
      const selection = chooseRelease(verified.catalogue, metadata, policy, state.highest_build);
      release = selection.release;
      state = { ...state, catalogue: verified.checkpoint };
      // Persist the authenticated sequence even for --check, so an older catalogue
      // cannot later erase an update that has already been observed.
      atomicJson(join(prefix, '.update-state.json'), state);
      if (selection.current || options.check) return { ...base, status: selection.current ? 'current' : 'available', version: release.version, build: release.build_id };
    }
    await confirmation(`${options.rollback ? 'Restore' : 'Install'} Touba ${release.version} (build ${release.build_id.slice(0, 12)})?`, options, signal);
    signal?.throwIfAborted();
    if (process.platform === 'win32') {
      const executable = relative(root, realpathSync(process.execPath));
      if (!executable.startsWith('..') && !isAbsolute(executable)) fail('UpdateWindowsBootstrapRequired', 'Run the installed touba.cmd launcher to update Windows safely.');
    }
    identity();
    idle(root);
    // Work outside the active prefix. The canonical installer deliberately refuses
    // overlapping source/destination trees and stages its own verified copy.
    const expanded = release.expanded_size ?? 2 * 1024 ** 3;
    space(prefix, expanded);
    space(dirname(prefix), (release.size ?? 0) + expanded * 2);
    const work = mkdtempSync(join(dirname(prefix), '.touba-update-'));
    try {
      let candidate;
      if (retained) {
        candidate = join(work, 'retained');
        cpSync(retained, candidate, { recursive: true, force: false, errorOnExist: true });
      } else {
        const archive = join(work, 'release.tar.gz');
        await download(release.url, { policy, fetcher, destination: archive, release, signal });
        const extracted = await extractPayload(archive, join(work, 'extracted'), { signal });
        if (extracted.expanded > release.expanded_size) fail('UpdateExpandedSizeMismatch');
        candidate = extracted.root;
      }
      verifyPayload(candidate, release, policy);
      signal?.throwIfAborted();
      const report = activate({ candidate, installed, release, state, lock, validate, idle });
      return { ...base, status: options.rollback ? 'restored' : 'updated', version: release.version, build: release.build_id,
        previous_build: report.preserved_build };
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
}

export async function updateCommand(args, root) {
  let options = {};
  const abort = new AbortController();
  const cancel = () => abort.abort(Object.assign(new Error('Update cancelled.'), { code: 'UpdateCancelled' }));
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    options = parseUpdateOptions(args);
    if (options.help) return { text: help, exitCode: 0 };
    const report = await performUpdate(root, options, { signal: abort.signal });
    const descriptions = { current: 'Up to date', available: 'Update available', updated: 'Updated', restored: 'Previous build restored' };
    return { text: options.json ? JSON.stringify(report) : `${descriptions[report.status]}: Touba ${report.version} (build ${report.build.slice(0, 12)}).${report.status === 'available' ? '\nRun touba update to install it.' : ''}`, exitCode: 0 };
  } catch (error) {
    const unmanaged = !error.code && !existsSync(join(root, 'TOOLCHAIN.json'));
    const code = unmanaged ? 'UpdateUnmanagedInstallation' : error.code ?? 'UpdateFailed';
    const message = unmanaged ? 'Install the latest Touba build from https://toubalang.org/hub/telechargements/ to enable verified updates.'
      : error.message;
    return { text: options.json ? JSON.stringify({ schema: 'touba-update-result-v1', status: 'refused', code, message }) : `${code}: ${message}`, exitCode: 2 };
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}
