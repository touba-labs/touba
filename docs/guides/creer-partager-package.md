# Créer, installer et partager un package

Un package Touba est l'unité de réutilisation : types, fonctions, tools, skills
exécutables, agents, stratégies, mémoires ou procédures contextuelles peuvent
cohabiter. Une intégration est un usage d'un package, pas un format supplémentaire.
Library les rassemble, le Hub les présente, un registry indexe leurs versions.

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
3. Renseigner `description`, `publisher`, `license` et `readme`.
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
touba package add /chemin/vers/acme.review-0.1.0.tar.gz
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
séparément ce dossier sur HTTPS avec les contrôles d'accès appropriés.

## Préserver la gouvernance

Les imports gardent leurs références. Un package n'élargit pas `uses`,
`callable_by`, les grants, secrets ou scopes. Un agent conserve ses callers
source ; une stratégie exportée peut l'appeler sous ce contrat. Un contexte
guide le modèle sans lui ajouter de capacité.

Suite : [tutoriel d'import](../tutoriels/package-reutilisable.md),
[procédures contextuelles](skills-first.md), [référence](../reference/packages.md).
