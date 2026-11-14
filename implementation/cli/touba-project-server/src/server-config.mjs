import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { validateProjectServerConfig, serverConfigPaths as paths } from '../../../contracts/product-surfaces/server-config.mjs';
const fields = {
  host: '--host', port: '--port', client_origins: '--client-origin',
  mcp_discovery_config: '--mcp-discovery-config',
  identity_control_plane_url: '--identity-control-plane-url', identity_service_token_env: '--identity-service-token-env',
  identity_service_token_vault: '--identity-service-token-vault',
  auth_token_env: '--auth-token-env', identity_file: '--identity', secrets_file: '--secrets',
  schedule_triggers: '--schedule-triggers', cloud_notifications: '--cloud-notifications', validation_plan: '--validation-plan',
  request_triggers: '--request-triggers', webhook_signature_secret_env: '--webhook-signature-secret-env',
  package_hosts: '--package-hosts', human_approval_host: '--human-approval-host', agent_decision_provider: '--agent-decision-provider',
  package_registry: '--package-registry', package_registry_trust: '--package-registry-trust',
  deployment_target_url: '--deployment-target-url', deployment_target_token_env: '--deployment-target-token-env',
  trace_pure_functions: '--trace-pure-functions', max_pending_approvals: '--max-pending-approvals',
};
const fail = field => { throw Object.assign(new Error(`Invalid project server configuration: ${field}`), { code: 'ToubaServeConfigInvalid', field }); };

function localPath(root, path, field, { required = false } = {}) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || /[\\\x00-\x1f\x7f]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) fail(field);
  let cursor = root;
  for (const part of path.split('/')) {
    cursor = join(cursor, part);
    try { if (lstatSync(cursor).isSymbolicLink()) fail(field); }
    catch (error) { if (error.code !== 'ENOENT' || required) throw error; }
  }
  return cursor;
}

export function serverConfigArguments(root, document) {
  validateProjectServerConfig(document);
  const args = [];
  for (const [key, flag] of Object.entries(fields)) {
    if (!Object.hasOwn(document, key)) continue;
    let value = document[key];
    if (paths.has(key)) {
      if ((key === 'human_approval_host' || key === 'agent_decision_provider') && value.startsWith('pkg:')) {
        if (!/^pkg:[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\/[a-z][a-z0-9_-]*$/.test(value)) fail(key);
      } else value = localPath(root, value, key);
    }
    if (typeof value === 'boolean') { if (value) args.push(flag); }
    else if (Array.isArray(value)) for (const item of value) args.push(flag, item);
    else args.push(flag, String(value));
  }
  return args;
}

// Configuration is opt-in and never looked up automatically in a cloned
// project. Unknown fields and duplicate flags are refused before host loading.
export function expandServerConfig(rawArgs, cwd = process.cwd()) {
  const remaining = [], configurations = [], roots = [];
  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index];
    if (arg === '--config') {
      const value = rawArgs[++index];
      if (!value || value.startsWith('--')) fail('config');
      configurations.push(value);
    } else {
      remaining.push(arg);
      if (arg === '--project-root') roots.push(rawArgs[index + 1]);
    }
  }
  if (!configurations.length) return rawArgs;
  if (configurations.length !== 1 || roots.length > 1 || roots.some(value => !value || value.startsWith('--'))) fail('config');
  const root = realpathSync(resolve(cwd, roots[0] ?? '.'));
  const file = localPath(root, configurations[0], 'config', { required: true });
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32768 || relative(root, realpathSync(file)).startsWith('..')) fail('config');
  let document;
  try { document = JSON.parse(readFileSync(file, 'utf8')); } catch { fail('json'); }
  const configured = serverConfigArguments(root, document);
  const explicit = new Set(remaining.filter(arg => arg.startsWith('--')).map(arg => arg.split('=')[0]));
  for (const key of Object.keys(document)) if (fields[key] && explicit.has(fields[key])) {
    throw Object.assign(new Error(`Project server option ${fields[key]} is already set by --config. Edit ${key} in the configuration file or remove the duplicate command-line option.`),
      { code: 'ToubaServeConfigInvalid', field: key, reason: 'duplicate_option' });
  }
  return [...configured, ...remaining];
}
