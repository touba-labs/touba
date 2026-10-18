# SDK Python : écrire un handler

Objectif : déclarer un tool dans Touba, générer son handler Python et l'exécuter
sous le contrôle du Core. Aucun modèle ni service externe n'est nécessaire.

## 1. Installer le SDK

Dans un dossier de projet vide :

```sh
touba init --language python
touba sdk install python
```

Python 3.11+ avec `venv` et `pip` est requis. Le SDK fourni avec Touba
est installé hors ligne dans `.venv`. Activez-le avec
`source .venv/bin/activate` sous macOS/Linux ou
`.venv\Scripts\Activate.ps1` sous Windows.

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

Le contrat métier reste dans Touba. Python fournit l'implémentation du tool.

## 3. Générer et examiner le binding

Passez explicitement les décisions de l'hôte :

```sh
touba prepare --mode write --host-decisions-json '{"bindings":{"tool:sdk.handlers/Normalize":{"grants":[],"effect_contract":{"kind":"none"}}}}'
```

Ce tool transforme seulement du texte : aucun grant ni effet externe.
Pour un accès réseau, fichier ou secret, déclarez les besoins réels et examinez
les décisions hôtes correspondantes. Le SDK ne les accorde jamais à votre place.

`prepare` génère `handlers/sdk/handlers/normalize.handler.py`, son test
`.handler.contract.test.py` et le manifest. Il lit les contrats sans importer
ni exécuter votre code Python.

## 4. Écrire la fonction métier

Dans le handler généré, remplacez seulement le corps de `run` :

```python
async def run(request, context):
    return request.strip().upper()
```

Conservez les constantes et l'appel à `define_tool` générés.
Un `def run(request, context)` synchrone fonctionne également.
Ici, `request` est directement le texte ; avec plusieurs paramètres Touba,
ce serait un dictionnaire portant leurs noms.

## 5. Tester et exécuter

Vérifiez le contrat d'admission :

```sh
python handlers/sdk/handlers/normalize.handler.contract.test.py
```

Ajoutez aussi vos tests métier : les tests générés ne prouvent pas que la
transformation répond à votre besoin.

```python title="run.py"
from touba_sdk import ToubaEngine

engine = ToubaEngine(project_root=".")
result = engine.run(
    source="src/sdk/handlers.tb",
    manifest=".touba/build/dev/touba.manifest.json",
    inputs={"value": "  invoice 42  "},
)
assert result.status == "success", result
assert result.result == "INVOICE 42", result
print(result.result)
```

Exécutez `python run.py`. Le résultat attendu est `INVOICE 42`.
Le Core vérifie les types, l'admission du tool et la trace, quel que soit
le langage hôte du handler.

## 6. Verrouiller les fichiers

Pour séparer le code métier, ajoutez ce fichier à côté du handler :

```python title="handlers/sdk/handlers/helpers.py"
def normalize(value):
    return value.strip().upper()
```

Dans le handler, ajoutez `from helpers import normalize` et utilisez
`return normalize(request)` dans `run`. L'import local sera suivi par Touba.
À la racine du projet, créez son identité Python minimale :

```toml title="pyproject.toml"
[project]
name = "business-handlers"
version = "0.1.0"
```

Le SDK est déjà installé depuis sa wheel locale. Pour d'autres dépendances,
déclarez-les dans `pyproject.toml` et fournissez le verrou de votre gestionnaire,
comme expliqué dans le [guide supply chain](../guides/supply-chain-handlers.md).

```sh
touba compile src/sdk/handlers.tb --out program.air.json
touba supply-chain generate --air program.air.json \
  --manifest .touba/build/dev/touba.manifest.json --out touba.lock.json
touba supply-chain validate --air program.air.json \
  --manifest .touba/build/dev/touba.manifest.json --lock touba.lock.json
```

Le verrou inclut le handler, `helpers.py` et `pyproject.toml`. Modifier
`helpers.py` après génération entraîne un refus à la validation, avant
l'appel du handler lorsque ce verrou est exigé à l'exécution. Aucune fonction
Python du projet n'est exécutée pendant l'inventaire.

La revue reste en attente et l'identité SDK reste inconnue sans métadonnées
explicites : ces avertissements sont attendus, pas une qualification production.
Examinez réellement le verrou et ses dépendances avant d'approuver une revue.

## Pour un handler à effets

Utilisez un contrat d'effet adapté et rendez un reçu corrélé à l'exécution
réelle, jamais un reçu fabriqué avant l'opération. Les helpers Python
`create_tool_result`, `create_effect_receipt` et
`create_compensation_receipt` couvrent les mêmes enveloppes que JavaScript.
Un reçu ne garantit pas à lui seul l'idempotence du service externe.

Consultez le [SDK Python](../guides/sdk-python.md) pour les secrets, erreurs,
reçus et limites actuelles, et le
[tutoriel d'approbation](./approbations-roles-delais.md) pour la reprise gouvernée.
