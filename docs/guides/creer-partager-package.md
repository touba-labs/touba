# Créer, installer et partager un package

## Partager un module hôte

Pour réutiliser un adaptateur d'identité, placez le module dans `host/` et
ajoutez ces champs au manifeste du package. Incluez ses fichiers auxiliaires :

```json title="Host module declarations"
{
  "hosts": [
    { "id": "approval", "kind": "human_approval", "path": "host/approval.mjs" }
  ],
  "files": ["host"]
}
```

```sh
touba package check --publishing
touba package pack
```

Le consommateur installe le package, relit l'adaptateur, configure son
environnement puis choisit explicitement son point d'entrée :

```sh
touba run --project . --human-approval-host pkg:acme.review/approval
```

L'adaptateur exporte `attestHumanApproval` et, si nécessaire,
`resolveInitiator` en JavaScript ; `attest_human_approval` et
`resolve_initiator` en Python. Le
[tutoriel d'approbation](../tutoriels/approbations-roles-delais.md) montre leur
contrat. Une proposition de décision utilise `kind: "decision_provider"`
et `--agent-decision-provider`. Les fichiers sont contrôlés avant chargement ;
les accès et identités restent configurés par l'application.


Un package Touba est l'unité de réutilisation : types, fonctions, tools, skills
exécutables, agents, stratégies, mémoires ou procédures contextuelles peuvent
cohabiter. Une intégration est un usage d'un package, pas un format supplémentaire.
Library les rassemble, le Hub les présente, un registry indexe leurs versions.

## Parcours complet

Vous construisez un projet **auteur**, puis distribuez une archive à un projet
**consommateur**. La CLI génère la structure et contrôle le contenu ; vous
écrivez le contrat métier, ses tests et les instructions d'utilisation.
Pour suivre toutes les commandes dans l'ordre, ouvrez le
[tutoriel de création et d'utilisation](../tutoriels/package-reutilisable.md).

Avant de commencer, installez Touba et vérifiez `touba version` et
`touba doctor`. Un package de code Touba pur ne demande ni SDK hôte, ni clé
modèle, ni serveur. Les SDK deviennent nécessaires si votre code hôte les
importe ; le langage du handler ne change pas le format du package.

| Contenu à partager | Contrat à déclarer | Utilisation dans l'application |
| --- | --- | --- |
| Type, constante, fonction ou skill exécutable | Références publiques dans `exports`, sources dans `files` | Import typé depuis le module, puis appel Touba |
| Agent et workflow | `exports.agents` et `exports.strategies`, avec leurs dépendances | Import ; le workflow est une stratégie, pas un second format |
| Intégration avec un service externe | Tool exporté, handler proposé et prérequis documentés | Binding revu par l'hôte, SDK éventuel et autorisations explicites |
| Procédure contextuelle | Entrée `contexts` et procédure Markdown | Sélection et activation de contexte, pas un `import skill` |

Le nom installé (`acme.review`), le module (`acme.review`) et la déclaration
(`skill:acme.review/Echo`) ont des rôles distincts. Ils coïncident partiellement
dans l'exemple généré ; l'import utilise le **module**, jamais un chemin vers
`packages/`. Le répertoire géré reste unique dans chaque projet.

## Créer le projet auteur

Pour les URL, régions ou identifiants attendus par un handler, utilisez une
[configuration d'hôte typée et revue](../reference/packages.md#configuration-dun-handler).
Ces valeurs n'ont pas à être détournées en secrets ; elles ne sont pas injectées
dans l'environnement parent et n'accordent aucune permission.

`touba package new` ouvre un questionnaire : organisation, nom, description,
auteur, version, licence et contenu initial. La CLI affiche l'identité et le
dossier avant confirmation. Annuler ne crée aucun fichier. Pour un script :

```sh title="Terminal"
touba package new review --org acme --license MIT --yes
cd review
touba package check
touba package test
```

Utilisez une licence adaptée à vos droits. `--context` génère une procédure
Markdown au lieu de la skill d'exemple. Les espaces deviennent des tirets :
`Atelier Nord` et `Gestion factures` donnent `atelier-nord.gestion-factures`
dans `gestion-factures/`. Les noms sont en minuscules ; les caractères non
acceptés sont signalés, pas supprimés silencieusement. La création locale ne
réserve pas le nom et n'authentifie pas l'organisation.

```text title="Projet auteur exécutable"
review/
  touba.package.json
  README.md
  .gitignore
  src/acme/review.tb
  tests/echo.test.mjs
  packages/
```

Le manifeste unique porte l'identité, la version, les exports et les exigences.
Le module généré remplace les tirets par des underscores : identité de package
et référence de module sont distinctes. Les imports existants ne sont pas réécrits.

`packages/` est réservé aux dépendances, dans un projet auteur comme dans une
application créée avec `touba init`. Un fichier, un lien ou un alias de casse
`Packages` à cet emplacement est refusé, jamais remplacé. Le badge VS Code
`P` identifie le dossier sans certifier ses contenus. Développez vos packages
dans un dossier auteur séparé, jamais dans une copie installée.

Les commandes retrouvent le manifeste le plus proche depuis les sous-dossiers :
pas de `../` à répéter pour vérifier, tester, versionner ou empaqueter.

## Développer le contenu et le contrat public

Le générateur fournit un point de départ fonctionnel. Dans `src/`, remplacez
Echo par vos déclarations métier, puis alignez les références de `exports`
et les assertions du test. Ajoutez chaque nouveau fichier de test à
`contract_tests` : la commande n'invente pas les cas à vérifier.

Voici le manifeste généré par la commande précédente. Vous n'avez pas à le
recopier ; il montre les champs à maintenir quand le contenu évolue.

```json title="touba.package.json"
{
  "package_schema_version": "touba-package-v1",
  "name": "acme.review",
  "version": "0.1.0",
  "description": "Reusable acme.review package.",
  "touba": {
    "air_profile": "touba-air-json-canonical-v1",
    "runtime_compatibility": ">=1.0.0 <2.0.0"
  },
  "exports": {
    "skills": [
      "skill:acme.review/Echo"
    ]
  },
  "readme": "README.md",
  "files": [
    "src",
    ".gitignore"
  ],
  "publisher": "acme",
  "license": "MIT",
  "contract_tests": [
    "tests/echo.test.mjs"
  ]
}
```

- `exports` définit l'API publique. Renommer une déclaration exige de mettre
  à jour son export et les consommateurs concernés. Les autres déclarations
  restent internes au package.
- `files` inventorie le contenu distribuable. Le manifeste, le README, les
  tests déclarés, les handlers et ressources de contexte sont également pris
  en compte par leur déclaration. Ajoutez explicitement vos autres ressources.
  Vérifiez l'inventaire rendu par `touba package check --json` avant diffusion.
- `touba.runtime_compatibility` exprime la plage réellement testée, pas une
  promesse de compatibilité avec des versions futures.
  Une plage stable comme `>=1.0.0 <2.0.0` n'inclut pas une préversion telle que
  `1.5.0-rc.1`. Pour qualifier cette candidate, l'auteur peut préparer une copie
  de travail du package déclarant exactement `1.5.0-rc.1`, puis la vérifier et
  l'archiver avec ses tests. Ne modifiez pas un package déjà installé pour
  contourner ce refus : son empreinte et ses contrats restent contrôlés.
  Sinon, utilisez une distribution stable satisfaisant la plage annoncée.
- `dependencies` contient des versions exactes ; utilisez `touba package add`
  depuis le projet auteur pour faire enregistrer dépendance et lock ensemble.
- `engines` vérifie actuellement la plage Node et les plateformes. Documentez
  dans le README les autres prérequis, notamment Python, ses dépendances,
  services et variables ; ne leur inventez pas de champ non reconnu.

Le README doit permettre à un autre développeur d'installer, importer et
exécuter un exemple sans vous contacter : entrées et sorties, exports,
commandes, prérequis, permissions demandées, erreurs attendues et licence.
Gardez identifiants, prompts et descriptions destinés aux modèles en anglais.
Aucune clé, fichier `.env`, cache ou dépendance `node_modules` dans l'archive.

### Ajouter un handler JavaScript ou Python

Déclarez le tool dans le code Touba et son export, écrivez le handler suivant
le parcours [JavaScript](../tutoriels/handlers-javascript.md) ou
[Python](../tutoriels/handlers-python.md), puis déclarez son fichier dans
`handlers` selon la [référence](../reference/packages.md). Indiquez les
bibliothèques hôtes nécessaires et comment les installer. `package add`
n'exécute ni `npm install`, ni `pip install`, ni script de post-installation.

Le consommateur installe explicitement le SDK choisi avec
`touba sdk install javascript` ou `touba sdk install python`. Il examine
le plan de `touba prepare`, les handlers et les décisions hôtes avant
exécution. Fournir du code ne fournit ni secret, ni grant, ni approbation.
Les tests de package restent des tests Node déclarés dans `contract_tests` ;
les tests de handlers Python ont leur propre commande, décrite dans leur tutoriel.

## Vérifier et tester

`check` vérifie structure, inventaire, prérequis hôtes, dépendances exactes,
compilation et exports réels. Il indique les métadonnées manquantes pour partager ;
`check --publishing` les rend obligatoires. Il n'exécute aucun handler ou test.

`test` exécute les fichiers Node déclarés dans `contract_tests`, après ces
vérifications. Le test généré compile et exécute la skill Echo : remplacez-le
par vos contrats métier. Sans test déclaré, une procédure textuelle retourne
`no_tests`, avec un code de sortie non nul. Un fichier vide ou une suite
entièrement ignorée n'est pas présenté comme une réussite.

La commande extrait une distribution neuve dans un dossier temporaire et le
supprime après le test. Elle ne réutilise pas `.touba/build` de l'auteur et ne
modifie pas son manifeste. Le test généré installe ensuite le package dans un
consommateur temporaire par cas, via son helper `runEntry(entry, inputs)`.
Adaptez l'entrée et les assertions pour ajouter des cas indépendants.

Les tests peuvent importer `@touba/sdk`, `@touba/sdk/testing` et les entrées
publiques de `@touba/runtime` : la commande
fournit les entrées du SDK de sa propre toolchain, hors de l'archive testée.
Elle ne reprend pas le `node_modules` de l'auteur et n'installe rien par réseau.
L'installation du SDK dans une application consommatrice reste une étape distincte.

Relisez les tests avant exécution : ce code hôte dispose des droits système de
votre compte, pas d'une sandbox. Les secrets d'environnement ne sont pas
transmis par défaut ; `--env NOM` autorise explicitement une variable. Cela
n'empêche pas un test de lire un fichier accessible. Isolez les tests tiers.

### Scénarios explicites de conformité des effets

`assertEffectScenario` dans `@touba/sdk/testing` et `assert_effect_scenario`
dans `touba_sdk.testing` vérifient le même contrat `touba-effect-scenario-v1`.
L'auteur choisit les scénarios et les ajoute à ses `contract_tests`. Ces
assertions n'exécutent et ne rejouent aucune opération elles-mêmes.

Le package d'exemple `implementation/examples/package-effect-scenarios` montre
un service HTTP local synthétique, son stockage transactionnel et le handler
réel du package installé dans un consommateur temporaire. Le contrôleur mesure
les appels et les écritures du service et rouvre le même journal entre les trois
exécutions. Trois cas sont disponibles :

- `duplicate` : une écriture, puis deux relectures du résultat sans nouvel appel ;
- `lost_reply` : réponse perdue après écriture, reprise avec la même clé et
  déduplication par le service, puis relecture sans nouvel appel ;
- `reconciliation_required` : réponse perdue, effet incertain conservé et deux
  tentatives refusées sans nouvelle émission.

Deux contrôles négatifs vérifient que le reçu absent et une clé changée à la
reprise font échouer le scénario. Leur réussite signifie que ces défauts ont
été détectés. Le résultat identifie le scénario avec la portée
`author_test_synthetic_service`, sans arguments, valeurs métier ou reçu détaillé.
Ces observations restent des tests fournis par l'auteur. Elles ne certifient
pas leur propre source d'observation, un fournisseur distant ou tous les usages
du handler. Le service réel doit assurer la déduplication transactionnelle ou
la réconciliation prévues par son contrat.

Exécutez les tests tiers dans un worker isolé, sans réseau sortant. Le service
synthétique utilise uniquement le loopback interne. Installer ou inspecter un
package ne lance aucun de ces scénarios. Les packages sans ces tests conservent
leur format et leur comportement existants.

### Tester une stratégie qui utilise un outil

Le helper `runEntry` du test généré accepte les décisions d'hôte du consommateur
de test. Elles sont explicites et ne modifient pas les droits du package :

```javascript
const run = runEntry('strategy:acme.invoice/Run', { value: 'Exemple' }, {
  hostDecisions: {
    bindings: {
      'tool:acme.invoice/Read': {
        package_handler: 'acme.invoice',
        grants: [],
        effect_contract: { kind: 'none' },
      },
    },
  },
});
assert.equal(run.status, 'success');
```

Cet exemple suppose un outil sans effet externe. Pour une écriture simulée,
choisissez son vrai contrat d'effet dans les décisions et passez
`effectJournal: true` au helper. Vérifiez aussi le reçu et l'état du simulateur.
Une reprise exige le même journal durable : le helper crée un consommateur neuf
par appel et ne constitue donc pas à lui seul un test de rejeu. Les dépendances
verrouillées sont installées avec l'archive, sans chemins différents chez l'auteur.

## Exigences d'une entreprise ou d'un auteur

Avant diffusion :

1. Choisir une identité stable `organisation.nom` et une version SemVer exacte.
2. Déclarer uniquement les exports publics et les dépendances exactes.
3. Renseigner `description`, `publisher` et `license`. Préparer une présentation : le `readme` du package suffit et permet la publication directe en CLI ; un service de publication peut aussi recueillir cette présentation séparément.
4. Expliquer entrées, sorties, erreurs, effets, limites et exemples d'import.
5. Déclarer les prérequis hôtes dans `engines` et la configuration attendue.
6. Tester les cas nominaux et les refus, sans données privées ni secrets.
7. Installer l'archive dans un projet distinct et vérifier son usage réel.

Un handler respecte `touba-tool-handler-v1`. Livrer un handler ne crée pas un
binding approuvé : le consommateur choisit son chemin, ses grants, secrets,
scopes et limites. L'intégrité d'une archive ne garantit pas l'innocuité du code.
Pour un handler JavaScript important `@touba/sdk`, le consommateur suit le
[guide SDK](sdk-javascript.md). Aucun npm install caché n'a lieu pendant l'ajout.

## Partager sans serveur

Depuis le projet auteur :

```sh title="Terminal"
touba package check --publishing
touba package test
touba package pack
```

L'archive est créée dans `dist/acme.review-0.1.0.tar.gz`. `--output <chemin>`
choisit un autre emplacement ; aucune archive existante n'est écrasée.
Les fichiers déclarés et la fermeture des dépendances sont inclus. La CLI
fournit l'empreinte SHA-256. Transmettez l'archive par un canal dont l'origine
est vérifiable. Aucun serveur Touba n'est nécessaire.

Le verrou de transport des dépendances est généré par l'archive : ne l'ajoutez
pas à `files`. Le consommateur possède son propre `touba.packages.lock.json`.
Les transitives sont conservées dans ce verrou sans devenir des dépendances
directes du manifeste auteur. `PackageLockDistributionConflict` demande de
retirer l'inclusion explicite du verrou et de produire une nouvelle version.

Dans une application créée avec `touba init`, ajoutez le chemin réel de
l'archive ou d'un dossier auteur :

```sh title="Forme de la commande"
touba package add /path/to/acme.review-0.1.0.tar.gz
touba package list
touba package check
```

Pour une installation manuelle, placez les fichiers distribuables dans
`packages/acme.review/`, puis lancez `touba package add acme.review`,
même depuis `src/`. N'y copiez pas les builds, caches ou secrets du projet
auteur. Copier un dossier seul ne l'enregistre pas.

Dans une application, l'ajout met à jour `touba.project.json` et
`touba.packages.lock.json`. Dans un package auteur, il renseigne
`dependencies` dans `touba.package.json` et le même lock. Versionnez ces
fichiers et conservez les dossiers installés pour travailler hors réseau.
`prepare`, l'éditeur et `run --project` contrôlent leur intégrité.

### Composer des packages compatibles

Dans le candidat en qualification, un ajout peut proposer de réutiliser une
dépendance installée dont la version satisfait les contraintes déclarées.
L'archive de l'auteur reste inchangée. La CLI rend `review_required` : relisez
les versions exactes, les contraintes et les changements de contrats, puis
acceptez l'empreinte retournée.

```sh
touba package add ./acme.review-0.2.0.tar.gz --json
touba package add ./acme.review-0.2.0.tar.gz --accept sha256:EMPREINTE_AFFICHEE
```

Pour revoir ensemble des ajouts, des versions conservées et des mises à jour :

```json title="selection.json"
{
  "schema_version": "touba-package-update-set-v1",
  "packages": [
    { "path": "./acme.base-1.1.0.tar.gz" },
    { "path": "./acme.review-0.2.0.tar.gz" }
  ]
}
```

```sh
touba package update-set selection.json --json
touba package update-set selection.json --accept sha256:EMPREINTE_AFFICHEE
```

Les chemins sont relatifs au fichier de sélection. Une racine inchangée est
conservée, pas réinstallée sous un contenu différent. Un conflit nomme les
consommateurs concernés. Une modification après l'aperçu impose une nouvelle
revue. Aucune plage ne certifie la compatibilité métier : testez votre application.

Un lot de soumission a un autre rôle : il transporte les archives originales,
avec leurs dépendances exactes. Une version compatible publiée ne remplace
pas automatiquement la preuve de publication d'une version embarquée.

## Faire évoluer une version

```sh title="Terminal"
touba package version patch
touba package test
touba package pack
```

`patch`, `minor`, `major` ou une version exacte strictement supérieure sont
acceptés. Sans argument, un terminal interactif demande le choix. Seule la
version du manifeste change : aucun commit, tag, envoi distant ou modification
des consommateurs. Touba ne déduit pas la compatibilité métier du changement.

Après publication, conservez l'identité `organisation.nom` : changer de nom
crée un autre package. Une version publiée conserve son contenu. Faites évoluer
description, licence, README ou exports dans une nouvelle version.

## Revoir la gouvernance d'une mise à jour

**Disponible à partir de Touba 1.4.0.**

L'application conserve ses exigences dans `touba.project.json` :
`configuration.package_contracts` décrit les contrats revus et
`configuration.tool_policies` fixe ses approbations minimales. Versionnez ces
données avec le projet. Retirer un package ou nettoyer `.touba/build/` les conserve.

```sh
touba prepare --mode plan
```

Le plan montre les changements d'approbation, de rôle, de délai, de séparation
des signataires, de droits, de secrets, d'accès mémoire et de signature.
Un contrat modifié produit `PackageGovernanceReviewRequired`.
Pour adopter la version après revue, recopiez son empreinte exacte affichée
par le plan dans les décisions hôte :

```json title="package-review.json"
{
  "review_packages": {
    "example.export": "sha256:EXACT_DIGEST_FROM_THE_PLAN"
  }
}
```

```sh
touba prepare --mode plan --host-decisions package-review.json
touba prepare --mode write --host-decisions package-review.json
touba prepare --mode check
```

Cette revue accepte le contrat du package ; elle conserve le minimum de
l'application. Pour définir ce minimum explicitement, utilisez la même procédure
avec `tool_policies` :

```json title="Décisions hôte"
{
  "tool_policies": {
    "tool:example.export/Export": {
      "role": "reviewer",
      "timeout_ms": 60000,
      "distinct_from": "initiator"
    }
  }
}
```

Une approbation de l'opération satisfait les contraintes compatibles des deux
origines : délai le plus court et séparations cumulées. Des rôles ou règles
d'exclusion différents demandent un arbitrage explicite
(`ToolApprovalPolicyConflict`). Les checkpoints séparés du programme gardent
leur propre décision. La valeur `null`, choisie explicitement dans
`tool_policies`, retire le minimum de l'application pour cet outil ; les
exigences encore présentes dans le package continuent de s'appliquer.

La première préparation écrite adopte les approbations des packages et examine
les anciens AIR disponibles. Sans historique conservé, elle établit une première
base à relire. Un outil renommé reste une nouvelle identité. Les règles métier
et l'unicité des opérations restent dans le service qui réalise l'effet.

La préparation inscrit ces exigences dans le manifest utilisé à l'exécution.
Pour exécuter directement un AIR avec le SDK, fournissez ce manifest ou un
binding `approval_policy` équivalent : le SDK ne recherche pas la configuration
d'un projet à partir d'un AIR seul.

## Dépendances et développement local

Une seule version exacte par nom, aucun choix implicite de « dernière version ».
Dépendance absente, cycle ou conflit provoquent un diagnostic. `add` ne remplace
pas une version installée. Pour examiner une mise à jour :

```sh
touba package update /path/to/acme.review-0.2.0.tar.gz --json
```

La prévisualisation conserve les fichiers installés et rend `review_digest`,
les versions, empreintes, handlers modifiés et contrats. Après revue :

```sh
touba package update /path/to/acme.review-0.2.0.tar.gz --accept sha256:EXACT_REVIEW_DIGEST
touba prepare --mode plan
```

Le registre configuré permet aussi `touba package update acme.review@0.2.0`.
L'acceptation est liée au contenu et à l'état du projet ; un changement impose
une nouvelle revue. Les dépendances encore requises, les minima d'approbation
et les permissions restent contrôlés. Préparez ensuite les contrats selon la
procédure précédente. La mise à jour n'exécute aucun handler.

Pour revenir volontairement à une version plus ancienne, ajoutez
`--allow-downgrade` lors de la prévisualisation et de l'acceptation :

```sh
touba package update acme.review@0.1.0 --allow-downgrade --json
touba package update acme.review@0.1.0 --allow-downgrade --accept sha256:EXACT_REVIEW_DIGEST
```

Cette décision remplace le code installé ; elle n'annule ni les effets déjà
réalisés ni les migrations de données. Les minima d'approbation du consommateur
restent en place. Une version retirée du registre reste refusée. Une même version
ne peut pas être remplacée par un autre contenu. Préparez le projet avant de
reprendre les exécutions.

Pour sélectionner directement un export exécutable, déclarez sa référence dans
`entrypoints` de `touba.project.json`, puis préparez et exécutez le projet :

```sh
touba prepare --entry skill:acme.review/Echo --mode write
touba run --project . --entry skill:acme.review/Echo --inputs-json '{"value":"Package contract"}'
```

Les exports privés sont refusés. Un tool externe nécessite toujours ses bindings
et autorisations, qu'il soit appelé directement ou depuis un autre module.

Pour travailler sur une source mutable, une entrée projet `packages` peut
indiquer `manifest`, `version` et `editable: true`, hors du répertoire
géré `packages/`. Cette option explicite ne fournit pas l'intégrité d'une
installation verrouillée. Ne mélangez pas les deux modes pour une même identité.

## Registry choisi explicitement

```sh title="Forme de la commande"
touba package add acme.review@0.1.0 --registry ./registry
```

Le registry est un dossier ou une URL HTTPS ; aucune adresse par défaut n'est
supposée. L'identité et l'empreinte de l'archive sont vérifiées. Une version
retirée est refusée. Le statut éditorial ne remplace pas vos autorisations.

Pour consulter l'état des versions installées dans un registre configuré :

```sh
touba package audit
```

Cette lecture explicite affiche le motif connu d'un retrait et sa date de
consultation. Elle ne modifie rien, ne stoppe aucun run et ne constitue pas une
recherche exhaustive de vulnérabilités. Une version absente du catalogue est
inconnue, pas déclarée sûre. Sans accès au registre, la consultation échoue ;
aucun ancien résultat n'est présenté comme une réponse actuelle.

Après une consultation réussie d'un registre signé, sa copie locale se consulte
explicitement hors ligne :

```sh
touba package audit --offline
touba package list --status
```

Ces deux commandes ne contactent pas le registre. Elles revérifient la signature,
les révocations et les révisions déjà connues, puis indiquent la date de collecte
locale et l'expiration signée. Un cache expiré reste lisible avec un avertissement
et un code de sortie `1` ; il ne devient jamais une autorisation d'installation.
Un cache absent, altéré ou signé par une clé révoquée provoque un refus.
`touba package list` sans option reste limité aux vérifications locales.
`prepare` n'ajoute aucune consultation réseau.

Le cache `<fichier-de-confiance>.status.sqlite` est régénérable. Il est séparé
de `<fichier-de-confiance>.sqlite`, qui conserve la continuité des clés et des
révisions : ne supprimez pas ce dernier pour contourner un refus.

Pour une URL distante, fournir les clés approuvées de l'opérateur avec
`--trust registry-trust.json`. La CLI vérifie l'index signé, sa validité,
puis les empreintes des métadonnées et de l'archive. Le fichier de confiance
doit être obtenu et vérifié auprès de l'opérateur, indépendamment du package.
Voir la [référence des registres signés](../reference/packages.md#registre-distant-signé).

`touba registry check --registry ./registry --source-root ./registry` vérifie
index, métadonnées et artefacts. `--previous <snapshot-publié-fiable>` contrôle
aussi la continuité : aucune suppression, aucun renommage ou remplacement
d'une version publiée. Un retrait de disponibilité conserve son enregistrement.
L'opérateur doit authentifier les éditeurs et protéger leurs espaces de noms ;
ce contrôle local ne constitue pas un service d'identité.

## Publier un registry statique local

`publish` compile et empaquette le package, puis génère l'index et les
métadonnées attendus par le lecteur Touba. Il n'exécute pas les tests auteur,
ne téléverse rien et ne certifie pas l'organisation.

```sh title="Publication locale"
touba package test
touba package publish --registry ./registry
touba registry check --registry ./registry --source-root ./registry
```

Le dossier cible contient `index.json`, `metadata/<nom>-<version>.json` et
`archives/<nom>-<version>.tar.gz`. L'index `touba-registry-index-v1` relie
chaque identité/version à ses métadonnées et leur empreinte SHA-256.
Les métadonnées `touba-registry-package-v1` décrivent identité, état,
compatibilité et archive avec son empreinte. Ces fichiers sont générés :
aucune reconstruction manuelle du format n'est nécessaire.

Une publication locale commence en `draft`. Après revue du code, le
consommateur peut explicitement l'accepter :

```sh title="Installer un brouillon relu"
touba package add acme.review@0.1.0 --registry ./registry --allow-draft
```

Une identité/version déjà présente est immuable. Publiez une nouvelle version
pour changer le contenu. L'index est remplacé atomiquement après les artefacts ;
les publications concurrentes sont refusées. Après un arrêt interrompu,
inspectez le verrou `.touba-registry-publishing` et les fichiers non indexés
avant récupération, sans les écraser. Pour diffuser le registry, hébergez
séparément ce dossier sur HTTPS avec un index signé et les contrôles d'accès
appropriés.

## Publier vers un service compatible

```sh
touba package publish --registry https://registry.example.org/registry
```

Ouvrez le lien proposé, confirmez le code affiché dans votre terminal, puis
validez votre identité dans le navigateur. Le service contrôle votre droit de
publier dans l'organisation du package et qualifie l'archive avant de l'enregistrer.
Une version publiée est immuable : utilisez `touba package version` pour la suite.
`--no-browser` convient à un terminal sans navigateur. L'adresse ci-dessus est
un exemple de service compatible, pas l'annonce d'un Registry public Touba.
Le parcours est commun aux packages JavaScript et Python.

## Préparer un brouillon depuis l’éditeur

Pour faire relire la présentation avant publication, choisissez un service
compatible avec les brouillons :

```sh
touba package submit --registry https://registry.example.org/registry
```

Touba prépare et vérifie l’archive, ouvre la connexion navigateur puis la soumet.
Le service contrôle vos droits et exécute les tests isolés. La commande rend le
lien du brouillon privé : complétez la présentation, prévisualisez puis publiez.

Pour reprendre un package créé dans l’interface du service, copiez son identifiant :

```sh
touba package checkout 11111111-1111-4111-8111-111111111111 --registry https://registry.example.org/registry
cd review
touba package check
touba package test
touba package submit
```

Remplacez l’identifiant d’exemple par celui du brouillon. Le dossier créé porte
le nom court du package (`review` dans cet exemple). `--root` choisit un dossier
parent existant ; aucun dossier existant n’est remplacé. La récupération
vérifie les empreintes, le contenu et les contrats sans exécuter le code auteur.

Le lien local `.touba/package-draft.json` mémorise le registre, l’identité du
brouillon et son empreinte. Il ne contient aucun secret et reste hors archive.
Les soumissions suivantes réutilisent ce lien. La présentation enregistrée dans
le service et ses images sont conservées ; chaque remplacement est tracé.

Si le code distant a changé, relisez le nouveau brouillon avant de poursuivre.
`--draft <identifiant>` sélectionne explicitement une cible de même nom et version.
Après une interruption, consultez le service pour savoir si la soumission a
abouti. Un verrou local résiduel doit être examiné avant récupération.
Les mêmes commandes s’appliquent aux handlers JavaScript et Python.

Pour une collection, utilisez [un lot de soumissions borné](../reference/packages.md#soumettre-plusieurs-packages)
avec `touba package submit-suite suite.json --registry <url>`. Il conserve les
brouillons individuels et s'arrête au premier problème, sans publication automatique.
Avec `--session-only`, une même connexion temporaire sert aux packages du lot
visant le même registre. Elle reste en mémoire puis est révoquée à la fin du lot,
y compris en cas d'échec. Le renouvellement des jetons conserve l'échéance
initiale, au plus une heure selon le service ; l'activité ne prolonge pas le MFA.
Chaque archive conserve ses propres contrôles et compteurs. Si la révocation
distante ne peut être confirmée, le résultat le signale sans perdre les brouillons.

Avant publication, le service vérifie aussi les dépendances embarquées. Publiez
leurs versions exactes d'abord, depuis les feuilles du graphe jusqu'aux packages
qui les utilisent. Une dépendance privée, retirée ou de contenu différent bloque
la diffusion du parent. Les usages locaux restent possibles sans cette publication.

## Sélectionner un handler proposé

Dans les décisions hôtes, `bindings[toolRef].package_handler` sélectionne
l'identité du package, par exemple `"acme.billing"`. Cela choisit seulement
le point d'entrée déclaré. L'hôte approuve séparément grants, secrets, contrat
d'effet et limites. Aucun stub local inutilisé n'est créé pour le tool ainsi
sélectionné. Examinez cette sélection dans le plan avant d'appliquer les décisions.

L'auteur peut ajouter `effect_contract` à sa déclaration de handler. Cette
recommandation apparaît dans la fiche et dans la revue du package ; l'application
reste responsable du contrat effectif de son binding. Une lecture réseau peut
déclarer `kind: none` ; une écriture locale peut nécessiter `external_write`.
Le droit réseau ne permet donc pas de déduire la nature de l'effet.
Sans recommandation, `prepare` affiche `PackageEffectRecommendationMissing` ;
l'hôte choisit toujours le contrat effectif. Les tests déclarés réussis prouvent
les cas exécutés, pas la conformité universelle d'un connecteur ni la qualification
d'un fournisseur réel.

Pour accéder aux ressources d'une dépendance depuis un handler, utilisez le
[résolveur SDK](../reference/packages.md#ressources-dune-dépendance-depuis-un-handler).
Il utilise le verrou du package, au lieu d'un chemin dépendant de `cwd()`.

Pour une écriture, testez le reçu et l'état réellement enregistré par le service,
y compris si la réponse se perd. Le [guide des effets](effets-idempotents.md#tester-un-handler-de-package)
présente les cas à couvrir et les assertions JavaScript/Python.

## Préserver la gouvernance

Les imports gardent leurs références. Un package n'élargit pas `uses`,
`callable_by`, les grants, secrets ou scopes. Un agent conserve ses callers
source ; une stratégie exportée peut l'appeler sous ce contrat. Un contexte
guide le modèle sans lui ajouter de capacité.

Suite : [tutoriel d'import](../tutoriels/package-reutilisable.md),
[procédures contextuelles](skills-first.md), [référence](../reference/packages.md).

## Préparer un brouillon depuis GitHub Actions

Un propriétaire autorise le dépôt GitHub, le fichier workflow, la branche et
l’environnement dans le service de publication, après authentification forte.
Il obtient un identifiant d’autorisation, sans secret à enregistrer dans GitHub.

Dans un job ayant installé Touba et récupéré les sources du package, activez
`id-token: write`, choisissez l’environnement autorisé, puis lancez :

```sh
touba package submit --ci 11111111-1111-4111-8111-111111111111 --registry https://registry.example.org/registry
```

Remplacez l’identifiant et l’URL par ceux de votre service. Le jeton GitHub reste
en mémoire et sert à une seule soumission. Le service vérifie les identifiants
stables du dépôt GitHub et de son propriétaire, le workflow, la branche et l’environnement,
puis qualifie l’archive. Le résultat contient le lien privé du brouillon et sa
provenance. Un membre habilité le prévisualise et le publie ensuite.

Ce mode crée un nouveau brouillon ; une version déjà soumise est signalée pour
revue. La commande et le manifeste sont identiques pour JavaScript et Python.
