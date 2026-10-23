---
sidebar_position: 1
---

# Référence syntaxe

## Transformer des listes et composer du texte

| Expression | Résultat |
| --- | --- |
| `[x * 2 for x in values if x > 0]` | Nouvelle liste des valeurs positives doublées |
| `concat(left, right)` | Nouvelle liste, dans l'ordre gauche puis droite |
| `join(labels, "; ")` | Texte réunissant une `List of Text` |

La collection est évaluée une fois. Pour chaque élément, le filtre est évalué
avant la transformation. L'élément nommé reste local à la compréhension ; les
listes d'entrée sont conservées. Les types des éléments doivent être compatibles.
Une liste vide reçoit son type du contexte, par exemple `bind labels as List of Text = []`.

Les compréhensions respectent la limite d'itérations de l'hôte, y compris pour
les éléments filtrés, ainsi que les contrôles d'annulation et de durée.
Voir le [tutoriel de fonctions pures](../tutoriels/fonctions-metier-pures.md).


Cette page est une aide de consultation pour la syntaxe visible.

## Fichiers et indentation

Les fichiers `.tb` acceptent les fins de ligne LF (Linux/macOS) et CRLF
(Windows). Indentez chaque niveau avec quatre espaces, sans tabulation.
Les diagnostics pointent vers les lignes et positions du fichier original ;
aucune conversion manuelle en LF n'est nécessaire. Un retour chariot isolé
(`CR` sans `LF`) ne constitue pas une fin de ligne.

Un commentaire commence par `#` et se termine à la fin de la ligne. Il peut
occuper une ligne entière ou suivre une instruction. `//` est la division
entière, pas un marqueur de commentaire.

## Text, types et portée des liaisons

Un littéral `Text` est entre guillemets doubles sur une ligne source. Les échappements JSON sont décodés une seule fois : `\n` (saut de ligne), `\r`, `\t`, `\b`, `\f`, `\"`, `\\`, `\/` et `\uXXXX` (Unicode, y compris paires valides). `"a\n\nb"` contient deux sauts de ligne ; `"\\n"` conserve un antislash suivi de n. Les échappements invalides et les contrôles bruts sont refusés. Les chaînes source multilignes restent non admises ; aucune interpolation implicite ni évaluation JavaScript.

`Int / Int` retourne un `Float`. `Int // Int` retourne un `Int` tronqué vers zéro : `(0 - 7) // 2` vaut `-3`. Le diviseur zéro est refusé. Le formatage monétaire et les conventions locales relèvent d'un package, pas d'une conversion implicite.

Un gabarit est explicitement marqué : `f"Dossier {reference}, quantité {text(quantity)}"`. Chaque expression entre accolades doit produire `Text`. Écrivez `{{` et `}}` pour des accolades littérales. Les échappements restent ceux des textes ordinaires ; les expressions sont pures et aucun code hôte n'est exécuté.

Un nom de liaison est local à son bloc. Des branches distinctes peuvent réutiliser le même nom ; masquer un nom encore visible ou utiliser un nom hors de son bloc est refusé. Les contrôles `if`, `for` et `while` peuvent s'imbriquer dans les fonctions, skills et stratégies. Les éléments de liste restent typés, y compris avec `List of List of Int`.

## Module

<!-- touba-example: compile -->
```touba title="source.tb"
module examples.name
```

Dans un projet Touba, le chemin recommandé reprend le nom logique du module :

```text title="Structure"
src/examples/name.tb
```

## Limites du run

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

Une capacité peut être réutilisée tant que son autorité et le budget le permettent. Les sous-agents partagent les compteurs du run ; une reprise humaine conserve la consommation précédente. À l’assemblage, les plafonds du module d’entrée et des modules dont une déclaration exécutable est liée sont combinés par minimum. Importer uniquement un type, une constante ou une mémoire ne transfère pas les plafonds de son module. Les dépendances exécutables conservent leurs limites.

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

<details>
<summary>Modules complets requis par cet exemple d’imports</summary>

Enregistrez ces fichiers avec le module importeur. Un import résout un contrat source, pas une permission runtime.

<!-- touba-example: compile -->
```touba title="src/examples/common.tb"
module examples.common

type SearchRequest
    query is Text
    rows is Int

define DefaultRows as Int = 5

function NormalizeQuery
    takes query as Text
    gives Text
    do
        give query
```

<!-- touba-example: compile -->
```touba title="src/examples/data_tools.tb"
module examples.data_tools

import type SearchRequest from examples.common

tool SearchDatasets
    description "Find public datasets matching the request."
    takes request as SearchRequest
    gives Text
    requires network
```

<!-- touba-example: compile -->
```touba title="src/examples/shared_flow.tb"
module examples.shared_flow

skill BuildBrief
    description "Return a typed brief supplied by the caller."
    takes brief as Text
    gives Text
    do
        give brief

strategy SharedRun
    takes brief as Text
    gives Text
    uses BuildBrief
    do
        BuildBrief
            with brief as brief
            into result
        give result
```

<!-- touba-example: compile -->
```touba title="src/examples/agent_pool.tb"
module examples.agent_pool

agent Reviewer
    responsibility "Review the supplied brief for completeness using only authorized capabilities."
    callable_by strategy examples.shared_flow.SharedRun
```

<!-- touba-example: compile -->
```touba title="src/examples/shared_memory.tb"
module examples.shared_memory

memory ProjectKnowledge
```

</details>

## Types

<!-- touba-example: fragment -->
```touba title="source.tb"
type Request
    query is Text
    rows is Int
```

Builtins principaux : `Text`, `Boolean`, `Int`, `Float`, `List of <Type>`.

### Énumérations métier

Une énumération nomme un ensemble fermé de valeurs. Chaque déclaration est un
type distinct : `Priority.high` n'est pas un `Text`.

<!-- touba-example: compile -->
```touba title="priority.tb"
module priority

enum Priority
    low
    normal
    high

define DefaultPriority as Priority = Priority.normal

function IsUrgent
    takes priority as Priority
    gives Boolean
    do
        give priority == Priority.high
```

Les comparaisons `==` et `!=` demandent le même type nominal. Les comparaisons
ordonnées et la conversion implicite depuis un texte sont refusées. Les records,
listes et signatures peuvent utiliser ce type ; l'import est
`import type Priority from priority`.

À la frontière JSON (handler, entrée hôte ou réponse agentique), la valeur est
le nom exact du membre, par exemple `"high"`, vérifié dans le type attendu.
Une valeur inconnue est refusée, jamais remplacée par un membre par défaut.
Pour un argument statique de trigger, utiliser une constante `define`.
Les variantes ne portent pas de payload. `match value` puis des blocs `case Enum.member` sélectionnent une branche exhaustive : tous les membres doivent apparaître une seule fois, sans cas par défaut. Voir [Énumérations](../concepts/enumerations.md).

### Valeurs optionnelles explicites

`Optional of T` distingue une valeur absente d'une valeur vide. `some(value)`
construit une présence ; `none(T)` construit une absence typée.

<!-- touba-example: compile -->
```touba title="optional_contact.tb"
module optional_contact

function ContactLabel
    takes contact as Optional of Text
    gives Text
    do
        if present contact as address
            give address
        else
            give "No contact"

function EmptyContact
    gives Optional of Text
    do
        give none(Text)

function KnownContact
    takes address as Text
    gives Optional of Text
    do
        give some(address)
```

`address` n'existe que dans la branche `if present`. L'accès direct
`contact.value`, l'utilisation comme `Text` et la comparaison de deux
optionnels sont refusés : traiter la présence, puis comparer la valeur extraite.
Les tests de présence se composent avec `else if` et les boucles.
Les types `List of Optional of Contact` et `Optional of List of Contact`
ont des sens distincts et sont acceptés.

En JSON, utiliser `{"present":false}` ou
`{"present":true,"value":"person@example.test"}`, sans autre champ.
`null` n'est pas une absence Touba ; un champ Optional reste obligatoire
dans un record. `{"present":true,"value":""}` est un texte présent et vide.
Les handlers et les providers doivent respecter la même enveloppe.
`some` et `none` sont des expressions, pas des constantes de module `define`.

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
- Seuls les littéraux `Text`, `Boolean`, `Int`, `Float` et les membres d'énumération qualifiés sont acceptés
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

- Arithmétique : `+`, `-`, `*`, `/`, `//`, `%`
- Booléens : `and`, `or`, `not`
- Comparaisons : `==`, `!=`, `<`, `>`, `<=`, `>=`
- Concaténation texte : `++`
- Rendu texte explicite : `text(expr)` pour `Text`, `Int`, `Float`, `Boolean` et `Date`
- Accès champ : `value.field`
- Construction nominale : `record TypeName { field as expression, ... }`

Le constructeur `record` utilise un type déclaré, local ou importé. Chaque
champ sans valeur par défaut doit être fourni exactement une fois. Les valeurs
par défaut sont appliquées à la construction source. Les données reçues d’un
handler, d’un hôte ou d’un modèle doivent fournir le record complet.

`copy original { status as "approved" }` construit un nouveau record du même
type en remplaçant les champs indiqués. Le record initial reste inchangé.

Les listes s’écrivent `["a", "b"]`. Une liste vide `[]` demande un type attendu,
par exemple `bind tags as List of Text = []`. Les listes imbriquées sont
acceptées ; leurs éléments gardent le même type.

`Date` représente une date civile ISO `YYYY-MM-DD`, entre les années 0001 et
9999. `date("2026-10-21")` vérifie le calendrier, y compris les années
bissextiles. Deux `Date` peuvent être comparées. Le format JSON reste un texte
ISO validé, avec `format: date` dans le schéma envoyé au modèle.

| Contrainte de champ | Types | Exemple |
| --- | --- | --- |
| `format` | Text | `code is Text format "digits"` |
| `length` | Text, List | `code is Text length 3`, `tags is List of Text length 0..5` |
| `min`, `max` | Int, Float | `count is Int min 0 max 100` |
| `default` | Valeur compatible | `active is Boolean default true` |

`digits` désigne les chiffres ASCII de 0 à 9. La longueur d’un texte compte
les caractères Unicode, celle d’une liste ses éléments. Les bornes sont
inclusives. Les valeurs par défaut acceptent les scalaires, `date("2026-10-21")`,
`none(Text)` et `[]`, avec un type compatible. Une expression métier calculée
reste dans une fonction. Voir [Données typées](../concepts/donnees-typees.md).

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
annulation ou un arrêt humain n'est jamais capturé.

## Conditions et itérations composables

`else if` sélectionne le premier cas vrai ; le `else` final est facultatif.
Sans cas retenu, le programme continue après la chaîne. Chaque `for` parcourt
sa liste dans l'ordre ; une liste vide n'exécute pas son corps. Les boucles
intérieures repartent du début à chaque nouvelle entrée.

<!-- touba-example: compile -->
```touba title="Sélection et parcours"
module examples.control

function FirstPositive
    takes rows as List of List of Int
    gives Int
    do
        for row in rows
            for item in row
                if item > 0
                    give item
        give 0

function Category
    takes value as Int
    gives Text
    do
        if value < 0
            give "negative"
        else if value == 0
            give "zero"
        else
            give "positive"
```

`give` quitte l'invocation, même depuis une boucle intérieure. Les valeurs
restent immuables ; il n'y a ni affectation, ni `break`, ni `continue`.
`while` réévalue sa condition et reste borné : une condition qui ne change
pas peut atteindre la limite. Un littéral `while true` ou `while false`
est refusé à la compilation.

La limite hôte `max_loop_iterations` (100 par défaut) s'applique à chaque
activation d'une boucle. Terminer exactement à la limite est permis ;
entamer une itération supplémentaire est refusé. L'imbrication ne contourne
ni les budgets globaux du run, ni l'autorité des appels. Une approbation
humaine dans une boucle exige une nouvelle décision à chaque passage.

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
agent sans signature accepte seulement l’appel simple. Un agent importé avec
une signature explicite accepte aussi ces liaisons : le compilateur doit disposer
des sources des modules concernés pour résoudre et vérifier leur contrat.
Les types gardent leur identité de module et `callable_by` reste vérifié.
Une même capacité autorisée peut être appelée plusieurs fois, dans les budgets
applicables ; les droits du spécialiste ne deviennent pas ceux de son appelant.

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

Une stratégie locale ou importée avec `gives` peut aussi être appelée par une
skill ou une stratégie avec `with` / `into`. Tous ses paramètres sont explicites.
Les valeurs locales sont isolées ; budgets et annulation restent ceux du run.
Une function pure ne peut pas appeler une stratégie. Une révision bornée peut
transmettre son état typé à une nouvelle invocation, sans mémoire implicite.

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
- Les appels enrichis d'agents utilisent `with` / `into` avec une signature explicite résolue, locale ou importée. Aucun contrat n'est inféré de `uses`.
- Pas de méthode hôte comme `title.toLowerCase()`
- Pas de lecture `stdin`
- Pas de `show` ou `ask` dans `function`
- Pas de clause `uses` dans une `function` pure ; appeler les fonctions pures directement.
- `on failure` appartient à un `skill`, pas à une `strategy`.
- `callable_by` appartient à un `agent`, pas à un `skill`.
- Pas de réassignation ou variable mutable
- Pas de constante de module basée sur un appel ou une expression composée
- Pas d’import effectful de package externe, alias, wildcard ou re-export dans la portée actuelle
- Pas de `runs agent` dans un trigger
:::

`Float` utilise l’arithmétique flottante binaire. `text()` préserve sa valeur numérique et peut afficher un bruit décimal comme `0.7000000000000001` ; aucun arrondi silencieux n’est appliqué. Utilisez des unités entières `Int` pour des montants exacts à échelle fixe et un formatage explicite côté application hôte pour l’affichage.


## Parallélisme structuré

Une skill ou stratégie distribue une liste typée vers une cible déclarée :

<!-- touba-example: fragment -->
```touba
parallel Diagnose
    each incident in incidents
    with request as incident
    max_concurrency 4
    max_items 32
    into diagnoses
```

Fragment à placer dans un corps `do`, avec cible et variables déclarées.
La cible peut être un agent, une stratégie, une skill, une function ou un tool
avec sortie explicite R. Le résultat est `List of R`, dans l'ordre des entrées.
Les deux bornes sont obligatoires, entières et positives ; la concurrence ne
peut pas dépasser la cardinalité maximale. Tous les arguments sont contrôlés
avant admission. Aucun résultat partiel n'est publié. Les règles d'autorité
usuelles s'appliquent ; une function pure ne peut pas contenir ce bloc.
Voir le [tutoriel multi-agent](../tutoriels/orchestration-multi-agent-sequentielle.md).
