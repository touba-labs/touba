import { findPackageWorkspace, readPackageWorkspace, verifyInstalledPackages } from './package-store.mjs';
import { registryPackageStates } from './registry.mjs';
import { createRegistryReader } from './package-fetch.mjs';
import { configuredRegistry } from './package-registry-config.mjs';

export async function cachedPackageDiagnostics(root) {
  try {
    const configuration = configuredRegistry(root);
    if (!configuration) return [];
    const report = await auditPackageStatus({ ...configuration, root, offline: true });
    const evidence = { source: 'cache', collected_at: report.collected_at, expires_at: report.expires_at, freshness: report.freshness };
    return [
      ...(report.freshness === 'expired' ? [{ severity: 'warning', code: 'PackageStatusExpired',
        message: 'The cached signed catalogue has expired. Refresh explicitly with touba package audit.', ...evidence }] : []),
      ...report.packages.filter(pkg => pkg.status === 'yanked').map(pkg => ({ severity: 'warning', code: 'PackageVersionWithdrawn',
        package_name: pkg.name, version: pkg.version, ...evidence,
        message: `${pkg.name}@${pkg.version} was withdrawn in the last verified catalogue.${pkg.withdrawal ? ' Reason: ' + pkg.withdrawal.reason : ''} No live consultation was made.`,
      })),
    ];
  } catch (error) {
    return [{ severity: 'warning', code: 'PackageStatusUnavailable', reason: error.code ?? 'RegistryStatusUnavailable',
      message: 'Withdrawal status could not be verified from the local cache. Run touba package audit explicitly. No network request was made.' }];
  }
}

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
