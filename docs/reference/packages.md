# Référence des packages

## Texte public des packages

Les métadonnées de présentation et le README refusent les caractères de
contrôle, les changements invisibles de direction, les fillers invisibles et
les caractères Unicode TAG qui peuvent dissimuler du texte. Les séparateurs
U+2028 et U+2029 sont également refusés : utilisez les retours à la ligne
ordinaires dans les descriptions et le Markdown. Les scripts RTL ordinaires,
les accents, les jointures ZWJ/ZWNJ et les emoji courants restent utilisables.
Les emoji construits avec des caractères TAG sont concernés par ce refus.

La politique couvre la propriété Unicode 17.0 `Default_Ignorable_Code_Point`.
Les jointures et sélecteurs de variante ne sont admis que dans leur contexte
linguistique ou graphique prévu : une suite de sélecteurs derrière un emoji
est refusée. Un nom composé uniquement de blancs Braille est également refusé.
Les diagnostics indiquent le champ et le point de code, sans restituer le texte
caché. Une position désigne un point de code Unicode, à partir de 1.

Corrigez le texte du projet auteur puis recréez son archive. Une archive déjà
publiée conserve ses octets et son empreinte. Pour une ancienne installation
refusée, utilisez le [parcours de récupération](../guides/recuperer-package-historique.md).
Cette règle de présentation ne remplace ni la vérification d'intégrité ni les
contrôles de gouvernance ; elle ne certifie pas qu'un texte visible est fiable.

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
`touba-package-v1` pour les dépendances exactes, ou `touba-package-v2` pour les
plages déclarées. Une procédure contextuelle et un agent réutilisable utilisent
le même format de distribution. Les imports `.tb` restent typés.

## Dépendances compatibles, résolution exacte

Dans un package auteur, installez d'abord la version exacte testée de la dépendance.
Pour permettre son évolution chez les consommateurs, sélectionnez ensuite
`"package_schema_version": "touba-package-v2"` et déclarez votre contrainte :

```json
{
  "dependencies": { "acme.base": ">=1.0.0 <2.0.0" }
}
```

La plage affirme la compatibilité choisie par l'auteur. Testez les versions
que vous annoncez compatibles ; Touba vérifie la contrainte, pas l'ensemble du
comportement métier. Le verrou et l'archive retiennent toujours les versions
exactes et les empreintes de tous les fichiers. Ils restent à versionner.
Les lecteurs antérieurs refusent le nouveau schéma explicitement.

Une contrainte est une version exacte ou une conjonction d'au plus huit
comparateurs `=`, `>`, `>=`, `<`, `<=`, séparés par une espace et suivis d'une
version complète. Les raccourcis `^`, `~`, `*`, les alternatives `||` et les
versions partielles ne sont pas acceptés. Une préversion exige un comparateur
qui la vise explicitement avec le même triplet majeur/mineur/correctif.
Les pins exacts conservent aussi leur suffixe de build exact.

`package update` revoit le candidat fourni et sa fermeture. Un changement de
dépendance embarquée apparaît dans `changes` et les contraintes des consommateurs
dans `constraints` avec `--json`. Une revue acceptée remplace l'ensemble en une
transaction ; les autres packages gardent leurs octets. Une contrainte installée
incompatible refuse l'opération dès l'aperçu. Même nom et même version avec
d'autres fichiers, revue périmée et préversion non admise restent refusés.
L'application conserve ses exigences de gouvernance et prépare ensuite le projet.

Touba ne choisit aucune « dernière version » et n'effectue aucun téléchargement
implicite pour résoudre une plage. Fournissez une archive fermée ou un candidat
exact depuis votre registre de confiance. Une seule version par nom est admise.
Pour plusieurs racines indépendantes, préparez `updates.json` :

```json
{
  "schema_version": "touba-package-update-set-v1",
  "packages": [
    { "path": "../shared" },
    { "path": "../billing-1.2.0.tar.gz" },
    { "name": "acme.rules", "version": "1.3.0", "registry": "https://packages.example/registry", "trust": "registry-trust.json" }
  ]
}
```

Les chemins sont relatifs au fichier de sélection. Chaque cible doit déjà être
installée. Jusqu'à 32 sources explicites peuvent former une fermeture de
128 packages au maximum, dans les limites de taille des packages. Un registre
HTTP est vérifié avec sa propre confiance locale, sa signature et les octets
exacts de l'archive. Une source locale reste une sélection explicite de fichiers.

```sh
touba package update-set updates.json --json
touba package update-set updates.json --accept <review_digest>
```

Les racines, leurs origines, contraintes et changements sont revus ensemble.
Deux dépendances embarquées différentes sont refusées, sauf si leur remplacement
exact est lui-même sélectionné comme racine et satisfait tous les consommateurs.
La sélection n'infère aucune compatibilité. La confirmation revérifie la confiance,
les archives et le workspace ; aucun handler ne s'exécute pendant l'installation.
Un échec de la transaction restaure l'ensemble remplacé. Une interruption du
processus laisse un marqueur de transaction qui bloque l'utilisation avant examen.


## Configuration d'un handler

Le champ `handlers[].configuration` du package désigne un fichier inventorié.
Pour recevoir des réglages, ce fichier décrit les champs attendus :

```json
{
  "schema_version": "touba-handler-configuration-v1",
  "fields": {
    "endpoint": { "type": "string", "required": true, "max_bytes": 2048 },
    "region": { "type": "string" },
    "retries": { "type": "integer", "min": 0, "max": 5 }
  }
}
```

L'application fournit les valeurs dans une décision d'hôte revue :

```json
{
  "bindings": {
    "tool:acme.connector/Read": {
      "package_handler": "acme.connector",
      "configuration": { "endpoint": "https://example.invalid/api", "retries": 2 },
      "effect_contract": { "kind": "none" }
    }
  }
}
```

```sh
touba prepare --mode plan --host-decisions host-decisions.json
touba prepare --mode write --host-decisions host-decisions.json
touba prepare --mode check
```

Le handler accède à `context.configuration.endpoint` en JavaScript ou à
`context["configuration"]["endpoint"]` en Python. Un fragment explicite porte
`configuration: { "schema": ..., "values": ... }` dans le binding concerné.
Les types sont `string`, `boolean`, `integer` et `number`, sans valeur par défaut
implicite : 64 champs au plus, clés ASCII de 64 caractères, texte de 4 Kio par
champ et budget total de 16 Kio. Le budget réserve 32 octets par nombre pour
rester identique dans les deux SDK. Champs inconnus et valeurs invalides sont refusés.

Ces réglages ne deviennent ni des variables d'environnement, ni des droits,
ni des secrets. Les traces générales ne les recopient pas ; un handler qui les
retourne volontairement dans ses résultats peut toutefois les exposer.
Conservez les valeurs dans la configuration privée de l'application, pas dans
le package publié. Les identifiants secrets restent des secrets déclarés.

Un changement de schéma demande une nouvelle revue. Un changement de valeurs
invalide les anciennes approbations et la réutilisation d'un effet associé à
une autre configuration. Sélectionner explicitement un handler sans schéma
retire l'ancienne configuration dans le plan. Les anciens fichiers descriptifs
restent distribuables mais n'activent pas le transport de valeurs. Utilisez un
runtime et des SDK qui prennent en charge ce contrat ; un ancien SDK refuse
l'enveloppe enrichie. Sans configuration, l'enveloppe historique reste inchangée.

## Commandes

`package test` fournit le SDK JavaScript de sa toolchain aux tests déclarés,
y compris l'entrée `@touba/sdk/testing` pour vérifier les reçus. Le harnais
n'importe pas le SDK installé chez l'auteur, ne modifie pas son dossier et
n'effectue aucun téléchargement. Les tests locaux restent du code hôte à isoler.
`PackageTestSdkInvalid` signale une incohérence du SDK de la toolchain ; utilisez
une distribution complète de Touba. Installer un autre SDK chez l'auteur ne
corrige pas ce défaut de distribution.

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
| `touba package submit-suite suite.json --registry <url>` | Soumet un lot explicite de projets auteurs, séquentiellement, sous forme de brouillons privés |
| `touba package list` | Liste et vérifie les dépendances enregistrées |
| `touba package list --status` | Ajoute les états du cache signé et sa fraîcheur, sans accès réseau |
| `touba package audit` | Consulte explicitement le registre configuré pour les versions installées |
| `touba package audit --offline` | Relit le cache signé, en signalant son expiration éventuelle |
| `touba package update <archive\|nom@version>` | Prévisualise le remplacement ; `--accept <review_digest>` applique le plan exact |
| `touba package update <cible> --allow-downgrade` | Permet une revue explicite vers une version inférieure, sans annuler les effets passés |
| `touba package remove org.nom` | Retire une dépendance non requise par une autre |

Toutes acceptent `--json`, `--root` et `--lang fr` ou `--lang en`. La langue
explicite prime sur celle du terminal et accompagne la connexion par appareil.
Les motifs écrits par un éditeur restent dans leur langue d'origine.
La racine est découverte depuis les
sous-dossiers ; pour `new`, `--root` est le parent du nouveau dossier. Sans cible,
`check` vérifie le package auteur courant ou les dépendances d'une application.
Code de sortie : `0` réussite, `1` test échoué/absent ou création annulée, `2`
erreur de contrat/arguments. Check/add/pack/checkout n’exécutent aucun code auteur.
Pour `audit` et `list --status`, le code `1` signale aussi une version retirée,
dépréciée, inconnue ou un cache expiré. Une consultation échouée ne devient pas
une réussite hors ligne implicite. Une signature expirée reste refusée pour
l'installation, même si l'audit hors ligne permet de lire son ancien état.
`prepare` signale les retraits déjà connus dans ce cache et sa fraîcheur,
sans connexion réseau ni modification d'une exécution. Rafraîchissez l'état
explicitement avec `touba package audit`.
Un audit ponctuel avec `--registry` et `--trust` ne configure pas le projet.
Sélectionnez explicitement `touba package registry <url> --trust <fichier-vérifié>`
pour que `prepare` relise ce cache. Sans configuration, le statut de retrait
reste signalé comme non vérifié, et les packages locaux restent utilisables.
Le service exécute les tests isolés lors de submit et de la publication distante.
`add --allow-draft` accepte explicitement une version draft du registry choisi.
Un nom d'organisation local n'atteste ni disponibilité ni propriété publique.

### Soumettre plusieurs packages

Le fichier du lot contient les chemins relatifs des dossiers auteurs, par exemple
`["utilitaires", "facturation"]`. Chaque chemin reste sous son dossier parent.
La CLI vérifie toutes les archives, leurs dépendances verrouillées et leur taille
avant le premier envoi. Les dépendances présentes dans le lot précèdent leurs
consommateurs. Une même version doit désigner les mêmes fichiers partout.

Les limites par défaut sont 16 packages, 256 Mio d'archives et 15 minutes, avec
un seul envoi à la fois. `--max-packages`, `--max-bytes` et `--timeout-seconds`
permettent de les régler, jusqu'à 32 packages, 512 Mio et 30 minutes. Les limites
et quotas du registre continuent à s'appliquer indépendamment.

Le lot s'arrête au premier refus ou à l'annulation. Les brouillons déjà créés
restent disponibles ; le résultat donne chaque état et le délai de nouvel essai
reçu du serveur. Vérifiez une soumission interrompue dans le service avant de
relancer. À la reprise, une archive identique déjà qualifiée dans son brouillon
n'est pas renvoyée. Un brouillon non qualifié reste soumis à vérification.
Le lot ne publie aucune version et ne réessaie pas automatiquement.

### Ressources d'une dépendance depuis un handler

Les SDK proposent `resolvePackageResource` en JavaScript et
`resolve_package_resource` en Python. Le handler indique son propre manifeste,
le nom d'une dépendance déclarée et un fichier inventorié de cette dépendance :

```javascript
import { resolvePackageResource } from '@touba/sdk';
const schemaPath = resolvePackageResource(
  new URL('../touba.package.json', import.meta.url),
  'acme.schemas',
  'resources/invoice.json',
);
```

```python
from pathlib import Path
from touba_sdk import resolve_package_resource

schema_path = resolve_package_resource(
    Path(__file__).resolve().parent.parent / 'touba.package.json',
    'acme.schemas',
    'resources/invoice.json',
)
```

Ces exemples placent le handler dans `handlers/`. Le résolveur fonctionne dans
le dossier auteur, l'archive extraite et le consommateur installé, sans dépendre
du dossier courant ni rechercher un manifeste dans les parents. Il vérifie la
version verrouillée, les empreintes et l'inventaire avant de rendre un chemin.
Les liens symboliques, traversées, dépendances absentes et fichiers non inventoriés
sont refusés. Chaque résolution est bornée : 4 096 fichiers par package,
16 Mio par fichier et 64 Mio d'inventaire.

Le résolveur ne charge pas de code et n'accorde aucun droit. Sous confinement,
l'hôte doit autoriser séparément la lecture du verrou, des manifestes et des
fichiers vérifiés, via son inventaire `code_paths`. L'inventaire de fichiers ne
remplace pas les exports Touba ni les contrôles d'appel d'un outil. Pour invoquer
un outil exporté, utilisez les mécanismes gouvernés du langage ; ce helper sert
aux ressources et bibliothèques hôtes explicitement sélectionnées.

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

`effect_contract`, facultatif dans la proposition de handler, recommande le
contrat d'effet attendu : par exemple
`{"kind":"external_write","retry_mode":"reconcile"}`. Il est affiché par le
plan et suivi dans la revue des contrats du package. Il ne s'applique pas comme
permission ou binding de l'application. Une recommandation absente n'atteste pas
l'absence d'effet ; une permission réseau peut aussi servir une simple lecture.
Vérifiez les reçus avec `assertEffectReceipt` (`@touba/sdk/testing`) ou
`assert_effect_receipt` (`touba_sdk.testing`), puis testez le comportement du
service. Les anciens lecteurs refusent ce nouveau champ : indiquez dans
`runtime_compatibility` la plage du candidat réellement testé.

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

Les copies installées historiques peuvent être inspectées par `package list`
et `package audit`, puis retirées par leur nom exact avec `package remove`.
Les restrictions de nom, module ou présentation sont séparées du statut signé
du registre. Cette lecture conserve inventaire et empreintes ; elle n'autorise
pas leur compilation, admission ou exécution. Voir
[la récupération bilingue](../guides/recuperer-package-historique.md).

`touba package check --json` conserve les erreurs source sous forme d'objets
dans `diagnostics` : `code`, `message`, `severity`, `source_path` et
`source_ref` lorsqu'ils sont disponibles. Le code global est
`PackageSourceInvalid`. Les indices de ligne et colonne JSON commencent à
zéro ; l'affichage terminal commence à un. La compilation invalide est
signalée avant les exports, pour éviter une cascade de faux exports absents.

Pour une archive valide, `packages` décrit toute la fermeture : nom, version
résolue, empreinte de contenu et `dependencies` vers des versions exactes.
`archive_digest` identifie séparément l'archive compressée. Un service de
publication peut exiger que chaque dépendance soit déjà publiée avec ce contenu.
Les refus `package_dependencies_not_publishable` donnent les dépendances à
traiter dans l'ordre ; `package_closure_required` demande une nouvelle soumission
avec le validateur actualisé. Ils ne publient aucune dépendance automatiquement.

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
| `PackageLockDistributionConflict` | Retirer le verrou de `files`, puis empaqueter une nouvelle version |
| `PackageReviewChanged` | Relire la mise à jour ; l'archive ou le projet a changé |
| `PackageReviewRequired` | Prévisualiser le retour de version et accepter son empreinte exacte |
| `RegistryStatusCacheMissing` | Effectuer `touba package audit` avec accès au registre signé |
| `RegistryStatusCacheInvalid` | Rafraîchir le cache explicitement ; conserver la continuité de confiance |
| `RegistryStatusCacheBusy` | Réessayer après la consultation concurrente |
| `RegistryStatusCacheUnavailable` | Utiliser un registre distant signé pour la consultation de cache |
| `PackageEntrypointNotExported` | Choisir un export exécutable déclaré dans le package |
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
| `touba package submit [dossier] --presentation-from <publication-id>` | Nouvelle version avec présentation et illustrations reprises explicitement |
| `touba package submit [dossier] --ci <autorisation> --registry <URL>` | Nouveau brouillon depuis un job GitHub Actions autorisé |

Les commandes interactives acceptent `--no-browser` et `--json`. Un registre
compatible peut proposer une session conservée dans le coffre système, ouverte
par `touba package login` et révoquée par `touba package logout`.
La durée d'auteur annoncée par le service est bornée à une heure au maximum,
depuis la confirmation initiale. Les jetons courts sont renouvelés pendant cette
fenêtre ; l'inactivité ou une politique plus stricte peuvent l'écourter.
`--session-only` garde l'identité en mémoire pour la seule opération.
Le service exige l’authentification
renforcée pour ces opérations CLI. `checkout` contrôle l’accès privé et
l’intégrité avant extraction ; `submit` applique les validations et tests
isolés du service. La publication reste une action explicite.

Le mode `--ci` utilise OIDC GitHub avec `id-token: write`. Son autorisation
est liée au dépôt GitHub, au workflow, à la branche et à l'environnement. Elle prépare uniquement
un nouveau brouillon, sans lien local ni remplacement automatique. La publication
finale exige une personne habilitée et une authentification forte dans le service.
`--draft` et `--no-browser` ne s’utilisent pas avec `--ci`.

`--presentation-from` exige un registre annonçant cette capacité, une version
publiée du même package et du même espace, et un nouveau numéro de version.
Cette reprise est disponible pour une nouvelle soumission interactive, pas pour
un remplacement, `--ci` ou `--automation`. Sans cette option, la présentation
initiale d'une nouvelle version provient de son README.

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
| `PackageDraftLockUnsafe` | Inspecter le verrou et les processus avant toute intervention manuelle |
| `PackageOperationCancelled` | Consulter le brouillon avant une nouvelle tentative |
| `PackageDraftRefused` | Vérifier session, droits et diagnostic renvoyé par le service |

Après une interruption brutale, le verrou local est récupéré uniquement si son
format, son propriétaire et la disparition du processus sur le même hôte sont
vérifiables. Un verrou ancien, illisible ou provenant d'un autre hôte est conservé.
Une interruption pendant la récupération peut laisser un fichier `.recovery` à
examiner. Les contrôles de concurrence du serveur restent appliqués.

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
