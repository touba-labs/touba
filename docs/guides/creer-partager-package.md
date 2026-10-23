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

Relisez les tests avant exécution : ce code hôte dispose des droits système de
votre compte, pas d'une sandbox. Les secrets d'environnement ne sont pas
transmis par défaut ; `--env NOM` autorise explicitement une variable. Cela
n'empêche pas un test de lire un fichier accessible. Isolez les tests tiers.

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

## Dépendances et développement local

Une seule version exacte par nom, aucun choix implicite de « dernière version ».
Dépendance absente, cycle ou conflit provoquent un diagnostic. `add` ne remplace
pas une version installée. Préparez une mise à niveau dans une copie de travail :
`touba package remove <nom>`, ajout de la nouvelle version, revue des diffs et
nouvelle préparation. Le retrait refuse une dépendance encore requise.

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

## Sélectionner un handler proposé

Dans les décisions hôtes, `bindings[toolRef].package_handler` sélectionne
l'identité du package, par exemple `"acme.billing"`. Cela choisit seulement
le point d'entrée déclaré. L'hôte approuve séparément grants, secrets, contrat
d'effet et limites. Aucun stub local inutilisé n'est créé pour le tool ainsi
sélectionné. Examinez cette sélection dans le plan avant d'appliquer les décisions.

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
