---
sidebar_position: 10
---

# Budgets financiers des fournisseurs

Les compteurs `limits run` bornent le travail du runtime. Le registre financier
du SDK borne séparément les dépenses des appels passant par un transport hôte.
Les prix restent dans votre configuration : Touba n'intègre aucun tarif modèle.

## Ouvrir un budget durable

Créez un répertoire privé pour l'état de l'application. Réutilisez le même
fichier et le même identifiant pour les sous-agents, retries et reprises d'une
même opération. Un nouvel identifiant représente un nouveau budget, pas une
reprise. Ici, le plafond est de 10 USD : un dollar vaut 1 000 000 micro-unités.

```javascript
import { mkdirSync } from "node:fs";
import { createSqliteProviderBudget } from "@touba/sdk/budget/sqlite";

mkdirSync(".touba/private", { recursive: true, mode: 0o700 });
const budget = createSqliteProviderBudget({
  filename: ".touba/private/provider-costs.sqlite",
  budgetId: "invoice-batch-2026-10",
  currency: "USD",
  limitMicros: 10_000_000n,
});
console.log(budget.snapshot().remainingMicros.toString());
budget.close();
```

L'équivalent Python utilise le même format SQLite et les mêmes opérations :

```python
from pathlib import Path
from touba_sdk.budget.sqlite import create_sqlite_provider_budget

Path(".touba/private").mkdir(parents=True, exist_ok=True, mode=0o700)
budget = create_sqlite_provider_budget(
    filename=".touba/private/provider-costs.sqlite",
    budget_id="invoice-batch-2026-10",
    currency="USD",
    limit_micros=10_000_000,
)
print(budget.snapshot()["remaining_micros"])
budget.close()
```

JavaScript utilise `bigint`, Python `int`. Un montant flottant est refusé.
Pour sérialiser un snapshot JavaScript en JSON, convertissez explicitement les
montants en chaînes décimales. Le registre ne convertit pas les devises.

Réouvrir avec un plafond supérieur conserve le plafond précédent. Un plafond
inférieur s'applique à toutes les connexions ; il n'annule pas les appels en vol.

## Brancher le transport JavaScript

`createProviderCostFetch`, importé de `@touba/sdk`, reçoit quatre options :

| Option | Rôle |
| --- | --- |
| `budget` | Registre partagé, gardé ouvert pendant les appels |
| `quote(request)` | Borne de coût établie par l'hôte pour la requête HTTP finale |
| `readUsage(response, quote)` | Usage fournisseur valorisé au même tarif |
| `fetch` | Transport HTTP sans retry caché ; `globalThis.fetch` par défaut |

Passez le résultat dans l'option `fetch` de votre SDK fournisseur, au niveau le
plus bas. Ainsi, chaque retry repasse par une réservation. Avec le prévol de
contexte Touba, employez ce transport pour **fetch et countFetch** : une requête
de comptage doit elle aussi avoir un coût connu, éventuellement nul selon le
contrat fournisseur. Ne laissez pas un autre chemin HTTP facturable hors registre.

Le callback `quote` doit retourner `basis: "upper_bound"`, `maxCostMicros`,
`currency`, `tariffId` et `tariffDate` (format `YYYY-MM-DD`). Il doit vérifier le
modèle, l'entrée entière, la sortie maximale et les frais additionnels pertinents.
Une estimation moyenne, le prix d'un autre modèle ou un nombre de tokens choisi
par le modèle ne sont pas des bornes. Une borne absente refuse l'envoi.
Un appel déclaré gratuit doit aussi être justifié par le contrat fournisseur.

Le callback `readUsage` retourne l'un de ces objets :

```javascript
const reported = { kind: "reported", costMicros: 230n };
const estimated = { kind: "estimated", costMicros: 240n };
const unknown = { kind: "unknown" };
```

Ce sont des formes de contrat, pas des prix réels. `reported` signifie « usage
retourné par le fournisseur, valorisé au tarif hôte » et non « facture vérifiée ».
Lisez les métadonnées d'usage, jamais un montant produit dans le texte du modèle.
Seul `reported` peut libérer la différence avec la réservation. Une réponse sans
usage, un timeout du lecteur d'usage (5 secondes par défaut), une réponse SSE ou
une coupure conserve la borne entière. L'option `usageTimeoutMs` ajuste ce délai.
Les redirections HTTP automatiques sont refusées.

Le registre Python dispose de `reserve`, `settle`, `attempt`, `list_attempts`,
`snapshot` et `close`. Le provider HTTP Python peut utiliser ce même registre
avec `token_cost`, sans copier le solde ni ouvrir un nouveau budget.
Les options Python utilisent `snake_case`.

## Adaptateurs tarifaires

`createProviderTokenCostAdapter` valorise les tokens au tarif **fourni par
l'hôte**. Les protocoles pris en charge sont `openai-responses`,
`openai-chat`, `anthropic-messages` et `google-generate-content`.
Aucun prix fournisseur n'est codé dans le SDK.

`tariff` contient `id`, `date`, `currency` et `rates`. Les taux sont des
micro-unités **par million de tokens** : `input`, `output`, puis si nécessaire
`cacheRead`, `cacheWrite5m`, `cacheWrite1h`. Ce sont des `bigint` en JS ;
Python emploie des `int` et les noms `cache_read`, `cache_write_5m`,
`cache_write_1h`. Le calcul arrondit vers le haut une seule fois après la
somme exacte des produits.

`inputTokenBound` reçoit la requête finale complète, historique et schémas
inclus. Il retourne `{ basis: "upper_bound", tokens: n }` sur une justification
hôte. Un endpoint qui ne fournit qu'une estimation ne devient pas une borne.
Le modèle exact et la sortie maximale doivent correspondre au tarif.

```javascript
import { createOpenAiDecisionProvider, createProviderTokenCostAdapter } from "@touba/sdk";

export function buildProvider({ model, tariff, inputTokenBound, budget }) {
  const adapter = createProviderTokenCostAdapter({
    protocol: "openai-responses", model, tariff, inputTokenBound,
  });
  return createOpenAiDecisionProvider({
    model, maxOutputTokens: 512, maxRetries: 0,
    cost: { budget, ...adapter },
  });
}
```

Équivalent Python, avec le registre ouvert précédemment :

```python
from touba_sdk import create_open_ai_decision_provider, create_provider_token_cost_adapter

def build_provider(*, model, tariff, input_token_bound, budget):
    adapter = create_provider_token_cost_adapter(
        protocol="openai-responses", model=model, tariff=tariff,
        input_token_bound=input_token_bound, budget=budget,
    )
    return create_open_ai_decision_provider(
        model=model, max_output_tokens=512, max_retries=0, token_cost=adapter,
    )
```

En Python, la borne reçoit un dictionnaire `url`, `method`, `headers`,
`body` plutôt qu'un objet HTTP JavaScript. Ces callbacks appartiennent à
l'hôte ; ne journalisez pas les en-têtes, qui peuvent contenir une clé.

Le périmètre est le texte et les propositions de fonctions locales. Médias,
outils exécutés par le fournisseur, historique distant et options non tarifées
sont refusés plutôt que supposés gratuits. Les tokens de raisonnement OpenAI
déjà inclus dans la sortie ne sont pas comptés deux fois. Les écritures et
lectures de cache Anthropic sont séparées ; Gemini ajoute les tokens de pensée
et exige une borne de pensée explicite. D'autres options nécessitent un
adaptateur hôte qualifié.

Avec `context` et `cost` simultanés, JS exige `cost.counting = { quote,
readUsage }`. Python accepte `counting={"quote": ..., "read_usage": ...}`
dans son adaptateur ; les résultats utilisent `max_cost_micros`,
`tariff_id`, `tariff_date` et `cost_micros`. Le comptage utilise le même
budget. Zéro n'est acceptable que si le contrat fournisseur le justifie.

## Corrélation aux traces

Lorsqu'un provider tourne dans le Core, le registre relie chaque tentative à
`run_id`, `invocation_id`, `agent_ref` et `step_index`.
Les événements `provider_cost_recorded` conservent réservation, statut,
devise et identifiant/date du tarif, sans requête, réponse brute ni secret.
Le montant est une chaîne décimale de micro-unités. Après fermeture d'une
invocation, une réponse tardive peut réconcilier SQLite mais ne modifie pas la
trace terminale. Un refus de plafond ne relance pas le provider.

## Reprise et diagnostic

`snapshot()` distingue plafond, montant engagé, solde, blocage et nombre de
tentatives `pending`, `reported`, `estimated`, `unknown`. Un coût inconnu est
`null` (Python `None`), jamais zéro. Le montant engagé inclut les réservations
encore non réconciliées : ce n'est pas un total de factures.

Après un arrêt, `listAttempts({status: "pending"})` retrouve les identifiants
dont l'envoi ou le retour reste incertain. Utilisez `afterId` et `limit` pour
paginer (100 par défaut, maximum 1000), après arrêt des workers pour un inventaire
exhaustif. Python expose `list_attempts(status="pending", after_id=..., limit=...)`.
Un administrateur hôte peut appliquer `settle(id, usage)` sur preuve fournisseur.
Le temps écoulé, le redémarrage et l'absence de réponse ne prouvent pas la gratuité.

| Refus | Conséquence |
| --- | --- |
| `ProviderCostBoundUnavailable` | Aucun envoi sans borne connue |
| `ProviderCostBudgetExceeded` | Solde insuffisant, aucun nouvel envoi |
| `ProviderCostBoundViolated` | Coût supérieur à la borne enregistré ; budget bloqué |
| `ProviderBudgetStorageUnavailable` | Registre inaccessible, aucun nouvel envoi |

## Portée de la garantie

Le registre protège un plafond applicatif sous les hypothèses du tarif hôte et
de la borne fournie. Il ne certifie pas ces hypothèses ni les factures, et ne
contrôle pas les appels effectués hors du transport protégé. Les adaptateurs
doivent être qualifiés sur les modèles et options réellement utilisés.

Le fichier SQLite appartient à l'hôte de confiance, sur disque local, dans un
répertoire privé. Conservez-le avec l'état de reprise ; le supprimer remettrait
la comptabilité à zéro. Aucun prompt, secret ni réponse brute n'y est conservé.

Voir le [tutoriel sans appel payant](../tutoriels/budget-financier.md) et les
[budgets d'autonomie](./budgets-autonomie.md).
