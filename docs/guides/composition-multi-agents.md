# Composition multi-agents

Un workflow multi-agent n'est pas nécessairement une conversation libre.
Dans Touba, une stratégie orchestre des appels typés et chaque agent conserve
sa responsabilité, ses capacités et ses callers autorisés.

## Choisir la bonne unité

| Besoin | Unité |
| --- | --- |
| Calcul déterministe sans effet | `function` |
| Procédure réutilisable composée de capacités | `skill` |
| Choix autonome parmi des capacités autorisées | `agent` |
| Ordre, branches et composition du workflow | `strategy` |

Ne créez pas un agent uniquement pour appeler une autre déclaration. Une
stratégie peut appeler une sous-stratégie typée avec `with` / `into`.

## Exemple de composition typée

<!-- touba-example: compile -->
```touba title="review_team.tb"
module examples.review_team

function PrepareBrief
    description "Build a deterministic review brief from the supplied text."
    takes brief as Text
    gives Text
    do
        give "Review: " ++ brief

agent Reviewer
    takes brief as Text
    gives Text
    responsibility "Prepare the supplied review brief using only the declared capability."
    uses PrepareBrief
    callable_by strategy ReviewOne

strategy ReviewOne
    takes brief as Text
    gives Text
    uses Reviewer
    do
        Reviewer
            with brief as brief
            into reviewed
        give reviewed

strategy ReviewBatch
    takes briefs as List of Text
    gives List of Text
    uses ReviewOne
    do
        parallel ReviewOne
            each brief in briefs
            with brief as brief
            max_concurrency 2
            max_items 8
            into reviews
        give reviews
```

Chaque branche appelle `ReviewOne`, qui est autorisée à invoquer
`Reviewer`. Le parent `ReviewBatch` ne reçoit pas les capacités du reviewer.
L'exemple ne prétend pas réaliser une revue intelligente : il illustre la
signature et les frontières d'appel avec une seule capacité pure.

## Déléguer et échanger

Un agent peut invoquer un autre agent lorsque son `uses` et le
`callable_by` du destinataire le permettent. Passez un record métier explicite
et récupérez un résultat typé. Un appel n'accorde ni héritage des secrets,
ni partage implicite de mémoire ou de conversation.

Les [imports multi-modules](./imports-multi-modules.md) permettent de répartir
ces déclarations. Les mêmes vérifications s'appliquent à une cible importée.
Un modèle propose un appel ; il ne crée pas une cible arbitraire à partir
d'un nom reçu dans une réponse.

## Tester les compositions

Vérifiez le résultat, les refus d'invocation, les budgets partagés et la reprise
après pause, pas seulement chaque agent isolé. La boucle de décision propre à
un agent reste séquentielle ; le parallélisme est déclaré par le workflow.

Suivez le [tutoriel multi-agent](../tutoriels/orchestration-multi-agent-sequentielle.md)
pour la délégation, les révisions et les validations humaines, puis le
[guide parallèle](./parallelisme-borne.md) pour les bornes et la jointure.
