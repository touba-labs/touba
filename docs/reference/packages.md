# Référence des packages

## Modules hôtes partagés

Un package peut distribuer un adaptateur d'attestation ou de décision dans
`hosts`. Chaque entrée possède un `id` unique, un `kind` et un `path` :
`human_approval` ou `decision_provider`, avec un fichier JS ou Python.
Un package exclusivement hôte peut déclarer `exports: {}`.

```json title="Champs du manifeste"
{
  "hosts": [
    { "id": "approval", "kind": "human_approval", "path": "host/approval.mjs" },
    { "id": "decision", "kind": "decision_provider", "path": "host/decision.py" }
  ],
  "files": ["host"]
}
```

Le projet active un module par `pkg:organisation.package/identifiant`,
dans `--human-approval-host` ou `--agent-decision-provider`.
Touba vérifie l'inventaire de tous les packages installés avant son chargement.
Les fichiers auxiliaires doivent figurer dans `files` ; les bibliothèques JS
ou Python sont installées explicitement dans l'environnement de l'application.
Le module hôte fait partie du code de confiance de cette application.
Après remplacement d'un package déjà chargé, redémarrez l'hôte.

Les handlers Python proposés utilisent le Python de `.venv` du projet
consommateur lorsqu'il existe. Touba évite l'écriture de bytecode pendant leur
exécution. Pour vos tests Python lancés séparément, utilisez `python -B`.
Un cache ajouté dans `packages/` reste un fichier non déclaré : vérifiez son
origine et réinstallez une copie validée, sans modifier le lock pour l'accepter.

Les grants contrôlent l'admission des opérations Touba. Le confinement du
processus hôte se configure séparément avec la politique de sandbox.


Le manifeste auteur unique est `touba.package.json`, schéma
`touba-package-v1`. Une procédure contextuelle et un agent réutilisable utilisent
le même format de distribution. Les imports `.tb` restent typés.


## Commandes

| Commande | Effet |
| --- | --- |
| `touba package new` | Questionnaire et confirmation avant création |
| `touba package new "Gestion factures" --org "Atelier Nord" --yes` | Crée `gestion-factures/`, identité `atelier-nord.gestion-factures` |
| `touba package check [dossier]` | Validation réelle, sans exécution des tests ; `--publishing` exige les métadonnées de partage |
| `touba package test [dossier]` | Exécution explicite des tests Node déclarés ; variables supplémentaires par `--env NOM` |
| `touba package version patch` | Version strictement croissante ; accepte aussi `minor`, `major`, une version exacte |
| `touba package pack [dossier]` | Archive `dist/<nom>-<version>.tar.gz` ; `--output` facultatif, aucun écrasement |
| `touba package add <nom\|dossier\|archive>` | Installation verrouillée ; un nom seul désigne le dossier copié dans `packages/` |
| `touba package add org.nom@1.0.0 --registry <source>` | Version exacte depuis un registry choisi |
| `touba package publish [dossier] --registry <dossier>` | Publication statique locale en draft, sans écrasement ni exécution |
| `touba package list` | Liste et vérifie les dépendances enregistrées |
| `touba package remove org.nom` | Retire une dépendance non requise par une autre |

Toutes acceptent `--json` et `--root`. La racine est découverte depuis les
sous-dossiers ; pour `new`, `--root` est le parent du nouveau dossier. Sans cible,
`check` vérifie le package auteur courant ou les dépendances d'une application.
Code de sortie : `0` réussite, `1` test échoué/absent ou création annulée, `2`
erreur de contrat/arguments. Check/add/pack/checkout n’exécutent aucun code auteur.
Le service exécute les tests isolés lors de submit et de la publication distante.
`add --allow-draft` accepte explicitement une version draft du registry choisi.
Un nom d'organisation local n'atteste ni disponibilité ni propriété publique.

### Champs du manifeste

| Champ | Exigence |
| --- | --- |
| `package_schema_version` | `touba-package-v1` |
| `name` | Identifiant qualifié en minuscules : `acme.billing` |
| `version` | SemVer exacte, par exemple `1.2.0` |
| `touba.air_profile` | `touba-air-json-canonical-v1` |
| `touba.runtime_compatibility` | Plage SemVer, effectivement vérifiée |
| `exports` | Objet ; listes `types`, `defines`, `functions`, `tools`, `skills`, `agents`, `strategies`, `memories` |
| `contexts` | Procédures contextuelles ; optionnel |
| `dependencies` | Noms de packages vers versions exactes ; optionnel |
| `files` | Fichiers/dossiers relatifs à inclure ; sinon `src` pour du code |
| `handlers` | Implémentations proposées, sans binding ni grant effectif |
| `engines` | Plage `node`, liste `platforms` ; optionnel |
| `description`, `publisher`, `license` | Obligatoires pour préparer l’archive avec `pack` |
| `readme` | README inclus dans l’archive ; requis pour publier directement en CLI. Le service de publication peut accepter une présentation renseignée séparément. |
| `contract_tests` | Fichiers Node `.test.mjs`, `.test.cjs`, `.test.js` ; exécutés uniquement par `package test` |
| `root` | Facultatif ; uniquement `.` |
| `provenance` | Métadonnées `kind`, `source`, `revision` ; non signées |

Au moins un export ou un contexte est requis. Une référence exportée doit
exister réellement. Par exemple `skill:acme.billing/PrepareInvoice` est
déclarée dans `src/acme/billing.tb`. Les constantes de `exports.defines`
utilisent le préfixe `constant:`.

## Contexte

```json title="Entrée dans contexts"
{
  "id": "review",
  "description": "Review supplied material against explicit criteria.",
  "procedure": "SKILL.md",
  "activation": { "model_invocable": true, "user_invocable": true },
  "resources": [
    { "name": "checklist", "path": "resources/checklist.md", "kind": "reference",
      "description": "Acceptance checklist", "loadable_as_context": true }
  ],
  "execution_links": []
}
```

La procédure Markdown est non vide. Les ressources ont un nom unique, un
chemin, un type et une description. Types : `procedure`, `reference`,
`example`, `template`, `sample`, `script`, `fixture`.
Un script ne peut pas être chargé ou exécuté comme contexte.
Un lien d'exécution porte `label`, `target_ref` et `description` ; il
désigne un tool ou une skill, sans l'autoriser.

Sélection : `--skill-pack packages/acme.review#review`.
Activation : `--activate-skill-pack skill_pack:acme.review/review`.
Le protocole interne `touba-skill-pack-v1` est produit par Touba ; l'auteur
ne maintient pas un deuxième manifeste.

## Handler proposé

```json title="Entrée dans handlers"
{
  "tool": "tool:acme.billing/ReadInvoice",
  "path": "handlers/read_invoice.mjs",
  "protocol": "touba-tool-handler-v1",
  "documentation": "README.md"
}
```

Le tool doit être déclaré. `configuration`, facultatif, désigne un fichier
décrivant la configuration. La CLI vérifie son inclusion, pas la disponibilité
du service métier. Le projet choisit le binding process, ses grants, ses
secrets, son contrat d'effet et ses limites.

Après revue, sélectionnez une proposition affichée par `prepare` dans les
décisions hôte :

```json title="Extrait de décisions hôte"
{ "bindings": { "tool:acme.billing/ReadInvoice": {
  "package_handler": "acme.billing"
} } }
```

Cette sélection configure seulement le processus (`node` pour JS, Python de
`.venv` si présent, sinon `python3`) et évite un stub inutilisé. Elle n'accorde aucun grant, secret ou
effet. Les autres formats demandent un binding explicite ; un handler existant
n'est jamais supprimé automatiquement.

## Vérifications et diagnostics

`touba package check --json` conserve les erreurs source sous forme d'objets
dans `diagnostics` : `code`, `message`, `severity`, `source_path` et
`source_ref` lorsqu'ils sont disponibles. Le code global est
`PackageSourceInvalid`. Les indices de ligne et colonne JSON commencent à
zéro ; l'affichage terminal commence à un. La compilation invalide est
signalée avant les exports, pour éviter une cascade de faux exports absents.

Les chemins sont relatifs et confinés ; liens symboliques et liens durs dans
les archives, fichiers spéciaux, chemins sortants et collisions sont refusés.
Les fichiers secrets usuels et `node_modules` ne sont pas distribuables.
Limites : 4 096 fichiers/entrées, 16 Mio par fichier, 64 Mio de contenu,
1 Mio pour le manifeste et profondeur 32. Une fermeture contient au plus
128 packages. Aucune commande fournie par un package ne s'exécute à l'installation.

| Diagnostic | Action |
| --- | --- |
| `PackageDependencyMissing` | Fournir la dépendance exacte |
| `PackageDependencyConflict` | Résoudre le conflit de versions/contenus |
| `PackageDependencyCycle` | Supprimer le cycle |
| `PackageIntegrityMismatch` | Comparer au package et au lock approuvés ; ne pas accepter aveuglément le changement |
| `PackageNotInstalled` | Valider et enregistrer avec `package add` |
| `PackageRequirementMissing` | Fournir l'environnement hôte déclaré |
| `PackageExportUnknownRef` | Corriger l'export ou sa déclaration |
| `PackageAuthorityFieldForbidden` | Configurer les autorisations dans le projet |
| `PackageInstallationIncomplete` | Examiner la transaction interrompue avant récupération |

Le lock d'installation ne remplace pas la [supply chain d'exécution](../guides/supply-chain-handlers.md).
Voir le [guide auteur et consommateur](../guides/creer-partager-package.md).

## Brouillons privés

| Commande | Résultat |
| --- | --- |
| `touba package submit [dossier] --registry <URL>` | Archive vérifiée et soumise comme brouillon privé |
| `touba package checkout <identifiant> --registry <URL> [--root <parent>]` | Nouveau dossier auteur, nommé comme le package |
| `touba package submit [dossier] [--draft <identifiant>]` | Resoumission vers le brouillon lié ou explicitement choisi |
| `touba package submit [dossier] --ci <autorisation> --registry <URL>` | Nouveau brouillon depuis un job GitHub Actions autorisé |

Les commandes interactives acceptent `--no-browser` et `--json`. L’identité est confirmée
dans le navigateur à chaque opération. Le service exige l’authentification
renforcée pour ces opérations CLI. `checkout` contrôle l’accès privé et
l’intégrité avant extraction ; `submit` applique les validations et tests
isolés du service. La publication reste une action explicite.

Le mode `--ci` utilise OIDC GitHub avec `id-token: write`. Son autorisation
est liée au dépôt GitHub, au workflow, à la branche et à l'environnement. Elle prépare uniquement
un nouveau brouillon, sans lien local ni remplacement automatique. La publication
finale exige une personne habilitée et une authentification forte dans le service.
`--draft` et `--no-browser` ne s’utilisent pas avec `--ci`.

Le lien local `.touba/package-draft.json` est exclu de l’archive. Il contient
registre, identité/version, identifiant, révision et empreinte, sans jeton.
Une modification de présentation distante est conservée à la resoumission.
Un changement d’archive ou une révision concurrente interrompt le remplacement.

| Diagnostic | Action |
| --- | --- |
| `PackageAlreadyExists` | Choisir un parent sans dossier portant le nom du package |
| `PackageDraftConflict` | Relire le brouillon distant avant de resoumettre |
| `PackageDraftTargetMismatch` | Vérifier registre, identité et version de la cible |
| `PackageDraftIntegrityMismatch` | Faire vérifier l’archive par l’opérateur |
| `PackageDraftBusy` | Vérifier l’opération active avant toute récupération du verrou |
| `PackageOperationCancelled` | Consulter le brouillon avant une nouvelle tentative |
| `PackageDraftRefused` | Vérifier session, droits et diagnostic renvoyé par le service |

## Registre distant signé

La même archive peut être publiée vers un service compatible :

```sh
touba package publish --registry https://registry.example.org/registry
```

Le navigateur confirme le compte, le second facteur et l'autorisation du
terminal. Le service vérifie l'espace de publication, l'archive et ses tests
isolés. `--no-browser` affiche le lien à ouvrir manuellement. Les identifiants
de publication restent en mémoire pour cette opération.

Pour installer une version publiée, obtenez le fichier de confiance auprès
de l'opérateur du registre et vérifiez son empreinte par un canal de confiance :

```sh
touba package add acme.review@1.0.0 \
  --registry https://registry.example.org/registry \
  --trust registry-trust.json
```

Si le registre est privé, la commande ouvre le navigateur pour autoriser sa
lecture. `--no-browser` affiche le lien à ouvrir vous-même. Ce consentement
permet de consulter le catalogue et de télécharger les packages publiés ;
il ne permet pas de publier. Le jeton reste en mémoire pendant l'installation
et sa révocation est demandée à la fin, y compris en cas d'échec.
L'authentification et le fichier de confiance sont deux contrôles distincts.

L'index signé lie le registre à ses versions et empreintes. Une signature
invalide, une clé inconnue ou révoquée, un index expiré et une version retirée
interrompent l'installation. Les permissions d'exécution restent celles du
projet consommateur. Les commandes sont identiques pour les handlers
JavaScript et Python. L'adresse ci-dessus illustre un registre compatible ;
elle ne désigne pas un service public Touba ouvert.

La CLI conserve la dernière révision acceptée et les clés déjà vues dans
`registry-trust.json.sqlite`, à côté du fichier de confiance choisi. Gardez
ces deux fichiers ensemble. Une révision plus ancienne, un contenu différent
à révision identique ou une clé révoquée interrompent la commande. Pour une
rotation, l'opérateur fournit d'abord un fichier avec les deux clés actives,
puis retire ou révoque l'ancienne. Une révocation observée reste effective
après restauration d'un ancien fichier de confiance.

Déplacer le fichier de confiance sans son état SQLite démarre un nouvel
amorçage. Le premier accès s'appuie sur la clé vérifiée et la validité de la
signature ; sauvegarder l'état conserve ensuite la protection anti-retour arrière.


`touba package check archive.tar.gz --publishing` vérifie directement une
archive sans l'installer ni exécuter ses tests contributeur.

## Migrer un ancien contexte

La distribution utilise uniquement `touba.package.json`. Pour remplacer un
ancien `skill.json`, créez `touba package new acme.review --context --yes`,
reprenez la procédure dans `SKILL.md`, puis déclarez ressources et liens dans
`contexts`. Vérifiez avec `package check` avant `package add`. La commande
retirée `touba skill` indique ce parcours ; aucun ancien manifeste n'est chargé.

Les erreurs de `package ... --json` sont des objets JSON sur stdout, avec
`status: "error"`, `diagnostics[].code`, `message` et un code de sortie non nul.
Un fichier réservé à la place de `packages/` produit `PackageDirectoryRequired` ;
un lien produit `PackageSymlinkForbidden`. Une ressource absente donne
`PackageFileMissing`, avec son chemin relatif. `PackageExportMissing` concerne
un import non exporté, un module exporté absent de l'inventaire ou un package
sans export ni contexte ; `PackageExportUnknownRef` concerne un export
vers une déclaration absente.
