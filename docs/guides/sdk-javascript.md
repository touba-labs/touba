# SDK JavaScript

Le prochain build prépare l’[approbation par opération et la provenance des
écritures](./approbation-operation-et-unicite.md), avec le même contrat dans les deux SDK.

## Reprises protégées

Les SDK conservent l'intégrité et la consommation des checkpoints dans
`.touba/approval-checkpoints.sqlite` du projet. Gardez cette base avec les
journaux d'effets lors d'une sauvegarde. Les options `humanCheckpointStore`
(JavaScript) et `human_checkpoint_store` (Python) permettent un autre chemin
stable. Un checkpoint modifié, déjà consommé ou absent de cette base est refusé.
Une reprise séquentielle interrompue pendant un effet demande un rapprochement
avec le service métier avant toute nouvelle approbation.

## Packages hôtes et options d'exécution

Les deux SDK acceptent un chemin de module ou un sélecteur
`pkg:organisation.package/identifiant`. Le module doit être déclaré dans
`hosts` du package installé. L'installation vérifie le contenu ; son activation
est un choix explicite de l'application.

| Réglage | JavaScript | Python |
| --- | --- | --- |
| Attestation | `humanApprovalHost` | `human_approval_host` |
| Décisions agent | `agentDecisionProvider` | `agent_decision_provider` |
| Délai d'attestation, ms | `humanApprovalAuthorityTimeoutMs` | `human_approval_authority_timeout_ms` |
| Détail des fonctions pures | `tracePureFunctions` | `trace_pure_functions` |

Le délai vaut 5 000 ms par défaut, entre 1 et 60 000 ms. Le détail vaut
`full` par défaut ; `calls` conserve les appels et la gouvernance avec moins
d'événements internes. Voir les [packages](../reference/packages.md) et les
[traces](../reference/traces-v1-rc.md).


Le SDK JavaScript appelle la même CLI gouvernée que le SDK Python. Les deux guides suivent le même parcours, avec les mêmes concepts et exemples de départ.

## Arguments du callback handler

JavaScript appelle `run({ request, context })` ; Python appelle
`run(request, context)`. La signature déclarée détermine `request`.

| Entrées déclarées | Request JavaScript | Request Python |
| --- | --- | --- |
| Aucune | `{}` | `{}` |
| Une : `value as Text` | `"Invoice 42"` | `"Invoice 42"` |
| Deux : `left as Int`, `right as Int` | `{ left: 2, right: 3 }` | `{"left": 2, "right": 3}` |

Avec une entrée, lisez directement sa valeur dans `request`. Le contexte
contient les métadonnées et helpers d'exécution ; les arguments métier ne
sont jamais placés au même niveau que lui. Sans signature explicite,
le handler reçoit la map des arguments.

## Installation

Le SDK est livré comme archive npm autonome avec la distribution Touba. Il
n'est pas nécessaire de publier le projet ni d'utiliser un registre public.
Node.js 24 et npm sont requis. Depuis la racine du projet JavaScript :

Choisissez le SDK JavaScript :

```sh
touba sdk install javascript
```

Touba vérifie l'empreinte de son archive, la conserve dans
`vendor/touba-sdk/<empreinte>/`, puis appelle npm hors ligne sans scripts
d'installation. Il crée `package.json` s'il est absent et vérifie l'import
de `ToubaEngine`.

Un projet utilisant pnpm, Yarn ou Bun garde son gestionnaire : la commande
refuse de modifier son lockfile. `touba sdk path javascript` donne le chemin
vérifié de l'archive à copier dans le projet et à ajouter avec ce gestionnaire.

L'archive contient les dépendances des providers et leurs licences. Cette
installation n'utilise pas le réseau. Conservez l'archive, `package.json` et
le lockfile pour rendre le projet réinstallable. Une seule dépendance
`@touba/sdk` par projet suffit pour tous les handlers et providers.
N'utilisez pas un lien vers le répertoire mutable de la CLI : sa mise à jour
ne doit pas changer la dépendance du projet. Une mise à jour du SDK est une
installation explicite d'une nouvelle archive compatible.

`touba init`, `touba prepare` et `touba handler stub` ne téléchargent rien
et ne modifient pas les dépendances JavaScript. Pour un projet avec des tools,
`prepare` expose `sdk_dependency` et distingue SDK absent, version incompatible,
dépendance fournisseur absente et dépendance non déclarée. Son statut de
génération ne remplace pas cette vérification de disponibilité.
Un stub non complété refuse l'exécution avec `HandlerNotImplemented`.

Sous Windows, le SDK reconnaît le lanceur `touba.cmd` de l’installation et
appelle directement le Node embarqué avec l’entrée CLI, sans interpréteur de
commandes. Les chemins avec espaces et les arguments restent des valeurs
littérales. Un script `.cmd` ou `.bat` personnalisé est refusé : utilisez un
exécutable avec ses arguments séparés. Cette résolution ne constitue pas une
vérification de signature éditeur.

## Mise à jour

Mettre à jour la CLI ne remplace pas les copies de `@touba/sdk` dans les projets. Vérifiez depuis chaque application :

```sh
npm ls @touba/sdk
node --input-type=module -e 'console.log(import.meta.resolve("@touba/sdk"))'
```

Après mise à jour de la CLI, réinstallez explicitement le SDK :

```sh
touba sdk install javascript
```

Les archives sont distinguées par leur empreinte, y compris lorsque la version
du candidat V1 reste 1.0.0. La nouvelle dépendance utilise la copie du projet ; les autres
applications conservent leur SDK.

Vérifiez et conservez le lockfile mis à jour, puis relancez vos tests métier. Ne supprimez pas les checkpoints ni les données du projet. Pour les triggers, utilisez `triggerEvent` et `triggerState` ; la référence d'entrée se nomme `entryRef`, pas `entry`.

## Importation

```js
import { ToubaEngine, ToubaEngineError, ToubaHandlerError } from "@touba/sdk";
import { assertRunSucceeded } from "@touba/sdk/testing";
```

Le paquet s’installe sous `@touba/sdk`. Les helpers de test sont dans son sous-module `testing`.

## Exécuter un programme

Pour utiliser l'entrée, le profil et les ressources d'un projet préparé :

```js
const result = await engine.run({project: ".", profile: "dev"});
```

Choisissez `project` ou l'une des entrées `source`, `air`, `airJson`.
Le mode projet charge les fichiers de ressources explicitement déclarés et
vérifie leurs empreintes. Les modes AIR/source utilisent les options fournies
par l'hôte. `resourceBindings` remplace explicitement l'ensemble préparé.

Pour une inverse métier, `engine.createCompensation(options)` puis
`engine.resumeCompensation(options)` fournissent le parcours hôte décrit dans
[Compensations explicites](compensations-explicites.md).

<!-- touba-example: compile -->
```touba title="program.tb"
module sdk.engine
strategy Review
    takes value as Text
    gives Text
    do
        give value
```

```js title="run.mjs"
import { ToubaEngine } from "@touba/sdk";

const engine = new ToubaEngine({ projectRoot: "." });
const run = await engine.run({ source: "program.tb", inputs: { value: "Invoice 42" } });
console.log(run.status, run.reason, run.result);
```

### Engine CLI

L’engine consomme l’enveloppe JSON complète retournée par la CLI, y compris les résultats et messages `show` volumineux. Un JSON invalide ou tronqué reste une erreur : une trace apparemment réussie ne remplace jamais un résultat absent. Utilisez le statut, la raison et le code de sortie documentés pour distinguer échec, attente, rejet et annulation.

#### Rôle

`ToubaEngine` permet à une application JavaScript d’appeler Touba sans manipuler directement le runtime interne.

Il pilote la CLI Touba :

```text title="Structure"
app JavaScript -> @touba/sdk ToubaEngine -> CLI Touba -> AIR/runtime -> trace
```

La CLI reste le contrat d’exécution. Le SDK ne devient pas l’autorité du langage.

#### Forme

```js title="app.mjs"
import { ToubaEngine } from "@touba/sdk";

const engine = new ToubaEngine({
  projectRoot: ".",
});

const run = await engine.run({
  source: "src/program.tb",
  entryRef: "skill:examples.project/Run",
  manifest: "touba.manifest.json",
  secrets: "touba.secrets.dev.json",
  inputs: {
    request: {
      name: "Bamba",
    },
  },
});

console.log(run.status);
console.log(run.result);
console.log(run.trace);
```

#### Paramètres visibles

| Élément | Rôle |
| --- | --- |
| `projectRoot` | racine du projet hôte utilisée pour résoudre les chemins relatifs |
| `source` | fichier `.tb` compilé par la CLI avant exécution |
| `air` ou `airJson` | alternative explicite à `source` si l’AIR existe déjà |
| `entryRef` | entrée AIR à exécuter, par exemple un `skill` ou une `strategy` |
| `manifest` | manifest de bindings de tools |
| `secrets` | fichier de handles de secrets |
| `resourceBindings` | fichier `touba-resource-bindings-v1` transmis à `touba run --resource-bindings` |
| `requireResourceBindings` | demande le refus si une ressource logique requise n’a pas de binding actif |
| `inputs` | objet d’entrée transmis au runtime |
| `agentDecisions` | décisions explicites d’agents, bornées par `uses` |
| `agentDecisionProvider` | chemin vers un provider local appelé par la CLI pour choisir une capacité d’agent |
| `agentDecisionProviderInitialMode` | `summary` ou `capabilities`, transmis explicitement à la CLI |
| `agentDecisionProviderContentMode` | `inline` ou `opaque_refs` ; aucune conversion implicite des données |
| `maxAgentSteps` | limite locale de pas pour une boucle agentique pilotée par provider |
| `humanCheckpointOut` | chemin privé où écrire un checkpoint uniquement si le run attend une approbation |
| `humanResumeCheckpoint` | chemin du checkpoint à reprendre ; combiner avec `humanCheckpointOut` pour conserver une éventuelle pause suivante |
| `parallelCheckpointOut`, `parallelResumeCheckpoint` | chemins privés pour sauvegarder et reprendre la progression d'un groupe parallèle |
| `parallelLimits` | plafonds hôte du groupe et du run, détaillés dans la [référence CLI](../reference/cli-v1-rc.md#exécutions-parallèles) |
| `userInputs` | réponses `ask` explicites par référence d'interaction ; en parallèle, utiliser la référence d'occurrence |
| `humanDecisions` | objet associant les références d'approbation aux décisions runtime |
| `effectJournal` | chemin du journal durable pour les effets ; conserver le même journal à la reprise |
| `triggerEvent` | événement normalisé : `trigger_ref`, `event_id`, `source_kind` et `arguments` nommés éventuels ; exclusif d'une entrée ordinaire |
| `triggerState` | chemin finissant par `.triggers.sqlite`, pour dédoublonnage et quotas persistants |
| `supplyChainLock`, `requireSupplyChainLock` | verrou explicite et exigence de validation avant exécution |
| `runLimits`, `maxProviderCalls` | bornes explicites d'exécution et d'appels provider |

Une instance de `ToubaEngine` représente un contexte de projet ou de session. Elle peut exécuter plusieurs fichiers ou plusieurs entrées ; il n’est pas nécessaire de créer une instance par fichier `.tb`.

## Compiler un programme

```js
const compiled = await engine.compile({ source: "program.tb" });
const compiledRun = await engine.run({ airJson: compiled.airJson, inputs: { value: "Invoice 42" } });
// compiled.airDocument is the parsed object; airJson also accepts this object.
```

Cet extrait prolonge `run.mjs`. `compile` renvoie `airJson` (texte) et `airDocument` (objet). Fournissez exactement une entrée à `run` : `source`, `air` (fichier) ou `airJson` (texte ou objet).

## Résultats et erreurs

`pendingInteractions` (JavaScript) et `pending_interactions` (Python) exposent
toutes les questions actuellement en attente sous forme `{interaction_ref, prompt}`,
ou `[]`. Le champ singulier désigne la première question pour `user_input_pending`.
Répondez par occurrence avec `userInputs` / `user_inputs`, puis reprenez avec
`parallelResumeCheckpoint` / `parallel_resume_checkpoint`. La liste publique
ne contient aucun état privé de continuation.

`run.status` vaut `success`, `stopped` ou `cancelled` pour une issue non
technique. `run.reason` distingue réussite, attente, arrêt explicite, refus
humain, expiration et annulation. Une pause ou un refus humain ne lève pas
une exception technique. `run.messages` expose les messages `show` sous forme
`{ interaction_ref, text }`. `run.pendingInteraction` expose le prompt d'une
saisie attendue. Ces données métier ne sont pas copiées dans `run.trace`.

Les échecs de compilation, d'admission, d'exécution ou de lancement lèvent
`ToubaEngineError`. Inspectez `error.details.exitCode`, `status`, `reason`,
`trace` et `stderr` quand présents ; un lancement impossible expose aussi
`code`. Ne transformez pas cette exception en succès. Les sorties publiques
n'exposent pas le checkpoint privé. Les décisions humaines doivent cibler les
références de l'AIR effectivement exécuté, jamais celles d'un autre programme.

Deux codes d’admission utiles, disponibles dans les deux SDK :

| `error.code` | Action |
| --- | --- |
| `ProjectEntrypointNotAllowed` | Choisir une entrée déclarée dans `touba.project.json`, ou la déclarer puis préparer le projet. |
| `EffectJournalBusy` | Attendre la libération du journal par son processus détenteur. |

Ces refus arrivent avant l’exécution, en mode `process` comme `persistent`.

### Conserver les traces

```js
const run = await engine.run({ source: "program.tb", traceStore: ".touba/traces.sqlite" });
```

SQLite conserve les traces par défaut dans `.touba/traces.sqlite`, à la racine
du projet de l’engine. Le chemin ci-dessus peut être personnalisé. Chaque segment
reste disponible après la fin du processus ; `traceOut` / `trace_out` permet
en plus un export JSON. L’archivage est décrit dans la [référence traces](../reference/traces-v1-rc.md#conserver-les-traces).

Pour une longue trace, choisissez `traceMode: "reference"`. Le résultat métier
revient après la finalisation du journal, avec `traceReference`
et `trace` à `null`. Lisez ensuite les événements par pages :

```js
const traceStore = ".touba/traces.sqlite";
const run = await engine.run({
  source: "program.tb", traceStore, traceMode: "reference",
});
let after;
while (true) {
  const page = await engine.readTrace({
    traceStore, reference: run.traceReference, after, limit: 100,
  });
  for (const event of page.events) console.log(event.kind);
  if (page.done) break;
  after = page.next;
}
```

`readTrace` utilise le lecteur Core en lecture seule. `limit` accepte 1 à
1 000 événements ; le contenu des événements d'une page est limité à 1 Mio.
Un échec runtime expose sa référence dans `error.details.traceReference`.
La référence sert à la lecture ; la reprise d'exécution utilise son checkpoint.
Conservez la référence et le journal pour reprendre la lecture après un
redémarrage. Commencez sans curseur pour vérifier l'empreinte du segment complet ;
les pages suivantes contrôlent leurs événements et leur ordre.

En mode intégral, `trace` contient le document complet. La limite de transport
de 32 Mio s'applique aux réponses SDK, y compris au résultat métier et aux
messages. Une trace longue peut être conservée et lue par pages sans augmenter
cette limite. Voir la [référence traces](../reference/traces-v1-rc.md#conserver-les-traces).

## Écrire un handler

Après `touba prepare --mode write` ou `touba handler stub`, conservez les
exports `run`, `TOUBA_HANDLER_SDK`, `TOUBA_HANDLER_GENERATED_BY`, la signature
et le garde d'exécution du fichier. Remplacez uniquement le corps métier de
`run`, puis exécutez le test `*.handler.contract.test.mjs` généré.
Les exemples `defineTool` ci-dessous montrent l'API autonome ; ils ne sont
pas des remplacements complets d'un fichier généré.

Un seul paramètre déclaré arrive directement dans `request`. Avec zéro ou
plusieurs paramètres, `request` est l'objet d'arguments nommés.
`inputSignature` contient des noms uniques et leurs `type_ref` ;
`outputType` désigne le type déclaré ou vaut `null` pour un tool sans résultat.

### Rôle

Le SDK simplifie :

- la lecture de la requête envoyée par le runtime ;
- le parsing JSON ;
- la vérification défensive du `tool_ref` ;
- la sérialisation de la valeur de retour ;
- la sérialisation des erreurs contrôlées.

### Forme

```js title="handler.mjs"
import { defineTool } from "@touba/sdk";

await defineTool({
  toolRef: "tool:module.name/ToolName",
  inputSignature: [{ name: "request", type_ref: "type:module.name/Input" }],
  outputType: "type:module.name/Output",
  requiredGrants: ["network"],
  run: async ({ request, context }) => {
    return await runHostCode(request, context);
  },
});
```

`defineTool` identifie le tool attendu, vérifie défensivement les grants et
secret handles reçus, puis appelle une fonction métier `run({ request,
context })`. La fonction retourne une valeur conforme au `gives` du tool.

### Exemple

```js title="search_datasets.handler.mjs"
import { defineTool } from "@touba/sdk";

await defineTool({
  toolRef: "tool:examples.search/SearchDatasets",
  inputSignature: [{ name: "request", type_ref: "type:examples.search/SearchRequest" }],
  outputType: "type:examples.search/SearchResult",
  requiredGrants: ["network"],
  run: async ({ request }) => {
    return await searchDatasets(request);
  },
});
```


### Paramètres visibles

Pour les packs, `engine.run({ skillPacks: ["skills/dataset-brief"],
activeSkillPackRefs: ["skill_pack:project/dataset-brief"], ... })` transmet des
chemins explicites, résolus depuis `projectRoot`. Sans activation, seuls les
hints sont proposés. Les options `skillPackDiscoveryMaxBytes`,
`skillPackActivationMaxBytes` et `agentModelInputMaxBytes` fixent les budgets.
Voir le [parcours complet](../tutoriels/skill-pack-script-tool.md).

| Élément | Rôle |
| --- | --- |
| `tool:module.name/ToolName` | référence du tool attendu par le handler |
| `request` | entrée métier si le tool déclare un seul input |
| `context.arguments` | arguments structurés complets envoyés par le runtime |
| `context.grants` | grants accordés au handler |
| `context.secretHandles` | handles secrets exposés au handler |
| `context.limits` | limites runtime du handler |
| valeur retournée | résultat qui doit respecter le type `gives` du tool |

Le chemin public est `defineTool`.

Pour le projet complet, suivez le [tutoriel de handlers JavaScript](../tutoriels/handlers-javascript.md).

## Effets et provenance

Pour retourner des métadonnées de provenance mémoire séparément du résultat
métier, utilisez l'enveloppe explicite :

```js
import { createToolResult } from "@touba/sdk";

return createToolResult(record, {
  memoryMetadata: [{ memory_ref: "memory:app/Records", operation: "read" }],
});
```

Cet extrait appartient au corps du handler ; `record` est sa valeur métier.
Les autres propriétés de provenance dépendent du contrat mémoire déclaré.
Un objet métier ordinaire portant une clé `memory_metadata` reste un objet
métier, pas une enveloppe. Le SDK refuse les métadonnées mal formées ; le runtime
vérifie leur correspondance au tool, au scope et aux permissions, sans leur
accorder d'autorité supplémentaire.

`createEffectReceipt` et `createCompensationReceipt` produisent des reçus corrélés à l’opération. Utilisez les helpers du contexte après l’effet réel ; un reçu n’accorde aucun droit et ne remplace pas l’idempotence du service externe.

## Tester

### Tester le métier d'un handler

Les tests générés `*.handler.contract.test.mjs` vérifient les métadonnées et
les refus d'admission. Ils ne prouvent ni le résultat métier ni la réalisation
de l'effet. Ajoutez un test positif du `run` exporté et des cas d'erreur, avec
des services isolés. Exemple pour un handler qui normalise un ticket textuel :

```js
import test from "node:test";
import assert from "node:assert/strict";
import { run } from "./normalize_ticket.handler.mjs";

test("normalizes the real single-input request", async () => {
  assert.equal(await run({ request: "  SSO unavailable  ", context: {} }),
    "SSO unavailable");
});
```

Avec un seul `takes ticket as Text`, `request` est le texte lui-même,
pas `{ ticket }`. Avec plusieurs `takes`, c'est l'objet des arguments nommés.
Une exception non gérée expose sa classe sûre et un conseil de reproduction,
jamais son message brut qui pourrait contenir un secret. Utilisez
`ToubaHandlerError` pour un diagnostic public volontairement sûr.

### Tests déterministes avec le vrai moteur

Le sous-module `@touba/sdk/testing` fournit quatre aides, sans moteur de test
parallèle ni permissions automatiques :

| Aide | Usage |
| --- | --- |
| `createScriptedDecisionProvider(steps)` | Propositions déterministes avec attentes explicites sur `mode`, `agent_ref` et/ou `step_index` |
| `assertRunSucceeded(result, expected)` | Vérifier statut, raison de fin et résultat métier exact |
| `assertRunRefused(() => engine.run(options), code)` | Exiger le code exact d'un refus runtime ; une compilation ou un lancement raté ne compte pas |
| `assertTraceEvents(trace, { kind, count, where })` | Vérifier le nombre exact d'événements, avec filtre booléen synchrone facultatif |

Un provider de test remplace les propositions du modèle, pas les contrôles de
Touba. Il peut proposer une capacité interdite pour éprouver le refus réel.
Il ne sélectionne aucune capacité par défaut et ne déduit pas qu'une capacité
déjà utilisée est épuisée. Exemple à adapter aux références de votre programme :

```js title="tests/decision-provider.mjs"
import { createScriptedDecisionProvider } from "@touba/sdk/testing";

export default createScriptedDecisionProvider([
  {
    expect: { mode: "capabilities", step_index: 0 },
    decision: {
      action: "select_capability",
      target_ref: "tool:archive_testing/NormalizeTicket",
      arguments: { ticket: "  T-1  " },
      source: "scripted-test",
    },
  },
  {
    expect: { mode: "summary", step_index: 1 },
    decision: { action: "answer_directly", result: "T-1", source: "scripted-test" },
  },
]);
```

Passez ce module à `engine.run({ ...options, agentDecisionProvider:
"tests/decision-provider.mjs", agentDecisionProviderInitialMode: "capabilities" })`.
Les étapes sont ordonnées ; un mode inattendu ou un appel supplémentaire échoue.
Dans le même processus, `provider.assertConsumed()` vérifie aussi les étapes
inutilisées. Avec Engine, le provider vit dans le processus CLI : vérifiez le
résultat, les événements et vos effets depuis le test appelant. La propriété
`provider.calls` ne retient que mode, référence agent et index, pas les prompts,
entrées ou observations.

```js
import assert from "node:assert/strict";
import { assertRunSucceeded, assertRunRefused, assertTraceEvents } from "@touba/sdk/testing";

const result = await engine.run(options);
assertRunSucceeded(result, "T-1");
assertTraceEvents(result.trace, { kind: "run_completed", count: 1 });

// forbiddenOptions désigne un provider qui propose une capacité hors de uses.
const refused = await assertRunRefused(
  () => engine.run(forbiddenOptions),
  "AgentCapabilityNotAllowed",
);
assert.equal(refused.reason, "AgentCapabilityNotAllowed");
```

Vérifiez séparément l'absence de paiement, de message ou d'écriture dans le
service ou journal de test isolé. Une trace de tentative ne prouve pas un effet
externe. Gardez aussi des tests d'intégration avec vos vrais services de test ;
un provider scripté n'est pas une évaluation de modèle. Aucun réseau payant
n'est activé par ces aides, mais un handler réel garde ses effets autorisés.

Les tests d'admission générés comportent un `todo` explicite pour la couverture
métier. Remplacez-le par vos assertions positives et négatives ; des contrôles
de métadonnées réussis ne rendent pas un handler fonctionnel. Le SDK distribué
est testé dans une installation autonome avec un handler en processus, un refus avant invocation
et la régression du mauvais accès `request.ticket` pour une entrée unique.

## Reprises et parallélisme

### Approbations successives

Après une pause, fournissez ensemble `humanResumeCheckpoint` (checkpoint lu), `humanCheckpointOut` (nouveau fichier) et `humanDecisions` (décision pour cette pause). Une seconde pause conserve le run et avance son curseur : les instructions et effets précédents ne sont pas rejoués. Réutilisez le même `effectJournal` pour les écritures externes. Une décision visant une autre approbation est refusée. Un résultat terminal, notamment un rejet, ne crée pas de nouveau checkpoint. Ne relancez pas le programme depuis le début avec une liste de décisions pour contourner la reprise.

### Pauses facultatives et triggers dans l'Engine

Pour un trigger `request`, `triggerEvent.arguments` contient les arguments déjà nommés selon `takes`, par exemple `{ topic: "Dataset review" }`. Le SDK n'applique pas `payload.map` à un corps HTTP brut. Le service webhook fait ce mapping ; le runtime vérifie ensuite les arguments typés.

`humanCheckpointOut` n'oblige pas le programme à suspendre. Un chemin terminé
garde son résultat et son succès, sans écrire de checkpoint ni effacer un
ancien fichier à ce chemin. Utilisez un chemin distinct par run et fiez-vous
à `status` et `reason`, pas à la seule présence d'un fichier. Ne fournissez pas de nouveaux `inputs` à la reprise. Une reprise
doit utiliser le checkpoint et le journal de la même opération.

Pour déclencher un événement déjà reçu par votre application :

```js
const result = await engine.run({
  air: "daily_research.air.json",
  manifest: "touba.manifest.json",
  triggerEvent: {
    trigger_ref: "trigger:examples.daily_research/DailyResearchSchedule",
    event_id: "watch-event-42",
    source_kind: "schedule",
  },
  triggerState: "watch.triggers.sqlite",
});
```

L'état persistant refuse le rejeu du même identifiant et applique les quotas.
L'Engine ne démarre ni ordonnanceur ni serveur webhook : utilisez
`touba trigger run` ou `touba trigger serve` pour ces services.
La prévalidation sans exécution est disponible en CLI avec
`--trigger-dry-run`, sans `--state`.
Voir [triggers gouvernés](./triggers-gouvernes.md) et
[l'API serveur](./api-serveur-projet.md).

### Parallélisme natif avec Engine

Le bloc source `parallel` est exécuté par le runtime Touba, sans ordonnanceur
JavaScript métier à ajouter. `engine.run()` transmet les options
`parallelCheckpointOut`, `parallelResumeCheckpoint` et `parallelLimits`
à la CLI ; les limites de run restent communes aux branches.

```js
const outcome = await engine.run({
  source: "diagnostics.tb",
  entryRef: "strategy:parallel.diagnostics/Run",
  inputs: { incidents: ["billing", "shipping"] },
  parallelCheckpointOut: "private/parallel.json",
  parallelLimits: { maxExternalCalls: 4, maxBranches: 64 },
});
```

Configurer le provider et les bindings exigés par la source comme pour un appel
séquentiel. À la reprise, remplacer `inputs` par `parallelResumeCheckpoint`
et fournir `humanDecisions` pour les occurrences réellement en attente.
Une question `ask` sans réponse suspend le groupe avec `user_input_pending`.
L’hôte lit `pendingInteractions` (JavaScript) ou `pending_interactions` (Python),
conserve le checkpoint parallèle et fournit une réponse par référence
avec `userInputs` / `user_inputs`. La reprise conserve les branches terminées
et les budgets consommés. Chaque réponse concerne une seule occurrence.
`userInputProvider` reste le callback du runtime intégré ; l’Engine utilise
les réponses explicites de `userInputs`.
Voir le [tutoriel complet](../tutoriels/orchestration-multi-agent-sequentielle.md).

Pour un parcours exécutable de succès et de refus, voir [Tester un programme Touba](./tests-metier.md).

## Budgets financiers

Le registre `createSqliteProviderBudget` s’importe depuis `@touba/sdk/budget/sqlite`.
`createProviderCostFetch`, depuis `@touba/sdk`, réserve une borne avant chaque
tentative HTTP. Utilisez un tarif hôte vérifié, un identifiant stable et le même
registre pour les descendants et reprises. Voir le [guide des coûts fournisseurs](./couts-fournisseurs.md)
et le [tutoriel sans appel payant](../tutoriels/budget-financier.md).

## Capacités complémentaires

Les adaptateurs de modèles, l’historique conversationnel et le bridge MCP ont des API dans les deux SDK. Le transport persistant de l’Engine entre plusieurs runs est propre à JavaScript ; Python utilise un processus neuf par run. Le [guide Python](./sdk-python.md) présente les noms et options correspondants.

### Provider de décision agentique

#### Rôle

Un provider de décision reçoit la requête `touba-agent-decision-v1` produite par
le runtime. Il ne reçoit pas l’autorité finale : il propose une réponse directe,
demande le catalogue ou sélectionne une capacité. Le runtime Touba vérifie
ensuite la décision.

Le SDK fournit trois points d’entrée :

| API | Rôle |
| --- | --- |
| `createAiSdkDecisionProvider` | Adaptateur générique pour un modèle compatible AI SDK fourni par le projet. |
| `createOpenAiDecisionProvider` | Helper OpenAI fondé sur le provider OpenAI de l’AI SDK. |
| `createOllamaDecisionProvider` | Helper Ollama local via endpoint OpenAI-compatible, sans clé obligatoire par défaut. |

#### Forme générique

```js title="decision-provider.mjs"
import { createAiSdkDecisionProvider } from "@touba/sdk";
import { model } from "./model-provider.mjs";

export const decideAgentCapability = createAiSdkDecisionProvider({
  model,
});
```

`model` est fourni par le projet avec le provider AI SDK choisi. Par défaut,
`decisionInterface: "structured"` génère le schéma de sortie, appelle
`generateObject`, puis retourne une décision normalisée au runtime. L’interface
native décrite ci-dessous est un choix explicite de l’hôte.

`createAiSdkDecisionProvider` est la surface neutre : elle ne choisit pas le
fournisseur. Les helpers fournisseur configurent seulement le `model`, les
options provider et les variables d’environnement usuelles. Le runtime continue
à vérifier `uses`, signatures, budgets, secrets et traces après la réponse du
modèle.

À chaque étape exécutable, toutes les capacités déclarées restent sélectionnables,
y compris celles déjà utilisées. Une recherche peut être répétée avec d’autres
arguments et un outil peut être interrogé plusieurs fois, sous les quotas et
contrôles du runtime. L’historique ne force jamais une réponse finale.

Chaque observation associe le résultat aux arguments nommés de son invocation.
Deux lectures du même outil avec des paramètres différents restent donc
distinguables, même si les résultats sont des nombres ou des booléens. Le runtime
capture les arguments avant le handler. Le mode `opaque_refs` ne transmet pas leurs
valeurs brutes ; les contrôles de secrets et de volume restent appliqués.

Le SDK conserve la signature propre à chaque cible : les champs d’un autre outil
ne deviennent pas obligatoires. Il valide les arguments de la cible choisie avant
de retourner la décision. Le résultat direct respecte le `gives` déclaré par
l’agent (texte, booléen, entier, nombre, liste ou record local décrit, y compris
des champs imbriqués). Pour un agent historique sans `gives`, le helper SDK
conserve son format texte par défaut ; cela ne restreint pas le protocole runtime
à du texte. Un descripteur nominal non résolu ou récursif est refusé explicitement
par le helper, sans schéma de substitution trompeur.

Le modèle et les options fournisseur relèvent de la configuration du projet,
pas d’un champ `llm_model` reçu dans les données utilisateur. Pour un choix
dynamique, fournir une option `model` explicite qui applique la politique de
l’hôte.

`allowHumanReview: false` retire la revue dynamique du schéma et des actions
annoncées dans l’entrée modèle ; les
barrières `human.approve` et `human.review` déclarées dans la source restent
pleinement actives.

#### Réponses fournisseur complètes

Dans les interfaces `structured` et `native`, le SDK vérifie les métadonnées de
fin de génération avant d’accepter la décision. Avec les helpers HTTP Responses,
un `finishReason` favorable ne suffit pas : le corps doit porter
`status: "completed"`, sans `error` ni `incomplete_details`. Une réponse partielle,
en attente, annulée ou échouée produit `IncompleteModelDecision`, même si elle
contient déjà un JSON valide ou un appel de fonction apparemment complet.

Un `generateObject` injecté doit fournir les mêmes métadonnées de complétion
que le SDK réel. Un retour limité à `{ object }` est refusé. Cette vérification ne prouve
pas la satisfaction métier : les types, l’autorité et les effets restent à
vérifier par Touba et par l’application.

#### Choisir l’interface native

Pour un parcours complet, de la source `.tb` à l’inspection de la trace, suivre
le tutoriel [Utiliser les appels natifs sous autorité Touba](../tutoriels/provider-natif-gouverne.md).

Pour un modèle AI SDK qui prend en charge les appels de fonctions et les sorties
structurées, activer l’interface native dans le fichier provider :

```js title="decision-provider.mjs"
import { createAiSdkDecisionProvider } from "@touba/sdk";
import { model } from "./model-provider.mjs";

export const decideAgentCapability = createAiSdkDecisionProvider({
  model,
  decisionInterface: "native",
  instructions: "Complete the request using observed data and authorized operations.",
  maxOutputTokens: 1000,
});
```

L’option est aussi acceptée par `createOpenAiDecisionProvider` et
`createOllamaDecisionProvider`. Elle ne change ni la syntaxe `.tb`, ni l’AIR,
ni l’autorité du programme.

Certains modèles de raisonnement n'acceptent ni température imposée ni appel
de fonction forcé. Configurez alors `temperature: null` pour omettre ce
paramètre et, si nécessaire, `nativeToolChoice: "auto"`. Les défauts restent
respectivement `0` et `"required"`. En `"auto"`, Touba exige toujours une seule
proposition valide en phase catalogue : une réponse sans appel est refusée,
pas transformée en permission ou en réponse finale. Les réglages de raisonnement
propres au fournisseur passent par `providerOptions` ; vérifiez leur prise en
charge par le connecteur et le modèle utilisés. `maxOutputTokens` doit aussi
couvrir les tokens de raisonnement lorsque l'API les compte dans cette limite.

- Au catalogue, le SDK expose une fonction native par capacité autorisée,
  dérivée de sa référence et de sa signature. Une capacité peut être une
  `function`, un `tool`, une `skill`, un `agent` ou une `strategy` ; le transport
  « fonction » ne transforme pas toutes ces capacités en tools Touba.
- Le modèle propose exactement un appel. Le SDK ne fournit aucun exécuteur de
  fonction à l’AI SDK. Une proposition inconnue, multiple, déjà exécutée par le
  fournisseur, mal typée ou incomplète est refusée. Touba reste seul responsable
  de vérifier puis d’exécuter l’opération.
- En orientation et finalisation, la réponse reste structurée et conforme au
  `gives` de l’agent. La finalisation n’expose pas de fonctions exécutables.
- Au catalogue, `touba_finish` permet aussi de proposer un résultat final typé.
  Cette opération de contrôle n’exécute aucune capacité. Le SDK la traduit en
  `answer_directly`, également disponible dans l’interface structurée.
- En mode `inline`, l’historique associe les arguments validés et le résultat
  réel de chaque invocation sous forme d’appel/résultat natif. Un texte contenant
  du JSON reste du texte ; un record reste un record. Aucun raisonnement du
  modèle n’est inventé.
- En mode `opaque_refs`, l’historique reste constitué de descripteurs de données.
  Le SDK ne fabrique pas d’appels à partir d’arguments opaques et ne résout pas
  leurs références. Ce mode ne convient pas à une comparaison qui exige que le
  modèle lise des valeurs masquées.

Le SDK conserve désormais les messages originaux du connecteur par invocation,
avec leurs identifiants et métadonnées opaques en mode `inline`. La RAM est le
défaut ; un stockage transactionnel, notamment SQLite, permet les reprises
après redémarrage. L'historique reste borné et distinct de la mémoire métier.
Voir [Historique conversationnel des agents](historique-conversationnel.md)
pour les limites, la persistance, l'isolation et la frontière `opaque_refs`.

La rétention est distincte de la fenêtre envoyée. `context` active le prévol
tokenisé OpenAI ; `createProviderContextFetch` le branche sur les connecteurs
Anthropic/Gemini. Aucun résumeur LLM n'est appelé par défaut. Les tutoriels
[SQLite](../tutoriels/historique-sqlite.md) et
[contexte/compaction](../tutoriels/contexte-et-compaction.md) détaillent les limites,
les événements et le refus d'un contexte indispensable trop volumineux.

La revue humaine dynamique passe par un contrôle distinct,
`touba_request_human_review`, qui ne porte que `review_prompt`. Le runtime
applique la vraie décision humaine ; le modèle ne joue pas le rôle de
l’approbateur. Son observation reste une donnée d’état, pas un résultat d’outil
fictivement exécuté. `allowHumanReview: false` retire ce contrôle, sans neutraliser
les validations obligatoires de la source.

Lors d'une reprise autorisée, le SDK représente les observations validées sans
redéclencher les effets. Le checkpoint courant doit contenir les arguments,
identités et portées requis ; un état ancien incomplet est refusé par le
runtime, pas réparé avec des arguments inventés. Budgets et contrôles d'autorité
restent applicables à la reprise.

Les hints et contenus de skill packs sont transmis comme ressources informatives,
pas comme instructions système supplémentaires ni fonctions exécutables. L’accès
à une mémoire exige toujours les scopes source et les grants du manifest.

La frontière d'autorité reste donc la suivante :

| Contrôle | Autorité en interface native |
| --- | --- |
| catalogue et `uses` | construit et revérifié par le runtime Touba |
| arguments et types | schéma SDK en première ligne, validation runtime avant entrée dans la cible |
| délégation agent | `callable_by` vérifié par le runtime à chaque invocation |
| grants, mémoire et secrets | AIR, manifest, scopes et secret store ; jamais le modèle |
| revue humaine | décision humaine réelle et barrières déclarées dans la source |
| budgets, effets et reprise | compteurs, identité d'effet, journal et checkpoints du runtime, sans redispatch des effets passés |
| skill packs | contexte informatif ; aucun script n'est promu en fonction native |

La validation couvre notamment les propositions non exécutables, les appels répétés,
les références opaques, la revue et la reprise, les scopes mémoire, les packs,
la délégation `callable_by`, les secrets, le rejeu d'effet et la complétion
fournisseur. Elle ne transforme pas cette qualification locale en garantie de
justesse métier du modèle ni en preuve de sécurité générale.

#### Consignes métier et protocole SDK

Utiliser `instructions` pour ajouter les consignes de l’application tout en
conservant le protocole de décision du SDK :

```js
export const decideAgentCapability = createOpenAiDecisionProvider({
  model: process.env.TOUBA_AGENT_DECISION_OPENAI_MODEL,
  instructions: "Complete the request using observed data and authorized operations.",
});
```

`instructions` accepte une chaîne ou une fonction de la requête retournant une
chaîne, éventuellement asynchrone. Ce sont des consignes de l’hôte, pas un champ
à alimenter directement depuis un document externe ou un input utilisateur.
Les consignes et descriptions générées ou contrôlées par Touba sont rédigées en
anglais afin d'éviter un facteur linguistique implicite entre adaptateurs et
évaluations. Cette convention ne limite pas les données métier, contenus
externes ou requêtes utilisateur, qui peuvent rester multilingues sans être
rejetés ni traduits par le runtime.
L’option historique `system` reste un **remplacement complet** du message système
standard. Son utilisation exige de prendre en charge le protocole : orientation,
sélection d’une capacité, réutilisation, complétion et finalisation. Remplacer ce
message par les seules consignes métier peut perdre ces indications. Ce protocole appartient à l’adaptateur, pas aux règles métier du langage.

#### Forme OpenAI

```js title="decision-provider.mjs"
import { createOpenAiDecisionProvider } from "@touba/sdk";

export const decideAgentCapability = createOpenAiDecisionProvider({
  model: "gpt-4.1-nano",
});
```

Le helper lit `TOUBA_AGENT_DECISION_OPENAI_API_KEY` ou `OPENAI_API_KEY`. Cette
valeur doit rester un secret local ou d’environnement, jamais une valeur
committée.

L'option hôte `fetch` facultative est transmise à `createOpenAI` pour mesurer
ou contrôler le transport fournisseur. Elle n'accorde aucune capacité au
programme `.tb` et ne doit pas être pilotée par des données de domaine.

#### Forme Ollama locale

```js title="decision-provider.mjs"
import { createOllamaDecisionProvider } from "@touba/sdk";

export const provider_metadata = {
  provider_kind: "sdk_ai",
  provider_name: "researcher-provider",
  provider_version: "1.0.0",
  model_family: "ollama",
  endpoint_family: "openai_compatible",
  prompt_template_id: "researcher-v1",
  decision_schema_version: "touba-agent-decision-v1",
};

export const decideAgentCapability = createOllamaDecisionProvider({
  model: "llama3.2",
  baseURL: "http://127.0.0.1:11434/v1",
});
```

Le helper Ollama utilise l’API OpenAI-compatible exposée par l’hôte local. Par
défaut, il lit `TOUBA_AGENT_DECISION_OLLAMA_BASE_URL`, puis `OLLAMA_BASE_URL`,
et utilise `http://127.0.0.1:11434/v1` si rien n’est fourni. Le modèle peut être
fixé par option, par `TOUBA_AGENT_DECISION_OLLAMA_MODEL` ou par `OLLAMA_MODEL`.
Une entrée métier nommée `llm_model` ne modifie pas cette configuration.

Une clé n’est pas requise pour le cas local standard. Si un endpoint compatible
exige une clé, la passer par `TOUBA_AGENT_DECISION_OLLAMA_API_KEY`,
`OLLAMA_API_KEY` ou une option hôte non committée.

Ces deux helpers HTTP utilisent Responses par défaut ; `transport: "chat"`
sélectionne Chat Completions. Vérifiez les sorties structurées et les appels
de fonctions pris en charge par le serveur et le modèle choisis.
Les formats d’appels et de résultats sont décrits dans la
[documentation officielle OpenAI](https://developers.openai.com/api/docs/guides/function-calling).
Le helper Ollama ne garantit pas ces fonctionnalités pour toute installation
locale. Pour un autre protocole, fournissez un modèle adapté à
`createAiSdkDecisionProvider`.

#### Borner le corps HTTP fournisseur

Les deux helpers HTTP acceptent `maxProviderRequestBytes`, un entier positif
comptant les octets du corps HTTP sérialisé avant son envoi :

```js
export const decideAgentCapability = createOpenAiDecisionProvider({
  model: process.env.TOUBA_OPENAI_MODEL,
  decisionInterface: "native",
  maxProviderRequestBytes: 65536,
  maxOutputTokens: 1000,
});
```

En interface native, la limite effective est la plus petite des limites
`maxProviderRequestBytes` et `agentModelInputMaxBytes` du runtime lorsqu’elles
sont présentes. Le runtime contrôle d’abord sa propre entrée ; le helper contrôle
ensuite le corps réellement sérialisé, y compris l’historique, les instructions
et les schémas ajoutés par le SDK. Un dépassement produit
`ProviderRequestBudgetExceeded` avant envoi, sans troncature silencieuse. Un corps
impossible à mesurer est refusé par `ProviderRequestBodyUnavailable`.

`agentProviderObservationsMaxBytes` reste un contrôle distinct de la projection
d’observations runtime, pas une mesure du corps HTTP. Aucun de ces plafonds
n’est un budget de coût ou de tokens. `createAiSdkDecisionProvider` refuse
`maxProviderRequestBytes` : avec un modèle fourni par le projet, le transport
appartient à l’hôte, qui doit appliquer lui-même ce contrôle.

#### Actions

| Action | Moment | Effet |
| --- | --- | --- |
| `answer_directly` | Tous les modes | Retourne une réponse conforme au résultat déclaré de l’agent. |
| `request_capabilities` | `orientation` | Demande au runtime le catalogue autorisé. |
| `select_capability` | `capability_catalog` | Sélectionne une capacité et fournit ses arguments. |
| `request_human_review` | `capability_catalog` | Demande un review humain gouverné, distinct de `human.approve`. |
| `cannot_complete` | `finalization` | Déclare les informations insuffisantes ; le runtime conserve l’échec de limite de pas. |

Après une capacité exécutée, le runtime peut rappeler le provider avec une
observation dans `model_input.agent_state`. Cette boucle est séquentielle et
bornée par `maxAgentSteps`. Elle permet à l’agent d’utiliser plusieurs fois les
ressources autorisées sans confier l’autorité d’exécution au modèle.

Le catalogue permet de sélectionner une opération ou de retourner un résultat
typé. Une réponse en prose libre ne devient jamais une réponse finale par
déduction du SDK. L’orientation reste le mode initial par défaut.

### Finalisation des agents et observations

La responsabilité doit décrire l’opération métier et sa condition de fin.
Une consigne générique invitant à remplir une responsabilité ne définit pas
une tâche. Le développeur peut préciser comment une entrée exprime le travail
demandé, sans transformer les données ou contenus récupérés en instructions
d’autorité supérieure.

Le transport structuré du SDK place les instructions du source et les contrats
runtime dans le canal d’instructions. Les entrées métier, observations et contenus
des skill packs restent des données. Le même texte d’instruction n’est plus
dupliqué dans les données. L’interface native conserve les mêmes contrôles
d’autorité du runtime.

Un provider personnalisé doit examiner `observations[].value`, aussi disponible
dans `model_input.agent_state.observations`, et rapprocher les arguments de
l’invocation du travail demandé. Il renvoie `answer_directly` lorsque le résultat
est suffisant ; en `finalization`, `cannot_complete` sinon. Il ne conclut pas
au seul motif qu’une observation existe et ne redemande pas une opération au
seul motif qu’une capacité reste autorisée.

Les appels répétés, y compris avec les mêmes arguments, restent permis.
`repeated_from_step` et `identical_invocation_number` signalent les invocations
identiques dans les observations et les événements de trace, sans y ajouter
leurs arguments ou résultats bruts. Ce diagnostic n’arrête rien et ne crée
aucun cache. Une nouvelle invocation n’est pas un retry du même effet ;
l’identité d’effet et l’idempotence du backend traitent les retries séparément.

Tous les profils projet démarrent par l’orientation, sauf choix explicite de
`--agent-decision-provider-initial-mode capabilities`. Ce dernier présente
immédiatement les opérations disponibles et la possibilité d’un résultat typé.
Huit étapes d’exécution peuvent demander dix-sept appels fournisseur : orientation
et catalogue par étape, puis finalisation terminale. Chaque appel, retry compris,
consomme le budget fournisseur déclaré. Un statut runtime réussi ne prouve ni
que l’opération métier était nécessaire, ni qu’elle a eu lieu : vérifiez les
effets acquis indépendamment pour les applications à effets externes.

#### Transport structuré : l’action reste liée au résultat

Dans tous les modes structurés, le SDK demande au modèle une enveloppe
contenant un objet `decision`. Le JSON Schema choisit une branche complète :
`answer_directly` exige le type de résultat déclaré ; `request_capabilities` ou
`cannot_complete` n’utilise la sentinelle vide que dans sa propre branche.
Un résultat record ne peut donc pas être remplacé par une chaîne vide simplement
parce qu’une autre action l’autorise. Le SDK déplie l’enveloppe et valide la
décision avant de la transmettre à Touba. Les providers personnalisés retournent
toujours directement l’action publique `touba-agent-decision-v1` ; l’enveloppe
est un détail du transport modèle SDK, pas une syntaxe Touba. Au catalogue,
la branche de sélection conserve les arguments de la capacité ; la branche
de réponse exige le `gives` de l’agent. La proposition native `touba_finish`
porte ce même type de résultat, sans exécuter d’effet métier.

### Choisir le cycle de vie de l’Engine

Par défaut, `executionMode: "process"` exécute chaque appel dans un processus
neuf. Pour un service à code stable, activez explicitement le mode persistant :

```js
import { ToubaEngine } from "@touba/sdk";

const engine = new ToubaEngine({
  projectRoot: ".",
  executionMode: "persistent",
});
try {
  const result = await engine.run({
    air: "build/program.air.json",
    entryRef: "strategy:app/Review",
    inputs: { value: "Invoice 42" },
  });
  console.log(result.status, result.reason);
} finally {
  await engine.close();
}
```

Les deux modes passent par la même admission CLI. Les valeurs, budgets,
secrets et droits du runtime sont propres à chaque appel ; AIR, manifest et
fichiers d’autorité sont relus. Le mode persistant conserve un processus privé
par Engine, sans serveur réseau, avec quatre appels actifs et seize en attente.
La surcharge est refusée, pas exécutée sans limite.

Les modules hôtes JavaScript (provider, vérificateur d’identité et dépendances)
restent chargés : leurs connexions et variables globales peuvent persister.
Après modification de ce code, fermez l’Engine et créez-en un nouveau.
Utilisez le mode par défaut si vous exigez un processus hôte neuf à chaque
appel. Les handlers gardent leurs propres processus et restrictions.

Une source `.tb` est recompilée à chaque appel ; un AIR déjà compilé évite ce
coût. Dans une sonde locale sur Mac arm64 / Node 24.15.0, un programme pur avec
64 octets d’entrée passe d’environ 348 ms à 2 ms de médiane une fois le worker
chaud (20 appels). Le premier appel persistant prend environ 196 ms et le
worker occupe environ 103 Mio après la sonde. Ce n’est pas la latence d’un
appel modèle ou d’un traitement métier. `engine.workerMetrics` expose le RSS
et le CPU cumulés du worker, pas ceux des handlers enfants.

`run({ ..., signal: controller.signal })` accepte un `AbortSignal`.
L’annulation coopérative du mode persistant vise l’appel concerné ; si le code
hôte reste bloqué, le worker entier est arrêté après cinq secondes, ce qui
interrompt aussi ses autres appels. Le mode isolé arrête son processus.
Un crash ou une annulation ne relance jamais automatiquement une opération.
Vérifiez le journal d’effets avant une reprise ; un effet externe peut déjà
avoir eu lieu. Appelez `close()` lors de l’arrêt de l’application.

Pour les applications Python, consultez le [SDK Python](sdk-python.md).

## Providers et historique

Les factories `createAiSdkDecisionProvider`, `createOpenAiDecisionProvider`
et `createOllamaDecisionProvider` ont leurs équivalents Python, avec les mêmes
contrats et `decisionInterface: "structured"` ou `"native"`.
`createMemoryDecisionHistoryStore` vient de `@touba/sdk` ;
`createSqliteDecisionHistoryStore` de `@touba/sdk/history/sqlite`.
RAM est le stockage par défaut ; SQLite conserve les mêmes identifiants
d'invocation et exigences de reprise dans les deux SDK.
La compaction structurelle est locale. Un résumé textuel est produit seulement
par le callback hôte `summarize` s'il est fourni.
Voir [historique et contexte](./historique-conversationnel.md).

Les coûts se branchent au transport final par `cost: { budget, ...adapter }`
dans `createOpenAiDecisionProvider`. Le contrôle de contexte et le budget
financier sont distincts ; leur combinaison exige `cost.counting` avec
`quote` et `readUsage` explicites pour les requêtes de comptage.
Voir les [adaptateurs tarifaires](./couts-fournisseurs.md).

## MCP

L'importeur MCP génère `requires network` et le grant correspondant dans son brouillon. Pour un serveur stdio strictement local, révisez ensemble la déclaration et le manifest : `network` n'est pas imposé par le transport stdio. Les droits `process` exigés par le profil d'isolation restent nécessaires. Un serveur qui contacte Internet doit conserver l'autorisation réseau.

`createMcpStdioToolBridge({ mcpToolName, config })` retourne un handler
`bridge({ request, context })`. La configuration
`touba-mcp-bridge-config-v1` est la même en Python. Le bridge lance le serveur
stdio après admission du tool par le Core, applique les limites de temps/taille,
ne transmet que les secrets liés et ferme le processus serveur.
Le grant `process` reste nécessaire lorsqu'un confinement OS l'exige.

## Frontière d’autorité

Le SDK n’est pas l’autorité principale.

Le runtime vérifie avant dispatch :

- tool connu ;
- grants accordés ;
- secrets disponibles ;
- scopes agent et mémoire ;
- limites de payload ;
- contraintes de payload quand elles sont déclarées ;
- shape d’entrée ;
- sélection agentique contre `uses` ;
- arguments fournis par le provider contre la signature AIR.
- resource bindings associés aux ressources utilisées par le tool appelé.

Après retour du handler, le runtime vérifie aussi la shape de sortie.

Pour l’engine CLI, le SDK appelle la CLI Touba. Il ne lit pas automatiquement les manifests, les secrets, les handlers ou les fichiers `.env`.
Il ne découvre pas non plus les resource bindings : l’application doit passer
explicitement `resourceBindings` quand le run dépend d’une ressource logique.

### Bonnes pratiques

Pour les handlers :

- Garder le handler court.
- Ne pas lire tout l’environnement hôte.
- Ne jamais écrire un secret dans la sortie standard.
- Retourner une valeur conforme au `gives` du tool.
- Laisser le runtime refuser les cas de contrat invalide.

Pour l’engine :

- Réutiliser une instance par projet ou session.
- Passer explicitement `manifest`, `secrets` et `inputs`.
- Passer explicitement `resourceBindings` et `requireResourceBindings` quand un
  tool dépend d’une `memory`, d’un provider de décision ou d’une source
  événementielle câblée par l’hôte.
- Passer `agentDecisionProvider` quand un agent doit choisir une capacité pendant l’exécution.
- Régler `maxAgentSteps` pour borner explicitement les scénarios agentiques
  multi-étapes.
- Garder `agentDecisions` pour les tests reproductibles et les scénarios déterministes.
- Utiliser `createAiSdkDecisionProvider` pour éviter un provider spécifique codé à la main.
- Utiliser un helper fournisseur seulement quand sa convention d’environnement
  correspond au projet ; sinon fournir explicitement le `model` à
  `createAiSdkDecisionProvider`.
- Garder la clé modèle hors des inputs et hors des traces.
- Ne pas passer de valeur secrète dans `inputs`.
- Lire les traces retournées par `run.trace` plutôt que de parser les logs.
- Garder les tests live avec réseau ou clé API en opt-in.

## Passer d’un SDK à l’autre

Les noms des classes et les concepts sont communs. Les fonctions et options suivent la casse habituelle de chaque langage. Les clés des protocoles AIR, manifest et trace restent inchangées.

| JavaScript | Python |
| --- | --- |
| `ToubaEngine`, `ToubaEngineError`, `ToubaHandlerError` | `ToubaEngine`, `ToubaEngineError`, `ToubaHandlerError` |
| `projectRoot`, `entryRef`, `pendingInteraction` | `project_root`, `entry_ref`, `pending_interaction` |
| `pendingInteractions` | `pending_interactions` |
| `compile({ source })` → `airJson`, `airDocument` | `compile(source)` → `air_json`, `air_document` |
| `run({ airJson })` | `run(air_json=...)` |
| `defineTool`, `createToolHandler`, `handleToolRequest` | `define_tool`, `create_tool_handler`, `handle_tool_request` |
| `createToolResult`, `createEffectReceipt`, `createCompensationReceipt` | `create_tool_result`, `create_effect_receipt`, `create_compensation_receipt` |
| `toubaSdkMetadata` | `touba_sdk_metadata` |
| `@touba/sdk/testing` | `touba_sdk.testing` |
| `createScriptedDecisionProvider`, `assertRunSucceeded`, `assertRunRefused`, `assertTraceEvents` | `create_scripted_decision_provider`, `assert_run_succeeded`, `assert_run_refused`, `assert_trace_events` |

JavaScript utilise `await` ; Python propose `ToubaEngine` synchrone et `AsyncToubaEngine` avec `await`. Les fonctions métier reçoivent `run({ request, context })` en JavaScript et `run(request, context)` en Python. Ce sont des différences d’appel, pas de responsabilités.

Retrouvez les mêmes étapes dans le [SDK JavaScript](./sdk-javascript.md), le [SDK Python](./sdk-python.md), les tutoriels [Engine JavaScript](../tutoriels/engine-javascript.md) / [Engine Python](../tutoriels/engine-python.md) et [handlers JavaScript](../tutoriels/handlers-javascript.md) / [handlers Python](../tutoriels/handlers-python.md).

## Sorties typées et diagnostics fournisseur

Les contrats `Date`, `format`, `length`, `min` et `max` suivent le même
chemin dans les deux SDK : schéma fournisseur, validation de la réponse,
puis validation runtime. Les données invalides sont refusées avant utilisation.

| Réglage | JavaScript | Python |
| --- | --- | --- |
| Encodage du schéma | `schemaEncoding` | `schema_encoding` |
| Choix automatique (défaut) | `"auto"` | `"auto"` |
| Représentation Touba | `"canonical"` | `"canonical"` |
| Optionnels aplatis | `"flat_optionals"` | `"flat_optionals"` |

En mode automatique, le SDK adapte les champs `Optional` pour les modèles
Anthropic : il réduit les unions du schéma transmis, vérifie la réponse reçue,
puis restitue l’encodage Touba `{present, value}`. Les deux validations restent
actives, en interface `structured` comme `native`. Une valeur mal formée
n’est jamais convertie en absence. Les limites de schéma restent propres au
modèle choisi ; qualifiez les types métier avec ce modèle.

Dans le module hôte, exportez `initialModes` (JS) ou `initial_modes` (Python)
pour choisir `summary` ou `capabilities` par référence d’agent :

```js
export const initialModes = {
  "agent:app.invoices/Reader": "capabilities",
};
```

```python
initial_modes = {"agent:app.invoices/Reader": "capabilities"}
```

Sans choix explicite, un agent sans capacité démarre directement avec son
contrat de résultat. Pour un routage par agent, le SDK transmet les métadonnées
du modèle résolu ; l’événement `agent_decision_provider_model_resolved`
identifie le fournisseur et le modèle effectivement sélectionnés.

Les échecs de comptage conservent le statut HTTP et un diagnostic borné.
Une génération interrompue expose `finish_reason` et, lorsqu’elle est fournie,
`incomplete_reason`. Aucun résultat partiel n’est exécuté.

Pour un handler d’écriture, le code public de l’erreur est conservé ; un reçu
absent ou invalide est signalé séparément. Voir
[Effets externes](effets-idempotents.md#erreur-du-handler-et-état-de-leffet).

### Router plusieurs providers

Un routeur hôte transmet les deux arguments à l’adaptateur choisi :

```js
import { providers } from "./models.mjs";

export function decideAgentCapability(request, execution) {
  const provider = providers.get(request.agent_ref);
  if (!provider) throw new Error("No provider configured for this agent");
  return provider(request, execution);
}
```

`providers` est une Map configurée par l’hôte. `execution` transporte notamment
l’annulation et la remontée des coûts. Conservez cet objet tel quel, séparément
du prompt. Gardez les instances de providers entre les décisions pour préserver
leur historique. Le guide Python présente le même routage avec le contexte
propagé par son canal hôte.

## Transport, délais et diagnostics

Les helpers OpenAI et Ollama acceptent `transport: "responses"` (défaut)
ou `transport: "chat"` pour `/chat/completions`. Le choix est explicite :
Touba utilise le protocole configuré, sans bascule automatique entre les deux.

```js
const decideAgentCapability = createOllamaDecisionProvider({
  model: "YOUR_LOCAL_MODEL",
  transport: "chat",
  decisionInterface: "structured",
  maxOutputTokens: 4096,
  maxRetries: 0,
  timeoutMs: 120000,
  maxProviderRequestBytes: 262144,
});
```

Vérifiez que le serveur et le modèle choisis acceptent le schéma JSON ou les
appels de fonctions demandés. Par défaut, les helpers réservent 4 096 tokens
de sortie, n'effectuent aucune relance automatique et bornent chaque demande
à 120 secondes. Ces valeurs sont configurables. Le runtime applique également
ses budgets et son délai fournisseur ; son annulation est transmise au transport.

Le comptage OpenAI par `context` utilise Responses. Avec Chat Completions,
configurez une limite de corps HTTP et une politique de contexte adaptée au
serveur. Pour le coût, choisissez l'adaptateur `openai-chat` ou
`openai-responses` correspondant. Une requête interrompue sans relevé d'usage
conserve sa réservation jusqu'au rapprochement du coût.

Les observations `inline` sont étiquetées `external_content`. Les valeurs
restent des données externes ; leur exactitude métier se vérifie dans le
programme. `opaque_refs` conserve les références sans transmettre les valeurs.
Les raisons libres du modèle restent hors de la trace publique.
