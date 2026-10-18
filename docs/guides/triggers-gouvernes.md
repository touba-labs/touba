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

## 2. Compiler

```sh title="Terminal"
touba compile src/examples/daily_research.tb --out daily_research.air.json
```

L’AIR contient la déclaration du trigger, sa cible et ses limites. Il ne contient pas de scheduler, de secret ou de payload externe.
`payload.topic` est un binding dynamique du champ de l’événement, pas une valeur
factice ni une valeur de repli. Le mapping du manifest doit couvrir ce même
argument ; un champ manquant est refusé avant l’exécution.

## 3. Activer le trigger dans le manifest

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
  --state touba.trigger-state.json \
  --trace-out daily_research.trace.json
```

Résultat attendu après environ une seconde :

```text title="Sortie"
Daily research run: daily review
```

`--max-runs` est obligatoire pour éviter toute boucle implicite. `--state` est
obligatoire pour que le runner conserve la preuve des événements consommés et
applique les quotas de manière durable. Le runner s’arrête après le nombre de
runs demandé.

La trace écrite dans `daily_research.trace.json` contient l’événement reçu, l’acceptation du trigger, le début d’exécution et la fin du run.

Le fichier `touba.trigger-state.json` suit le schéma
`touba-trigger-state-v1`. Il mémorise les `event_id` consommés, les refus
observés et la clé de jour UTC utilisée pour appliquer `max_runs_per_day`, sans
payload brut. Si un même événement est rejoué, Touba refuse avant de relancer la
stratégie avec `TriggerReplayRejected`. Une acceptation enregistrée un jour
précédent ne bloque pas le premier événement du jour courant. Le chemin passé à
`--state` doit se terminer par `.trigger-state.json`.

## 5. Lancer le service webhook

```sh title="Terminal"
touba trigger serve daily_research.air.json \
  --manifest touba.manifest.json \
  --state touba.trigger-state.json \
  --queue touba.trigger-queue.json \
  --trace-dir traces \
  --max-events 1
```

Si le manifest V1 contient un binding `external_write`, ajoutez un journal
d'effets local :

```sh title="Terminal"
touba trigger serve daily_research.air.json \
  --manifest touba.manifest.json \
  --state touba.trigger-state.json \
  --queue touba.trigger-queue.json \
  --effect-journal touba.effect-journal.json
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
`touba.trigger-queue.json`, exécute la stratégie, écrit l’état TD-1 et produit
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
decision provider. Le service de triggers ne fournit pas encore la reprise
générale d'une opération suspendue ; cette capacité relève d'une tranche
ultérieure. Il ne faut donc pas assimiler un checkpoint runtime ou un
`operation_id` du serveur de projet au `queue_id` durable décrit ici.

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
touba inspect touba.trigger-state.json
touba inspect daily_research.air.json --manifest touba.manifest.json
```

L’inspection affiche ce qui existe dans les artefacts fournis. Pour l’état
durable de trigger (TD-1), elle affiche les compteurs d’acceptations, de refus et
d’`event_id` consommés. Le service webhook existe quand il est lancé
explicitement par `touba trigger serve` ; la supervision de déploiement relève
de l’environnement hôte.

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
| Runner lancé sans `--state` | refus CLI avant exécution |
| Service webhook sans `--queue` | refus CLI avant démarrage |
| Écriture externe sans `--effect-journal` | refus CLI avant démarrage |
| Payload request non conforme au manifest | refus avant mise en queue |
| Signature webhook invalide | refus avant mise en queue |
| Service webhook exposé hors loopback sans token | refus CLI avant démarrage |

Le worker du service est unique dans le processus. Il sérialise les entrées et
se réveille à l’échéance d’un retry sans attendre un nouveau webhook. Utilisez
un seul processus pour un même ensemble de fichiers `--queue`, `--state` et,
le cas échéant, `--effect-journal` : leur partage entre plusieurs processus
n’est pas supporté.

La reprise d’une entrée `processing` périmée conserve
`recovery_effect_outcome: "unknown"`, car un effet externe a pu réussir avant
l'interruption. Le contrat d'effet V1 est obligatoire : le journal autorise
une nouvelle tentative d'écriture inconnue
uniquement pour `idempotency_key` et bloque `reconcile` ou `none`. Les fichiers
de queue, d'état et de journal sont remplacés atomiquement chacun de leur côté,
mais ne forment pas une transaction avec l'effet externe. Le service ne promet
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
- Les signatures HMAC, retries bornés, reprises d’entrées `processing` et états
  dead-letter sont supportés par le service webhook.
- La propriété de queue et du journal est locale à un processus. Le package
  doit honorer réellement la clé idempotente ou le rapprochement déclaré.
- La CLI, le SDK, le service de triggers et le serveur projet raccordent un
  journal d'effets, avec des identités de portée propres à chaque hôte.
- Les schedulers distribués, queues distribuées, adapters cloud, auto-discovery
  de manifest, déclenchements directs d’agents et certifications réglementaires
  relèvent des couches plateforme environnantes.
:::
