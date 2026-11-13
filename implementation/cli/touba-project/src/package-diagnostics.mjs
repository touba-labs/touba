// Human diagnostics; stable machine codes and source diagnostics stay intact.
import { packageError } from './package-contract.mjs';

const messages = {
  RegistryPackageYanked: ['Cette version a été retirée. Choisissez une version disponible dans le catalogue.', 'This version was withdrawn. Choose an available version in the catalog.'],
  PackagePublicationTargetInvalid: ['Utilisez HTTPS ou l’origine locale exacte, avec 127.0.0.1 ou [::1]. Le nom localhost n’est pas accepté pour cette connexion.', 'Use HTTPS or the exact local origin with 127.0.0.1 or [::1]. The name localhost is not accepted for this connection.'],
  RegistryConfigurationRequired: ['Configurez le registre du projet : touba package registry <url> --trust <fichier-vérifié>.', 'Configure the project registry: touba package registry <url> --trust <reviewed-file>.'],
  RegistryVaultUnavailable: ['Le coffre système est indisponible. Déverrouillez-le ou utilisez --session-only pour cette opération.', 'The system credential vault is unavailable. Unlock it or use --session-only for this operation.'],
  RegistrySessionUnavailable: ['Ce registre ne permet pas de conserver une session. Utilisez --session-only pour cette opération.', 'This registry cannot retain a session. Use --session-only for this operation.'],
  RegistryLogoutIncomplete: ['La session locale est effacée. La révocation distante reste à confirmer depuis votre compte.', 'The local session is cleared. Confirm remote revocation from your account.'],
  RegistryConfigurationInvalid: ['Vérifiez la configuration du registre et le fichier local de clés, puis relancez touba package registry.', 'Check the registry configuration and local key file, then run touba package registry again.'],
  RegistryTrustRequired: ['Sélectionnez un fichier de clés vérifié avec --trust. Son empreinte doit être confirmée auprès de l’exploitant.', 'Select a verified key file with --trust. Confirm its fingerprint with the operator.'],
  RegistrySessionBusy: ['Une autre commande utilise cette session. Réessayez après sa fin.', 'Another command is using this session. Retry when it finishes.'],
  publication_suspended: ['La publication de cet espace est suspendue. Contactez l’administration Touba.', 'Publication is suspended for this space. Contact Touba administration.'],
  package_namespace_mismatch: ['Le nom du package appartient à un autre espace. Sélectionnez cet espace ou corrigez le manifeste.', 'The package name belongs to another space. Select that space or correct the manifest.'],
  submission_rate_reached: ['La limite de soumissions est atteinte.', 'The submission limit has been reached.'],
  package_validator_busy: ['Le validateur est occupé. Votre soumission peut être réessayée.', 'The validator is busy. You can retry your submission.'],
  publication_permission_required: ['Un rôle de propriétaire ou de mainteneur est requis dans cet espace.', 'An owner or maintainer role is required in this space.'],
  strong_authentication_required: ['Confirmez votre identité avec touba package login, puis réessayez.', 'Confirm your identity with touba package login, then retry.'],
  published_version_immutable: ['Cette version est déjà publiée. Préparez un nouveau numéro avec touba package version.', 'This version is already published. Prepare a new number with touba package version.'],
};

export function retrySeconds(value, now = Date.now()) {
  if (!value) return null;
  const number = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - now) / 1000);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function publicationRefusal(code, result, fallback) {
  const reason = /^[a-z_]{1,80}$/.test(result.data?.error ?? '') ? result.data.error : fallback;
  return Object.assign(packageError(code, reason), { reason, retryAfter: retrySeconds(result.headers?.get('retry-after')) });
}

export function packageLocale(locale) {
  locale ??= process.env.TOUBA_LOCALE || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || 'en';
  return /^fr(?:$|[-_.])/i.test(locale) ? 'fr' : 'en';
}

export function packageDiagnostic(error, locale) {
  const fr = packageLocale(locale) === 'fr';
  const message = messages[error.reason] ?? messages[error.code];
  if (!message) return error instanceof Error ? error.message : String(error);
  const delay = Number.isSafeInteger(error.retryAfter) && error.retryAfter >= 0
    ? (fr ? ` Réessayez dans ${error.retryAfter} s.` : ` Retry in ${error.retryAfter} s.`) : '';
  return `${error.code}: ${message[fr ? 0 : 1]}${delay}`;
}
