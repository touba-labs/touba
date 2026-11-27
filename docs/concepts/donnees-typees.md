# Données typées

Touba vérifie les données aux frontières du programme : entrées, résultats de
tools et décisions des agents. Les mêmes contrats servent au compilateur, au
runtime et aux schémas présentés aux modèles.

## Dates et listes

`Date` est une date civile ISO, sans heure ni fuseau. `date("2026-10-21")`
construit une date valide ; `date("2026-02-30")` est refusé. Une valeur reçue
d’un modèle doit déjà respecter ce format.

Les listes utilisent `[a, b]`. Le type attendu permet de construire une liste
vide, par exemple `bind items as List of Text = []`.

## Contrats de champs

<!-- touba-example: compile -->
```touba
module examples.typed_data

type Invoice
    reference is Text length 1..40
    issued_on is Date
    currency is Text length 3 default "CAD"
    total_cents is Int min 0
    tags is List of Text length 0..8 default []
    reason is Optional of Text default none(Text)

function Draft
    gives Invoice
    do
        give record Invoice { reference as "INV-42", issued_on as date("2026-10-21"), total_cents as 12500 }

function Flag
    takes invoice as Invoice
    gives Invoice
    do
        give copy invoice { tags as ["review"], reason as some("Purchase order date needs review") }
```

Le type indique les valeurs admises. Les règles métier, comme comparer la date
d’une facture à celle de sa commande, restent dans une fonction ou une stratégie.

| Élément | Rôle |
| --- | --- |
| `length 1..40` | Bornes inclusives, en caractères Unicode ou éléments de liste |
| `min`, `max` | Bornes numériques |
| `format "digits"` | Texte composé de chiffres ASCII |
| `default` | Valeur utilisée par le constructeur source si le champ est omis |
| `copy` | Nouveau record avec remplacement explicite de champs |

Les valeurs par défaut ne réparent pas les données externes. Le handler et le
modèle produisent tous les champs du contrat, y compris l’absence explicite
`{"present": false}` d’un champ optionnel.

## Résultat d’une approbation

`human.approve … into approval` lie une valeur `Approval`.

| Champ | Type | Contenu |
| --- | --- | --- |
| `decision` | Text | `approved`, `rejected` ou `expired` selon la branche |
| `subject_ref` | Optional of Text | Signataire attesté, lorsqu’il existe |
| `attested_roles` | List of Text | Rôles validés par l’hôte |
| `request_id`, `run_id` | Text | Identifiants de corrélation |
| `accepted_at` | Text | Instant UTC au format ISO |
| `comment` | Optional of Text | Commentaire de décision, jusqu’à 4 096 caractères |

Un champ inconnu est signalé à la compilation. Ce résultat permet de préparer
une notification ou un statut métier. L’autorité d’approbation reste portée
par les reçus privés du runtime et l’attestation hôte.

Suite : [tutoriel des données typées](../tutoriels/donnees-typees.md) et
[approbations avec rôles et délais](../tutoriels/approbations-roles-delais.md).

## Constantes et diagnostics

Une date fixe se déclare au niveau du module. Les commentaires peuvent suivre
une déclaration ou une instruction :

<!-- touba-example: compile -->
```touba
module examples.fixed_date

define Closing as Date = date("2026-10-31") # End of period

function ReadClosing
    gives Date
    do
        give Closing # Validated civil date
```

Un échec de contrainte indique le champ, la contrainte et sa borne :
par exemple `min requires 0`. La valeur rejetée reste hors du diagnostic.

## Agréger et trier des listes pures

`sum(values)` additionne une liste de `Int` ou de `Float`, dans son ordre.
Une liste vide typée donne zéro. Un débordement Int ou
une somme Float non finie est refusé. `sort(values)` retourne une nouvelle liste
croissante de nombres ou de textes, sans modifier l’entrée. Pour Text, l’ordre
est lexicographique UTF-16, indépendant de la langue et de la locale.
Les records et comparateurs personnalisés ne sont pas acceptés.

<!-- touba-example: compile -->
```touba
module examples.totals
function Total
    takes values as List of Int
    gives Int
    do
        give sum(values)
function Sorted
    takes values as List of Int
    gives List of Int
    do
        give sort(values)
```

Les deux opérations respectent la borne d’itérations du runtime, l’annulation
et la durée. Elles n’appellent ni outil ni modèle ; les budgets d’appels peuvent
rester nuls. Les compréhensions, `concat` et `join` conservent leurs contrats.
