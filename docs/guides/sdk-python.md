# SDK Python

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


Le SDK Python appelle la même CLI gouvernée que le SDK JavaScript. Les deux guides suivent le même parcours, avec les mêmes concepts et exemples de départ.

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

Depuis la racine de votre application, choisissez le SDK Python :

```sh
touba sdk install python
```

La commande vérifie la wheel livrée avec Touba, la conserve dans
`vendor/touba-sdk/<empreinte>/`, crée ou réutilise `.venv`, puis installe
`touba-sdk` hors ligne. Elle vérifie les imports `ToubaEngine` et `AsyncToubaEngine`.
Aucune installation globale ni publication PyPI n'est nécessaire.
Python 3.11+ doit être présent, avec `uv` ou `venv` et `pip`.

### Choisir le gestionnaire

```sh
touba sdk install python --manager uv
touba sdk install python --manager pip
```

Sans option, `auto` sélectionne `uv` si le projet contient `uv.lock`,
sinon `pip`. Le gestionnaire choisi doit être installé.
Avec `uv` et un `pyproject.toml`, Touba inscrit la wheel locale dans les
dépendances et actualise `uv.lock` hors ligne. Un prochain `uv sync`
conserve donc le SDK. Sans projet Python déclaré, seul le venv est préparé.

La résolution hors ligne d'un projet uv existant nécessite que ses autres
dépendances soient déjà disponibles dans le cache uv. Touba installe uniquement
sa wheel ; la synchronisation du reste du projet reste à votre initiative.
Pour Poetry, PDM ou un autre gestionnaire, utilisez l'archive vérifiée fournie
par `touba sdk path python` avec votre gestionnaire.

Pour choisir un interpréteur lors de la création du venv :

```sh
touba sdk install python --python python3.12
```

Un `.venv` existant est conservé ; `--python` ne remplace pas son interpréteur.

Le répertoire `.venv` appartient au projet : un lien symbolique vers un autre
environnement est refusé. Si `prepare` signale cette disposition, créez un
environnement dédié et relancez `touba sdk install python`. Conservez l’ancien
environnement tant que ses dépendances servent à d’autres projets.
Activez-le avant d'exécuter votre application :

```sh
source .venv/bin/activate
python -c "from touba_sdk import ToubaEngine, AsyncToubaEngine; print('SDK ready')"
```

Sous Windows, utilisez `.venv\Scripts\Activate.ps1` ou directement
`.venv\Scripts\python.exe` sans activer le venv.
La commande `touba` doit rester accessible. Pour une autre installation,
passez son chemin absolu à `ToubaEngine(command=...)`.

Conservez `vendor/touba-sdk` et vos déclarations de dépendances dans Git ;
excluez `.venv`. Dans un projet uv, conservez aussi `uv.lock`.

Sous Windows, le SDK reconnaît le lanceur `touba.cmd` de l’installation et
appelle directement le Node embarqué avec l’entrée CLI, sans interpréteur de
commandes. Les chemins avec espaces et les arguments restent des valeurs
littérales. Un script `.cmd` ou `.bat` personnalisé est refusé : utilisez un
exécutable avec ses arguments séparés. Cette résolution ne constitue pas une
vérification de signature éditeur.

## Mise à jour

### Conserver un historique au repos

Dans le candidat 1.5.0, `engine.adopt_state(reason="Mise à jour revue")` produit
un aperçu hors ligne pour la toolchain courante. Après revue et confirmation par
l'exploitant, rappeler la méthode avec le même motif et
`accept=preview["review_digest"]`. `AsyncToubaEngine` propose la même méthode
asynchrone. `max_backup_bytes` borne le volume à sauvegarder.

Le serveur doit être arrêté. Les attentes, opérations inachevées et effets
incertains bloquent l'adoption. Les historiques conservent leur provenance.
`engine.adopt_state(recover=True)` résout une interruption après vérification
du reçu et des octets, sans restauration de store ni rejeu d'opération.
Voir [le guide de conservation](stockage-et-conservation.md).


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

Pour utiliser l'entrée, le profil et les ressources d'un projet préparé :

```python
result = engine.run(project=".", profile="dev")
```

Choisissez `project` ou l'une des entrées `source`, `air`, `air_json`.
Le mode projet charge les fichiers de ressources explicitement déclarés et
vérifie leurs empreintes. Les modes AIR/source utilisent les options fournies
par l'hôte. `resource_bindings` remplace explicitement l'ensemble préparé.

Pour une inverse métier, `engine.create_compensation(**options)` puis
`engine.resume_compensation(**options)` fournissent le parcours hôte décrit dans
[Compensations explicites](compensations-explicites.md).
`AsyncToubaEngine` expose les mêmes méthodes avec `await`.

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

Deux codes d’admission utiles, disponibles dans les deux SDK :

| `error.code` | Action |
| --- | --- |
| `ProjectEntrypointNotAllowed` | Choisir une entrée déclarée dans `touba.project.json`, ou la déclarer puis préparer le projet. |
| `EffectJournalBusy` | Attendre la libération du journal par son processus détenteur. |

Ces refus arrivent avant l’exécution, avec `ToubaEngine` comme `AsyncToubaEngine`.

### Conserver les traces

```python
run = engine.run(source="program.tb", trace_store=".touba/traces.sqlite")
```

SQLite conserve les traces par défaut dans `.touba/traces.sqlite`, à la racine
du projet de l’engine. Le chemin ci-dessus peut être personnalisé. Chaque segment
reste disponible après la fin du processus ; `traceOut` / `trace_out` permet
en plus un export JSON. L’archivage est décrit dans la [référence traces](../reference/traces-v1-rc.md#conserver-les-traces).

Pour une longue trace, choisissez `trace_mode="reference"`. Le résultat métier
revient après la finalisation du journal, avec `trace_reference`
et `trace` à `None`. Lisez ensuite les événements par pages :

```python
trace_store = ".touba/traces.sqlite"
run = engine.run(
    source="program.tb", trace_store=trace_store, trace_mode="reference",
)
after = None
while True:
    page = engine.read_trace(
        trace_store=trace_store, reference=run.trace_reference,
        after=after, limit=100,
    )
    for event in page["events"]:
        print(event["kind"])
    if page["done"]:
        break
    after = page["next"]
```

`read_trace` utilise le lecteur Core en lecture seule. `limit` accepte 1 à
1 000 événements ; le contenu des événements d'une page est limité à 1 Mio.
Un échec runtime expose sa référence dans `error.details["trace_reference"]`.
La référence sert à la lecture ; la reprise d'exécution utilise son checkpoint.
Conservez la référence et le journal pour reprendre la lecture après un
redémarrage. Commencez sans curseur pour vérifier l'empreinte du segment complet ;
les pages suivantes contrôlent leurs événements et leur ordre.

Avec `AsyncToubaEngine`, utilisez `await engine.run(...)` et
`await engine.read_trace(...)` avec les mêmes paramètres.

En mode intégral, `trace` contient le document complet. La limite de transport
de 32 Mio s'applique aux réponses SDK, y compris au résultat métier et aux
messages. Une trace longue peut être conservée et lue par pages sans augmenter
cette limite. Voir la [référence traces](../reference/traces-v1-rc.md#conserver-les-traces).

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


La sortie standard d’un handler process est réservée au protocole JSON.
Pour les journaux, utilisez `console.error` en JavaScript ou
`print(message, file=sys.stderr)` en Python, sans secrets ni données personnelles.
Une sortie parasite entraîne `ToolHandlerInvalidJson` ; un effet déjà produit
n’est pas annulé par cette erreur. Vérifiez son état avant de relancer une écriture.

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

`AsyncToubaEngine` permet plusieurs appels avec `asyncio.gather`. Cela ne remplace pas un groupe parallèle déclaré dans le programme Touba, qui conserve ses propres limites et règles de reprise. Voir [traitement parallèle](https://toubalang.org/docs/tutoriels/traitement-parallele) et [approbations](../tutoriels/approbations-roles-delais.md).

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
et les règles communes d'[historique](https://toubalang.org/docs/guides/historique-conversationnel).

## MCP

L'importeur MCP génère `requires network` et le grant correspondant dans son brouillon. Pour un serveur stdio strictement local, révisez ensemble la déclaration et le manifest : `network` n'est pas imposé par le transport stdio. Les droits `process` exigés par le profil d'isolation restent nécessaires. Un serveur qui contacte Internet doit conserver l'autorisation réseau.

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
[Effets externes](https://toubalang.org/docs/guides/effets-idempotents#erreur-du-handler-et-état-de-leffet).

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

## Transport, délais et diagnostics

`transport="responses"` (défaut) et `transport="chat"` sélectionnent
respectivement Responses et Chat Completions, pour OpenAI comme Ollama.
Les mêmes réglages qu'en JavaScript existent en Python :
`max_output_tokens=4096`, `max_retries=0`, `timeout_ms=120000` par défaut.
Le transport reste celui choisi par l'hôte ; un endpoint compatible doit
prendre en charge les sorties structurées ou les appels de fonctions utilisés.

Les codes `PythonHostImportFailed`, `PythonHostConfigurationInvalid`,
`PythonHostCallbackFailed`, `PythonHostTlsFailed`,
`PythonHostTransportFailed` et `PythonHostTimeout` identifient l'étape en défaut.
Pour obtenir la classe d'erreur et sa ligne locale sans copier les messages,
définissez `TOUBA_PYTHON_HOST_DIAGNOSTICS` vers un nouveau fichier privé.
Le fichier est borné à 64 Kio et créé avec des droits restreints. Les traces
publiques conservent seulement les codes structurés.

Une annulation arrête le processus du module hôte Python et ses demandes
en cours. L'application décide ensuite d'une nouvelle exécution.
Les imports de `touba_sdk` chargent à la demande les composants utilisés ;
un handler simple n'initialise pas les bridges de modèles, MCP ou SQLite.

Le guide [SDK JavaScript](./sdk-javascript.md#transport-délais-et-diagnostics)
détaille les limites de corps HTTP, de contexte et de coût communes aux deux SDK.

### Choisir Python avec uv

`--python` accepte un exécutable explicite. Pour un nouvel environnement, Touba
résout et vérifie cet interpréteur avant de transmettre son chemin exact au
gestionnaire. Une `.venv` existante est conservée et sa version est vérifiée ;
l’option ne recrée pas silencieusement cet environnement. Un Python trop ancien
produit un diagnostic invitant à choisir Python 3.11 ou plus récent.

## Examiner les anciennes archives SDK


`touba sdk clean python --root .` produit un aperçu JSON : archives
référencées ou protégées, candidats, octets récupérables et `reviewDigest`.
Après arrêt des installations en cours et relecture, passer cette empreinte
avec `--accept <reviewDigest>`. `--keep <sha256,...>` protège explicitement des
archives de retour arrière. Le mode JavaScript utilise `clean javascript`.

Le contrôle porte sur les seules archives gérées de `vendor/touba-sdk`, reconnues
par leur empreinte et leur nom. Les références du projet et de ses sous-projets
sont examinées avec des bornes de lecture. Les archives inconnues ou modifiées,
les symlinks et les références non vérifiables sont conservés. Une `.venv`
protège les wheels Python ; les états d’exécution présents protègent les archives.
Les fichiers privés sont laissés non lus et rendent le retrait conservateur.
L’installation ne supprime aucune archive automatiquement. Les verrous et
manifests ne sont pas réécrits ; le nettoyage conserve les références actuelles
et les archives choisies pour une installation hors ligne.
