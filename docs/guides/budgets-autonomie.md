---
sidebar_position: 9
---

# Budgets d’autonomie

Les budgets d’autonomie limitent une exécution Touba. Ils servent à refuser une exécution qui dépasserait un périmètre borné : durée de run, nombre d’étapes, nombre d’appels tools, nombre d’invocations agents ou nombre d’appels au decision provider agentique.

Ils ne mesurent pas les coûts facturés par un fournisseur LLM, les tokens, les quotas d’équipe ou la conformité réglementaire. Les dépenses passant par un transport hôte peuvent être bornées séparément par le [registre financier du SDK](./couts-fournisseurs.md).

## Syntaxe d’usage

### Dans la source Touba

<!-- touba-example: compile -->
```touba
module examples.bounded

limits run
    max_run_ms as 30000
    max_steps as 100
    max_tool_calls as 20
    max_agent_invocations as 5
    max_provider_calls as 10
```

Un seul bloc `limits run`, après les imports et avant les déclarations, fixe les plafonds du run entier. Chaque valeur est un littéral Int strictement positif, au plus `9007199254740991`. Le compilateur conserve la localisation source dans l’AIR ; aucune édition manuelle de JSON n’est nécessaire.

Une capacité peut être réutilisée tant que son autorité et le budget le permettent. Les sous-agents partagent les compteurs du run ; une reprise humaine conserve la consommation précédente. À l’assemblage, les plafonds du module d’entrée et des modules dont une déclaration exécutable est liée sont combinés par minimum. Importer uniquement un type, une constante ou une mémoire ne transfère pas les plafonds de son module.

### Par CLI

```sh title="Terminal"
touba run program.air.json \
  --max-run-ms 30000 \
  --max-steps 100 \
  --max-tool-calls 20 \
  --max-agent-invocations 5 \
  --max-provider-calls 4 \
  --output trace
```

### Par JSON CLI

```sh title="Terminal"
touba run program.air.json \
  --run-limits-json '{"max_steps":100,"max_tool_calls":20}' \
  --output trace
```

### Par manifest

```json title="touba.manifest.json"
{
  "manifest_version": "touba-manifest-v1",
  "run_limits": {
    "max_steps": 100,
    "max_tool_calls": 20,
    "max_agent_invocations": 5,
    "max_provider_calls": 4
  },
  "bindings": {}
}
```

Puis :

```sh title="Terminal"
touba run program.air.json \
  --manifest touba.manifest.json \
  --output trace
```

## Budgets disponibles

| Budget | Rôle |
| --- | --- |
| `max_run_ms` | Durée maximale du run, observée aux frontières runtime |
| `max_steps` | Nombre maximal de nœuds runtime consommés |
| `max_tool_calls` | Nombre maximal de dispatchs tools |
| `max_agent_invocations` | Nombre maximal d’invocations agents |
| `max_provider_calls` | Nombre maximal d’appels au decision provider agentique |
| `max_runs_per_day` | Quota de trigger, porté par les limites de trigger |

## Différence avec timeout

`--run-timeout-ms` est un contrôle d’annulation d’exécution. Quand il est observé, le run se termine en `cancelled`.

`--max-run-ms` est un budget d’autonomie. Quand il est dépassé, le run échoue avec un événement budget et un statut final `failure`.

## Règle de restriction

Quand plusieurs sources déclarent une limite, la limite effective est la plus restrictive.

Le manifest peut restreindre une limite issue de l’AIR. Il ne peut pas l’élargir silencieusement.

Les budgets sont attachés au run. Ils sont donc partagés par les capacités
appelées successivement, y compris lorsqu’un agent en appelle un autre par une
capacité autorisée. Cette règle rend le coût d’autonomie observable au niveau du
workflow complet : un appel provider, un dispatch tool ou une étape consommée en
amont réduit le budget restant pour la suite.

Exemple :

<!-- touba-example: compile -->
```touba
module examples.restricted

limits run
    max_steps as 10
```

```json title="Manifest refusé"
{
  "manifest_version": "touba-manifest-v1",
  "run_limits": {
    "max_steps": 20
  },
  "bindings": {}
}
```

Le runtime refuse cette configuration, car `20` élargit la limite AIR `10`.


## Pause et reprise humaine

Une pause ne remet pas les budgets à zéro. Le checkpoint conserve les compteurs,
le temps actif déjà consommé et les plafonds effectifs, y compris ceux de l’hôte.
À la reprise, les limites précédentes et actuelles sont combinées par minimum.
Supprimer ou augmenter une option hôte ne rend donc aucun budget supplémentaire.
Le temps passé à attendre une décision humaine est exclu de `max_run_ms` ;
l’expiration de cette attente relève d’une deadline distincte.

Les anciens checkpoints de développement dépourvus de cet état complet sont
refusés sans modification. Conservez-les ; aucune migration ou remise à zéro
implicite n’est effectuée.

`max_provider_calls` compte chaque tentative auprès du decision provider,
y compris les retries pilotés par le runtime. Un SDK fournisseur peut effectuer
ses propres retries HTTP : ce compteur n’est pas une mesure des requêtes réseau
réelles ni une garantie de facturation.

## Budgets partagés en parallèle

Toutes les branches et tous les sous-agents consomment les mêmes compteurs de
run. La vérification et la réservation se font avant dispatch, sans fenêtre de
concurrence entre elles : deux branches ne peuvent pas consommer le même dernier
permis. Une erreur de transport ne rembourse pas automatiquement la tentative.

Les bornes `max_concurrency` et `max_items` du source limitent un groupe.
`parallelLimits` côté Engine, ou `--parallel-limits-json` côté CLI, bornent aussi
les branches vivantes, transports externes et profondeur à l'échelle du run,
groupes imbriqués compris. Voir la [référence CLI](../reference/cli-v1-rc.md).
Un timeout logique ne libère pas un transport toujours actif ; ces plafonds
ne constituent ni une facture ni une limite monétaire.

## Lire un refus

Avec `--output trace`, un refus de budget contient des événements comme :

```json title="Trace extrait"
{
  "kind": "dispatch_refused_budget_exceeded",
  "payload": {
    "budget_kind": "max_tool_calls",
    "limit_value": 1,
    "consumed_value": 1,
    "target_ref": "tool:examples.search/SearchDatasets",
    "runtime_error_code": "ToolCallBudgetExceeded"
  }
}
```

Vous pouvez inspecter la trace :

```sh title="Terminal"
touba inspect trace.json
```

L’inspection affiche le nombre de budgets vérifiés, consommés, dépassés et les types de budget concernés.

## Limites

Les budgets d’autonomie sont des limites runtime Touba.

Ils ne garantissent pas :

- un hard kill système ;
- un quota distribué ;
- un coût fournisseur ;
- un compteur de tokens portable ;
- une sandbox réseau ou filesystem ;
- une conformité réglementaire automatique.
