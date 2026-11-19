# Retirer une installation historique

Ce parcours concerne une copie installée et verrouillée, dont le nom ou les
exports ne respectent plus le contrat actuel. Il est disponible dans les sources
du candidat 1.5.0 ; sa présence dépend de l'identité exacte du build installé.

Depuis le projet consommateur :

```sh
touba package list --lang fr
touba package audit --lang fr
touba package remove ancien_espace.outils --lang fr
touba prepare --mode plan
```

Remplacez le nom d'exemple par le nom exact affiché. `audit` utilise le registre
de confiance explicitement configuré ; `--offline` consulte sa copie signée en
cache, avec sa date et son expiration. Ne changez pas une identité pour la faire
correspondre à celle d'un autre éditeur.

`list` et `audit` vérifient toujours le schéma reconnu, les chemins, les fichiers
et les empreintes du verrou. Ils signalent les restrictions sans compiler ni
exécuter les packages installés. Un statut distant « disponible » ne lève pas
une restriction locale. La nouvelle installation et `prepare` restent stricts.

Le retrait est explicite et conserve les autres packages. Un package encore
requis par une dépendance doit d'abord être retiré ou remplacé avec celle-ci,
selon un plan revu. Les imports du programme ne sont pas réécrits : adaptez-les,
installez une version conforme puis revoyez la préparation avant exécution.
Relisez aussi les points d'entrée et les contrats de packages dans
`touba.project.json` : le retrait ne supprime pas ces décisions d'application.
Après correction des références et revue du plan, utilisez
`touba prepare --mode write`, puis `touba prepare --mode check` pour un contrôle
bloquant. Le mode `plan` produit un aperçu ; lisez son statut et ses diagnostics.
Le retrait ne rejoue aucun effet et ne nettoie pas les données d'exécution.

Si l'intégrité, le schéma, un lien ou une transaction interrompue est refusé,
arrêtez la récupération automatique. Conservez le projet et ses preuves, puis
restaurez une copie complète issue d'une sauvegarde vérifiée ou demandez une
analyse ciblée. Ne supprimez pas le verrou pour faire disparaître le contrôle.

## English

For an installed and locked historical package, run `touba package list`, then
`touba package audit` against your explicitly trusted registry. Use the exact
reported name with `touba package remove <name>`. Review source imports and run
`touba prepare --mode plan` before resuming work. These commands do not rename
the package, execute its code or undo external effects.

Inspection preserves schema, file inventory, path and digest checks. Signed
catalogue verification and trust continuity remain required. Historical naming,
export or presentation restrictions are reported separately from registry status;
they do not authorize installation or execution. Dependent packages prevent
removal until an explicit replacement or removal plan resolves their references.
Also review entry points and package contracts in `touba.project.json`;
removal preserves these application decisions. After correcting references and
reviewing the plan, run `touba prepare --mode write`, then
`touba prepare --mode check` for a blocking check. The plan is a preview:
read its status and diagnostics.

On an integrity, unknown-schema, link or interrupted-transaction error, preserve
the evidence and restore a verified complete backup or request a targeted review.
Deleting the lock is not a recovery procedure.
