# Notes de version

Le [changelog](../../CHANGELOG.md) détaille les changements de chaque version.
La [documentation publiée](https://toubalang.org/docs/reference/notes-versions/)
présente les notes et les migrations pour les distributions disponibles.

## Touba 1.4.0

Les mises à jour de packages préservent les approbations exigées par
l’application. Une modification du contrat de gouvernance demande une revue
explicite. Les projets neufs se préparent avec `touba prepare --mode write`,
puis `touba prepare --mode check`. Avant une mise à jour, sauvegardez les
données et traitez les opérations suspendues avec leur build d’origine.
Mettez ensuite la CLI et les SDK du projet à niveau.

## Touba 1.3.1

Les projets préparés conservent les exigences d’approbation sur les outils
importés, y compris ceux des dépendances transitives. Une opération protégée
compte pour un seul appel d’outil entre la demande d’approbation et la reprise.
La CLI et les SDK JavaScript et Python conservent les diagnostics précis
`ProjectEntrypointNotAllowed` et `EffectJournalBusy`.

Mettez à jour le runtime et les SDK du projet ensemble. Gardez la distribution
d’origine pour reprendre une exécution suspendue avec son état.

## Touba 1.1.0

Cette version ajoute la mise à jour vérifiée de la distribution :

```sh
touba update --check
touba update
touba update --rollback
```

Explorer améliore la lecture des ressources et des budgets. Les reprises
refusent les checkpoints altérés, les contrats hôtes modifiés et les approbations
déjà consommées. Les diagnostics des SDK conservent les causes structurées.

Pour migrer, sauvegardez les données, terminez ou rapprochez les opérations
suspendues, installez la distribution puis actualisez les SDK de chaque projet.
Un retour à l’ancien exécutable conserve les données métier actuelles.
Le [guide d’installation](https://toubalang.org/docs/demarrer/installation) décrit ce parcours.

Les mises à jour suivantes paraîtront ici après qualification et distribution.
