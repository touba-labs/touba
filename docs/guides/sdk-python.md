# Appeler Touba depuis Python

Le package `touba-sdk` fournit `Engine` et `AsyncEngine` pour appeler la CLI
Touba installée. Python 3.11 minimum ; aucune dépendance Python à l’exécution.
L’admission, les droits, les budgets et les traces restent ceux du Core.

## Installation hors ligne

Créez un environnement virtuel et consultez `touba version --json` :
`distribution.python_sdk_archive` donne la wheel livrée avec la toolchain.
Installez cette archive dans votre venv, sans registre :

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --no-index --no-deps /chemin/vers/touba_sdk-0.1.0-py3-none-any.whl
```

Remplacez le chemin par celui affiché. Sous Windows, activez
`.venv\Scripts\Activate.ps1`. La wheel n’embarque pas le compilateur :
la commande `touba` doit être accessible. Pour une autre installation,
passez son chemin absolu à `Engine(command=...)`.
Conservez la wheel et son checksum. Pour changer de build V1 à numéro
identique, utilisez `--force-reinstall` sur la nouvelle archive validée.

## Un programme, deux styles d’appel

<!-- touba-example: compile -->
```touba title="program.tb"
module example.python
strategy Review
    takes value as Text
    gives Text
    do
        give value
```

```python
from touba_sdk import Engine

engine = Engine(project_root=".")
run = engine.run(source="program.tb", inputs={"value": "Invoice 42"})
print(run.status, run.reason, run.result)
```

Dans une application asynchrone :

```python
import asyncio
from touba_sdk import AsyncEngine

async def main():
    engine = AsyncEngine(project_root=".")
    air = await engine.compile("program.tb")
    run = await engine.run(air_document=air, inputs={"value": "Invoice 42"})
    print(run.status, run.reason, run.result)

asyncio.run(main())
```

`source` recompile le programme ; `air` désigne un fichier déjà compilé et
`air_document` un dictionnaire AIR. Fournissez exactement une de ces options.
L’Engine Python utilise un processus neuf par appel. Il ne lance pas de serveur.
Le mode persistant décrit dans le [SDK JavaScript](./sdk-touba.md) est une
option du client JavaScript, pas une option Python implicite.

## Options et issues

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

`RunResult` expose `status`, `reason`, `result`, `messages`,
`pending_interaction` et `trace`. Une pause, un rejet humain ou un arrêt
déclaré restent des résultats contrôlés. `EngineError` porte `phase`,
`code` et `details` pour une erreur technique ou un refus du runtime.
Les sorties brutes stderr ne sont pas recopiées dans les exceptions.
`engine.version()` expose l’identité de la CLI ; `sdk_metadata()` distingue
les builds du client Python par leur empreinte.

Pour une reprise, fournissez le checkpoint de l’opération, le même journal
d’effets et la décision visant l’occurrence attendue. Ne repartez pas du début
pour simuler une reprise. Les rôles et identités sont attestés par
`human_approval_host`, le module hôte de confiance de la CLI, pas par un
dictionnaire Python fourni par le modèle. Voir
[approbations, rôles et délais](../tutoriels/approbations-roles-delais.md).

`timeout=30` borne une opération de transport ; `cancel_event=threading.Event()`
permet l’annulation synchrone. Avec asyncio, annulez la tâche attendue.
Les processus sont arrêtés et aucun appel n’est relancé automatiquement.
Sur POSIX, l’arrêt vise le groupe de processus ; Windows vise le processus
CLI sans garantie équivalente sur ses descendants. Une annulation peut
survenir après un effet externe : inspectez le journal avant toute reprise.

Le SDK pilote Touba ; il ne génère pas encore des handlers Python avec
`touba init --language python`. Une application Python peut appeler un projet
Touba existant dont les handlers respectent le protocole process.
Le [tutoriel d’orchestration](../tutoriels/python-orchestration.md) montre
comment ajouter cette frontière à un programme Python.
