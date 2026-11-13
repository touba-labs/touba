import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expandServerConfig } from './server-config.mjs';
import { currentStateBuild } from './state-origin.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
export const fleetDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function fleetSourceDigest(root) {
  const excluded = new Set(['.git', '.touba', '.venv', 'node_modules', 'vendor', '__pycache__',
    'package.json', 'package-lock.json', 'pyproject.toml', 'uv.lock']);
  const records = []; let bytes = 0, count = 0;
  function visit(directory, prefix = '', depth = 0) {
    if (depth > 32) fail('ToubaFleetSourceLimit');
    for (const name of readdirSync(directory).sort()) {
      if (excluded.has(name)) continue;
      const path = resolve(directory, name), relative = prefix + name, stat = lstatSync(path);
      if (++count > 10000) fail('ToubaFleetSourceLimit');
      if (stat.isSymbolicLink()) fail('ToubaFleetSourceSymlink');
      if (stat.isDirectory()) visit(path, relative + '/', depth + 1);
      else if (/\.(tb|json|mjs|cjs|js|py|toml|lock)$/.test(name)) {
        bytes += stat.size; if (bytes > 64 * 1024 * 1024 || !stat.isFile()) fail('ToubaFleetSourceLimit');
        records.push([relative, createHash('sha256').update(readFileSync(path)).digest('hex')]);
      }
    }
  }
  visit(root); return fleetDigest(records);
}
function document(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) fail('ToubaFleetConfigInvalid');
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { fail('ToubaFleetConfigInvalid'); }
}

// A fleet is an explicit local allowlist. No folders are discovered automatically.
export function readProjectFleet(file) {
  file = resolve(file);
  const value = document(file);
  if (value?.schema_version !== 'touba-project-fleet-v1' || Object.keys(value).some(key => !['schema_version', 'projects', 'deployment_targets'].includes(key))
    || !Array.isArray(value.projects) || !value.projects.length || value.projects.length > 32) fail('ToubaFleetConfigInvalid');
  const ids = new Set(), roots = new Set(), ports = new Set();
  const projects = value.projects.map(entry => {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => !['id', 'root', 'config'].includes(key))
      || typeof entry.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(entry.id) || typeof entry.root !== 'string' || !entry.root.trim()
      || typeof entry.config !== 'string' || !entry.config.trim()) fail('ToubaFleetConfigInvalid');
    const root = realpathSync(resolve(dirname(file), entry.root));
    if (!lstatSync(root).isDirectory() || ids.has(entry.id) || roots.has(root)) fail('ToubaFleetConfigInvalid');
    const project = document(resolve(root, 'touba.project.json'));
    if (!['javascript', 'python'].includes(project.language)) fail('ToubaFleetConfigInvalid');
    const args = expandServerConfig(['--project-root', root, '--config', entry.config], root);
    const argument = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
    const host = argument('--host', '127.0.0.1'), port = Number(argument('--port', '8791'));
    if (!['127.0.0.1', '::1', 'localhost'].includes(host) || !Number.isSafeInteger(port) || port < 1 || port > 65535 || ports.has(port)) fail('ToubaFleetPortConflict');
    ids.add(entry.id); roots.add(root); ports.add(port);
    return { id: entry.id, root, config: entry.config, language: project.language, port, host,
      profile_digest: fleetDigest(args), project_digest: fleetDigest(project),
      source_digest: fleetSourceDigest(root), candidate_build: currentStateBuild(),
      schedule_triggers: args.includes('--schedule-triggers'), cloud_notifications: args.includes('--cloud-notifications') };
  });
  const targets = value.deployment_targets ?? [];
  if (!Array.isArray(targets) || targets.length > 4) fail('ToubaFleetConfigInvalid');
  const deployment_targets = targets.map(entry => {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => !['id', 'storage', 'host', 'port', 'auth_token_env'].includes(key))
      || typeof entry.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(entry.id) || ids.has(entry.id)
      || typeof entry.storage !== 'string' || !entry.storage.trim()
      || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(entry.auth_token_env ?? '')) fail('ToubaFleetConfigInvalid');
    const host = entry.host ?? '127.0.0.1', port = entry.port;
    if (!['127.0.0.1', '::1', 'localhost'].includes(host) || !Number.isSafeInteger(port) || port < 1 || port > 65535 || ports.has(port)) fail('ToubaFleetPortConflict');
    // Existing operator-owned storage only. Creation and its authority are separate.
    const storage = realpathSync(resolve(dirname(file), entry.storage));
    if (!lstatSync(storage).isDirectory() || roots.has(storage)) fail('ToubaFleetConfigInvalid');
    ids.add(entry.id); roots.add(storage); ports.add(port);
    return { id: entry.id, storage, host, port, auth_token_env: entry.auth_token_env, candidate_build: currentStateBuild() };
  });
  return { schema_version: 'touba-project-fleet-plan-v1', file, projects, deployment_targets, review_digest: fleetDigest({ projects, deployment_targets }) };
}

export function assertFleetReview(file, reviewDigest) {
  const plan = readProjectFleet(file);
  if (typeof reviewDigest !== 'string' || plan.review_digest !== reviewDigest) fail('ToubaFleetReviewRequired');
  return plan;
}
