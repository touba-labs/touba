# Construire et vérifier des données typées

Ce tutoriel s’exécute localement, sans modèle ni service externe. Il construit
une facture, compare deux dates et produit une copie destinée à la revue.

## 1. Écrire le programme

Enregistrez ce programme dans `invoice.tb` :

<!-- touba-example: compile -->
```touba title="invoice.tb"
module examples.invoice_data

type Invoice
    reference is Text length 1..40
    issued_on is Date
    order_date is Date
    currency is Text length 3 default "CAD"
    total_cents is Int min 0
    flags is List of Text length 0..5 default []

function Review
    takes invoice as Invoice
    gives Invoice
    do
        if invoice.issued_on < invoice.order_date
            give copy invoice { flags as ["invoice_before_order"] }
        give invoice

strategy Demo
    gives Invoice
    do
        bind draft as Invoice = record Invoice { reference as "INV-42", issued_on as date("2026-10-20"), order_date as date("2026-10-21"), total_cents as 12500 }
        Review
            with invoice as draft
            into reviewed
        give reviewed
```

Les valeurs par défaut remplissent `currency` et `flags` à la construction.
`copy` conserve les autres champs et laisse la facture d’origine intacte.

## 2. Exécuter

```sh
touba compile invoice.tb --out invoice.air.json
touba run invoice.air.json --entry strategy:examples.invoice_data/Demo --output result
```

Le résultat contient `currency: "CAD"` et
`flags: ["invoice_before_order"]`. La règle de date appartient au métier :
vous pouvez ensuite orienter cette facture vers une approbation humaine.

## 3. Vérifier les frontières

- Remplacez la date par `date("2026-02-30")` : la valeur est refusée.
- Remplacez `total_cents` par `0 - 1` : le contrat numérique est refusé.
- Ajoutez `invoice.missing_field` : le compilateur signale le champ inconnu.

Un handler ou un modèle fournit un record complet : les défauts source
s’appliquent à `record`, pas aux entrées externes. Les deux SDK utilisent les
mêmes dates ISO, listes JSON et contraintes.

Voir [Données typées](../concepts/donnees-typees.md) pour le contrat et
[Approbations avec rôles](approbations-roles-delais.md) pour la suite du parcours.
