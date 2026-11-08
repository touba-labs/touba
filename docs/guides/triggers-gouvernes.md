---
sidebar_position: 9
---

# Triggers gouvernés

Un trigger Touba transforme un événement en exécution gouvernée.

Deux chemins V1 sont disponibles :

```text title="Forme disponible"
schedule -> strategy
request -> strategy
```

Le premier utilise un runner foreground borné. Le second utilise un service
webhook HTTP explicite, avec queue persistante, état TD-1 et trace. Les
deux chemins passent par AIR, manifest et vérifications runtime avant
d’exécuter la stratégie.

## 1. Écrire le programme

<!-- touba-example: compile -->
```touba title="src/examples/daily_research.tb"
module examples.daily_research

strategy DailyResearch
    takes topic as Text
    do
        show
            with message as "Daily research run: " ++ topic

trigger DailyResearchSchedule
    on schedule "every 1s"
    runs strategy DailyResearch
    with topic as "daily review"
    limits
        max_runs_per_day as 1
        timeout_ms as 30000

trigger DailyResearchWebhook
    on request POST "/webhook/daily-research"
    runs strategy DailyResearch
    with topic as payload.topic
    limits
        max_runs_per_day as 10
        timeout_ms as 30000
```

Le runner accepte ce format :

```text title="Standard"
every <n>s
every <n>m
every <n>h
```

Un cron complet reste hors périmètre du runner.

### Planifier dans un projet administré par client

Exposez le trigger dans `entrypoints` de `touba.project.json`, préparez le projet,
Le serveur peut ensuite gérer ses échéances :

```sh title="Terminal"
touba serve --schedule-triggers \
  --agent-decision-provider hosts/decision.mjs \
  --human-approval-host hosts/approval.mjs \
  --secrets touba.secrets.dev.json
```

Conservez vos options de connexion Cloud. Les modules hôtes et secrets sont ceux
explicitement configurés par l'exploitant. L'interface ne les charge pas à chaud.
L'option de planification reste désactivée par défaut.

client affiche les prochaines échéances, le dernier résultat, les occurrences
manquées et les interruptions. Le serveur traite un run à la fois. Une décision
humaine en attente bloque les nouvelles occurrences du même trigger. Elle peut
être approuvée et reprise dans client, y compris après redémarrage.

Les intervalles suivent les bornes UTC. Un nouveau plan commence à l'échéance
suivante. Après une interruption du service, les occurrences intermédiaires sont
comptées comme manquées ; une seule occurrence courante peut démarrer. Une
horloge reculée ne rejoue pas les anciennes échéances. Le registre d'admission
SQLite applique le rejeu et `max_runs_per_day` aussi aux appels manuels depuis
client.

Si le serveur s'arrête au milieu d'un run, le plan reste interrompu. Après examen
de ses traces et effets, un responsable autorisé peut **Revoir l'interruption**,
avec un motif. Cela autorise les prochaines échéances sans rejouer le run ancien.
Les reprises métier d'un effet externe restent régies par son contrat d'idempotence.

Limites de ce premier ordonnanceur : un serveur par racine de projet, un worker,
100 plans conservés et 2 Mio d'état de planification. L'état du planificateur est
dans `.touba/trigger-scheduler.sqlite` ; l'admission des événements demeure dans
`.touba/triggers.sqlite`. Conservez les deux avec les traces et checkpoints lors
des sauvegardes. Le service webhook indépendant garde ses propres procédures.

## 2. Compiler

```sh title="Terminal"
touba compile src/examples/daily_research.tb --out daily_research.air.json
```

L’AIR contient la déclaration du trigger, sa cible et ses limites. Il ne contient pas de scheduler, de secret ou de payload externe.
`payload.topic` est un binding dynamique du champ de l’événement, pas une valeur
factice ni une valeur de repli. Le mapping du manifest doit couvrir ce même
argument ; un champ manquant est refusé avant l’exécution.

## 3. Activer le trigger dans le manifest

Dans un projet préparé, utilisez les
[décisions hôtes de triggers](projet-touba-prepare.md#ressources-déclarées-et-déclencheurs)
avec `prepare --host-decisions`. La préparation crée les entrées désactivées ;
la décision hôte sélectionne celles à activer et peut abaisser leurs limites.
Le manifest ci-dessous illustre le résultat attendu et le parcours hors projet
avec des artefacts explicites.

```json title="touba.manifest.json"
{
  "manifest_version": "touba-manifest-v1",
  "bindings": {},
  "triggers": {
    "trigger:examples.daily_research/DailyResearchSchedule": {
      "enabled": true,
      "source": {
        "kind": "schedule"
      },
      "limits": {
        "max_runs_per_day": 1,
        "timeout_ms": 30000
      }
    },
    "trigger:examples.daily_research/DailyResearchWebhook": {
      "enabled": true,
      "source": {
        "kind": "request"
      },
      "payload": {
        "format": "json",
        "content_types": ["application/json"],
        "max_bytes": 4096,
        "map": {
          "topic": "$.topic"
        }
      },
      "limits": {
        "max_runs_per_day": 10,
        "timeout_ms": 30000
      }
    }
  }
}
```

Sans cette entrée, le runtime refuse le trigger avant d’exécuter la stratégie.

## 4. Lancer le trigger réel

```sh title="Terminal"
touba trigger run daily_research.air.json \
  --manifest touba.manifest.json \
  --trigger trigger:examples.daily_research/DailyResearchSchedule \
  --max-runs 1 \
  --state touba.triggers.sqlite \
  --trace-out daily_research.trace.json
```

Résultat attendu après environ une seconde :

```text title="Sortie"
Daily research run: daily review
```

`--max-runs` fixe le nombre d’exécutions. Le registre SQLite par défaut est
`.touba/triggers.sqlite`, dans le projet ou à côté de l’AIR hors projet.
`--state` permet de choisir un autre fichier `.sqlite`.

La trace écrite dans `daily_research.trace.json` contient l’événement reçu, l’acceptation du trigger, le début d’exécution et la fin du run.

Le registre SQLite mémorise les `event_id` consommés, les refus
observés et la clé de jour UTC utilisée pour appliquer `max_runs_per_day`, sans
payload brut. Si un même événement est rejoué, Touba refuse avant de relancer la
stratégie avec `TriggerReplayRejected`. Une acceptation enregistrée un jour
précédent ne bloque pas le premier événement du jour courant. Le chemin passé à
`--state` doit se terminer par `.triggers.sqlite`.

## 5. Lancer le service webhook

```sh title="Terminal"
touba trigger serve daily_research.air.json \
  --manifest touba.manifest.json \
  --state touba.triggers.sqlite \
  --queue touba.trigger-queue.sqlite \
  --trace-dir traces \
  --max-events 1
```

Si le manifest V1 contient un binding `external_write`, ajoutez un journal
d'effets local :

```sh title="Terminal"
touba trigger serve daily_research.air.json \
  --manifest touba.manifest.json \
  --state touba.triggers.sqlite \
  --queue touba.trigger-queue.sqlite \
  --effect-journal touba.effect-journal.sqlite
```

Le service refuse de démarrer sans ce journal. Le `queue_id` de l'entrée sert
de portée stable aux tentatives successives du même effet logique.

Dans un autre terminal :

```sh title="Terminal"
curl -X POST http://127.0.0.1:8787/webhook/daily-research \
  -H 'content-type: application/json' \
  -H 'x-touba-event-id: evt-webhook-001' \
  -d '{"topic":"industrial adoption"}'
```

Le service répond `202 queued`, inscrit une entrée dans
`touba.trigger-queue.sqlite`, exécute la stratégie, écrit l’état TD-1 et produit
une trace par entrée si `--trace-dir` est fourni. Le corps HTTP brut n’est pas
injecté comme input Touba implicite et n’est pas écrit dans la queue, l’état ou
la trace ; la queue conserve la taille, le digest SHA-256 du payload et les
arguments explicitement mappés par le manifest. Les champs non listés dans
`payload.map` sont ignorés.

`(trigger_ref, event_id)` identifie une réception logique. Avec un
`x-touba-event-id` explicite, le même digest de payload réutilise l'entrée et
son `queue_id` sans nouvel enqueue ; un digest différent sous la même identité
est refusé avec `TriggerEventPayloadConflict` avant enqueue. Une entrée active
est renvoyée avec `deduplicated: true` ; une entrée terminale déjà consommée
produit `TriggerReplayRejected` en conservant le même `queue_id`. Sans cet
en-tête, le service génère une nouvelle identité pour chaque requête et ne peut
pas dédupliquer les retries de l'émetteur. Un en-tête présent mais invalide est
refusé avec `TriggerEventIdInvalid` avant mise en queue. Les valeurs explicites
acceptées contiennent de 1 à 128 lettres ASCII, chiffres, points, tirets bas,
deux-points ou tirets.

Pour exposer ce webhook à un fournisseur externe, ajouter
`--signature-secret-env TOUBA_TRIGGER_SIGNATURE_SECRET` et envoyer
`x-touba-signature: sha256=<hmac>` calculé sur le corps HTTP exact.

Sur une interface non loopback, ajouter `--auth-token-env TOUBA_TRIGGER_TOKEN` et
envoyer `Authorization: Bearer <token>` ou `x-touba-trigger-token: <token>`.

Les arguments issus de `payload.map` deviennent les inputs typés de la stratégie
déclenchée et restent accessibles à ses agents sous la frontière de contenu du
decision provider.

### Modèles et approbations du service autonome

Sélectionnez les mêmes modules hôtes de confiance que pour une exécution CLI :

```sh title="Terminal"
touba trigger serve program.air.json \
  --manifest touba.manifest.json \
  --agent-decision-provider hosts/decisions.mjs \
  --human-approval-host hosts/approvals.mjs \
  --human-checkpoint-store .touba/approval-checkpoints.sqlite \
  --auth-token-env TOUBA_TRIGGER_TOKEN \
  --management-token-env TOUBA_TRIGGER_MANAGEMENT_TOKEN
```

Les modules JavaScript ou Python sont chargés au démarrage explicite. Un module
Python utilise l'interpréteur du SDK installé, sélectionnable par
`TOUBA_HOST_PYTHON`. Ajoutez `--secrets` et `--effect-journal` selon les contrats
du projet. Les délais du fournisseur et de l'attestation sont configurables
par `--agent-decision-provider-timeout-ms` et
`--human-approval-authority-timeout-ms`.

Une pause d'approbation devient `awaiting_human`. Le checkpoint complet reste
dans la file privée, lié à sa garde SQLite. Le service continue à recevoir les
autres événements sans relancer cette stratégie. Après redémarrage, l'attente
et son identité sont conservées.

L'interface d'administration autonome est distincte de l'arrivée des webhooks :

| Route privée | Contenu |
| --- | --- |
| `GET /_touba/approvals?after=…` | Références des attentes, rôle demandé et curseur ; aucun argument ou checkpoint brut |
| `POST /_touba/approvals` | `queue_id`, `request_id` et `decision` avec `decision: "approved"` ou `"rejected"`, puis `evidence_ref` |

Ces routes exigent le jeton de gestion, différent du jeton d'entrée. Elles sont
absentes sans `--management-token-env`. Gardez-les derrière votre accès privé
et HTTPS. Le jeton de gestion permet de soumettre une décision ; l'hôte
d'attestation doit encore vérifier sa preuve, son signataire, son rôle et la
demande exacte. Une référence inventée ne constitue pas une approbation.

La reprise utilise exclusivement le checkpoint conservé. Elle ne reçoit ni
nouveaux arguments, ni nouvelle politique. Une décision périmée, un checkpoint
modifié ou un rejeu ne déclenche pas l'effet. Une seconde approbation produit
une nouvelle demande. Les traces de chaque segment sont conservées séparément.
`/status` distingue les attentes humaines et les interruptions ; client les lit
depuis les magasins déclarés dans **Opérations**. Pour le parcours humain intégré
dans **Décisions**, utilisez le serveur projet administré : ses sessions et
identités Cloud sont distinctes de ce service autonome.

## 6. Tester les checks sans exécuter

```sh title="Terminal"
touba run daily_research.air.json \
  --manifest touba.manifest.json \
  --trigger-event-json '{"trigger_ref":"trigger:examples.daily_research/DailyResearchSchedule","event_id":"evt-001","source_kind":"schedule"}' \
  --trigger-dry-run
```

Résultat attendu :

- le trigger existe dans l’AIR ;
- le manifest l’active ;
- la source événementielle correspond ;
- les limites du manifest n’élargissent pas celles de l’AIR ;
- la stratégie cible n’est pas lancée en dry-run.

## 7. Exécuter avec un événement explicite

```sh title="Terminal"
touba run daily_research.air.json \
  --manifest touba.manifest.json \
  --trigger-event-json '{"trigger_ref":"trigger:examples.daily_research/DailyResearchSchedule","event_id":"evt-002","source_kind":"schedule"}' \
  --output trace
```

Ce mode sert aux tests d’hôte ou d’adapter. Il fournit l’événement à la main au lieu d’attendre l’intervalle déclaré.

## 8. Inspecter

```sh title="Terminal"
touba inspect daily_research.air.json
touba inspect trace.json
touba trigger state touba.triggers.sqlite --trigger trigger:examples.daily_research/DailyResearchSchedule
touba inspect daily_research.air.json --manifest touba.manifest.json
```

L’inspection affiche ce qui existe dans les artefacts fournis. Pour l’état
durable de trigger (TD-1), elle affiche les compteurs d’acceptations, de refus et
d’`event_id` consommés. Le service webhook existe quand il est lancé
explicitement par `touba trigger serve` ; la supervision de déploiement relève
de l’environnement hôte.

## Conservation et migration

L’admission du déclencheur est enregistrée avant le lancement de sa stratégie.
Un arrêt du processus conserve ainsi l’identité consommée. Les compteurs sont
calculés par jour UTC ; les identifiants anti-rejeu restent conservés après archivage.

Le registre est limité à 512 Mio par défaut. `--state-max-bytes` ajuste ce
plafond (minimum 65 536 octets). Un registre plein bloque une nouvelle admission.

```sh title="Consulter une page"
touba trigger state touba.triggers.sqlite --limit 100
touba trigger state touba.triggers.sqlite --after 100 --limit 100
```

Utilisez la valeur `next` renvoyée comme curseur de la page suivante.
`--trigger <référence>` filtre les événements et ajoute les compteurs du trigger.

```sh title="Archiver les événements terminés"
touba trigger archive-state touba.triggers.sqlite --before 2026-10-01T00:00:00Z
touba trigger archive-state touba.triggers.sqlite --before 2026-10-01T00:00:00Z \
  --out archives/triggers-octobre.sqlite --apply
```

La première commande prévisualise. La seconde copie puis vérifie l’archive
avant de retirer les détails des événements réussis et des refus. Les événements
actifs, suspendus ou d’issue incertaine, les compteurs et les identifiants
consommés restent dans le registre. L’archive se consulte avec `touba trigger state`.

Pour convertir un ancien état JSON, arrêtez son service puis lancez :

```sh title="Migration explicite"
touba trigger migrate-state ancien.trigger-state.json --out touba.triggers.sqlite
touba trigger migrate-state ancien.trigger-state.json --out touba.triggers.sqlite --apply
```

La migration crée un nouveau registre et une copie exacte `.source-backup.json`.
Elle conserve le fichier d’origine et refuse d’écraser une destination existante.
Les états migrés restent d’issue incertaine, car l’ancien registre conservait
l’admission mais pas le résultat final. Aucun événement n’est relancé.

## Refus utiles

| Situation | Comportement attendu |
| --- | --- |
| Trigger absent de l’AIR | refus avant exécution |
| Trigger désactivé dans le manifest | refus avant exécution |
| Source événementielle différente | refus avant exécution |
| Manifest qui élargit une limite AIR | refus avant exécution |
| Événement runtime normalisé sans `event_id` | refus avant exécution |
| `event_id` déjà consommé dans `--state` | refus replay avant exécution |
| Même identité webhook et même digest | entrée et `queue_id` existants réutilisés |
| Même identité webhook et digest divergent | `TriggerEventPayloadConflict` avant mise en queue |
| En-tête `x-touba-event-id` invalide | `TriggerEventIdInvalid` avant mise en queue |
| Service webhook sans `--queue` | file SQLite dans `.touba/trigger-queue.sqlite` |
| Écriture externe sans `--effect-journal` | refus CLI avant démarrage |
| Payload request non conforme au manifest | refus avant mise en queue |
| Signature webhook invalide | refus avant mise en queue |
| Service webhook exposé hors loopback sans token | refus CLI avant démarrage |

Le worker sérialise les entrées et se réveille à l’échéance d’un retry.
La prise en charge et les mises à jour des entrées sont transactionnelles.
Une entrée expirée reste réservée à son processus tant que celui-ci est vivant.
Déployez un seul service par projet ; la coordination des effets entre hôtes
nécessite un protocole de reprise supplémentaire.

Une entrée `processing` ou `continuing` dont le processus a disparu devient
`interrupted`, avec `recovery_effect_outcome: "unknown"`. Aucun redémarrage de
stratégie n'est automatique après cette interruption. Examinez les traces et
les reçus du service externe avant toute nouvelle demande. Les retries d'un
échec dont le résultat est connu restent bornés par `--max-attempts` et le
contrat d'effet : une écriture inconnue exige `idempotency_key`, tandis que
`reconcile` et `none` la bloquent. La queue,
le journal et l’état des déclencheurs utilisent des transactions SQLite.
L’admission est durable avant le lancement de la stratégie.
Ces écritures ne forment pas une transaction avec l’effet externe. Le service ne promet
donc pas `exactly-once` ni un rapprochement automatique.

## Portée

:::info
- Le runner foreground exécute les entrées planifiées gouvernées.
- Le service webhook exécute les entrées `request -> strategy`.
- La queue durable suit `touba-trigger-queue-v1`.
- Le manifest active explicitement chaque trigger.
- L’état de trigger enregistre les `event_id` consommés et les refus de replay.
- Les contrats de payload du manifest mappent des champs JSON explicites vers
 les arguments de la stratégie cible.
- Le service webhook gère les signatures HMAC, retries bornés, attentes humaines
 durables, interruptions à réconcilier et états dead-letter.
- La propriété de queue et du journal est locale à un processus. Le package
 doit honorer réellement la clé idempotente ou le rapprochement déclaré.
- La CLI, le SDK, le service de triggers et le serveur projet raccordent un
 journal d'effets, avec des identités de portée propres à chaque hôte.
- Les schedulers distribués, queues distribuées, adapters cloud, auto-discovery
 de manifest, déclenchements directs d’agents et certifications réglementaires
 relèvent des couches plateforme environnantes.
:::
