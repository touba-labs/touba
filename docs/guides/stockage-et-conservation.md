# Stockage et conservation

Touba conserve l’état évolutif dans des bases SQLite locales. SQLite est livré
avec le runtime : aucun serveur de base de données n’est nécessaire. L’application
choisit les emplacements, les quotas et la durée de conservation.

## Choisir le stockage

| Données | Emplacement courant | Réglage |
| --- | --- | --- |
| Traces | `.touba/traces.sqlite` | `--trace-store` ; service webhook : `--trace-max-bytes` |
| Événements admis et quotas journaliers | `.touba/triggers.sqlite` | `--state`, `--state-max-bytes` |
| File webhook | `.touba/trigger-queue.sqlite` | `--queue`, `--queue-max-bytes`, `--queue-max-entries` |
| Journal d’effets | chemin `.effect-journal.sqlite` choisi par l’hôte | `--effect-journal` |
| Approbations, points de reprise et interactions | bases distinctes dans `.touba/` | serveur projet |
| Compensations | chemin `.sqlite` choisi par l’hôte | `touba compensation --store` ; SDK hôte |

Le quota par base est de 512 Mio par défaut ; la file accepte 10 000 entrées.
Pour les traces, ce quota compte les en-têtes et événements JSON ; les index et
le journal transactionnel SQLite occupent de l’espace supplémentaire. Réservez
une marge disque et surveillez aussi la taille réelle des fichiers.
Les opérations de stockage valident les identités et les révisions. Une panne
ou un quota atteint arrête le travail concerné en conservant les états durables.
Les effets externes gardent leur contrat d’idempotence et de reprise.

## Lire par pages

```bash
touba trigger state .touba/triggers.sqlite --limit 100
touba trigger queue .touba/trigger-queue.sqlite --limit 100
touba state list effects .touba/project.effect-journal.sqlite --limit 100
touba state list compensations .touba/compensations.sqlite --limit 100
```

Pour continuer, transmettez le curseur `next` à `--after`. Les pages contiennent
au plus 1 000 éléments. Les [traces](../reference/traces-v1-rc.md) disposent
également d’un lecteur paginé dans la CLI et les deux SDK.

## Conserver les preuves utiles

L’archivage des déclencheurs copie les détails terminés dans une nouvelle base,
vérifie leur empreinte, puis les retire de la base courante avec `--apply`.
Les identifiants consommés et compteurs restent présents pour empêcher le rejeu.

```bash
touba trigger archive-state .touba/triggers.sqlite --before 2026-10-01T00:00:00Z
touba trigger archive-state .touba/triggers.sqlite --before 2026-10-01T00:00:00Z --out archives/triggers.sqlite --apply
touba trigger archive-queue .touba/trigger-queue.sqlite --before 2026-10-01T00:00:00Z --out archives/queue.sqlite --apply
```

La file archive les entrées réussies. Les travaux actifs, échoués ou d’issue
incertaine restent disponibles pour la reprise. Les archives se consultent avec
les mêmes commandes `state` et `queue`. Le serveur projet propose aussi
`touba serve --archive-state` et `--restore-state <identifiant>` pour son état
au repos ; ajoutez `--apply` après avoir vérifié l’aperçu.

## Migrer un ancien état

Arrêtez les processus qui écrivent les données. Validez d’abord la migration,
puis créez la nouvelle base :

```bash
touba state migrate effects ancien.effect-journal.json --out .touba/effects.effect-journal.sqlite
touba state migrate effects ancien.effect-journal.json --out .touba/effects.effect-journal.sqlite --apply
touba trigger migrate-state ancien.trigger-state.json --out .touba/triggers.sqlite --apply
touba trigger migrate-queue ancienne.queue.json --out .touba/trigger-queue.sqlite --apply
```

`state migrate` accepte `effects`, `compensations`, `checkpoints`,
`human-requests`, `human-decisions`, `changes`, `interaction-sessions` et `interaction-assets`.
Les formats doivent satisfaire les contrats courants. Les sources sont conservées
avec une copie exacte `.source-backup.json`, et une destination existante est refusée.
Les migrations ne déclenchent aucune exécution et n’inventent aucune approbation.

Lisez ensuite la base avec
`touba state list effects .touba/effects.effect-journal.sqlite`.
Pour une nouvelle exécution, passez ce même chemin à `touba run --effect-journal`.
Pour une reprise, conservez également le checkpoint, sa base de garde et les
décisions liées : la migration du journal seule ne renouvelle pas une approbation.
Une issue `unknown` reste incertaine après migration. Gardez cet état jusqu'à
vérification de l'effet auprès du service métier.

Pour le serveur projet, migrez ensemble les collections liées puis lancez
`touba serve --check-state` avant de redémarrer. Conservez aussi les fichiers
d’assets référencés par leurs métadonnées. Le programme, son manifest et ses
modules hôtes doivent correspondre aux points de reprise conservés.

L’historique des propositions d’édition utilise
`.touba/project-change-proposals.sqlite`. Pour un historique JSON existant :

```bash
touba state migrate changes .touba/project-change-proposals.json --out .touba/project-change-proposals.sqlite
touba state migrate changes .touba/project-change-proposals.json --out .touba/project-change-proposals.sqlite --apply
```

La migration valide au plus 16 Mio de JSON par opération. Elle conserve les
identifiants, décisions et preuves présents ; une proposition ancienne sans
preuve de révision doit être reproposée avant application. La présence du JSON
empêche de démarrer silencieusement un historique vide. Conservez la build
ayant produit les autres états et suivez le diagnostic `serve --check-state`
avant tout changement de build.

## Changer de build avec un projet au repos

La commande `state adopt` du candidat courant permet de conserver l'historique
serveur compatible dans les chemins standard. Arrêtez tous les processus qui
écrivent cet état, puis demandez un aperçu avec la nouvelle toolchain :

```bash
touba state adopt --project ./mon-projet --reason "Mise à jour revue de la toolchain"
touba state adopt --project ./mon-projet --reason "Mise à jour revue de la toolchain" --accept EMPREINTE_DE_L_APERCU
```

Le contrôle refuse les attentes humaines, les opérations actives ou interrompues,
les effets incertains, les formats inconnus et les données sans origine connue.
Un journal SQLite occupé ou une modification après aperçu impose une nouvelle
vérification. Les chemins personnalisés et les journaux dotés d'une exportation
de traces ne sont pas encore pris en charge par ce parcours.

Une sauvegarde privée de l'état est vérifiée dans `.touba/state-adoptions/` avant
l'adoption. Elle conserve aussi les preuves locales et, s'il existe, le fichier
standard `state/secrets.local.json`. Cette copie peut donc contenir des secrets :
gardez-la privée, hors Git, avec les protections de votre projet. L'aperçu ne
contient que les chemins, tailles et empreintes, jamais les valeurs. Les stores
personnalisés dans `state/` nécessitent un adaptateur de compatibilité.
Les stores et les traces restent identiques ; seule l'origine de
l'état reçoit une chaîne de transitions de build. Cette chaîne n'autorise pas
la reprise d'un ancien checkpoint. Le format d'origine v2 est refusé par les
anciennes toolchains. La limite de copie par défaut est de 2 Gio ; ajustez-la
explicitement avec `--max-backup-bytes` après vérification de l'espace disponible.

En cas d'interruption, le démarrage est bloqué. La commande suivante vérifie les
copies et constate si le changement d'origine a eu lieu :

```bash
touba state adopt --project ./mon-projet --recover
```

Elle ne restaure pas de stores et ne réexécute aucun effet. Une divergence des
données demande une réconciliation par l'exploitant. Cette vérification de format
ne démontre pas la compatibilité métier : rejouez aussi vos tests applicatifs.
Le parcours reste en qualification avant la prochaine distribution.

Un refus `ToubaStateAdoptionStoreUnsupported` en JSON peut inclure `store`,
chemin relatif borné dans `.touba/`. Ce champ aide à identifier le fichier
à examiner ; il ne contient ni son contenu ni le chemin absolu du projet.
Ne déplacez pas ce fichier pour contourner le contrôle. Conservez la build
précédente jusqu'à la qualification d'un adaptateur ou d'une migration adaptée.

## Exporter vers PostgreSQL

Un processus séparé peut envoyer les traces progressivement vers PostgreSQL.
Le programme continue à écrire dans SQLite ; les données en attente restent
sur disque jusqu’à l’accusé de la destination.

```bash
touba trace export --store .touba/traces.sqlite --postgres-env TRACE_DATABASE_URL
touba trace export --store .touba/traces.sqlite --postgres-env TRACE_DATABASE_URL --watch
```

Définissez `TRACE_DATABASE_URL` dans l’environnement du processus avec les
identifiants d’un compte PostgreSQL dédié. La commande prépare le schéma
`touba_traces` à la première connexion. Hors boucle locale, la CLI exige TLS
avec validation du certificat et du nom du serveur. Le mot de passe reste dans
l’environnement, sans être affiché dans la commande ni dans ses diagnostics.

Chaque lot contient au plus 100 événements par défaut ; `--batch-size`
accepte 1 à 1 000. Une passe traite au plus 100 lots, ajustables avec
`--max-batches`. `--watch` poursuit l’export et attend progressivement en cas
d’indisponibilité. Arrêtez ce processus avec Ctrl+C ou SIGTERM.

L’accusé local est écrit après le COMMIT distant. Si une réponse est perdue,
le même lot peut être renvoyé ; PostgreSQL vérifie les identités et les empreintes.
Un worker remplacé est refusé par un numéro de lease croissant. L’archivage local
protège les traces encore attendues par une destination configurée.

Les données restent consultables localement après export. Leur suppression reste
une décision explicite de conservation. Ce mécanisme coordonne les workers
**d’export**, indépendamment des workers exécutant vos opérations métier.

## Exploitation

Sauvegardez les bases au repos et protégez leurs répertoires comme les données
de votre application. SQLite n’applique pas de chiffrement au repos. Pour un
service, surveillez le disque, les files et les opérations en attente ; choisissez
une politique de conservation compatible avec vos besoins d’audit.
