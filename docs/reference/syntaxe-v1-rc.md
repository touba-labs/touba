---
sidebar_position: 1
---

# Référence syntaxe

Cette page est une aide de consultation pour la syntaxe visible.

## Module

<!-- touba-example: compile -->
```touba title="source.tb"
module examples.name
```

Dans un projet Touba, le chemin recommandé reprend le nom logique du module :

```text title="Structure"
src/examples/name.tb
```

## Imports

Les imports documentés couvrent deux familles :

- imports purs (IM-1) : `type`, `define` non sensible et `function` pure ;
- imports effectifs (IM-2) : `tool`, `skill`, `strategy`, `agent` et `memory` locaux du même projet.

<!-- touba-example: compile -->
```touba title="source.tb"
module examples.search

import type SearchRequest from examples.common
import define DefaultRows from examples.common
import function NormalizeQuery from examples.common
import tool SearchDatasets from examples.data_tools
import skill BuildBrief from examples.shared_flow
import strategy SharedRun from examples.shared_flow
import agent Reviewer from examples.agent_pool
import memory ProjectKnowledge from examples.shared_memory
```

Les imports doivent être placés après `module` et avant les autres déclarations.

:::info Portée
Les imports effectifs (IM-2) permettent d’importer des composants effectifs locaux, mais n’accordent aucune
autorité d’exécution. Le manifest, les grants, les secrets, les handlers, les
scopes mémoire, `callable_by`, les contraintes, le lock supply chain et les refus
runtime restent explicites.

Les packages externes, aliases, wildcard et re-export ne sont pas documentés comme disponibles.
Les imports sont résolus par l’assemblage AIR du projet, pas par le runtime.
:::

## Types

<!-- touba-example: fragment -->
```touba title="source.tb"
type Request
    query is Text
    rows is Int
```

Builtins principaux : `Text`, `Boolean`, `Int`, `Float`, `List of <Type>`.

## Constantes de module

`define` nomme une valeur de module immuable et non sensible.

<!-- touba-example: fragment -->
```touba title="source.tb"
define Name as Type = literal
```

<!-- touba-example: fragment -->
```touba title="source.tb"
define DefaultTopic as Text = "transport"
define ScoreLimit as Float = 0.75
define MaxRows as Int = 10
define ReviewsEnabled as Boolean = true
```

Une constante peut être utilisée par les fonctions, skills ou stratégies du même module.

:::info Portée
- Seuls les littéraux `Text`, `Boolean`, `Int` et `Float` sont acceptés
- Pas d'expression composée dans `define`
- Pas de secret, variable d'environnement ou chemin local dans `define`
:::

## Function

Une `function` calcule une valeur pure.

<!-- touba-example: fragment -->
```touba title="source.tb"
function AverageScore
    takes score as Float
    takes bonus as Float
    gives Float
    do
        give (score + bonus) / 2.0
```

Valeur locale immuable dans un bloc :

<!-- touba-example: fragment -->
```touba title="source.tb"
define ScoreLimit as Float = 0.75

function ReviewScore
    takes score as Float
    takes bonus as Float
    gives Text
    do
        bind adjusted as Float = (score + bonus) / 2.0
        bind accepted as Boolean = adjusted >= ScoreLimit
        if accepted
            give "accepted"
        else
            give "review"
```

`bind` sert à nommer un calcul local. Il ne permet pas de modifier la valeur ensuite.

Expressions :

- Arithmétique : `+`, `-`, `*`, `/`, `%`
- Booléens : `and`, `or`, `not`
- Comparaisons : `==`, `!=`, `<`, `>`, `<=`, `>=`
- Concaténation texte : `++`
- Rendu texte explicite : `text(expr)` pour `Text`, `Int`, `Float` et `Boolean`
- Accès champ : `value.field`
- Construction nominale : `record TypeName { field as expression, ... }`

Le constructeur `record` accepte uniquement un type local explicite. Tous les
champs déclarés sont obligatoires et doivent être fournis exactement une fois.
Les objets anonymes, champs optionnels, valeurs par défaut, spreads et mises à
jour partielles ne font pas partie de cette version.

## Tool

Un `tool` déclare un effet externe. Le code réel vit dans un handler hôte.

<!-- touba-example: fragment -->
```touba title="source.tb"
tool SearchDatasets
    description "Search approved dataset sources for records matching the request."
    takes request as DatasetSearchRequest
    gives DatasetSearchResult
    requires network
```

Clauses supportées : `requires <capability>`, `secrets HANDLE`, `uses memory <Name> read`, `uses memory <Name> write`.

## Skill

Une `skill` orchestre des fonctions, tools, skills, interactions et validations humaines supportées.

<!-- touba-example: fragment -->
```touba title="source.tb"
skill Search
    description "Run the governed dataset search workflow and return normalized results."
    takes request as DatasetSearchRequest
    gives DatasetSearchResult
    uses SearchDatasets
    do
        SearchDatasets
            with request as request
            into result
        give result
```

Un fallback déclare la seule famille qu'il accepte :

<!-- touba-example: fragment -->
```touba title="source.tb"
tool Primary
    gives Text

skill Backup
    gives Text
    do
        give "backup"

skill Run
    gives Text
    uses Primary
    uses Backup
    do
        Primary
        give "primary"
    on failure handler
        fallback Backup
```

Les familles capturables sont `business`, `authority`, `provider` et
`handler`. Une famille différente remonte jusqu'au résultat terminal. Une
annulation ou un arrêt humain n'est jamais capturé. Les blocs `if`, `for` et
`while` ne peuvent pas contenir une autre structure de contrôle dans cette
version.

## Agent

Un `agent` expose une responsabilité bornée. `takes` et `gives` déclarent son
interface directe optionnelle ; `callable_by` déclare les callers autorisés.

<!-- touba-example: fragment -->
```touba title="source.tb"
agent Researcher
    description "Research agent that selects an authorized dataset-search capability."
    takes request as DatasetSearchRequest
    gives DatasetSearchResult
    responsibility "Select the declared research capability that matches the request."
    uses Search
    callable_by strategy RunSearch
```

Toute capacité exposée à un decision provider par `agent.uses` doit déclarer une
`description` source explicite. Le runtime refuse avant l’appel provider si ce
signal manque.

Un appel typé utilise exactement les liaisons communes :

<!-- touba-example: fragment -->
```touba title="source.tb"
Researcher
    with request as request
    into result
```

`with` est obligatoire pour chaque entrée déclarée et `into` nomme la sortie
validée contre `gives`. Aucune entrée ou sortie n’est déduite de `uses`. Un
agent sans signature garde uniquement l’appel simple historique. L’appel
enrichi d’un agent importé reste refusé dans cette tranche, faute de résolution
de signature intermodule au moment du typecheck.

La forme inter-module explicite est acceptée pour les agents importés :

<!-- touba-example: fragment -->
```touba title="source.tb"
agent Reviewer
    responsibility "Fulfill the declared Reviewer responsibility using only authorized capabilities."
    callable_by strategy examples.agent_app.RunReview
```

## Strategy

Une `strategy` est un point d'orchestration exécutable par le runtime.

<!-- touba-example: fragment -->
```touba title="source.tb"
strategy RunSearch
    uses Researcher
    do
        Researcher
```

## Trigger

Un `trigger` déclare une entrée événementielle gouvernée.

<!-- touba-example: fragment -->
```touba title="source.tb"
trigger DailyResearchSchedule
    on schedule "every 1s"
    runs strategy RunResearch
    limits
        max_runs_per_day as 1
        timeout_ms as 30000

trigger WebhookResearch
    on request POST "/webhook/research"
    runs strategy RunResearch
    limits
        max_runs_per_day as 10
        timeout_ms as 30000
```

Touba accepte `schedule -> strategy` et `request -> strategy`. Le runner
`schedule` supporte `every <n>s`, `every <n>m` et `every <n>h`. Le service
webhook route `request` par méthode `GET`, `POST`, `PUT`, `PATCH` ou `DELETE`,
chemin absolu, contrat payload du manifest et état TD-1. Les autres familles
d’événements et le déclenchement direct d’agent relèvent des couches futures.

## Interactions utilisateur

`show` et `ask` sont des nœuds d'interaction, pas des fonctions.

<!-- touba-example: fragment -->
```touba title="source.tb"
show
    with message as "age is: " ++ text(age)

ask
    with prompt as "Search query?"
    into query
```

## Validation humaine

<!-- touba-example: fragment -->
```touba title="source.tb"
human.approve
    with context as change
    into approval
```

## Mémoires logiques

Une `memory` est une ressource logique. L'accès réel passe par un tool, un manifest et un handler.

<!-- touba-example: fragment -->
```touba title="source.tb"
memory ProjectKnowledge

tool ReadProjectKnowledge
    uses memory ProjectKnowledge read
    takes query as Query
    gives KnowledgeResult
    requires memory_read
```

## Limites syntaxiques visibles

:::info
- Pas de code handler inline dans `.tb`
- Pas de `handled_by`
- Pas d'appel enrichi d'agent avec `with` / `into`
- Pas de méthode hôte comme `title.toLowerCase()`
- Pas de lecture `stdin`
- Pas de `show` ou `ask` dans `function`
- Pas de réassignation ou variable mutable
- Pas de constante de module basée sur un appel ou une expression composée
- Pas d’import effectful de package externe, alias, wildcard ou re-export dans la portée actuelle
- Pas de `runs agent` dans un trigger
:::
