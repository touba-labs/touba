# SDK JavaScript : appeler Touba

Même programme, mêmes entrées et mêmes résultats que dans l’autre SDK. Aucun modèle, handler ou service externe n’est nécessaire.

## 1. Installer le SDK

Depuis un dossier d’application vide :

```sh title="Terminal"
touba sdk install javascript
```

Node.js 24 et npm sont requis.

## 2. Déclarer le programme Touba

Ce programme retourne une valeur typée. Il est identique dans les deux tutoriels SDK.

<!-- touba-example: compile -->
```touba title="program.tb"
module sdk.engine
strategy Review
    takes value as Text
    gives Text
    do
        give value
```

## 3. Importer et exécuter

```js title="run.mjs"
import assert from "node:assert/strict";
import { ToubaEngine } from "@touba/sdk";

const engine = new ToubaEngine({ projectRoot: "." });
const run = await engine.run({ source: "program.tb", inputs: { value: "Invoice 42" } });
assert.equal(run.status, "success");
assert.equal(run.result, "Invoice 42");
console.log(run.result);
```

Exécutez `node run.mjs` : résultat attendu `Invoice 42`.

## 4. Compiler et réutiliser l’AIR

Utilisez cet autre point d’entrée pour compiler une fois, puis transmettre l’AIR au même moteur :

```js title="compiled.mjs"
import assert from "node:assert/strict";
import { ToubaEngine } from "@touba/sdk";

const engine = new ToubaEngine({ projectRoot: "." });
const compiled = await engine.compile({ source: "program.tb" });
for (const airJson of [compiled.airJson, compiled.airDocument]) {
  const run = await engine.run({ airJson, inputs: { value: "Invoice 42" } });
  assert.equal(run.status, "success");
  assert.equal(run.result, "Invoice 42");
}
console.log("Invoice 42");
```

Exécutez `node compiled.mjs`. Même résultat ; le Core conserve toutes les vérifications.

## 5. Vérifier le résultat et les erreurs

Un mauvais type d’entrée doit provoquer un refus, pas un succès silencieux :

```js title="refused.mjs"
import assert from "node:assert/strict";
import { ToubaEngine, ToubaEngineError } from "@touba/sdk";

const engine = new ToubaEngine({ projectRoot: "." });
await assert.rejects(
  () => engine.run({ source: "program.tb", inputs: { value: 42 } }),
  (error) => error instanceof ToubaEngineError && error.phase === "run" && error.details.status === "failure",
);
console.log("refused");
```

Exécutez `node refused.mjs`. Une attente humaine ou un arrêt explicite restent, eux, des résultats contrôlés avec `status` et `reason` ; ne les assimilez pas à une erreur technique.

## Vérifier l'exemple complet

```sh title="Terminal"
node run.mjs
node compiled.mjs
node refused.mjs
```

## 6. Continuer avec les handlers

Passez au [tutoriel de handlers JavaScript](./handlers-javascript.md) pour exécuter du code métier hôte. Le [SDK JavaScript](../guides/sdk-javascript.md) détaille options, reprises, tests et limites. Comparez le même parcours avec le [SDK Python](./engine-python.md).
