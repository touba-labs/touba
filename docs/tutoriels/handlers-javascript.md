# SDK JavaScript : écrire un handler

Objectif : déclarer un tool dans Touba, générer son handler JavaScript et l’exécuter sous le contrôle du Core. Aucun modèle ni service externe n’est nécessaire.

## 1. Installer le SDK

Dans un dossier de projet vide :

```sh
touba init --language javascript
touba sdk install javascript
```

Node.js 24 et npm sont requis. Le SDK livré avec Touba s’installe hors ligne dans le projet.

## 2. Déclarer le contrat Touba

Créez les dossiers `src/sdk`, puis le fichier suivant :

<!-- touba-example: compile -->
```touba title="src/sdk/handlers.tb"
module sdk.handlers
tool Normalize
    takes value as Text
    gives Text
strategy Run
    takes value as Text
    gives Text
    uses Normalize
    do
        Normalize
            with value as value
            into result
        give result
```

Le contrat métier reste dans Touba. JavaScript fournit l’implémentation du tool.

## 3. Générer et examiner le binding

Passez explicitement les décisions de l’hôte :

```sh
touba prepare --mode write --host-decisions-json '{"bindings":{"tool:sdk.handlers/Normalize":{"grants":[],"effect_contract":{"kind":"none"}}}}'
```

Ce tool transforme seulement du texte : aucun grant ni effet externe. Pour un accès réseau, fichier ou secret, déclarez les besoins réels et examinez les décisions hôtes correspondantes. Le SDK ne les accorde jamais à votre place.

`prepare` génère `handlers/sdk/handlers/normalize.handler.mjs`, son test `.handler.contract.test.mjs` et le manifest. Il lit les contrats sans importer ni exécuter votre code JavaScript.

## 4. Écrire la fonction métier

Dans le handler généré, remplacez seulement la fonction `run`, en conservant son export :

```js
export async function run({ request, context }) {
  return request.trim().toUpperCase();
}
```

Conservez les constantes et l’appel à `defineTool` générés. Ici, `request` est directement le texte ; avec plusieurs paramètres Touba, ce serait un objet portant leurs noms.

## 5. Tester et exécuter

Vérifiez le contrat d’admission :

```sh
node --test handlers/sdk/handlers/normalize.handler.contract.test.mjs
```

Ajoutez aussi vos tests métier : les tests générés ne prouvent pas que la transformation répond à votre besoin.

```js title="run.mjs"
import assert from "node:assert/strict";
import { ToubaEngine } from "@touba/sdk";

const engine = new ToubaEngine({ projectRoot: "." });
const result = await engine.run({
  source: "src/sdk/handlers.tb",
  manifest: ".touba/build/dev/touba.manifest.json",
  inputs: { value: "  invoice 42  " },
});
assert.equal(result.status, "success");
assert.equal(result.result, "INVOICE 42");
console.log(result.result);
```

Exécutez `node run.mjs`. Le résultat attendu est `INVOICE 42`. Le Core vérifie les types, l’admission du tool et la trace, quel que soit le langage hôte.

## 6. Verrouiller les fichiers

Pour séparer le code métier, ajoutez ce fichier à côté du handler :

```js title="handlers/sdk/handlers/helpers.mjs"
export function normalize(value) {
  return value.trim().toUpperCase();
}
```

Dans le handler, ajoutez `import { normalize } from "./helpers.mjs";` et utilisez `return normalize(request);` dans `run`. L’import local sera suivi par Touba.

Complétez l’identité du projet sans écraser ses dépendances dans `package.json` :

```sh
npm pkg set name=business-handlers version=0.1.0
```

```sh
touba compile src/sdk/handlers.tb --out program.air.json
touba supply-chain generate --air program.air.json \
  --manifest .touba/build/dev/touba.manifest.json --out touba.lock.json
touba supply-chain validate --air program.air.json \
  --manifest .touba/build/dev/touba.manifest.json --lock touba.lock.json
```

Le verrou inclut le handler, `helpers.mjs`, `package.json` et les artefacts de dépendances déclarés. Modifier le helper après génération provoque un refus à la validation, avant dispatch lorsque le verrou est exigé. L’inventaire n’exécute pas le code du projet.

La revue reste en attente : ce verrou généré n’est pas une qualification production. Examinez réellement ses fichiers et dépendances avant d’approuver une revue. Voir [supply chain](../guides/supply-chain-handlers.md).

## Pour un handler à effets

Utilisez un contrat d’effet adapté et rendez un reçu corrélé à l’exécution réelle, jamais avant l’opération. `createToolResult`, `createEffectReceipt` et `createCompensationReceipt` couvrent les mêmes enveloppes qu’en Python. Un reçu ne garantit pas à lui seul l’idempotence externe.

Consultez le [SDK JavaScript](../guides/sdk-javascript.md), le même tutoriel avec le [SDK Python](./handlers-python.md) et le [tutoriel d’approbation](./approbations-roles-delais.md).
