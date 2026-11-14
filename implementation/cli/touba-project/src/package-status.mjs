import { findPackageWorkspace, readPackageWorkspace, verifyInstalledPackages } from './package-store.mjs';
import { registryPackageStates } from './registry.mjs';
import { createRegistryReader } from './package-fetch.mjs';

export async function auditPackageStatus(options) {
  const root = findPackageWorkspace(options.root), workspace = readPackageWorkspace(root);
  const lock = verifyInstalledPackages(root, workspace.records);
  const reader = options.offline ? { readBytes: async () => { throw new Error('Offline audit must not access the network'); }, close: async () => {} }
    : createRegistryReader(options.registry, { noBrowser: options['no-browser'] === true,
      sessionOnly: options['session-only'] === true });
  try {
    const { packages: catalogue, ...evidence } = await registryPackageStates({ ...options, readBytes: reader.readBytes });
    const versions = new Map(catalogue.map(item => [item.name + '@' + item.version, item]));
    const packages = lock.packages.map(installed => ({ name: installed.name, version: installed.version,
      installed_digest: installed.digest, ...(versions.get(installed.name + '@' + installed.version) ?? { status: 'unknown' }) }));
    const attention = evidence.freshness === 'expired' || packages.some(item => item.status !== 'validated');
    return { command: 'package audit', status: attention ? 'attention' : 'success', exitCode: attention ? 1 : 0,
      ...evidence, packages, notes: [
        ...(evidence.source === 'cache' ? [`Cached signed catalogue collected at ${evidence.collected_at}; expires at ${evidence.expires_at}. ${evidence.freshness === 'expired' ? 'Expired: refresh explicitly before relying on its status.' : 'Offline snapshot, not a live consultation.'}`] : []),
        ...packages.filter(item => item.status !== 'validated').map(item =>
          `${item.name}@${item.version}: ${item.status}${item.withdrawal ? ': ' + item.withdrawal.reason : ''}`),
        'Status of these names and versions in the selected registry at checked_at. Unknown is not a safety clearance.',
        'Local integrity was checked separately. No package was changed and no running execution was stopped.',
        'This command checks withdrawal status, not a vulnerability database. Run it again explicitly to refresh.',
      ] };
  } finally { await reader.close(); }
}
