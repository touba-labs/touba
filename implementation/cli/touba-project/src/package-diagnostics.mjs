// Human diagnostics; stable machine codes and source diagnostics stay intact.
import { PACKAGE_NAME, exactPackageVersion, packageError } from './package-contract.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { packageConflictDetails } from '../../../runtime/touba-handler-sdk/src/package-conflicts.mjs';

const localeContext = new AsyncLocalStorage();

export async function withPackageLocale(locale, callback) {
  if (locale !== undefined && !['fr', 'en'].includes(locale)) {
    throw packageError('PackageOptionInvalid', '--lang must be fr or en');
  }
  const selected = packageLocale(locale);
  return localeContext.run(selected, async () => {
    try { return await callback(); }
    catch (error) { error.packageLocale = selected; throw error; }
  });
}

const messages = {
  RegistrySharedConfigurationPresent: ['Ce projet utilise touba.registry.json. Relisez-le avec package registry --shared ; pour une commande ponctuelle, passez --registry et --trust explicitement.', 'This project uses touba.registry.json. Review it with package registry --shared; for one command, pass --registry and --trust explicitly.'],
  PackageInstalledContentMissing: ['Des fichiers du package verrouillé sont absents. Pour un dossier de package entièrement manquant, utilisez touba package restore avec son registre vérifié. Un dossier présent mais incomplet demande une récupération contrôlée ; aucun fichier modifié ne sera écrasé.', 'Locked package files are missing. For a completely absent package directory, use touba package restore with its verified registry. A present but incomplete directory needs controlled recovery; modified files will not be overwritten.'],
  RegistryUnavailable: ['Le registre est injoignable. Vérifiez son adresse, votre connexion et sa disponibilité, puis réessayez.', 'The registry is unreachable. Check its address, your connection and its availability, then retry.'],
  RegistryTimeout: ['Le registre n’a pas répondu dans les 20 secondes. Réessayez lorsque le service est disponible.', 'The registry did not respond within 20 seconds. Retry when the service is available.'],
  RegistryRequestCancelled: ['La lecture du registre a été annulée.', 'The registry read was cancelled.'],
  RegistryFetchFailed: ['Le registre a refusé la lecture. Vérifiez sa disponibilité et vos droits d’accès.', 'The registry refused the read. Check its availability and your access rights.'],
  RegistryTrustTargetMismatch: ['Ce fichier de confiance appartient à un autre registre. Sélectionnez les clés vérifiées pour l’adresse choisie ; ne modifiez pas l’adresse dans le fichier de clés.', 'This trust file belongs to another registry. Select verified keys for the selected address; do not edit the address in the key file.'],
  RegistryPackageNotFound: ['Ce package est absent du catalogue vérifié. Vérifiez son nom exact avec touba package search.', 'This package is absent from the verified catalog. Check its exact name with touba package search.'],
  RegistryPackageVersionMissing: ['Cette version est absente du catalogue vérifié. Consultez touba package info <nom>, puis choisissez une version exacte.', 'This version is absent from the verified catalog. Use touba package info <name>, then select an exact version.'],
  PackageRegistryOptionMissing: ['Indiquez le nom canonique et la version exacte : touba package add acme.outils@1.0.0 --registry <adresse>.', 'Specify the canonical name and exact version: touba package add acme.tools@1.0.0 --registry <address>.'],
  PackageExactVersionRequired: ['Choisissez une version exacte, par exemple acme.outils@1.0.0. latest et les plages ne sélectionnent pas automatiquement une version à installer.', 'Select an exact version, for example acme.tools@1.0.0. latest and ranges do not automatically select a version to install.'],
  PackageInstallationIncomplete: ['Une installation est active ou a été interrompue. Attendez sa fin ; si elle a été interrompue, examinez .touba-package-installing avant toute récupération.', 'An installation is active or was interrupted. Wait for it to finish; if interrupted, inspect .touba-package-installing before recovery.'],
  PackageProjectChanged: ['Le projet ou son verrou a changé pendant l’opération. Attendez la fin de l’autre commande et relancez la vérification.', 'The project or its lock changed during the operation. Wait for the other command to finish and repeat verification.'],
  PackageNotInstalled: ['Ce package n’est pas installé dans le projet sélectionné. Vérifiez touba package list et le dossier --root.', 'This package is not installed in the selected project. Check touba package list and the --root directory.'],
  PackageIntegrityMismatch: ['Les fichiers installés diffèrent du verrou. Conservez les preuves et restaurez une copie vérifiée ; ne supprimez pas le verrou pour contourner ce refus.', 'Installed files differ from the lock. Preserve evidence and restore a verified copy; do not delete the lock to bypass this refusal.'],
  PackageSymlinkForbidden: ['Un lien est interdit dans les fichiers gérés. Conservez les preuves et restaurez une copie vérifiée sans lien.', 'A link is forbidden in managed files. Preserve evidence and restore a verified copy without links.'],
  PackageProjectRequired: ['Le dossier sélectionné est absent ou ne contient pas de projet Touba valide. Vérifiez --root ou placez-vous dans le projet.', 'The selected directory is missing or contains no valid Touba project. Check --root or enter the project directory.'],
  PackageAuthorRequired: ['Sélectionnez le dossier d’un projet auteur de package existant avec --root.', 'Select an existing package author project directory with --root.'],
  PackageNameInvalid: ['Utilisez des segments en minuscules, avec chiffres et tirets simples, séparés par des points. Les identités historiques ne sont pas renommées automatiquement.', 'Use lowercase segments with digits and single hyphens, separated by dots. Historical identities are not renamed automatically.'],
  PackageModuleConflict: ['Les modules de deux packages se chevauchent. Choisissez un seul propriétaire avant l’installation.', 'Two packages claim overlapping modules. Select one owner before installation.'],
  PackageModuleOwnershipMismatch: ['Un export est hors du module du package. Utilisez son nom canonique (tirets remplacés par des soulignements) ou un sous-module.', 'An export is outside the package module. Use its canonical name (hyphens replaced by underscores) or a submodule.'],
  PackageMetadataInvalid: ['Retirez les caractères de contrôle et les séparateurs invisibles des métadonnées et du README.', 'Remove control characters and hidden separators from metadata and the README.'],
  PackagePathInvalid: ['Le chemin est invalide. Utilisez un chemin relatif portable, sans remontée de dossier ni nom réservé.', 'Invalid path. Use a portable relative path without parent traversal or reserved names.'],
  PackageArchiveInvalid: ['Archive invalide. Recréez-la avec touba package pack après vérification du package.', 'Invalid archive. Check the package, then recreate it with touba package pack.'],
  RegistryTrustInvalid: ['Le fichier de confiance est absent, illisible ou invalide. Sélectionnez le fichier local vérifié avec --trust.', 'The trust file is missing, unreadable or invalid. Select the verified local file with --trust.'],
  space_not_found: ['Cet espace est absent ou inaccessible à votre compte. Vérifiez son identifiant et vos appartenances.', 'This space is missing or inaccessible to your account. Check its identifier and your memberships.'],
  PackageVersionConflict: ['Cette version est incompatible avec la sélection. Le contenu d’une version existante reste immuable.', 'This version conflicts with the selection. An existing version’s content remains immutable.'],
  package_version_immutable: ['Le contenu d’une version existante est immuable. Choisissez une nouvelle version.', 'An existing version’s content is immutable. Choose a new version.'],
  package_downgrade_review_required: ['Une dépendance plus ancienne est sélectionnée. Relisez le lot avec touba package update-set --allow-downgrade, puis confirmez son empreinte avec --accept.', 'An older dependency is selected. Review the set with touba package update-set --allow-downgrade, then confirm its digest with --accept.'],
  PackageCreationCancelled: ['Création annulée. Aucun fichier modifié.', 'Creation cancelled. No files were changed.'],
  PackageInputInvalid: ['Choisissez executable ou context. Aucun fichier créé.', 'Choose executable or context. No files were created.'],
  PackageFileMissing: ['Une ressource déclarée dans le manifeste du package est absente. Vérifiez les chemins et les fichiers avant de recréer l’archive.', 'A declared package resource is missing. Check manifest paths and files before creating the archive again.'],
  PackageDraftReplaced: ['Ce brouillon a été remplacé. Relisez le nouveau brouillon et sélectionnez-le explicitement. Aucune archive soumise.', 'This draft was replaced. Review the new draft and select it explicitly. No archive was submitted.'],
  PackageInUse: ['Des contraintes de dépendances empêchent cette sélection. Relisez les consommateurs et choisissez leurs versions ensemble.', 'Dependency constraints prevent this selection. Review the consumers and select their versions together.'],
  PackageDependencyConflict: ['La sélection des dépendances est incompatible ou ambiguë. Sélectionnez explicitement les versions à revoir ensemble.', 'The dependency selection is incompatible or ambiguous. Explicitly select the versions to review together.'],
  HandlerConfigurationInvalid: ['Vérifiez les champs, types et limites du schéma de configuration du handler. Les valeurs restent dans la configuration d’hôte.', 'Check the handler configuration fields, types and limits. Values belong in the host configuration.'],
  HandlerConfigurationSchemaRequired: ['Sélectionnez le handler du package avec son schéma typé, ou déclarez le schéma dans votre fragment d’hôte.', 'Select the package handler with its typed schema, or declare the schema in your host fragment.'],
  HandlerConfigurationReviewRequired: ['Le handler change. Confirmez aussi les valeurs de configuration à lui transmettre.', 'The handler changed. Confirm the configuration values to pass to it as well.'],
  PackageHandlerConfigurationReviewRequired: ['Le schéma du handler a changé. Relisez-le puis sélectionnez ce handler et fournissez ses valeurs avec la décision d’hôte.', 'The handler schema changed. Review it, then select the handler and provide its values through the host decision.'],
  RegistryStatusCacheMissing: ['Aucun état signé en cache. Lancez touba package audit avec accès au registre.', 'No signed status is cached. Run touba package audit with access to the registry.'],
  RegistryStatusCacheInvalid: ['Le cache est invalide. Rafraîchissez-le avec touba package audit ; conservez le fichier de continuité de confiance.', 'The cache is invalid. Refresh it with touba package audit; preserve the trust continuity file.'],
  RegistryStatusCacheBusy: ['Une autre consultation modifie le cache. Réessayez après sa fin.', 'Another consultation is updating the cache. Retry when it finishes.'],
  RegistryStatusCacheStale: ['Le cache local est antérieur à la dernière révision vérifiée. Lancez touba package audit en ligne avec le même fichier de confiance.', 'The local cache predates the last verified revision. Run touba package audit online with the same trust file.'],
  RegistryStatusCacheUnavailable: ['La consultation hors ligne exige le cache d’un registre distant signé.', 'Offline status requires a cached signed remote registry.'],
  RegistryRollbackRefused: ['Le catalogue reçu est antérieur à la dernière révision vérifiée. Réessayez auprès du registre ; conservez le fichier de continuité de confiance.', 'The received catalog predates the last verified revision. Retry with the registry; preserve the trust continuity file.'],
  PackageReviewRequired: ['Prévisualisez le retour de version avec --allow-downgrade, puis acceptez son empreinte exacte avec --accept.', 'Preview the downgrade with --allow-downgrade, then accept its exact digest with --accept.'],
  PackageReviewChanged: ['L’empreinte acceptée ne correspond pas à la proposition actuelle. Relisez le plan et copiez son empreinte exacte ; le package, le projet ou la confiance peuvent avoir changé.', 'The accepted digest does not match the current proposal. Review the plan and copy its exact digest; the package, project or trust may have changed.'],
  RegistryPackageYanked: ['Cette version a été retirée. Choisissez une version disponible dans le catalogue.', 'This version was withdrawn. Choose an available version in the catalog.'],
  PackagePublicationTargetInvalid: ['Utilisez HTTPS ou l’origine locale exacte, avec 127.0.0.1 ou [::1]. Le nom localhost n’est pas accepté pour cette connexion.', 'Use HTTPS or the exact local origin with 127.0.0.1 or [::1]. The name localhost is not accepted for this connection.'],
  RegistryConfigurationRequired: ['Configurez le registre du projet : touba package registry <url> --trust <fichier-vérifié>.', 'Configure the project registry: touba package registry <url> --trust <reviewed-file>.'],
  RegistryVaultUnavailable: ['Le coffre système est indisponible. Déverrouillez-le ou utilisez --session-only pour cette opération.', 'The system credential vault is unavailable. Unlock it or use --session-only for this operation.'],
  RegistrySessionUnavailable: ['Ce registre ne permet pas de conserver une session. Utilisez --session-only pour cette opération.', 'This registry cannot retain a session. Use --session-only for this operation.'],
  RegistryLogoutIncomplete: ['La session locale est effacée. La révocation distante reste à confirmer depuis votre compte.', 'The local session is cleared. Confirm remote revocation from your account.'],
  RegistryConfigurationInvalid: ['Vérifiez la configuration du registre et le fichier local de clés, puis relancez touba package registry.', 'Check the registry configuration and local key file, then run touba package registry again.'],
  RegistryTrustRequired: ['Sélectionnez un fichier de clés vérifié avec --trust. Son empreinte doit être confirmée auprès de l’exploitant.', 'Select a verified key file with --trust. Confirm its fingerprint with the operator.'],
  RegistrySessionBusy: ['Une autre commande utilise cette session. Réessayez après sa fin.', 'Another command is using this session. Retry when it finishes.'],
  RegistrySessionExpired: ['La session temporaire a expiré. Relancez la commande et confirmez de nouveau votre identité ; les brouillons déjà reçus sont conservés.', 'The temporary session expired. Start the command again and confirm your identity; previously received drafts are preserved.'],
  publication_suspended: ['La publication de cet espace est suspendue. Contactez l’administration Touba.', 'Publication is suspended for this space. Contact Touba administration.'],
  package_namespace_mismatch: ['Le nom du package appartient à un autre espace. Sélectionnez cet espace ou corrigez le manifeste.', 'The package name belongs to another space. Select that space or correct the manifest.'],
  submission_rate_reached: ['La limite de soumissions est atteinte.', 'The submission limit has been reached.'],
  package_validator_busy: ['Le validateur est occupé. Votre soumission peut être réessayée.', 'The validator is busy. You can retry your submission.'],
  package_tests_failed: ['Les tests du package ont échoué. Relancez touba package test avant de soumettre.', 'Package tests failed. Run touba package test before submitting again.'],
  package_closure_required: ['Soumettez de nouveau l’archive avec le validateur actualisé pour vérifier ses dépendances.', 'Submit the archive again with the updated validator to verify its dependencies.'],
  package_dependencies_not_publishable: ['Publiez les dépendances exactes dans l’ordre ci-dessous avant ce package. Le brouillon est conservé.', 'Publish the exact dependencies in the order below before this package. The draft is preserved.'],
  package_validation_failed: ['L’archive est invalide. Lancez touba package check puis touba package pack.', 'The archive is invalid. Run touba package check, then touba package pack.'],
  package_validator_toolchain_mismatch: ['Le validateur doit être actualisé. Les tests de votre archive n’ont pas été exécutés.', 'The validator needs updating. Your archive tests were not executed.'],
  package_validation_timeout: ['La validation a dépassé sa durée maximale. Vérifiez la durée des tests.', 'Validation exceeded its time limit. Check test duration.'],
  publication_permission_required: ['Un rôle de propriétaire ou de mainteneur est requis dans cet espace.', 'An owner or maintainer role is required in this space.'],
  strong_authentication_required: ['Confirmez votre identité avec touba package login, puis réessayez.', 'Confirm your identity with touba package login, then retry.'],
  publication_authentication_required: ['La confirmation de votre identité a expiré ou a été refusée. Lancez touba package logout, puis touba package login et confirmez de nouveau votre identité.', 'Your identity confirmation expired or was refused. Run touba package logout, then touba package login and confirm your identity again.'],
  PackageDraftBusy: ['Une autre commande utilise ce brouillon. Attendez sa fin. Si elle a été interrompue, relancez la commande ; seul le verrou d’un processus disparu peut être récupéré.', 'Another command is using this draft. Wait for it to finish. If it was interrupted, retry; only a lock belonging to a departed process can be recovered.'],
  PackageDraftLockUnsafe: ['Le verrou du brouillon est illisible ou ne permet pas une récupération sûre. Vérifiez .touba/package-draft.lock et les processus actifs avant toute intervention.', 'The draft lock cannot be recovered safely. Inspect .touba/package-draft.lock and active processes before taking action.'],
  PackageAutomationRequestRequired: ['Ajoutez --request-id avec 16 à 100 lettres, chiffres, tirets ou traits de soulignement, sans point. Réutilisez cet identifiant uniquement pour la même requête.', 'Add --request-id with 16 to 100 letters, digits, hyphens or underscores, without dots. Reuse it only for the same request.'],
  PackageOptionInvalid: ['Option invalide pour cette commande. Consultez touba package --help et vérifiez les options et leurs valeurs.', 'Invalid option for this command. See touba package --help and check the options and their values.'],
  PackagePresentationReuseUnavailable: ['Ce registre ne propose pas encore la reprise de présentation par la CLI. Aucune archive n’a été soumise. Utilisez son interface pour ajouter une version.', 'This registry does not support CLI presentation reuse yet. No archive was submitted. Use its interface to add a version.'],
  presentation_source_invalid: ['Choisissez l’identifiant d’une version publiée pour une nouvelle soumission interactive.', 'Select a published version identifier for a new interactive submission.'],
  published_version_immutable: ['Cette version est déjà publiée. Préparez un nouveau numéro avec touba package version.', 'This version is already published. Prepare a new number with touba package version.'],
};

messages.package_module_conflict = ['Ce module est déjà réservé par un autre package publié. Demandez une revue de propriété au registre ; aucune installation locale ne libère cette réservation.', 'This module is already reserved by another published package. Request an ownership review from the registry; a local installation cannot release that claim.'];
messages.package_module_ownership_mismatch = messages.PackageModuleOwnershipMismatch;

function safeModuleClaims(value) {
  return Array.isArray(value) && value.length <= 2 && value.every(row =>
    typeof row?.package === 'string' && row.package.length <= 256 && PACKAGE_NAME.test(row.package)
    && typeof row.module === 'string' && row.module.length <= 256 && /^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)+$/.test(row.module))
    ? value.map(row => ({ package: row.package, module: row.module })) : [];
}

export function packageSessionNotice({ logout, persistent, read = false, minutes = 10 }, locale) {
  const fr = packageLocale(locale) === 'fr';
  if (logout) return fr ? 'Session du registre effacée.' : 'Registry session cleared.';
  if (!persistent) return fr ? 'Identité temporaire vérifiée puis révoquée. Utilisez login avec le coffre système pour conserver une session.' : 'Temporary identity verified and revoked. Use login with the system vault to retain a session.';
  if (read) return fr ? 'Session de lecture conservée dans le coffre système, pendant huit heures au maximum. Utilisez touba package logout --read pour vous déconnecter.' : 'Read session kept in the system credential vault for up to eight hours. Use touba package logout --read to disconnect.';
  return fr ? `Connexion conservée dans le coffre système. Nouvelle confirmation pour les opérations sensibles après ${minutes} minutes. Utilisez touba package logout pour vous déconnecter.` : `Connected using the system credential vault. Sensitive operations require confirmation again after ${minutes} minutes. Use touba package logout to disconnect.`;
}

export function retrySeconds(value, now = Date.now()) {
  if (!value) return null;
  const number = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - now) / 1000);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function publicationRefusal(code, result, fallback) {
  const reason = /^[a-z_]{1,80}$/.test(result.data?.error ?? '') ? result.data.error : fallback;
  const diagnostic = result.data?.diagnostic;
  // Only bounded machine identifiers cross the terminal boundary. Full private
  // test output remains available in the authenticated browser response.
  const details = ['package_tests_failed', 'package_validation_failed'].includes(reason)
    && diagnostic && ['inspection', 'tests'].includes(diagnostic.phase)
    && typeof diagnostic.code === 'string' && /^[A-Z][A-Za-z0-9]{1,79}$/.test(diagnostic.code)
    ? [{ code: diagnostic.code, phase: diagnostic.phase, message: reason }] : undefined;
  const dependencies = reason === 'package_dependencies_not_publishable' && diagnostic?.phase === 'dependencies'
    && diagnostic.code === reason && Array.isArray(diagnostic.dependencies) && diagnostic.dependencies.length < 128
    && diagnostic.dependencies.every(item => item && typeof item.name === 'string' && item.name.length <= 256 && PACKAGE_NAME.test(item.name)
      && typeof item.version === 'string' && item.version.length <= 128 && exactPackageVersion(item.version)
      && ['not_available', 'revalidation_required', 'content_mismatch'].includes(item.reason))
    ? diagnostic.dependencies.map(({ name, version, reason }) => ({ name, version, reason })) : undefined;
  const moduleClaims = reason === 'package_module_conflict' && diagnostic?.phase === 'ownership' && diagnostic.code === 'PackageModuleConflict'
    ? safeModuleClaims(diagnostic.claims) : [];
  return Object.assign(packageError(code, reason), { reason, diagnostics: details, dependencies, moduleClaims, retryAfter: retrySeconds(result.headers?.get('retry-after')) });
}

export function packageLocale(locale) {
  locale ??= localeContext.getStore() ?? (process.env.TOUBA_LOCALE || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || 'en');
  return /^fr(?:$|[-_.])/i.test(locale) ? 'fr' : 'en';
}

export function packageDiagnostic(error, locale) {
  const fr = packageLocale(locale ?? error.packageLocale) === 'fr';
  const underlying = error.reason === 'package_validation_failed' ? error.diagnostics?.[0]?.code : undefined;
  const message = messages[underlying] ?? messages[error.reason] ?? messages[error.code];
  if (!message) return error instanceof Error ? error.message : String(error);
  const delay = Number.isSafeInteger(error.retryAfter) && error.retryAfter >= 0
    ? (fr ? ` Réessayez dans ${error.retryAfter} s.` : ` Retry in ${error.retryAfter} s.`) : '';
  const details = error.diagnostics?.length ? ` [${error.diagnostics[0].phase}: ${error.diagnostics[0].code}]` : '';
  const http = Number.isInteger(error.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599 ? ` HTTP ${error.httpStatus}.` : '';
  const issue = error.publicTextIssue;
  const publicText = issue && ['description', 'publisher', 'license', 'readme'].includes(issue.field)
    && /^U\+[0-9A-F]{4,6}$/.test(issue.codepoint ?? '') && Number.isSafeInteger(issue.position) && issue.position > 0
    ? ` ${issue.field}: ${issue.codepoint}, position ${issue.position}.` : '';
  const withdrawal = error.code === 'RegistryPackageYanked' && typeof error.withdrawalReason === 'string' && [...error.withdrawalReason].length <= 500
    ? ` ${fr ? 'Motif' : 'Reason'} : ${error.withdrawalReason.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')}` : '';
  const reasons = fr ? { not_available: 'version publiée indisponible', revalidation_required: 'revérification par l’exploitant requise', content_mismatch: 'contenu différent de la version publiée' }
    : { not_available: 'published version unavailable', revalidation_required: 'operator revalidation required', content_mismatch: 'content differs from the published version' };
  const dependencies = error.dependencies?.map(item => `\n  ${item.name}@${item.version}: ${reasons[item.reason]}`).join('') ?? '';
  const conflicts = packageConflictDetails(error.constraints)?.map(row => `\n  ${row.blocking === true ? (fr ? '[bloquant] ' : '[blocking] ') : row.blocking === false ? '[compatible] ' : ''}${row.consumer}${row.origin ? ` (${(fr ? { selected: 'sélectionné', installed: 'installé', author: 'projet auteur' } : { selected: 'selected', installed: 'installed', author: 'author project' })[row.origin]})` : ''} → ${row.dependency}: ${row.constraint}; ${fr ? 'sélection' : 'selected'} ${row.version ?? (fr ? 'absente' : 'missing')}${row.current_version !== undefined ? `; ${fr ? 'actuelle' : 'current'} ${row.current_version ?? (fr ? 'absente' : 'missing')}` : ''}`).join('') ?? '';
  const replacement = error.code === 'PackageDraftReplaced' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(error.replacementId ?? '')
    ? ` --draft ${error.replacementId}` : '';
  const claims = safeModuleClaims(error.moduleClaims).map(row => `\n  ${row.package}: ${row.module}`).join('');
  const identity = typeof error.packageName === 'string' && error.packageName.length <= 256 && PACKAGE_NAME.test(error.packageName)
    ? ` ${error.packageName}.` : '';
  const recovery = error.installedPackageContext === true && ['PackageNameInvalid', 'PackageModuleOwnershipMismatch', 'PackageMetadataInvalid'].includes(error.code)
    ? (fr ? ' Pour une installation historique, utilisez package list ou package audit, puis package remove avec son nom exact.' : ' For a historical installation, use package list or package audit, then package remove with its exact name.') : '';
  return `${error.code}: ${message[fr ? 0 : 1]}${identity}${http}${publicText}${delay}${details}${withdrawal}${dependencies}${conflicts}${replacement}${claims}${recovery}`;
}
