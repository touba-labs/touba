# Tutoriel : créer un package et l'utiliser dans un autre projet

Ce parcours utilise le compilateur et le runtime réels, sans modèle ni réseau.
Vous créez `acme.echo`, testez son contrat, partagez une archive, l'importez
dans une application, puis mettez cette application à niveau. Les variantes
finales montrent le registry local et l'enregistrement manuel.

## Avant de commencer

Installez Touba, ouvrez un terminal et vérifiez `touba version` puis
`touba doctor`. Ce package pur n'a besoin d'aucun SDK ni service externe.
Les commandes ci-dessous sont écrites pour macOS/Linux ou un shell POSIX sous
Windows ; dans PowerShell, créez les mêmes dossiers et adaptez la syntaxe du
shell, pas les fichiers Touba. Travaillez dans un dossier neuf et gardez le
même terminal pour suivre les `cd`.

À la fin, les sources auteur restent dans `package-demo/echo/` ; l'application
est dans `package-demo/consumer/`. Son dossier `packages/acme.echo/` est une
copie contrôlée, pas le dossier dans lequel développer le package.

## 1. Créer le package auteur

```sh title="Terminal"
mkdir package-demo
cd package-demo
touba package new echo --org acme --license MIT --yes
cd echo
touba package check
touba package test
```

La skill générée est :

<!-- touba-example: compile -->
```touba title="src/acme/echo.tb"
module acme.echo

skill Echo
    description "Return the supplied text unchanged."
    takes value as Text
    gives Text
    do
        give value
```

Le manifeste `touba.package.json` contient `acme.echo`, la version `0.1.0`,
l'auteur issu de `--org`, la licence et le test déclaré. Choisissez une licence
que vous êtes habilité à utiliser. Le test généré compile et exécute Echo ;
une assertion incorrecte fait échouer `touba package test`.

Avant de partager, ouvrez les fichiers générés :

- `touba.package.json` : vérifiez `name`, `version`, `publisher`, `license`
  et l'export `skill:acme.echo/Echo` ;
- `src/acme/echo.tb` : la déclaration métier exportée ;
- `tests/echo.test.mjs` : le test qui prépare et exécute Echo, puis vérifie le résultat ;
- `README.md` : complétez le contrat d'entrée/sortie et l'exemple d'import.

Conservez Echo inchangée pendant ce tutoriel pour retrouver les mêmes résultats.
Pour votre propre package, remplacez source, exports et assertions ensemble,
selon le [guide auteur](../guides/creer-partager-package.md).

```sh title="Terminal"
touba package check --publishing
touba package pack
```

Le contrôle de publication doit réussir et l'archive doit apparaître dans
`dist/acme.echo-0.1.0.tar.gz`. `pack` fournit son empreinte, sans exécuter les
tests à votre place ni envoyer le package sur un serveur. Conservez l'archive
et son empreinte ; une seconde commande `pack` sur le même fichier est refusée.

## 2. Installer dans un autre projet

```sh title="Terminal"
cd ..
mkdir consumer
cd consumer
touba init
touba package add ../echo/dist/acme.echo-0.1.0.tar.gz
touba package list
mkdir -p src/client
```

`package list` doit afficher `acme.echo` en `0.1.0`. Touba crée
`touba.packages.lock.json` et enregistre la dépendance dans
`touba.project.json`. L'installation ne modifie pas le package auteur.

Créez le fichier suivant :

<!-- touba-example: compile -->
```touba title="src/client/main.tb"
module client.main

import skill Echo from acme.echo

strategy Run
    takes request as Text
    gives Text
    uses Echo
    do
        Echo
            with value as request
            into reply
        give reply
```

## 3. Préparer et exécuter

```sh title="Terminal"
touba prepare --mode write --entry strategy:client.main/Run
touba run --project . --inputs-json '{"request":"Package import works"}' --output json
```

Le résultat est `Package import works`. Aucune permission réseau, aucun
handler et aucune clé modèle ne sont nécessaires.

Dans le JSON de sortie, vérifiez `status: "success"` et
`result: "Package import works"`. Le nom qualifié après `from` désigne le
module ; `uses Echo` déclare la capacité utilisée par la stratégie.
Le chemin physique de la dépendance n'apparaît pas dans le code Touba.

## 4. Vérifier la frontière

Dans une copie de test, modifiez
`packages/acme.echo/src/acme/echo.tb`, puis relancez `touba prepare` :
`PackageIntegrityMismatch` refuse la préparation. La version inscrite dans
le manifeste seule ne suffit pas à garantir le contenu.

Essayez ensuite d'importer une déclaration non exportée : la préparation
refuse cet import. L'installation rend les déclarations publiques disponibles ;
elle ne rend pas tous les symboles du package publics.

Gardez l'archive originale et restaurez votre copie de test depuis celle-ci,
sans recalculer un lock pour masquer une modification inattendue.

## 5. Préparer une nouvelle version

Revenez dans le projet auteur, pas dans la copie installée :

```sh title="Terminal"
cd ../echo/src
touba package version patch
touba package check --publishing
touba package test
touba package pack
```

Les commandes retrouvent la racine depuis `src/`. L'archive est maintenant
`echo/dist/acme.echo-0.1.1.tar.gz` ; la première reste intacte. Aucun envoi distant
n'a lieu. Le consommateur conserve `0.1.0` jusqu'à une mise à niveau explicite.
L'identité `acme.echo` reste stable ; une nouvelle version peut faire évoluer
les métadonnées et le contrat documenté.

## 6. Mettre le consommateur à niveau

Depuis `echo/src/`, revenez dans le consommateur. Pour ce projet de démonstration
sans autre dépendance, retirez explicitement la copie installée puis ajoutez
l'archive suivante. Dans un vrai projet, faites cette opération dans une
branche ou copie de travail et conservez le lock précédent pour la revue.

```sh title="Terminal"
cd ../../consumer
touba package remove acme.echo
touba package add ../echo/dist/acme.echo-0.1.1.tar.gz
touba package list
touba package check
touba prepare --mode write --entry strategy:client.main/Run
touba run --project . --inputs-json '{"request":"Package import works"}' --output json
```

La liste indique `0.1.1` et le résultat reste identique. Les imports n'ont pas
changé : l'identité et le contrat sont stables. Versionnez le manifeste projet
et le lock ensemble. Les versions `0.1.0` et `0.1.1` ici appartiennent à votre
**package**, pas à la distribution du langage Touba.

## 7. Variante : publier et installer depuis un registry local

Toujours depuis `consumer/`, publiez la version auteur dans un dossier voisin :

```sh title="Terminal"
cd ../echo
touba package test
touba package publish --registry ../registry
touba registry check --registry ../registry --source-root ../registry
cd ../consumer
touba package remove acme.echo
touba package add acme.echo@0.1.1 --registry ../registry --allow-draft
touba package list
touba prepare --mode write --entry strategy:client.main/Run
touba run --project . --inputs-json '{"request":"Package import works"}' --output json
```

`registry/` contient l'index, les métadonnées et l'archive. La publication
locale commence en `draft` : `--allow-draft` accepte ici votre propre code relu,
pas un package tiers inconnu. Sans ce choix, le brouillon est refusé.
Une seconde publication de la même identité/version est refusée ; aucune
archive n'est écrasée. Cette commande ne réserve pas le nom auprès d'un service
public et ne téléverse rien. L'hébergement HTTPS vient séparément.

## 8. Variante : enregistrer un dossier copié manuellement

Dans un **nouveau projet de test**, lancez `touba init`. Pour l'archive que vous
venez de produire vous-même, ouvrez-la avec votre gestionnaire d'archives.
Copiez le contenu de son dossier `package/` dans `packages/acme.echo/`.
Le manifeste doit être directement à
`packages/acme.echo/touba.package.json`, sans un niveau `package/` supplémentaire.
Ne copiez pas le dossier auteur entier avec ses builds.

Depuis ce nouveau projet :

```sh title="Terminal (nouveau projet)"
touba package add acme.echo
touba package list
touba package check
```

Le nom suffit car Touba recherche le dossier dans `packages/`. La copie seule
ne remplace pas `add`, qui vérifie et enregistre le contenu. Reprenez
`src/client/main.tb` et les commandes de l'étape 3 pour l'utiliser.
Pour une archive reçue d'un tiers, préférez `touba package add <archive>` :
Touba contrôle ses chemins avant extraction.

## 9. Lire un refus et poursuivre

| Constat | Action |
| --- | --- |
| `PackagePublicationMetadataMissing` | Compléter les métadonnées signalées dans le manifeste auteur |
| `PackageExportUnknownRef` ou `PackageExportMissing` | Vérifier module, déclaration et export, puis refaire le contrôle |
| `PackageDependencyConflict` | Revoir la version déjà installée ; préparer une mise à niveau explicite |
| `PackageIntegrityMismatch` | Comparer la copie au contenu approuvé ; restaurer une copie fiable, sans réécrire le lock pour cacher la dérive |
| Aucun test déclaré | Ajouter de vrais tests ; `no_tests` n'est pas une validation métier |

## 10. Soumettre un brouillon pour relecture

Avec un service de publication compatible et un espace `acme` dont vous êtes
mainteneur, revenez dans le dossier auteur `echo` :

```sh
touba package submit --registry https://registry.example.org/registry
```

Cette adresse est un exemple à remplacer par celle de votre service.
Confirmez le code du terminal dans le navigateur. À la fin de la vérification,
ouvrez le lien renvoyé : le README sert de présentation par défaut. Vous pouvez
le conserver, téléverser un autre README ou rédiger des sections dans le service.
Prévisualisez la page, puis publiez cette version.

Pour reprendre ce brouillon sur une autre machine, utilisez son identifiant
dans un dossier parent libre :

```sh
touba package checkout 11111111-1111-4111-8111-111111111111 --registry https://registry.example.org/registry
cd echo
touba package check
touba package test
touba package submit
```

Remplacez l’identifiant d’exemple par celui renvoyé lors de votre soumission.
Touba crée `echo/` et mémorise le lien au brouillon ; les prochaines soumissions
utilisent ce lien. La présentation et les images enregistrées dans le service
sont conservées. Après publication, changez la version avant de soumettre
du nouveau code. Ce parcours est identique avec les deux SDK.

Vous avez maintenant un package testable, une archive réutilisable et une
application qui l'importe réellement. Pour aller plus loin :
[guide complet](../guides/creer-partager-package.md),
[référence du manifeste](../reference/packages.md),
[contexte de package et tool gouverné](skill-pack-script-tool.md),
[handlers JavaScript](handlers-javascript.md) et [Python](handlers-python.md).

## Variante GitHub Actions

Avec une autorisation de soumission créée par le propriétaire de votre espace,
le même package peut devenir un brouillon depuis le job CI :

```sh
touba package submit --ci 11111111-1111-4111-8111-111111111111 --registry https://registry.example.org/registry
```

Le job doit disposer de `id-token: write` et de l’environnement autorisé.
Remplacez les valeurs d’exemple par celles du service. Ouvrez ensuite le lien
renvoyé, vérifiez la présentation et publiez la version depuis l’interface.
Le [guide](../guides/creer-partager-package.md#préparer-un-brouillon-depuis-github-actions)
détaille le périmètre de cette autorisation.
