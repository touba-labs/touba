# Tutoriel - SDK Python, engine et provider

Relier un provider Python au vrai Core, conserver l'historique dans SQLite et
vérifier le résultat. Cette recette est entièrement locale : aucune clé API,
aucun appel modèle et aucun tarif fictif présenté comme un tarif fournisseur.

## 1. Installer le SDK du projet

Depuis un répertoire de projet, après installation de Touba :

```sh
touba sdk install python
source .venv/bin/activate
```

Sous Windows, utilisez `.venv\Scripts\Activate.ps1`. Gardez `touba` accessible
dans le terminal. Voir le [guide SDK Python](../guides/sdk-python.md).

## 2. Déclarer le programme

<!-- touba-example: compile -->
```touba title="program.tb"
module sdk.provider
agent Reviewer
    gives Text
    responsibility "Return the text Ready."
    callable_by strategy Run
strategy Run
    gives Text
    uses Reviewer
    do
        Reviewer
            into result
        give result
```

## 3. Brancher le provider et l'historique

```python title="provider.py"
from pathlib import Path
from touba_sdk import create_ai_sdk_decision_provider
from touba_sdk.history.sqlite import create_sqlite_decision_history_store

Path(".touba/private").mkdir(parents=True, exist_ok=True, mode=0o700)
store = create_sqlite_decision_history_store(
    filename=".touba/private/history.sqlite"
)

async def generate(options):
    # Deterministic teaching example, not a model call.
    return {
        "finishReason": "stop",
        "object": {"decision": {
            "action": "answer_directly",
            "source": "tutorial",
            "reason": "The requested text is available.",
            "result": "Ready",
        }},
    }

decide_agent_capability = create_ai_sdk_decision_provider(
    model="offline-demo",
    generate_object=generate,
    json_schema=lambda schema: schema,
    history={"store": store, "namespace": "tutorial"},
)
```

Le callback `generate` produit ici une réponse de test déterministe au format
attendu par l'adaptateur. Dans une application modèle, utilisez le transport de
votre fournisseur ou une factory comme `create_open_ai_decision_provider`.
Le type de retour et les actions proposées restent contrôlés par le Core.

SQLite est fourni par le backend embarqué avec Touba : aucun serveur de base de
données à installer. L'historique est lié aux identifiants de run et d'invocation,
pas au seul nom de l'agent. Une nouvelle exécution ne réutilise pas implicitement
une conversation terminée. Pour la durée du module, RAM convient aussi :
omettez simplement `history` pour le comportement par défaut.

## 4. Exécuter et vérifier

```python title="app.py"
from touba_sdk import ToubaEngine
from touba_sdk.testing import assert_run_succeeded

engine = ToubaEngine(project_root=".")
run = engine.run(
    source="program.tb",
    entry_ref="strategy:sdk.provider/Run",
    agent_decision_provider="provider.py",
    timeout=20,
)
assert_run_succeeded(run, "Ready")
print(run.result)
```

```sh
python app.py
```

Résultat attendu : `Ready`. Le module Python est chargé depuis le projet ;
stdout reste réservé au protocole. Vos logs de module peuvent utiliser stderr.
La CLI ferme le module et le backend à la fin du run ; SQLite reste sur disque.

## 5. Passer à un modèle

Le [guide SDK Python](../guides/sdk-python.md) montre la factory HTTP et
`decision_interface="native"`. Fournissez un modèle disponible, sa clé par
l'environnement hôte et un budget adapté avant de lancer un appel payant.
Les deux interfaces gardent la même admission Core. L'adaptateur générique
accepte aussi `generate_text` et `json_schema`, avec le contrat AI SDK.

Pour borner le contexte, lisez [historique et compaction](https://toubalang.org/docs/guides/historique-conversationnel).
Les limites d'historique ne sont pas un plafond financier ; celui-ci se branche
séparément selon le [guide des coûts](../guides/couts-fournisseurs.md).
