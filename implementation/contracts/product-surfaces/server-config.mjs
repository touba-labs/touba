import schema from './schemas/touba-project-server-config-v1.schema.json' with { type: 'json' };
import { validateObject } from './validate.mjs';

export const serverConfigPaths = new Set(['identity_file', 'secrets_file', 'validation_plan',
  'mcp_discovery_config',
  'human_approval_host', 'agent_decision_provider', 'package_registry_trust']);
const fail = field => { throw Object.assign(new Error(`Invalid project server configuration: ${field}`),
  { code: 'ToubaServeConfigInvalid', field }); };

// Pure contract validation, shared by configuration editors and the server.
// The server additionally verifies filesystem links and resolves local paths.
export function validateProjectServerConfig(document) {
  if (validateObject(schema, document).length) fail('document');
  if (document.package_hosts && (document.human_approval_host || document.agent_decision_provider)) fail('package_hosts');
  if (Boolean(document.package_registry) !== Boolean(document.package_registry_trust)) fail('package_registry_trust');
  if (document.identity_service_token_env && document.identity_service_token_vault) fail('identity_service_token_vault');
  if (document.request_triggers === true && !document.webhook_signature_secret_env) fail('webhook_signature_secret_env');
  if (Boolean(document.identity_control_plane_url) !== Boolean(document.identity_service_token_env || document.identity_service_token_vault)) fail('identity_service_token_env');
  for (const field of serverConfigPaths) {
    const value = document[field];
    if (value === undefined) continue;
    if (['human_approval_host', 'agent_decision_provider'].includes(field) && value.startsWith('pkg:')) {
      if (!/^pkg:[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\/[a-z][a-z0-9_-]*$/.test(value)) fail(field);
    } else if (!value || /^[A-Za-z]:|^[\/\\]/.test(value) || /[\\\x00-\x1f\x7f]/.test(value)
      || value.split('/').some(part => !part || part === '.' || part === '..')) fail(field);
  }
  for (const field of ['identity_control_plane_url', 'package_registry', 'deployment_target_url', 'client_origins']) {
    for (const value of field === 'client_origins' ? document[field] ?? [] : document[field] === undefined ? [] : [document[field]]) {
      let url;
      try { url = new URL(value); } catch { fail(field); }
      if (url.username || url.password || url.hash || url.search || /[\\\x00-\x20\x7f]/.test(value)
        || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
        || (field === 'client_origins' && (url.protocol !== 'https:' || url.pathname !== '/'))) fail(field);
    }
  }
  return document;
}
