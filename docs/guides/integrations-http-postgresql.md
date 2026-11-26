# Utiliser les packages HTTP/API et PostgreSQL

Un package fournit le protocole et des contrats réutilisables. Votre programme
choisit les opérations métier ; votre application configure les connexions,
les secrets et les autorisations.

## Installer dans le projet

Depuis le dossier de votre projet, ajoutez les archives obtenues auprès de
l’éditeur du package :

```bash
touba package add ./touba.http-api-1.0.0.tar.gz
touba package add ./touba.sql-effects-1.0.0.tar.gz
touba package check
```

Touba vérifie les fichiers et enregistre leurs empreintes. Les dépendances
sont installées dans `packages/`. Pour un registry, utilisez la commande
fournie sur la page du package et la configuration de confiance de l’opérateur.

| Package | Contenu | Configuration de l’application |
| --- | --- | --- |
| `touba.http-api` | Tool `Read`, type `Response`, clients JavaScript/Python | Origine HTTP autorisée, binding du tool, grant `network` |
| `touba.sql-effects` | Type `WriteReceipt`, transaction et registre d’effets JavaScript/Python | Driver PostgreSQL, connexion, tables, tool métier et contrat d’effet |

## Lire une API

Dans un handler situé à la racine du projet :

```javascript
import { createHttpClient } from './packages/touba.http-api/javascript/client.mjs';

const api = createHttpClient({ baseUrl: 'https://api.example.com' });
const response = await api.request('/catalog');
```

Équivalent Python, après installation du helper dans l’environnement du projet :

```bash
uv pip install ./packages/touba.http-api/python
```

```python
from touba_http_api import create_http_client

api = create_http_client(base_url="https://api.example.com")
response = api.request("/catalog")
```

`response` contient `status`, `body` et `content_type`. Le handler relie ce client
au tool importé `Read`. Le modèle choisit un chemin ; l’origine reste configurée
par l’hôte. Les réponses sont bornées à 1 Mio et le délai réseau à 10 secondes
par défaut. Les redirections sont refusées ; un statut HTTP d’erreur est renvoyé
à l’application pour traitement explicite. Le package couvre les lectures GET.

## Écrire dans PostgreSQL

Le package SQL apporte `applyOnce` en JavaScript et `apply_once` en Python.
Appliquez une fois `packages/touba.sql-effects/sql/schema.sql` avec le compte
administrateur de la base. Le compte du handler reçoit les droits sur ce registre
et sur les seules tables métier nécessaires.

Dans le corps du handler JavaScript, `connect` ouvre une nouvelle connexion
`pg.Client`, `context.effect` est fourni par le SDK et `request` porte l’identifiant :

```javascript
import { applyOnce } from './packages/touba.sql-effects/javascript/ledger.mjs';
import { createToolResult } from '@touba/sdk';

const result = await applyOnce({
  connect, effect: context.effect, operation: 'orders.mark-reviewed',
  write: async ({ query }) => {
    await query('UPDATE orders SET reviewed = true WHERE id = $1', [request]);
    return { value: request, receipt_ref: `order:${request}` };
  },
});
return createToolResult(result.value, { effectReceipt: result.effect_receipt });
```

En Python, installez `packages/touba.sql-effects/python` dans l’environnement
avec `uv pip install` ou `python -m pip install`, puis adaptez le même contrat :

```python
from touba_sql_effects import apply_once
from touba_sdk import create_tool_result

def write(query):
    query("UPDATE orders SET reviewed = true WHERE id = %s", (request,))
    return {"value": request, "receipt_ref": "order:" + request}

result = apply_once(connect=connect, effect=context["effect"],
                    operation="orders.mark-reviewed", write=write)
return create_tool_result(result["value"], effect_receipt=result["effect_receipt"])
```

`connect` fournit une connexion DB-API neuve, par exemple avec `pg8000`.
Le helper ferme la connexion dans les deux SDK. Le callback contient uniquement
les requêtes SQL de cette transaction. La connexion, les délais et les secrets
appartiennent à l’hôte ; le tool déclare ses besoins et le manifest accorde les
droits correspondants. Le [guide des effets](https://toubalang.org/docs/guides/effets-idempotents) montre ce binding.

## Comprendre la reprise

| Situation | Résultat |
| --- | --- |
| Premier appel confirmé | Écriture et reçu enregistrés dans la même transaction |
| Même identité et même requête | Résultat mémorisé ; callback non réexécuté |
| Identité réutilisée pour une requête différente | Refus `SqlEffectConflict` |
| Annulation SQL avec rollback confirmé | Reçu `not_applied` |
| Connexion perdue pendant le COMMIT | Reçu `unknown`, rapprochement avec la même identité |

Le registre doit être conservé tant que des appels peuvent être retentés.
Une compensation est une nouvelle opération métier explicitement déclarée :
voir [compensations](compensations-explicites.md).
