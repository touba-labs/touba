# SDK Python

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


Le SDK Python appelle la même CLI gouvernée que le SDK JavaScript. Les deux guides suivent le même parcours, avec les mêmes concepts et exemples de départ.

## Installation

Depuis la racine de votre application, choisissez le SDK Python :

```sh
touba sdk install python
```

La commande vérifie la wheel livrée avec Touba, la conserve dans
`vendor/touba-sdk/<empreinte>/`, crée ou réutilise `.venv`, puis installe
`touba-sdk` hors ligne. Elle vérifie les imports `ToubaEngine` et `AsyncToubaEngine`.
Aucune installation globale ni publication PyPI n'est nécessaire.
Python 3.11+ avec `venv` et `pip` doit être présent sur la machine.

Pour choisir un interpréteur lors de la création du venv :

```sh
touba sdk install python --python python3.12
```

Un `.venv` existant est conservé ; `--python` ne remplace pas son interpréteur.
Activez-le avant d'exécuter votre application :

```sh
source .venv/bin/activate
python -c "from touba_sdk import ToubaEngine, AsyncToubaEngine; print('SDK ready')"
```

Sous Windows, utilisez `.venv\Scripts\Activate.ps1` ou directement
`.venv\Scripts\python.exe` sans activer le venv.
La commande `touba` doit rester accessible. Pour une autre installation,
passez son chemin absolu à `ToubaEngine(command=...)`.

Pour gérer vous-même un environnement existant, `touba sdk path python`
donne le chemin vérifié de la wheel ; installez-la avec
`python -m pip install --no-index --no-deps --force-reinstall <wheel>`.
Ne commitez pas `.venv` ; conservez l'archive dans `vendor/touba-sdk`.

Sous Windows, le SDK reconnaît le lanceur `touba.cmd` de l’installation et
appelle directement le Node embarqué avec l’entrée CLI, sans interpréteur de
commandes. Les chemins avec espaces et les arguments restent des valeurs
littérales. Un script `.cmd` ou `.bat` personnalisé est refusé : utilisez un
exécutable avec ses arguments séparés. Cette résolution ne constitue pas une
vérification de signature éditeur.

## Mise à jour

Après une mise à jour de Touba, mettez explicitement le SDK du projet à jour :

```sh
touba sdk install python
```

Touba conserve le venv existant et vérifie la nouvelle archive. Les SDK des autres projets ne changent pas.

## Importation

```python
from touba_sdk import ToubaEngine, ToubaEngineError, ToubaHandlerError
from touba_sdk.testing import assert_run_succeeded
```

Le paquet d’installation s’appelle `touba-sdk`, le module importé `touba_sdk`. Les helpers de test sont dans son sous-module `testing`.

## Exécuter un programme

<!-- touba-example: compile -->
```touba title="program.tb"
module sdk.engine
strategy Review
    takes value as Text
    gives Text
    do
        give value
```

```python title="run.py"
from touba_sdk import ToubaEngine

engine = ToubaEngine(project_root=".")
run = engine.run(source="program.tb", inputs={"value": "Invoice 42"})
print(run.status, run.reason, run.result)
```

Dans une application asynchrone, utilisez `AsyncToubaEngine` :

```python
import asyncio
from touba_sdk import AsyncToubaEngine

async def main():
    engine = AsyncToubaEngine(project_root=".")
    run = await engine.run(source="program.tb", inputs={"value": "Invoice 42"})
    print(run.status, run.reason, run.result)

asyncio.run(main())
```

Les noms Python utilisent `snake_case`. Options usuelles :
`entry_ref`, `manifest`, `secrets`, `inputs`, `resource_bindings`,
`supply_chain_lock`, `require_supply_chain_lock`, `effect_journal`,
`agent_decision_provider`, `run_limits`, `max_provider_calls`,
`human_approval_host`, `human_decisions`, `user_inputs`,
`human_checkpoint_out`, `human_resume_checkpoint`,
`parallel_checkpoint_out`, `parallel_resume_checkpoint`,
`trigger_event`, `trigger_state`, `skill_packs` et `active_skill_pack_refs`.
`RunOptions` fournit les types de toutes les options. Les chemins relatifs
partent de `project_root`.

## Compiler un programme

```python
compiled = engine.compile("program.tb")
run = engine.run(air_json=compiled.air_json, inputs={"value": "Invoice 42"})
# compiled.air_document is the parsed object; air_json also accepts this object.
```

Cet extrait prolonge `run.py`. `compile` renvoie `CompileResult` avec `air_json` (texte) et `air_document` (objet). Fournissez exactement une entrée à `run` : `source`, `air` (fichier) ou `air_json` (texte ou dictionnaire). Avec `AsyncToubaEngine`, attendez également `compile` avec `await`.

## Résultats et erreurs

`pendingInteractions` (JavaScript) et `pending_interactions` (Python) exposent
toutes les questions actuellement en attente sous forme `{interaction_ref, prompt}`,
ou `[]`. Le champ singulier désigne la première question pour `user_input_pending`.
Répondez par occurrence avec `userInputs` / `user_inputs`, puis reprenez avec
`parallelResumeCheckpoint` / `parallel_resume_checkpoint`. La liste publique
ne contient aucun état privé de continuation.

`RunResult` expose `status`, `reason`, `result`, `messages`, `pending_interaction` et `trace`. Une pause, un rejet humain ou un arrêt déclaré restent des résultats contrôlés. `ToubaEngineError` porte `phase`, `code` et `details` pour une erreur technique ou un refus du runtime. Les sorties brutes stderr ne sont pas recopiées dans les exceptions.

`engine.version()` identifie la CLI ; `touba_sdk_metadata()` distingue les builds du SDK par leur empreinte.

## Écrire un handler

Après déclaration d’un tool, choisissez Python et générez le handler :

```sh
touba init --language python
touba sdk install python
touba prepare --mode write
```

`prepare` génère le handler `.handler.py`, ses tests de contrat et son binding vers `.venv`. Conservez les constantes et l’appel à `define_tool` générés ; complétez `run(request, context)`, avec `def` ou `async def`. Un seul paramètre est directement `request` ; zéro ou plusieurs paramètres forment un dictionnaire nommé.

`define_tool` gère l’entrée process JSON, `create_tool_handler` adapte le code métier et `handle_tool_request` vérifie l’enveloppe. Les exceptions inattendues sont masquées ; utilisez `ToubaHandlerError` pour un diagnostic public sans secret. Réservez stdout au protocole, pas aux logs.

Suivez le [tutoriel de handlers Python](../tutoriels/handlers-python.md).

## Effets et provenance

La provenance mémoire utilise une enveloppe explicite, séparée des données métier :

```python
from touba_sdk import create_tool_result

return create_tool_result(record, memory_metadata=[
    {"memory_ref": "memory:app/Records", "operation": "read"},
])
```

Cet extrait appartient au corps d’un handler ; `record` est la valeur métier. Une clé `memory_metadata` dans un dictionnaire ordinaire ne crée pas une enveloppe. Le Core vérifie la correspondance au tool, au scope et aux permissions.

`create_effect_receipt` et `create_compensation_receipt` produisent des reçus corrélés. Utilisez les helpers du contexte `create_effect_receipt` et `create_compensation_receipt` après l’effet réel. Un reçu n’accorde aucun droit et ne remplace pas l’idempotence du service externe.

## Tester

```python
from touba_sdk.testing import assert_run_succeeded, assert_trace_events

run = engine.run(source="program.tb", inputs={"value": "Invoice 42"})
assert_run_succeeded(run, "Invoice 42")
```

Cet extrait prolonge `run.py`. `touba_sdk.testing` fournit aussi `create_scripted_decision_provider`, `assert_run_refused` et `assert_trace_events`. Un provider scripté propose des décisions de test, jamais des permissions. Les tests de contrat générés vérifient l’admission ; ajoutez des tests positifs du résultat et des effets métier.

## Reprises et parallélisme

Pour reprendre une attente, transmettez le checkpoint de l’opération, le même journal d’effets et la décision visant l’occurrence attendue. `human_checkpoint_out` et `human_resume_checkpoint` suivent les approbations ; `parallel_checkpoint_out` et `parallel_resume_checkpoint` suivent les groupes parallèles. L’application atteste les identités via `human_approval_host`, jamais via un dictionnaire fourni par le modèle.

`AsyncToubaEngine` permet plusieurs appels avec `asyncio.gather`. Cela ne remplace pas un groupe parallèle déclaré dans le programme Touba, qui conserve ses propres limites et règles de reprise. Voir [traitement parallèle](../tutoriels/traitement-parallele.md) et [approbations](../tutoriels/approbations-roles-delais.md).

`timeout=30` borne le transport ; `cancel_event=threading.Event()` annule un appel synchrone. Avec asyncio, annulez la tâche. Aucun rejeu automatique. POSIX termine le groupe de processus ; Windows termine la CLI sans garantie équivalente sur ses descendants. Un effet peut déjà avoir eu lieu : inspectez le journal avant la reprise.

## Budgets financiers

Le registre `create_sqlite_provider_budget` s’importe depuis `touba_sdk.budget.sqlite`.
Il partage le format SQLite et les refus du SDK JavaScript, avec des options
`snake_case` et des montants entiers en micro-unités. Le branchement aux transports
modèle est distinct. Voir le [guide des coûts fournisseurs](./couts-fournisseurs.md)
et le [tutoriel sans appel payant](../tutoriels/budget-financier.md).

## Capacités complémentaires

Le moteur Python utilise un processus neuf par run. Les adaptateurs de modèles,
l'historique et le bridge MCP disposent d'API Python ; le transport persistant
du moteur entre plusieurs runs reste propre au SDK JavaScript.

## Providers et historique

`create_ai_sdk_decision_provider`, `create_open_ai_decision_provider` et
`create_ollama_decision_provider` suivent les mêmes contrats de décision que
leurs équivalents JavaScript. Ils sont appelables avec `await provider(request)`.
`decision_interface="structured"` est la forme par défaut ; `"native"`
demande des appels de fonctions natifs, toujours admis par le Core avant effet.

```python
from touba_sdk import create_open_ai_decision_provider
from touba_sdk.history.sqlite import create_sqlite_decision_history_store

store = create_sqlite_decision_history_store(filename="history.sqlite")
decide_agent_capability = create_open_ai_decision_provider(
    model="YOUR_MODEL_ID",
    decision_interface="native",
    history={"store": store, "namespace": "support"},
    max_output_tokens=512,
    max_retries=0,
)
```

Cet extrait configure un provider, sans lancer d'appel. Choisissez un modèle
disponible et une clé hôte. Passez le module `.py` à
`agent_decision_provider` ou `--agent-decision-provider`.
La CLI choisit la `.venv` du projet ; `TOUBA_HOST_PYTHON` permet un chemin
d'interpréteur explicite. Le module exporte `decide_agent_capability` ou `decide`.
Un module d'attestation exporte `attest_human_approval` et `initiator_ref`.
Ces modules sont de confiance : leurs chemins ne viennent jamais du modèle.

Les adaptateurs réutilisent le backend Node déjà livré avec Touba, par un
canal privé stdio. La wheel n'installe aucun SDK fournisseur supplémentaire.
Le provider générique accepte les callbacks Python `generate_text`,
`generate_object` et `json_schema` conformes au contrat AI SDK ; un SDK
fournisseur Python brut nécessite l'adaptation explicite de ses messages/résultats.

Sans callback `json_schema`, le schéma JSON est transmis directement à la
fonction Python de génération. Les adaptateurs HTTP acceptent aussi `fetch`
et `count_fetch` : chaque callback reçoit `{url, method, headers, body}` et
renvoie `{status, headers, body}`, avec corps texte et en-têtes chaîne/chaîne.
Ces échanges sont bornés à 8 Mio et restent privés au transport hôte.
Ne journalisez pas leurs en-têtes : ils peuvent contenir les clés fournisseur.

RAM est le stockage par défaut. Pour un store explicite, importez
`create_memory_decision_history_store` de `touba_sdk`. Les options historiques
emploient `max_bytes`, `max_messages`, `max_retained_bytes`,
`max_summary_bytes`, `summarize` et `on_event`. La compaction structurelle
est locale ; seul le callback hôte `summarize`, si fourni, produit un résumé.
Les identifiants d'invocation et les messages natifs restent cohérents avec JS.
SQLite assure la persistance ; RAM ne survit pas à la fermeture du module.
Fermez les providers et stores créés directement avec `close()`.

Le contrôle `context` de l'adaptateur OpenAI expose notamment
`context_window_tokens`, `safety_margin_tokens` et `timeout_ms`.
Contexte et budget monétaire sont deux contrôles distincts. Si vous activez
les deux, le transport de comptage exige son propre tarif explicite.
Une panne du canal n'est jamais rejouée automatiquement.

Voir le [tutoriel provider Python](../tutoriels/sdk-engine-provider-python.md)
et les règles communes d'[historique](./historique-conversationnel.md).

## MCP

`create_mcp_stdio_tool_bridge(mcp_tool_name=..., config=...)` retourne
un handler async `bridge(request, context)`. Le format
`touba-mcp-bridge-config-v1` reste identique à JavaScript.
Python utilise directement un sous-processus stdio borné : pas de serveur Node
supplémentaire dans le handler. Les handles de secrets, limites de temps/taille
et refus sont conservés. L'appel reste derrière l'admission du tool par le Core.

Le verrou supply-chain suit les imports Python statiques et les fichiers de verrouillage du gestionnaire sans exécuter les handlers ni auditer le venv installé. Voir [supply chain](./supply-chain-handlers.md). Pour une application utilisant un framework, voir [orchestration Python](../tutoriels/python-orchestration.md).

## Frontière d’autorité

Les deux SDK passent par la CLI Touba. Le Core vérifie types, droits, secrets, scopes, budgets, sélection agentique, approbations et effets avant dispatch, puis le résultat après retour. Le SDK n’accorde aucune autorité supplémentaire et ne constitue pas une seconde implémentation du langage.

Passez explicitement manifest, secrets et resource bindings. L’Engine ne charge pas automatiquement un `.env`. Les données et références des protocoles restent identiques quel que soit le SDK.

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

```python
from models import providers

async def decide_agent_capability(request):
    provider = providers.get(request["agent_ref"])
    if provider is None:
        raise ValueError("No provider configured for this agent")
    return await provider(request)
```

`providers` contient les adaptateurs initialisés une fois par le module hôte.
Le bridge Python propage le contexte d’invocation et les coûts dans son canal
privé, y compris à travers ce wrapper asynchrone. Gardez l’appel dans ce contexte ;
le prompt contient uniquement la requête métier. Le routeur JavaScript transmet
explicitement son second argument `execution`.
