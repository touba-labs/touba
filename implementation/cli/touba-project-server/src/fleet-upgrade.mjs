import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readProjectFleet, fleetDigest, fleetSourceDigest } from './project-fleet.mjs';
import { acquireStateLease, archiveProjectState } from './state-maintenance.mjs';
import { checkToubaProjectState } from './serve.mjs';
import { installSdk, bundledSdk } from '../../touba-project/src/sdk-command.mjs';
import { prepareProject } from '../../touba-project/src/project.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const codeOf = error => /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(error?.code ?? '') ? error.code : 'ToubaFleetUpgradeStepFailed';

// A receipt is updated before and after each mechanical step. It contains no host secrets.
function receiptPath(root) {
  const directory = join(root, '.touba');
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) fail('ToubaFleetStateInvalid');
  return join(directory, 'fleet-upgrade.json');
}
function prior(root) {
  const path = receiptPath(root);
  if (!existsSync(path)) return null;
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) fail('ToubaFleetStateInvalid');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (value.schema_version !== 'touba-fleet-upgrade-receipt-v1') fail('ToubaFleetStateInvalid');
  return value;
}
function durableWrite(path, value) {
  const temporary = path + '.' + randomUUID();
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n');
    fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, path);
    if (process.platform !== 'win32') {
      descriptor = openSync(dirname(path), 'r'); fsyncSync(descriptor);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
function save(root, value) {
  const path = receiptPath(root), history = join(dirname(path), 'fleet-upgrade-receipts');
  if (!existsSync(history)) mkdirSync(history, { mode: 0o700 });
  if (!lstatSync(history).isDirectory() || lstatSync(history).isSymbolicLink()) fail('ToubaFleetStateInvalid');
  if (!/^[0-9a-f-]{36}$/.test(value.id)) fail('ToubaFleetStateInvalid');
  durableWrite(join(history, value.id + '.json'), value);
  durableWrite(path, value);
}

export function fleetUpgrade({ checkState = checkToubaProjectState, sdk = bundledSdk, install = installSdk, prepare = prepareProject } = {}) {
  function inspect(project) {
    const release = acquireStateLease(project.root);
    try {
      const previous = prior(project.root);
      if (previous?.status === 'running') fail('ToubaFleetUpgradeInterrupted');
      const state = checkState({ projectRoot: project.root });
      const archive = archiveProjectState({ projectRoot: project.root }, checkState, release);
      const bundle = sdk(project.language);
      return { ...project, status: 'ready', candidate_build: state.candidate_build_id,
        source_digest: fleetSourceDigest(project.root),
        archive_digest: fleetDigest(archive.files), archive_files: archive.files.length,
        sdk: { name: bundle.name, version: bundle.version, sha256: bundle.sha256 },
        previous_receipt: previous ? fleetDigest(previous) : null };
    } finally { release(); }
  }
  function plan(file) {
    const fleet = readProjectFleet(file);
    const projects = fleet.projects.map(project => {
      try { return inspect(project); }
      catch (error) { return { ...project, status: 'blocked', code: codeOf(error) }; }
    });
    return { schema_version: 'touba-fleet-upgrade-plan-v1', projects, review_digest: fleetDigest(projects) };
  }
  return {
    plan,
    async apply(file, digest) {
      const reviewed = plan(file);
      if (reviewed.review_digest !== digest) fail('ToubaFleetReviewRequired');
      const results = [];
      for (const project of reviewed.projects) {
        if (project.status !== 'ready') { results.push(project); continue; }
        let release;
        const record = { schema_version: 'touba-fleet-upgrade-receipt-v1', id: randomUUID(),
          review_digest: digest, candidate_build: project.candidate_build, status: 'running', step: 'archive', archive_id: null };
        try {
          // This check also detects profile edits made during the preceding project.
          const current = readProjectFleet(file).projects.find(item => item.id === project.id);
          if (!current || current.profile_digest !== project.profile_digest || current.project_digest !== project.project_digest) fail('ToubaFleetReviewRequired');
          if (fleetDigest(inspect(current)) !== fleetDigest(project)) fail('ToubaFleetReviewRequired');
          release = acquireStateLease(project.root);
          const before = archiveProjectState({ projectRoot: project.root }, checkState, release);
          if (fleetDigest(before.files) !== project.archive_digest) fail('ToubaFleetReviewRequired');
          save(project.root, record);
          const archive = archiveProjectState({ projectRoot: project.root, applyState: true }, checkState, release);
          record.archive_id = archive.archive_id ?? null; record.step = 'sdk'; save(project.root, record);
          const bundle = sdk(project.language);
          if (bundle.sha256 !== project.sdk.sha256) fail('ToubaFleetReviewRequired');
          await install(project.language, { root: project.root });
          if (fleetSourceDigest(project.root) !== project.source_digest) fail('ToubaFleetReviewRequired');
          record.step = 'prepare'; save(project.root, record);
          const preparation = await prepare({ root: project.root, mode: 'plan', runProfile: 'dev' });
          if (preparation.diagnostics.some(item => item.severity === 'error')) fail('ToubaFleetPreparationReviewRequired');
          const result = await prepare({ root: project.root, mode: 'write', runProfile: 'dev', expectedReviewDigest: preparation.review_digest });
          if (result.status !== 'success') fail('ToubaFleetPreparationReviewRequired');
          record.status = 'complete'; record.step = 'complete'; save(project.root, record);
          results.push({ id: project.id, status: 'complete', archive_id: record.archive_id });
        } catch (error) {
          record.status = 'failed'; record.code = codeOf(error);
          if (release) save(project.root, record);
          results.push({ id: project.id, status: 'blocked', step: record.step, code: record.code, archive_id: record.archive_id });
        } finally { release?.(); }
      }
      return { schema_version: 'touba-fleet-upgrade-result-v1', projects: results };
    },
  };
}
