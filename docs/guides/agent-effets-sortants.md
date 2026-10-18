# Agent et effets sortants

Un agent peut respecter ses capacités tout en produisant une réponse incorrecte.
Un droit d'envoyer un courriel n'est pas un droit métier de promettre un paiement.
Les consignes au modèle ne remplacent donc pas un contrôle avant l'effet.

## Placer les contrôles dans le chemin obligatoire

Le chemin conseillé est : données obligatoires, proposition agentique,
politique déterministe, approbation si nécessaire, puis effet.
L'agent ne dispose pas du tool d'envoi. Le contrôle ne fait pas partie d'un
catalogue qu'il pourrait choisir d'ignorer.

Cet exemple utilise volontairement une politique simple et vérifiable :
une seule réponse textuelle préapprouvée est autorisée. Ce n'est pas un
détecteur général de prompt injection.

<!-- touba-example: compile -->
```touba title="support/outbound.tb"
module support.outbound

tool ReadCase
    description "Read the submitted case without modifying it."
    takes ticket as Text
    gives Text

tool SendReply
    description "Send an approved reply to the customer."
    takes reply as Text
    gives Text
    requires network

function IsApprovedTemplate
    takes draft as Text
    gives Boolean
    do
        give draft == "We received your request and will review it."

agent DraftReply
    takes caseText as Text
    gives Text
    responsibility "Draft a support reply from the case. Do not promise payments."
    callable_by strategy Reply

strategy Reply
    takes ticket as Text
    gives Text
    uses ReadCase
    uses DraftReply
    uses SendReply
    do
        ReadCase
            with ticket as ticket
            into caseText
        DraftReply
            with caseText as caseText
            into draft
        IsApprovedTemplate
            with draft as draft
            into allowed
        if allowed == false
            give "blocked_by_policy"
        human.approve
            with context as draft
            into approval
        SendReply
            with reply as draft
            into sent
        give sent
```

Le code lit le dossier avant d'appeler l'agent. Cela garantit la collecte,
pas la compréhension du dossier par le modèle. La fonction pure refuse toute
autre formulation, y compris une promesse de remboursement. Pour une politique
plus riche, faites proposer une structure typée, puis vérifiez ses montants,
destinataires et droits contre des données métier de confiance. Ne cherchez
pas à remplacer cette politique par une simple liste de mots interdits.

Le handler `ReadCase` doit être réellement sans effet et déclaré
`effect_contract.kind: "none"`. `SendReply` nécessite un binding autorisant
`network`, un contrat `external_write` et un journal d'effets.
Implémentez-le avec le SDK et une clé idempotente côté service.
Voir [les effets idempotents](./effets-idempotents.md).
L'agent ne peut ni choisir `SendReply`, ni supprimer les étapes de la strategy.

## Vérifier le parcours

- Réponse autorisée et approbation : exactement un envoi attendu pour cette opération.
- Réponse promettant un paiement : `blocked_by_policy`, aucun envoi.
- Réponse autorisée puis rejet ou expiration : aucun envoi.
- Décision provider visant `SendReply` directement : refus d'autorité.
- Reprise de la même opération après une panne : vérifier journal, reçu et
  dédoublonnage côté service, sans créer un nouveau run en remplacement.
- Dossier absent ou lecture en erreur : ne pas atteindre l'envoi.

Ces tests doivent inspecter les effets réels du handler isolé, pas seulement
le statut du run. Le contrôle métier doit être testé séparément de la
qualité statistique du modèle. Pour un runbook d'incident, placez de même la
lecture des journaux et les vérifications indispensables dans le flux
déterministe, avant la décision et l'éventuel redémarrage.

## Adapter ces règles à d'autres processus

| Processus | Composition Touba | Contrôle à garder chez l'hôte |
| --- | --- | --- |
| Notes de frais | `enum` pour la catégorie, fonction pure avec `else if` pour le seuil, validations successives avant paiement | identité et séparation effective des signataires, budget cumulé transactionnel, paiement idempotent |
| Soutien client | `if` imbriqués pour la matrice plan/priorité, `Optional of Customer` pour un dossier absent | qualité des données client, règles de contenu avant envoi |
| Revue d'une liste | `for` avec contrôle et approbation propres à chaque occurrence | suivi des décisions et effets externes, sans réutiliser une approbation pour toute la liste |
| Incident | lecture et politique déterministes, agent de diagnostic à autorité réduite, approbation avant redémarrage | vérification de santé, autorisation d'exploitation et rapprochement du redémarrage |

Deux instructions d'approbation signifient deux décisions, pas nécessairement
deux personnes distinctes. Un `while` reste borné par le budget d'itérations ;
la composition des boucles n'autorise pas une exécution illimitée. Utilisez
les aides [SDK de test](./sdk-javascript.md) pour tester succès et refus, puis
vérifiez séparément les effets dans les services de test.

## Ce que chaque couche garantit

| Couche | Responsabilité |
| --- | --- |
| Modèle | proposer un contenu ou une action ; sa qualité reste à mesurer |
| Code métier | vérifier le contenu, le dossier et les règles de décision |
| Runtime Touba | vérifier autorité, limites, contrats, pause humaine et traçabilité |
| Hôte et service externe | authentifier l'humain, exécuter l'effet, gérer idempotence et rapprochement |

`human.approve` est ici une barrière obligatoire. Un
`request_human_review` proposé par le modèle reste une initiative de l'agent :
ne l'utilisez pas seul pour garantir une validation que la politique exige.
Voir [l'API du serveur](./api-serveur-projet.md) pour présenter le contexte
à l'approbateur et corréler décision et reprise.
