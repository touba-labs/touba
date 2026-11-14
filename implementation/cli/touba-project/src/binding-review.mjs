import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

// This is a deliberately limited view for a privileged preparation review.
// Never include argv, environment values or absolute host paths. Fingerprints
// still bind all fields, including the information hidden by this projection.
export function bindingReviewValue(field, value, fingerprint, { root, manifestPath, grants = [] } = {}) {
  if (value === undefined) return fingerprint ?? null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  const object = item => item !== null && typeof item === 'object' && !Array.isArray(item);
  const paths = (items, base) => {
    const displayed = [], values = Array.isArray(items) ? items : [];
    let hidden = 0;
    for (const item of values) {
      let path;
      if (typeof item === 'string' && root && base && !/[\x00-\x1f\x7f]/u.test(item)) {
        path = relative(resolve(root), resolve(base, item)).replaceAll('\\', '/');
      }
      if (path !== undefined && !isAbsolute(path) && path !== '..' && !path.startsWith('../') && path.length <= 200 && displayed.length < 8) {
        displayed.push(path || '.');
      } else hidden++;
    }
    return { count: values.length, paths: displayed, hidden_count: hidden };
  };
  if (field === 'handler' && object(value)) {
    const name = typeof value.command === 'string' ? basename(value.command) : '';
    const executable = /^(?:node(?:\.exe)?|python(?:3(?:\.\d+)?)?(?:\.exe)?)$/u.test(name) ? name : '[hidden]';
    return { digest: fingerprint, executable, arguments_count: Array.isArray(value.args) ? value.args.length : 0,
      arguments_hidden: true, working_directory: paths([value.cwd ?? '.'], manifestPath && dirname(manifestPath)) };
  }
  if (field === 'sandbox' && object(value)) {
    // These paths are resolved relative to the handler cwd by the caller.
    return { digest: fingerprint, required: value.required === true,
      network: grants.includes('network') ? 'network' : grants.includes('network_local') ? 'local_sockets' : 'none',
      profile: value.profile === undefined || value.profile === 'default' ? 'default' : '[hidden]',
      code_inventory: { count: Array.isArray(value.code_paths) ? value.code_paths.length : 0, paths_hidden: true },
      read_access: paths(value.read_paths, manifestPath), write_access: paths(value.write_paths, manifestPath),
      local_sockets: { count: Array.isArray(value.local_sockets) ? value.local_sockets.length : 0, paths_hidden: true } };
  }
  const capabilities = new Set(['network', 'network_local', 'filesystem_read', 'filesystem_write', 'process']);
  if (field === 'grants' && Array.isArray(value) && value.every(item => capabilities.has(item))) return value;
  if (field === 'effect_contract' && object(value)) return { digest: fingerprint,
    kind: ['none', 'external_write'].includes(value.kind) ? value.kind : '[hidden]',
    ...(value.retry_mode === undefined ? {} : { retry_mode: ['none', 'idempotent'].includes(value.retry_mode) ? value.retry_mode : '[hidden]' }) };
  return fingerprint ?? null;
}
