# Approbation d’une opération et unicité métier

Ce guide prépare le prochain build, en qualification locale. Les distributions
publiées conservent leurs contrats actuels.

## Déclarer l’obligation sur l’outil

<!-- touba-example: compile -->
```touba
module examples.protected_payment

type Payment
    invoice_id is Text
    vendor is Text
    amount is Int

tool Pay
    takes payment as Payment
    gives Text
    human.approve
        with role as "finance"
        with timeout_ms as 3600000
        with distinct_from as "initiator"

strategy Execute
    takes payment as Payment
    gives Text
    uses Pay
    do
        Pay
            with payment as payment
            into result
        give result
```

Chaque appel de `Pay` demande l’approbation de ses arguments exacts. Cette
obligation suit l’outil à travers les imports, les skills et la sélection par
un agent. L’hôte atteste l’identité et les rôles avec l’adaptateur décrit dans
[Approbations avec rôles et délais](../tutoriels/approbations-roles-delais.md).
L’approbateur voit `request.review_context.operation` : outil, run, appelant,
agent actif et arguments. Ces valeurs restent dans le dossier privé de décision.

Un accord libère une seule invocation. Un refus, une expiration, une modification
du checkpoint ou son rejeu empêchent le dispatch. Les grants, secrets, scopes
mémoire et budgets restent requis. Un checkpoint `human.approve` placé dans une
stratégie conserve son rôle de contrôle de continuation ; l’obligation sur le
tool couvre aussi les autres chemins d’appel.

Un appel protégé consomme une seule unité de `max_tool_calls`, conservée pendant
l’attente et la reprise. Avec une limite de `1`, une opération approuvée peut
s’exécuter ; un deuxième appel atteint la limite. Chaque branche parallèle
partage le budget du run. Après modification des imports ou des politiques
d’outil, régénérez les artefacts avec `touba prepare --mode write`.

## Contrôles complémentaires

| Vérification | Où l’appliquer |
| --- | --- |
| Qui peut approuver cette opération exacte ? | Contrat Touba et adaptateur d’identité hôte |
| Le fournisseur et le montant correspondent-ils à la commande ? | Handler ou service, contre une source métier de confiance |
| Cette facture a-t-elle déjà été payée dans un autre run ? | Clé métier unique et transaction atomique du service |

Pour un service SQL, la validation et l’écriture partagent une transaction.
Une contrainte `UNIQUE(invoice_id)` protège les deux soumissions concurrentes,
même si chacune a obtenu sa propre approbation. En cas de paiement auprès d’un
service distant, transmettez sa clé d’idempotence et utilisez son protocole de
rapprochement après une interruption. Une transaction SQL locale ne rend pas
atomique un appel réseau.

## Conserver les preuves

Le handler reçoit `context.executionContext` en JavaScript et
`context["execution_context"]` en Python. Les champs sont identiques :
`run_id`, `caller_ref`, `agent_ref`, `agent_invocation_id`.
Enregistrez ce contexte avec la ligne écrite et l’identifiant d’appel. À la
lecture, restituez la provenance conservée de cette ligne. L’agent actif peut
être absent ; le contexte conserve alors l’appelant structurel.

```js
const provenance = context.executionContext;
const callId = context.request.call_id;
// Conserver provenance et callId avec l’écriture dans la transaction métier.
```

```python
provenance = context["execution_context"]
call_id = context["request"]["call_id"]
# Conserver provenance et call_id avec l’écriture dans la transaction métier.
```

Les scopes mémoire `read` et `write` sont indépendants. Un agent autorisé en
lecture seule ne peut pas appeler un outil d’écriture ; un agent ayant les deux
scopes peut écrire. La validation du contenu et la distinction entre politique
publiée et information produite par un agent appartiennent au service métier.

## Exécuter et reprendre

```sh
touba run --project . --human-approval-host host/approval.mjs --effect-journal .touba/run.effect-journal.sqlite --human-checkpoint-out .touba/pending.json
```

Conservez ensemble le checkpoint sous garde hôte, le journal d’effets et les
données métier. La CLI et les SDK utilisent le même contrôle d’approbation.
Le serveur conserve l’attente après redémarrage. Le profil linéaire avancé
`RESUME-1` utilise un autre format et refuse ces continuations imbriquées avant
tout effet ; utilisez ici les checkpoints humains. Avant une nouvelle tentative
après interruption d’un effet, vérifiez son état auprès du service.
