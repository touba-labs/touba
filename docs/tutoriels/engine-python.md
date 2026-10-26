# SDK Python : appeler Touba

Même programme, mêmes entrées et mêmes résultats que dans l’autre SDK. Aucun modèle, handler ou service externe n’est nécessaire.

## 1. Installer le SDK

Depuis un dossier d’application vide :

```sh title="Terminal"
touba sdk install python
```

```sh
source .venv/bin/activate
```

Python 3.11+ est requis. Sous Windows, utilisez `.venv\Scripts\Activate.ps1`.

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

```python title="run.py"
from touba_sdk import ToubaEngine

engine = ToubaEngine(project_root=".")
run = engine.run(source="program.tb", inputs={"value": "Invoice 42"})
assert run.status == "success", run
assert run.result == "Invoice 42", run
print(run.result)
```

Exécutez `python run.py` : résultat attendu `Invoice 42`.

## 4. Compiler et réutiliser l’AIR

Utilisez cet autre point d’entrée pour compiler une fois, puis transmettre l’AIR au même moteur :

```python title="compiled.py"
from touba_sdk import ToubaEngine

engine = ToubaEngine(project_root=".")
compiled = engine.compile("program.tb")
for air_json in (compiled.air_json, compiled.air_document):
    run = engine.run(air_json=air_json, inputs={"value": "Invoice 42"})
    assert run.status == "success", run
    assert run.result == "Invoice 42", run
print(run.result)
```

Exécutez `python compiled.py`. Même résultat ; le Core conserve toutes les vérifications.

## 5. Vérifier le résultat et les erreurs

Un mauvais type d’entrée doit provoquer un refus, pas un succès silencieux :

```python title="refused.py"
from touba_sdk import ToubaEngine, ToubaEngineError

engine = ToubaEngine(project_root=".")
try:
    engine.run(source="program.tb", inputs={"value": 42})
except ToubaEngineError as error:
    assert error.phase == "run", error
    assert error.details["status"] == "failure", error
else:
    raise AssertionError("An Int must not be accepted as Text")
print("refused")
```

Exécutez `python refused.py`. Une attente humaine ou un arrêt explicite restent, eux, des résultats contrôlés avec `status` et `reason` ; ne les assimilez pas à une erreur technique.

## Vérifier l'exemple complet

```sh title="Terminal"
.venv/bin/python run.py
.venv/bin/python compiled.py
.venv/bin/python refused.py
```

## 6. Continuer avec les handlers

Passez au [tutoriel de handlers Python](./handlers-python.md) pour exécuter du code métier hôte. Le [SDK Python](../guides/sdk-python.md) détaille options, reprises, tests et limites. Comparez le même parcours avec le [SDK JavaScript](./engine-javascript.md).

Dans une application asyncio, utilisez `AsyncToubaEngine` et `await` pour `compile` et `run`, sans appeler le client synchrone depuis la boucle active.
