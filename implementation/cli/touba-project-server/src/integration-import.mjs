import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importMcpTools } from '../../touba-project/src/mcp-import.mjs';
import { scaffoldRestTool } from '../../touba-project/src/rest-scaffold.mjs';
import { validateImportFiles } from '../../touba-project/src/import-files.mjs';
import { inspectSdkDependency } from '../../touba-manifest/src/sdk-dependency.mjs';
import sdk from '../../../runtime/touba-handler-sdk/package.json' with { type: 'json' };

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const hash = content => createHash('sha256').update(content).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const LIMIT = 1024 * 1024;

// Input is data, never a command or remote URL to fetch. The generator is the
// same one used by the CLI. Its files are reviewed before any project write.
export function planIntegrationImport(projectRoot, request) {
  const root = realpathSync(projectRoot);
  if (!object(request) || Object.keys(request).some(key => !['kind', 'name', 'document', 'selected', 'base_url', 'secret_handles', 'authorize_grants', 'timeout_ms', 'max_payload_bytes'].includes(key))
    || !['mcp', 'openapi'].includes(request.kind) || !/^[a-z][a-z0-9_]{0,47}$/.test(request.name ?? '')
    || !object(request.document) || Buffer.byteLength(JSON.stringify(request.document)) > LIMIT
    || !Array.isArray(request.selected) || !request.selected.length || request.selected.length > 24
    || request.selected.some(name => typeof name !== 'string' || !name.length || name.length > 128)
    || new Set(request.selected).size !== request.selected.length || typeof request.authorize_grants !== 'boolean'
    || !Array.isArray(request.secret_handles) || request.secret_handles.length > 16
    || request.secret_handles.some(name => !/^[A-Z][A-Z0-9_]{0,63}$/.test(name))) {
    fail('ToubaServeImportInvalid', 'Choose a named integration, a JSON document and 1 to 24 distinct operations. Secrets use handles only.');
  }
  const limits = { timeout_ms: request.timeout_ms ?? 5000, max_payload_bytes: request.max_payload_bytes ?? LIMIT };
  if (!Number.isSafeInteger(limits.timeout_ms) || limits.timeout_ms < 100 || limits.timeout_ms > 120000
    || !Number.isSafeInteger(limits.max_payload_bytes) || limits.max_payload_bytes < 1024 || limits.max_payload_bytes > LIMIT) {
    fail('ToubaServeImportInvalid', 'Import handler timeout must be 100 to 120000 ms; payload limit must be 1024 to 1048576 bytes');
  }
  const out = `integrations/${request.name}`, moduleName = `integrations.${request.name}`;
  // An import creates a new integration. Existing files require a separate
  // source change review; this route never overwrites them, even identically.
  const options = { root, out, moduleName, mode: 'plan', includeContents: true };
  let report;
  if (request.kind === 'openapi') {
    let base;
    try { base = new URL(request.base_url); } catch { fail('ToubaServeImportInvalid', 'An explicit HTTPS API base URL is required'); }
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) fail('ToubaServeImportInvalid', 'Use an HTTPS API URL without credentials, query or fragment');
    report = scaffoldRestTool({ ...options, configDocument: {
      rest_scaffold_config_version: 'touba-rest-scaffold-config-v1',
      service: { name: request.name.replaceAll('_', '-'), base_url: base.href, secret_handles: request.secret_handles, ...limits },
      openapi: request.document, operation_ids: request.selected,
    } });
  } else {
    if (request.base_url !== undefined && request.base_url !== '') fail('ToubaServeImportInvalid', 'Snapshot import does not connect to a server');
    if (!Array.isArray(request.document.tools) || request.document.tools.length > 256) fail('ToubaServeImportInvalid', 'MCP snapshot requires at most 256 tools');
    for (const name of request.selected) {
      const matches = request.document.tools.filter(tool => tool?.name === name);
      if (matches.length !== 1 || (matches[0].secret_handles !== undefined && (!Array.isArray(matches[0].secret_handles)
        || matches[0].secret_handles.length > 16 || matches[0].secret_handles.some(handle => !/^[A-Z][A-Z0-9_]{0,63}$/.test(handle))))) {
        fail('ToubaServeImportInvalid', 'Selected MCP names must be unique, with bounded secret handles');
      }
    }
    report = importMcpTools({ ...options, selectedTools: request.selected, configDocument: {
      mcp_import_config_version: 'touba-mcp-import-config-v1',
      server: { name: request.name.replaceAll('_', '-'), transport: 'snapshot', secret_handles: request.secret_handles, ...limits },
      tools: request.document.tools,
    } });
  }
  if (report.status !== 'success' || report.refused_tools?.length) fail('ToubaServeImportUnsupported', 'A selected operation has an unsupported contract. Review the CLI import diagnostics before importing it.');
  const files = report.files.map(file => ({ path: file.relative_path.replaceAll('\\', '/'), role: file.kind, content: file.content }));
  const source = files.find(file => file.role === 'source'), generatedSource = source.path;
  source.path = `src/integrations/${request.name}.tb`;
  for (const file of files.filter(file => file.role === 'import_report')) {
    const content = JSON.parse(file.content);
    if (Array.isArray(content.generated_files)) content.generated_files = content.generated_files.map(path => path === generatedSource ? source.path : path);
    file.content = JSON.stringify(content, null, 2) + '\n';
  }
  if (files.length > 60 || files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > 2 * LIMIT) fail('ToubaServeImportLimit', 'Generated artifacts exceed the bounded review limit');
  const bindingFile = files.find(file => file.role === 'binding_fragment'), fragment = JSON.parse(bindingFile.content);
  const grants = [];
  for (const [ref, binding] of Object.entries(fragment.bindings)) {
    binding.handler.command = process.execPath;
    grants.push({ tool_ref: ref, grants: binding.grants, secret_handles: binding.secrets ?? [] });
    if (!request.authorize_grants) binding.grants = [];
  }
  bindingFile.content = JSON.stringify(fragment, null, 2) + '\n';
  validateImportFiles(root, files.map(file => ({ ...file, path: join(root, file.path) })), { mode: 'plan' });
  for (const file of files) {
    try { lstatSync(join(root, file.path)); fail('ToubaServeImportExists', 'This integration already has files. Choose a new name or review an explicit source change.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const projectPath = join(root, 'touba.project.json');
  for (let path = projectPath; path !== root; path = dirname(path)) {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > LIMIT) fail('ToubaServeImportInvalid', 'Project configuration must be a bounded regular file');
  }
  const original = readFileSync(projectPath, 'utf8'), project = JSON.parse(original);
  if (project.project_version !== 'touba-project-v1' || project.configuration && !object(project.configuration)) fail('ToubaServeImportInvalid', 'Project configuration is invalid');
  project.configuration ??= {};
  const fragments = project.configuration.binding_fragments ?? [];
  if (!Array.isArray(fragments) || fragments.some(path => typeof path !== 'string') || fragments.length >= 256) fail('ToubaServeImportInvalid', 'Binding fragments are invalid or at capacity');
  if (fragments.includes(bindingFile.path)) fail('ToubaServeImportExists', 'This fragment is already configured');
  project.configuration.binding_fragments = [...fragments, bindingFile.path];
  files.push({ path: 'touba.project.json', role: 'project', content: JSON.stringify(project, null, 2) + '\n', base_content_exists: true, base_content_sha256: hash(original) });
  for (const file of files) { file.base_content_exists ??= false; file.base_content_sha256 ??= null; file.content_sha256 = hash(file.content); }
  const dependency = inspectSdkDependency(root, sdk.version, fileURLToPath(new URL('../../../runtime/touba-handler-sdk', import.meta.url)));
  return { files, grants, module: moduleName, kind: request.kind,
    runtime: { language: 'javascript', node_version: process.versions.node, sdk: dependency.status, sdk_version: sdk.version, ...limits },
    review_digest: `sha256:${hash(JSON.stringify(files))}`, authorize_grants: request.authorize_grants };
}

export function createIntegrationImport(root, { validate, apply, now = Date.now }) {
  const pending = new Map();
  return {
    preview(principal, request) {
      for (const [id, item] of pending) if (item.expires <= now() || item.principal === principal) pending.delete(id);
      if (pending.size >= 8) fail('ToubaServeImportLimit', 'Too many pending integration reviews');
      const plan = planIntegrationImport(root, request), diagnostics = validate(plan.files);
      const id = randomUUID(), expires = now() + 300000;
      const canApply = request.authorize_grants && !diagnostics.some(item => item.severity === 'error');
      if (canApply) pending.set(id, { principal, expires, request: structuredClone(request), digest: plan.review_digest });
      return { schema_version: 'touba-integration-import-preview-v1', id, expires_at: new Date(expires).toISOString(),
        review_digest: plan.review_digest, can_apply: canApply, module: plan.module, kind: plan.kind, runtime: plan.runtime,
        files: plan.files.map(({ path, role, content_sha256, content }) => ({ path, role, digest: `sha256:${content_sha256}`, ...(role === 'source' ? { source: content } : {}) })),
        grants: plan.grants, diagnostics, authorize_grants: plan.authorize_grants };
    },
    apply(principal, request) {
      if (!object(request) || Object.keys(request).some(key => !['id', 'review_digest', 'reason'].includes(key)) || typeof request.reason !== 'string' || !request.reason.trim() || request.reason.length > 1000) fail('ToubaServeImportInvalid', 'A reviewed import and a short reason are required');
      const item = pending.get(request.id);
      if (!item || item.principal !== principal || item.expires <= now()) fail('ToubaServeImportReviewMissing', 'Preview the import again');
      if (item.digest !== request.review_digest) fail('ToubaServeImportStale', 'The reviewed digest differs');
      pending.delete(request.id);
      const plan = planIntegrationImport(root, item.request);
      if (plan.review_digest !== item.digest) fail('ToubaServeImportStale', 'Project configuration changed; preview again');
      const diagnostics = validate(plan.files);
      if (diagnostics.some(item => item.severity === 'error')) fail('ToubaServeImportUnsupported', 'The project changed; preview and compile again');
      validateImportFiles(realpathSync(root), [{ path: join(realpathSync(root), '.touba/change-transactions/import-preflight/journal.json') }], { mode: 'plan' });
      const evidence = apply({ proposalId: request.id, targets: plan.files, decidedAt: new Date(now()).toISOString(),
        review_actor: `sha256:${hash(principal)}`, reason: request.reason });
      return { schema_version: 'touba-integration-import-result-v1', status: 'imported', module: plan.module,
        review_digest: plan.review_digest, files: plan.files.map(file => file.path), transaction_id: evidence.transaction_id };
    },
  };
}
