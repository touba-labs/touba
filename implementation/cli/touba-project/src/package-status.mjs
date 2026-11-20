import { findPackageWorkspace, inspectInstalledPackages, readPackageWorkspace } from './package-store.mjs';
import { resolve } from 'node:path';
import { registryPackageStates } from './registry.mjs';
import { createRegistryReader } from './package-fetch.mjs';
import { configuredRegistry } from './package-registry-config.mjs';
import { packageLocale } from './package-diagnostics.mjs';

export async function cachedPackageDiagnostics(root) {
  try {
    const configuration = configuredRegistry(root);
    if (!configuration) return [{ severity: 'warning', code: 'PackageStatusNotConfigured',
      message: 'Package withdrawal status is not checked: this workspace has no trusted registry configuration. Local packages remain usable. To reuse an audit during preparation, configure touba package registry <url> --trust <verified-file>, then run touba package audit. No network request was made.' }];
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
  const fr = packageLocale(options.lang) === 'fr';
  const date = value => new Intl.DateTimeFormat(fr ? 'fr-CA' : 'en-CA',
    { dateStyle: 'medium', timeStyle: 'long' }).format(new Date(value));
  const root = findPackageWorkspace(options.root), workspace = readPackageWorkspace(root);
  const { lock, packages: inspected } = inspectInstalledPackages(root, workspace.records, { allowMissing: true });
  const configured = configuredRegistry(root);
  const remembered = configured?.registry === options.registry && configured?.trust === options.trust;
  const reader = options.offline ? { readBytes: async () => { throw new Error('Offline audit must not access the network'); }, close: async () => {} }
    : createRegistryReader(options.registry, { noBrowser: options['no-browser'] === true,
      sessionOnly: options['session-only'] === true });
  try {
    const { packages: catalogue, ...evidence } = await registryPackageStates({ ...options, readBytes: reader.readBytes });
    const versions = new Map(catalogue.map(item => [item.name + '@' + item.version, item]));
    const packages = lock.packages.map(installed => {
      const restrictions = inspected.get(resolve(root, installed.manifest)).restrictions;
      return { name: installed.name, version: installed.version, installed_digest: installed.digest,
        ...(versions.get(installed.name + '@' + installed.version) ?? { status: 'unknown' }),
        ...(restrictions.length ? { restrictions } : {}) };
    });
    const attention = evidence.freshness === 'expired' || packages.some(item => item.status !== 'validated' || item.restrictions?.length);
    return { command: 'package audit', status: attention ? 'attention' : 'success', exitCode: attention ? 1 : 0,
      ...evidence, packages, notes: [
        ...(!remembered ? [fr ? 'Cette consultation ponctuelle ne configure pas la préparation. Sélectionnez le catalogue de confiance avec touba package registry <url> --trust <fichier-vérifié>.' : 'This one-off audit does not configure preparation. Use touba package registry <url> --trust <verified-file> explicitly to select the trusted catalogue for this workspace.'] : []),
        ...(evidence.source === 'cache' ? [fr ? `Catalogue signé en cache, recueilli le ${date(evidence.collected_at)}, expiration ${date(evidence.expires_at)}. ${evidence.freshness === 'expired' ? 'Périmé : actualisez explicitement avant de vous fier à son état.' : 'Copie hors ligne, sans consultation actuelle.'}` : `Cached signed catalogue collected at ${date(evidence.collected_at)}; expires at ${date(evidence.expires_at)}. ${evidence.freshness === 'expired' ? 'Expired: refresh explicitly before relying on its status.' : 'Offline snapshot, not a live consultation.'}`] : []),
        ...packages.filter(item => item.status !== 'validated').map(item =>
          `${item.name}@${item.version}${fr ? ' : ' : ': '}${fr ? ({ yanked: 'retiré', unknown: 'inconnu' })[item.status] ?? item.status : item.status}${item.withdrawal ? (fr ? ' : ' : ': ') + item.withdrawal.reason : ''}`),
        fr ? `État de ces noms et versions dans le registre sélectionné au ${date(evidence.checked_at)}. Un état inconnu ne garantit pas la sûreté.` : `Status of these names and versions in the selected registry at ${date(evidence.checked_at)}. Unknown is not a safety clearance.`,
        fr ? 'L’intégrité locale a été vérifiée séparément. Aucun package modifié et aucune exécution arrêtée.' : 'Local integrity was checked separately. No package was changed and no running execution was stopped.',
        fr ? 'Cette commande vérifie les retraits, pas une base de vulnérabilités. Relancez-la explicitement pour actualiser.' : 'This command checks withdrawal status, not a vulnerability database. Run it again explicitly to refresh.',
      ] };
  } finally { await reader.close(); }
}
