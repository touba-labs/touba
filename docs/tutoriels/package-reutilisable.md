# Tutoriel : partager une skill entre deux projets

Ce parcours utilise le compilateur et le runtime réels, sans modèle ni réseau.

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

```sh title="Terminal"
touba package check --publishing
touba package pack
```

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
