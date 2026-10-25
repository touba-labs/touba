# Journal SQLite de traces

Ce module est raccordé à `executeAirDocument` par l'option hôte `traceStorage`,
à la CLI par `--trace-store`, et aux SDK par `traceStore` / `trace_store`.
La CLI, le serveur projet, les deux SDK et `Run Current File` utilisent SQLite
par défaut. Les SDK et le serveur placent le journal dans `.touba/traces.sqlite`
à la racine du projet. La CLI cherche le projet contenant l'AIR ; sans manifeste
projet, elle utilise le dossier du plan d'exécution ou de l'AIR. L'option hôte
permet de choisir un autre journal. L'API runtime embarquée garde un stockage
choisi par son hôte ; sans `traceStorage`, elle travaille en mémoire.
Le graphe Explorer décrit les ressources AIR, sans consommer le journal.

## Contrat disponible

```js
import { createSqliteTraceStore } from "./src/sqlite-trace-store.mjs";
import { executeAirDocument } from "./src/index.mjs";

const storage = createSqliteTraceStore({ filename: "./.touba/traces.sqlite" });
try {
  const result = await executeAirDocument(air, { traceStorage: storage });
  for (const event of result.traceReader.events()) {
    // Consume one bounded page at a time; do not collect an unbounded array.
  }
  for (const segment of storage.segments()) {
    const page = storage.page(segment.id, { after: -1, limit: 100 });
    // page.next is an absolute sequence cursor for this segment.
  }
} finally {
  storage.close();
}
```

| Opération | Contrat |
| --- | --- |
| `openSegment(header, startIndex)` | Nouvel identifiant UUID ; l'en-tête et l'indice initial sont durables. |
| `append(id, event)` | Commit synchrone avant `true` ; doublon identique : `false` ; conflit refusé. Le runtime exige `true` pour tout nouvel événement. |
| `appendBatch(id, events)` | Au plus 64 événements et `maxBatchBytes` ; transaction atomique, nombre d'événements ajoutés après commit. |
| `page(id, {after, limit})` | Au plus 1 000 événements ; volume d'une page borné par `maxEventBytes`. |
| `events(id)` | Itérateur paginé ; borne supérieure capturée au début de la lecture. |
| `json(id)` | Fragments JSON d'un document canonique, sans accumuler tous les événements. |
| `document(id)` | Matérialisation explicite sous `maxDocumentBytes`. |
| `snapshot(id)` | Lecteur figé dès l'appel, avec `header`, `eventCount`, `startIndex`, `nextSequenceIndex`, `events({after})`, `json()` et `document()`. |
| `readReference(reference, {after, limit})` | Page d'un segment terminé correspondant à la référence ; même borne d'événements et d'octets que `page`. |
| `segments({runId, after, limit})` | Inventaire paginé par identifiant de segment. |
| `archive({destination, apply, protectedRunIds})` | Prévisualisation par défaut ; archive vérifiée avant retrait des runs réussis non protégés. |
| `close()` | Fermeture explicite de la connexion détenue par l'hôte. |

Un export peut consommer `json(id)` avec `Readable.from(...)` et `pipeline(...)`.
Le consommateur doit respecter la contre-pression de sa destination. Un segment
interrompu est lisible, mais n'est pas une trace terminale complète.

## Durabilité et limites

- SQLite embarqué, `journal_mode=DELETE`, `synchronous=EXTRA`, `fullfsync=ON`.
 Un événement est acquitté après commit. Pas de réseau ni d'exécution à distance.
- Défauts : 512 Mio de contenu sérialisé total, 1 Mio par événement et page,
 16 Mio pour une matérialisation complète. Les plafonds de contenu ne mesurent
 pas l'espace physique total du fichier SQLite ni son journal de transaction.
- Fichier privé (0600 sous POSIX), liens symboliques et liens physiques refusés.
 L'hôte doit protéger le répertoire et utiliser un disque local adapté à SQLite.
- Un `run_id` peut avoir plusieurs segments, notamment après une reprise.
 Les clés de stockage comprennent le segment ; aucun segment précédent n'est écrasé.
- Une erreur d'écriture se propage. Elle ne devient pas un avertissement
 d'observabilité et n'autorise pas la poursuite d'un appel non encore commencé.
 Les effets déjà acquis restent régis par leur journal d'effets.
- Les empreintes détectent une altération accidentelle ; elles ne constituent
 pas une signature contre un administrateur pouvant réécrire la base.

Le builder ne garde pas le tableau croissant en mode SQLite. Les digests JSON
et canoniques des approbations sont calculés progressivement, avec les mêmes
octets qu'avant. L'identité des compensations est présente dès `call_started` ;
le numéro de tentative, connu après lecture du journal d'effets, appartient aux
événements de résultat. Aucun événement publié n'est enrichi après coup.

Les observations internes des fonctions pures (`binding_created`,
`branch_evaluated`, `loop_evaluated`) passent par un tampon d'au plus 32 événements
et 64 Kio, réduit si la limite du stockage est plus petite. Il est vidé avant
tout autre événement, une lecture ou un digest. Les événements d'autorité,
d'appel et de résultat sont ainsi committés avant que l'exécution continue.
Un arrêt brutal peut perdre le dernier détail pur encore en tampon ; un tel
segment reste incomplet. L'observateur best-effort et le compteur de séquence
ne constituent jamais un acquittement durable. Les handlers et checkpoints
ne passent pas une barrière dont l'écriture échoue.

## Lectures et checkpoints

La finalisation valide la trace en flux, sans tableau d'événements ni ensemble
croissant d'identifiants. Les IDs produits par le runtime dérivent du run et de
la séquence contiguë ; cette propriété assure leur unicité pour ce parcours.
Les documents importés gardent leur validateur général, y compris pour des IDs
opaques. Les enveloppes JSON et les digests existants sont inchangés.

Le résultat runtime et les observations de checkpoints exposent `traceReader`,
non sérialisé. Avec SQLite, leur champ `trace` matérialise explicitement le
préfixe capturé, sous la limite de 16 Mio. L'hôte conserve la connexion ouverte
pendant ses lectures. Un observateur de checkpoint peut consommer
`traceReader.json()` progressivement. Les checkpoints séquentiels calculent
leur chaîne de digests uniquement sur les nouveaux événements. Les checkpoints
parallèles capturent leur préfixe avant d'attendre la file de sauvegarde.

La CLI attend chaque écriture de sortie ; l'export fichier privé est atomique.
Une panne après le début du run laisse le segment incomplet et ne produit pas
de faux refus d'admission prétendant qu'aucun effet n'a eu lieu.
Compensations, preuves d'exécution et traces agrégées des déclencheurs utilisent
aussi le lecteur progressif. Les segments sources de l'agrégat conservent leur
identité ; chaque événement agrégé référence le run et l'événement d'origine.
Le résumé CLI garde seulement les approbations, refus, nœuds distincts et
compteurs utiles. Ses collections sont limitées à 16 Mio sérialisés ; un
dépassement refuse cet export avec `TraceSummaryLimitExceeded`, sans supprimer
la trace durable ni transformer le résultat métier du run. Ses dates reprennent
les observations du début et de fin du segment.

Une base existante sans schéma de trace Touba est refusée avant tout changement
de schéma ou de mode de journalisation. Le journal doit avoir son propre chemin.

## Références et SDK

`createTraceReference(reader)` dans `contracts/trace-reference.mjs` produit
une référence sans chemin, avec identités, bornes, en-tête, terminal et digest
du JSON complet. Son calcul parcourt le segment sans le matérialiser.
`createSqliteTraceStore({filename, readOnly: true})` ouvre un journal existant
sans créer de fichier, changer son schéma ou son mode de journalisation.
Les méthodes d'écriture refusent ce mode avec `TraceStorageReadOnly`.

La lecture initiale vérifie le digest complet ; chaque page suivante vérifie
son ordre et les empreintes stockées, ainsi que l'en-tête et le terminal.
Un accès direct par curseur ne vérifie pas les événements précédents.
Ces empreintes ne remplacent ni les permissions d'accès ni une signature.

CLI : `--output json-reference --trace-store ...`, puis `touba trace read`.
SDK : `traceMode: "reference"` / `trace_mode="reference"`, puis `readTrace` /
`read_trace`. Les deux utilisent le même lecteur Core. La réponse contient le
résultat métier et la référence ; `trace` vaut `null` (`None` en Python).
Une pause clôt un segment et sa reprise en crée un nouveau. Avant admission,
le refus garde son enveloppe intégrale, puisqu'aucun segment n'a commencé.
Le SDK JS n'écrit plus de copie JSON temporaire implicite ; `traceOut` reste
un export explicitement demandé.

## Hôtes serveur et éditeur

Le serveur projet accepte le même objet hôte `traceStorage`. L'hôte garde la
connexion ouverte jusqu'à l'arrêt du serveur, puis la ferme. Exécutions,
reprises humaines, terminalisations et reprises durables transmettent cet objet
au runtime. Résumés, diagnostics et contrôles de checkpoints parcourent le
lecteur figé ; ils n'appellent pas son getter de document intégral.

Le serveur garde un index SQLite des segments, sans copie JSON par run.
`GET /runs/{run_id}/trace` exporte le contrat natif en flux avec contre-pression.
`?index=true` fournit l'index ; `/trace/segments/{index}?after=…&limit=100`
lit une page vérifiée. Ces routes conservent l'autorisation du projet et refusent
les jetons mobiles. La matérialisation interne explicite reste limitée à 8 Mio ;
les routes paginées et l'export en flux permettent de lire au-delà.

Les projections persistées gardent les 200 derniers événements, le nombre total,
les compteurs complets et `events_truncated`. Les preuves compactes nécessaires
à l'approbation courante sont conservées séparément lorsqu'elles précèdent cette
fenêtre. Les digests de checkpoints portent toujours sur le préfixe complet.

L'éditeur lit les références par le Core embarqué en lecture seule, après
sélection explicite du journal et confiance du workspace. Il remplace la page
affichée (100 événements maximum) plutôt que de cumuler les pages dans sa sortie.
La navigation vérifie le segment puis demande un événement par son indice.
Le validateur Core `validateTracePageMachineContract` distingue une page d'une
trace complète : corrélation, en-tête, ordre, événements connus, champs sensibles
interdits et terminal quand présent. Le rendu d'une page importée ne prouve pas
à lui seul le digest des événements absents.

`Run Current File` conserve le journal après suppression de l'AIR temporaire.
Avant une reprise interactive, toutes les pages sont vérifiées pour rechercher
un dispatch. Le journal est placé dans le workspace, sinon auprès du fichier ;
un document non enregistré utilise le stockage privé de l'extension.

## Archivage et conservation

```sh
touba trace archive --store .touba/traces.sqlite
touba trace archive --store .touba/traces.sqlite --destination archives/traces.sqlite --apply
```

Le dossier `archives` doit exister et être privé. La destination doit être nouvelle.
L'instantané complet est vérifié et synchronisé sur disque. La source libère
ensuite les runs dont le dernier segment a réussi ; pauses, échecs, segments
interrompus et runs protégés restent présents. Les références restent lisibles
en sélectionnant l'archive comme journal. L'espace SQLite libéré est réutilisable ;
la taille physique du fichier ne diminue pas nécessairement.

Pour un serveur, utiliser l'archivage/restauration de **l'état projet**, serveur
arrêté et opérations terminées : traces, index natif, checkpoints et journaux
d'effets restent ensemble. La rétention isolée refuse un journal associé à cet
état. Les bases hors des chemins standards restent à sauvegarder par l'hôte.
Un ancien état doit être vérifié et archivé avec sa build conservée avant de
créer un nouvel état ; son archive reste restituable avec cette build.

## Portée et lots distincts

Le mode SDK intégral garde la limite de transport de 32 Mio ; le mode référence
permet de lire une trace plus grande par pages, sous la même limite de transport.
L'état dédupliqué des triggers reste un
fichier, à migrer avec les autres collections dans . Les résultats
métier et messages de plusieurs runs restent proportionnels à la sortie
demandée ; la lecture bornée des traces ne borne pas ces valeurs applicatives.
La qualification de débit sur des applications représentatives,
l'export asynchrone PostgreSQL et la
rétention des autres collections constituent les lots suivants. Aucune purge
automatique ni migration de bases existantes n'est activée par ce module.

## Vérification

`node --test test/sqlite-trace-store.test.mjs test/compensation-runtime.test.mjs`
couvre exécution réelle, pause/reprise, compensation, ordre, doublons, conflits,
deux connexions, quotas, refus avant handler, corruption et arrêt de processus
par SIGKILL. L'épuisement physique du disque et la charge industrielle restent
à qualifier séparément.

La recette de volume crée 10 002 événements (~84 Mo JSON) dans un processus
Node dont le heap est limité à 48 Mio, puis valide et exporte toute la trace.
Mesure Mac du 24 octobre : 26,2 s, heap vivant après GC ~5,6 Mo. Ce contrôle
porte sur le stockage/lecteur, pas sur toute la mémoire métier d'une application.
Les tests de checkpoints comparent les digests existants aux préfixes lus après
l'avancement d'autres branches. Les recettes CLI et SDK utilisent la vraie
compilation et un journal SQLite rouvert après la fin de l'exécution.
