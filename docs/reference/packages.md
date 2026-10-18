# Référence des packages

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
erreur de contrat/arguments. Aucun test tiers n'est exécuté par check/add/pack/publish.
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
| `description`, `publisher`, `license`, `readme` | Obligatoires pour partager avec `pack` |
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

Cette sélection configure seulement le processus (`node` pour JS, `python3`
pour Python) et évite un stub inutilisé. Elle n'accorde aucun grant, secret ou
effet. Les autres formats demandent un binding explicite ; un handler existant
n'est jamais supprimé automatiquement.

## Vérifications et diagnostics

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
