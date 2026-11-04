# Notes de version

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
Le [guide d’installation](../demarrer/installation.md) décrit ce parcours.

Les mises à jour suivantes paraîtront ici après qualification et distribution.
