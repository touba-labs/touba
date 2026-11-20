// Human presentation of the canonical report. JSON remains the machine contract.
import { packageDiagnostic } from './package-diagnostics.mjs';

export function packageReportText(report, locale) {
  const fr = locale === 'fr';
  const state = value => fr ? ({ success: 'réussi', attention: 'à vérifier', error: 'erreur', review: 'à relire',
    review_required: 'revue requise', cancelled: 'annulé', validated: 'validé', yanked: 'retiré',
    unknown: 'inconnu', deprecated: 'déconseillé', reviewed: 'revu', draft: 'brouillon' })[value] ?? value : value;
  const direction = value => fr ? ({ add: 'ajout', keep: 'conservé', upgrade: 'mise à jour', downgrade: 'retour de version' })[value] ?? value : value;
  const plan = report.status === 'review_required' ? report : null;
  const lines = [report.command + ': ' + state(report.status), report.path ?? report.output ?? report.package ?? '',
    ...(report.previous ? [`${report.previous} -> ${report.version}`] : []), ...(report.notes ?? [])];
  for (const key of report.fingerprints ?? []) lines.push(`${key.id} (${key.status}) SHA-256 SPKI DER: ${key.sha256}`);
  if (plan) {
    for (const row of plan.roots ?? [{ name: plan.package, previous: plan.previous, version: plan.version, direction: plan.direction }]) {
      lines.push(`${row.name}: ${row.previous ?? 'absent'} -> ${row.version} (${direction(row.direction)})`);
    }
    for (const change of plan.changes ?? []) lines.push(`${change.name}: ${change.before?.version ?? 'absent'} -> ${change.after.version}`,
      `  ${change.before?.digest ?? 'absent'} -> ${change.after.digest}`);
    for (const resolution of plan.resolutions ?? []) for (const item of resolution.author_closure) {
      if (item.name === resolution.package) continue;
      const selected = plan.packages.find(pkg => pkg.name === item.name);
      lines.push(fr ? `${resolution.package} testé par l’auteur avec ${item.name}@${item.version} ; sélection ${selected?.version ?? 'absente'}`
        : `${resolution.package} tested by the author with ${item.name}@${item.version}; selected ${selected?.version ?? 'missing'}`);
    }
    for (const row of plan.constraints ?? []) lines.push(`${row.consumer} → ${row.dependency}: ${row.constraint}; ${fr ? 'sélection' : 'selected'} ${row.version}`);
    for (const change of plan.contract_changes ?? []) for (const key of ['required_secrets', 'required_capabilities', 'approval_policy', 'recommended_effect', 'configuration_schema']) {
      if (JSON.stringify(change.before?.[key]) !== JSON.stringify(change.after?.[key])) {
        lines.push(`${change.tool} ${key}: ${JSON.stringify(change.before?.[key] ?? null)} -> ${JSON.stringify(change.after?.[key] ?? null)}`);
      }
    }
    for (const handler of plan.handlers ?? []) lines.push(`${fr ? 'Handler modifié' : 'Changed handler'}: ${handler.tool} (${handler.before?.digest ?? 'absent'} -> ${handler.after?.digest ?? 'absent'})`);
  }
  for (const pkg of report.packages ?? []) {
    lines.push(`${pkg.name}@${pkg.version}${pkg.status ? (fr ? ' : ' : ': ') + state(pkg.status) : ''}`);
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) lines.push(fr
      ? `  Dépendance embarquée de ${pkg.name} : ${name}@${version} (version exacte de la fermeture, pas une sélection de dernière version).`
      : `  Bundled dependency of ${pkg.name}: ${name}@${version} (exact closure version, not a latest-version selection).`);
    if (pkg.restrictions?.length) {
      for (const restriction of pkg.restrictions) lines.push(`  ${packageDiagnostic({ code: restriction.code }, locale) || restriction.code}${restriction.module ? ': ' + restriction.module : ''}`);
      if (pkg.restrictions.some(item => item.code === 'PackageInstalledContentMissing')) lines.push(fr ? `  Dossier manquant. Restaurez la version verrouillée avec touba package restore ${pkg.name}.` : `  Missing directory. Restore the locked version with touba package restore ${pkg.name}.`);
      else lines.push(fr ? `  Installation historique non admissible. Retirez-la avec touba package remove ${pkg.name}, puis revoyez les imports et préparez le projet.`
        : `  Historical installation is not admissible. Use touba package remove ${pkg.name}, then review imports and prepare the project.`);
    }
  }
  lines.push(report.stdout ?? '', report.stderr ?? '');
  return lines.filter(Boolean).join('\n');
}
