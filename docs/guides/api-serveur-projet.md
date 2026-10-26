# API du serveur projet

`touba serve` relie une application au runtime Touba par HTTP et SSE.
L'application authentifie ses utilisateurs, présente les dossiers et transmet
leurs décisions ; le runtime conserve le contrôle des capacités et des effets.

## Terminer une session et archiver l'état

| Action | Route |
| --- | --- |
| Demander l'annulation d'une opération | `POST /interactions/sessions/{session_id}/operations/{operation_id}/cancel` |
| Archiver une session terminée | `POST /interactions/sessions/{session_id}/archive` |

Ces deux appels acceptent un corps JSON vide. L'annulation est coopérative :
relisez l'opération jusqu'à son état terminal. L'archivage de session conserve
ses décisions et preuves.

Pour repartir sur un état serveur neuf en développement, arrêtez le serveur,
résolvez les attentes et videz les files de déclenchement, puis :

```sh
touba serve --check-state
touba serve --archive-state
touba serve --archive-state --apply
```

L'aperçu liste les fichiers et leur taille. `--apply` déplace l'état vers
`.touba/state-archives/<identifiant>/`, avec inventaire et empreintes. Les
sources, packages, SDK, manifests et secrets restent en place. Ce nouveau
départ utilise un journal d'effets neuf : réservez-le aux jeux de données de
développement maîtrisés. Pour une reprise métier, conservez l'état existant.

Une restauration refuse d'écraser un état courant :

```sh
touba serve --restore-state <identifiant>
touba serve --restore-state <identifiant> --apply
```

Si l'archivage est interrompu, le serveur attend cette restauration. Utilisez
la build correspondant à l'état restauré. Les chemins d'état personnalisés
restent à sauvegarder avec leur procédure d'exploitation.

### Identifiants et commentaire d'une décision

`client_ref` identifie l'application qui soumet la décision.
`evidence_ref` désigne la preuve consultée par l'adaptateur d'attestation.
Ils ont deux rôles distincts et peuvent être présents ensemble.
Le commentaire est disponible dans `Approval.comment`, un `Optional of Text`
limité à 4 096 caractères. C'est du texte saisi par l'utilisateur ; seuls
`subject_ref` et `attested_roles` viennent de l'attestation validée.

## Préparer et démarrer

Depuis la racine du projet :

```sh
touba prepare --profile dev --mode write
touba prepare --profile dev --mode check
touba serve --project-root . --host 127.0.0.1 --port 8791 \
  --auth-token-env TOUBA_SERVER_TOKEN \
  --identity project-identity.json \
  --agent-decision-provider providers/decision.mjs
```

Définissez `TOUBA_SERVER_TOKEN` dans l'environnement de l'hôte avec un secret
fort. Ne l'envoyez pas au navigateur et ne le versionnez pas. Omettez
`--identity` lorsque votre adaptateur `--human-approval-host` atteste les
approbations depuis l’annuaire applicatif, ou en l’absence de décision humaine.
Omettez l’option provider si aucune décision agentique n’est requise. Un module provider est du code
hôte de confiance, jamais un fichier fourni par un utilisateur du client.

Le serveur lit directement la préparation `.touba/build/dev/` : aucune copie
d'AIR n'est nécessaire. Il vérifie les empreintes de ses entrées avant une
exécution. Après une modification, relancez `prepare`, puis
`POST /project/refresh`. Une préparation périmée est refusée. Le sandbox utilise
le profil de développement ; ce parcours ne constitue pas une activation de
production. Sans préparation, des AIR explicitement compilés dans le projet
restent utilisables.

`serve` accepte aussi `--agent-decision-provider-metadata-json`,
`--agent-decision-provider-content-mode inline|opaque_refs`,
`--agent-decision-provider-initial-mode summary|capabilities`,
`--agent-decision-provider-timeout-ms` et
`--agent-decision-provider-max-retries`.
Voir le [guide SDK](./sdk-javascript.md) pour le contrat du provider.
Les secrets de tools viennent de `touba.secrets.dev.json` ou de
`--secrets <profil.json>`.

Si vous maintenez un manifest explicite (notamment pour activer des triggers sans tools), préparez avec `--manifest touba.manifest.json` lors des modes `write` et `check`. Sans cette option, la préparation utilise son manifest dérivé, pas un fichier homonyme choisi implicitement à la racine.

Le fichier `--identity` doit rester à l'intérieur de `--project-root`. Son chemin relatif est résolu depuis cette racine. Un chemin extérieur est refusé avec `ToubaServeProductIdentityPathInvalid`, détaillé sous `ToubaServePreflightFailed`. Placez la configuration hôte dans le projet, sans y versionner de secret ni d'identifiants personnels.

## Entrées et hôtes du projet

Déclarez les parcours que l'application peut démarrer dans `touba.project.json` :

```json
{
  "entry": "strategy:app.expenses/ReviewExpense",
  "entrypoints": ["strategy:app.expenses/Reconcile"]
}
```

`entry` est le parcours par défaut ; `entrypoints` ajoute les autres parcours.
Après modification, relancez `touba prepare --mode write`. La CLI sélectionne
un parcours avec `touba run --project . --entry strategy:app.expenses/Reconcile`.
Le serveur publie ces entrées dans `GET /project` et contrôle la même liste
avant exécution et reprise. Les agents internes restent appelés par leurs
stratégies autorisées. Gardez les outils d'écriture internes hors de cette
liste lorsqu'une stratégie porte leur approbation.

Les options `--agent-decision-provider` et `--human-approval-host` acceptent
des modules JavaScript (`.mjs`) ou Python (`.py`). Installez le SDK Python avec
`touba sdk install python` ; le serveur utilise l'interpréteur de `.venv`.
Un même module choisi pour les deux rôles est chargé une seule fois et son
processus Python est fermé à l'arrêt du serveur.

| Rôle exporté | JavaScript | Python |
| --- | --- | --- |
| Décision agentique | `decideAgentCapability` | `decide_agent_capability` |
| Attestation humaine | `attestHumanApproval` | `attest_human_approval` |
| Initiateur constant | `initiatorRef` | `initiator_ref` |
| Initiateur attesté par run | `resolveInitiator` | `resolve_initiator` |
| Mode initial par agent | `initialModes` | `initial_modes` |

Le résolveur d'initiateur reçoit `run_id`, `entry_ref` et `inputs`. Il vérifie
la preuve applicative avant de renvoyer l'identifiant opaque de l'initiateur.
Cet identifiant est conservé à la reprise. `requested_by` reste une indication
du client, pas une preuve d'identité.

Pour une approbation avec un hôte d'attestation, l'application conserve son
annuaire et authentifie ses utilisateurs. Le serveur transmet
`{ request, decision, evidenceRef, hostDecision }` à l'adaptateur. Le POST
peut porter `evidence_ref`, une référence opaque à la preuve ; sans ce champ,
`evidenceRef` vaut `request_id`. L'adaptateur vérifie la demande, le signataire
et ses droits actuels. Le signataire attesté doit correspondre à `user_ref`
et `decided_by`.

La demande publique expose `policy` : rôle, délai et séparation des signataires.
Une décision acceptée conserve son reçu. Retirer l'adaptateur après redémarrage
ne supprime pas l'exigence d'attestation. Sans adaptateur, le parcours avec
`--identity` reste disponible ; les revues agentiques conservent ce contrôle.

## Routes d'exécution

Toutes les requêtes applicatives portent `Authorization: Bearer <jeton>`.
Les POST JSON portent `Content-Type: application/json`. Les contrats ci-dessous
sont les valeurs exactes de `schema_version`, pas des noms de versions du logiciel.

| Méthode et route | Contrat envoyé ou rôle |
| --- | --- |
| `GET /health` | disponibilité du processus |
| `GET /project` | inspection, entrées et signatures exécutables |
| `POST /project/refresh` | `touba-project-refresh-request-v1` |
| `GET /identity` | identité de projet, appareils et affectations |
| `POST /runs/sandbox` | `touba-sandbox-run-request-v1`, `execution_kind: "entrypoint"` |
| `POST /triggers/fire` | même contrat, `execution_kind: "trigger"` |
| `GET /interactions/sessions` | liste bornée des sessions |
| `POST /interactions/sessions` | `touba-interaction-session-create-v1` |
| `GET /interactions/sessions/<session_id>` | messages, résultats et opérations |
| `POST /interactions/sessions/<session_id>/messages` | `touba-interaction-message-request-v1`, réponse 202 avec opération |
| `GET /interactions/sessions/<session_id>/operations/<operation_id>` | état de l'opération |
| `GET /approvals/pending/current?run_id=<run_id>` | demande `touba-approval-request-v1` |
| `GET /reviews/pending/current?run_id=<run_id>` | demande `touba-human-review-request-v1` |
| `POST /decisions` | `touba-approval-decision-v1` ou `touba-human-review-decision-v1` |
| `POST /runs/sandbox/resume` | objet `{ "request_id": "..." }` |
| `POST /interactions/sessions/<session_id>/resume` | `touba-interaction-resume-request-v1` avec `request_id` |
| `GET /events` | SSE ; `Last-Event-ID` permet une reprise dans la rétention disponible |

`/runs/sandbox` et `/triggers/fire` partagent un schéma mais ont des discriminants
différents : envoyer un trigger à la première route est refusé.

Exemple d'exécution directe, avec la référence réellement publiée par
`GET /project` :

```json
{
  "schema_version": "touba-sandbox-run-request-v1",
  "execution_kind": "entrypoint",
  "target_ref": "strategy:app.expenses/ReviewExpense",
  "inputs": { "amount": 125 },
  "effect_policy": "runtime_only",
  "requested_by": { "kind": "service", "id": "expense-backend" },
  "reason": "Review the submitted expense"
}
```

`runtime_only` refuse les effets externes. Choisissez explicitement
`allow_declared_external_effects` pour les parcours qui en ont besoin ; cette
option ne crée aucun grant et ne contourne aucune approbation.

## Session, approbation, décision, reprise

1. Créez une session avec `target_ref`, `target_kind: "strategy"`,
 `presentation: "workflow"`, `effect_policy` et `requested_by`.
2. Envoyez un message avec un `message_id` unique, `display_text`, `inputs`
 et `requested_by`. Conservez `session_id`, `operation_id` et `run_id`.
3. Suivez l'opération via SSE ou sa route GET. Si elle est `awaiting_human`,
 chargez la demande avec **son `run_id`**, pas le dernier run global.
4. Présentez `summary`, `allowed_decisions` et `expires_at`, puis envoyez
 les références exactes reçues dans la demande :

```json
{
  "schema_version": "touba-approval-decision-v1",
  "request_id": "request-id-returned-by-server",
  "run_id": "run-id-returned-by-server",
  "trace_ref": "trace-reference-returned-by-server",
  "user_ref": "user:reviewer",
  "device_ref": "device:backend-reviewer",
  "decision": "approve",
  "decided_by": "user:reviewer",
  "decided_at": "2026-10-15T12:00:00.000Z",
  "comment": "Receipt and supplier verified.",
  "client_ref": "expense-backend"
}
```

5. Après l'acceptation 202 de la décision, reprenez la session avec son
 `request_id`. Une décision acceptée n'est pas encore un effet exécuté.
 Lisez le résultat terminal, y compris après un rejet ou une expiration.

Le résumé reprend uniquement le `context` explicite de `human.approve`,
évalué au moment de la pause et limité à 4 096 caractères. Choisissez un dossier
utile et sans données inutiles ; une troncature n'est pas un dossier complet.
Les champs sensibles usuels d'un record sont masqués et les valeurs de secrets
résolues sont interdites dans le checkpoint. Cette protection n'est pas un
détecteur universel de données personnelles : ne placez pas de secrets dans
du texte libre. Les messages `show` et les autres inputs ne sont pas recopiés.
Le contexte privé reste hors des traces et événements SSE.

## Configurer les identités de décision

`--identity` charge un fichier hôte conforme à `touba-product-identity-v1`.
Ce n'est ni une route d'inscription ni une authentification. Exemple local
minimal, réservé à un backend de confiance :

```json title="project-identity.json"
{
  "schema_version": "touba-product-identity-v1",
  "generated_at": "2026-10-15T12:00:00.000Z",
  "summary": {
    "user_count": 1, "team_count": 0, "device_count": 1,
    "active_assignment_count": 0, "revoked_device_count": 0
  },
  "users": [{
    "user_ref": "user:reviewer", "display_name": "Expense reviewer",
    "email": null, "status": "active", "team_refs": [],
    "role_refs": ["role:reviewer"]
  }],
  "teams": [],
  "roles": [{
    "role_ref": "role:reviewer", "name": "Reviewer", "scope": "human_decision"
  }],
  "devices": [{
    "device_ref": "device:backend-reviewer", "user_ref": "user:reviewer",
    "kind": "service", "status": "paired",
    "paired_at": "2026-10-15T12:00:00.000Z", "revoked_at": null
  }],
  "sessions": [], "assignments": [], "escalation_policies": [], "events": []
}
```

L'utilisateur doit être actif et l'appareil appairé à cet utilisateur. Le rôle
`human_decision` est large : il permet de traiter les demandes du projet.
Pour limiter un approbateur à un dossier, utilisez une affectation active
liée à `request_id`, `run_id`, `trace_ref`, `user_ref` et `device_ref`,
sans lui ajouter en parallèle le rôle global. Une affectation expirée ou un
appareil révoqué ne doit pas être « réparé » en désactivant les contrôles.

Le serveur exige les mêmes `request_id`, `run_id`, `trace_ref`, utilisateur
et appareil que la décision, un statut d'affectation actif et
`assigned_at <= heure serveur < expires_at`. L'égalité avec l'échéance refuse
l'affectation. Le rôle global reste une autorité distincte : son retrait est
nécessaire si l'affectation doit être la seule autorisation.
Pour imposer des signataires différents, déclarez `distinct_from as "previous"`
sur l'approbation et utilisez un hôte d'attestation. `"initiator"` exclut le
déposant attesté du run ; `exclude_signers` désigne une règle d'exclusion
inter-runs vérifiée par cet hôte.

Le jeton Bearer partagé authentifie le backend, pas chaque humain. Pour des
clients multi-utilisateurs, branchez le contrôle d'identité avec
`--identity-control-plane-url` et `--identity-service-token-env`, puis
transmettez le jeton humain via `x-touba-identity-token`.
Le serveur lie alors l'auteur à l'identité introspectée. Les lectures de
demandes exigent `decisions.read` ; les décisions exigent `decisions.act`,
en plus des contrôles d'appareil et d'affectation. Un contrôle distant exige HTTPS.
L'application demeure responsable de l'authentification réelle et de la
séparation des tâches métier.

## Graphe et preuves disponibles

`GET /authority/graph` identifie chaque point de validation compilé séparément. Deux approbations d'une stratégie restent deux nœuds ; la lecture du source ne les duplique pas.

`GET /runs/current` fournit un résumé et `GET /trace/current` une chronologie minimisée. Pour les preuves natives, utilisez `GET /runs/<run_id>/trace` : chaque lancement et reprise conserve son propre segment, avec les événements et l'engagement AIR d'origine, sans renumérotation.

L'export `touba-run-trace-export-v1` contient `segments` et `complete`. Un segment porte son état (`recording`, `paused`, `terminal`, `unavailable`), son digest et celui du précédent. `complete: true` signifie que le lancement et tous les segments sont disponibles et que le run est terminé, pas que la tâche métier a réussi. Après un arrêt brutal, un segment peut rester `recording` avec `trace: null` et `reason: "not_completed"` : aucune preuve manquante n'est reconstruite. Un run historique sans preuve native répond 404.

Le jeton projet est requis lorsqu'il est configuré, et `executions.read` lorsque le contrôle d'identité est activé. Le seul jeton mobile ne permet pas cet export. Aucun AIR, source, manifest, message métier ou checkpoint privé n'est découvert ni inclus automatiquement. Pour [l'audit local](./audit-traces.md), extrayez le champ `trace` de chaque segment disponible et fournissez explicitement l'AIR correspondant à son `run.air_digest`. Les digests locaux ne sont pas des signatures.

Les traces utilisent `.touba/traces.sqlite` (512 Mio de contenu sérialisé
par défaut), avec un index séparé limité à 128 Mio de pages SQLite et 256 segments
par run. Le quota de l’index porte sur les octets, y compris ses métadonnées,
sans plafond arbitraire sur le nombre de runs. Le serveur exporte les traces complètes progressivement. Son aperçu
conserve les 200 derniers événements et le nombre total.

`GET /runs/<run_id>/trace?index=true` donne l’index `touba-native-trace-index-v1`.
`/runs/<run_id>/trace/segments/0?limit=100` lit une page. Passez ensuite `next`
comme `after`, jusqu’à `done: true`. Ces deux routes conservent les mêmes
permissions projet et refusent le seul jeton mobile.

Archivez l’état complet du projet, serveur arrêté, pour garder associés les
traces, checkpoints et effets. Un journal plein arrête la progression avant
le prochain effet. Aucune purge automatique n’est activée.

Au démarrage et lors d’un contrôle d’état, le serveur vérifie les preuves
persistées par lots de 100 enregistrements, bornés à 16 Mio. Tous les lots sont
contrôlés ; une corruption historique bloque la reprise. Le temps de cet audit
augmente avec l’historique, tandis qu’une décision courante sélectionne ses
enregistrements par leurs identifiants indexés.
La réparation des interactions sélectionne les opérations de la fenêtre
d’interface et lit leurs checkpoints par pages. Les preuves plus anciennes
restent conservées et contrôlées par l’audit.
Ces parcours internes suivent l’ordre physique du stockage ; les curseurs
de l’API gardent leur ordre par identifiant. Le cache de validation porte sur
les octets JSON exacts relus sur disque. Chaque écriture revalide l’objet avant
sa sérialisation et vérifie que les enregistrements lus n’ont pas changé.

## Exploitation et concurrence

Les résultats sandbox et les messages de session transmettent les sorties
`show` dans `messages`, séparément de la valeur `result` retournée par
`give`. client affiche ces messages dans l'ordre, y compris avant une pause
humaine. Une reprise ajoute seulement ses nouveaux messages ; rejouer la même
demande de reprise ne duplique pas ceux déjà enregistrés.

Cette projection conserve au plus 100 messages, 4 Kio de texte par message et
16 Kio au total, sans couper les caractères UTF-8. `messages_truncated`
signale tout raccourcissement ou omission. Les contenus restent des données
métier privées, accessibles par les routes de résultat/session autorisées,
jamais par la chronologie minimisée ni les notifications SSE de progression.
Ils ne sont pas une trace native d'audit.

Le contrat V1 en développement exige ces champs pour les nouveaux résultats.
Un ancien résultat d'attente humaine incomplet est refusé sans modification du
fichier : conservez les données et qualifiez la migration avant de remplacer
le serveur d'un projet ayant des attentes en cours.

Conservez les identifiants par opération, utilisez SSE et ne relancez pas
automatiquement un nouveau run après une perte de connexion : retrouvez d'abord
l'opération existante. L'historique d'interaction est borné (100 sessions,
100 messages et 50 opérations par session). Les attentes et décisions durables
ont leur propre cycle de vie ; ne supprimez pas l'état pour libérer l'historique.

Les checkpoints, demandes et décisions humaines, journaux d'effets, sessions
et métadonnées de pièces jointes de `touba serve` utilisent des stores SQLite
privés sous `.touba` : `sandbox-checkpoints.sqlite`, `human-requests.sqlite`,
`human-decisions.sqlite`, `project.effect-journal.sqlite`,
`interaction-sessions.sqlite` et `interaction-assets.sqlite`.
Une opération ciblée lit et revalide ses enregistrements, puis les écrit dans
une transaction courte avec contrôle de révision. Les droits et échéances ne
sont jamais mis en cache. La validation d'un contenu strictement identique peut
être réutilisée dans un cache borné, sans conserver l'autorisation d'un appel.

Le démarrage conserve un audit exhaustif, proportionnel à l'historique.
`touba serve --check-state` vérifie aussi les liens entre checkpoints humains
et sessions d'interaction, sur des copies privées. Un lien orphelin non admis
par les règles de rétention est refusé, comme au démarrage. Le précontrôle
ne répare ni ne modifie les fichiers d'origine.
L'API d'historique des décisions reste exhaustive ; elle n'est pas paginée.
La fenêtre d'interaction de 100 sessions reste une projection bornée : son
renouvellement ne supprime ni checkpoints ni décisions ni effets.
Les écritures durables sont synchronisées sur disque ; mesurez leur coût avec
vos handlers et vos volumes. Ce stockage local ne qualifie pas plusieurs
serveurs concurrents sur un disque partagé et ne promet pas une latence fixe.

Les événements de progression synchrones sont regroupés avant écriture et
notification SSE. Le compteur reste complet et la fenêtre conserve les
80 derniers événements. Un crash peut perdre le dernier lot de progression :
cette projection d'interface n'est pas la preuve d'un effet. Les checkpoints
et le journal d'effets conservent leur persistance distincte.

Un serveur local n'a pas de quota implicite d'un run par seconde. Mesurez séparément
l'admission HTTP, l'exécution des handlers, les lectures d'état et le délai de
rafraîchissement du client. Les handlers et le stockage peuvent limiter le débit.
Pour les effets, associez le journal Touba à une clé idempotente et, si nécessaire,
à un rapprochement côté service externe. Ce n'est pas une garantie universelle
d'« exactement une fois ».

## Exploitation, sauvegarde et changement de build

Conservez le résultat de `touba version --json` avec l'archive CLI, le SDK et
les configurations exactes utilisés. Deux builds de développement `1.0.0`
ne constituent pas deux releases publiques ; comparez leur identité de build
et les changements documentés avant de remplacer l'installation.

Pour une sauvegarde cohérente :

1. Bloquez les nouvelles admissions et les producteurs de triggers, attendez
 la fin des handlers en cours, puis arrêtez le serveur. Une attente humaine
 déjà persistée peut être sauvegardée ; elle ne doit pas être supprimée.
2. Sauvegardez ensemble les sources, handlers, dépendances, manifest,
 configurations, locks et tout le répertoire `.touba`. Incluez aussi les
 chemins d'état explicitement configurés hors de ce répertoire. Les journaux
 d'effets, checkpoints, identités, décisions, sessions et traces natives
 forment un ensemble corrélé. Protégez et chiffrez les copies contenant des
 secrets ou des données métier, avec leurs droits d'accès.
3. Restaurez d'abord dans un environnement isolé, avec la même toolchain et
 les mêmes chemins pour les configurations absolues. Vérifiez les attentes,
 leurs échéances, les preuves natives et le journal d'effets avant de
 réautoriser des effets. Une sauvegarde n'arrête pas l'horloge des échéances.

La restauration qualifiée conserve l'identifiant d'une attente et ses preuves,
reprend après décision et ne redispatche pas l'effet lors d'une seconde reprise.
Cela suppose un instantané cohérent et aucun effet externe non rapproché depuis
cet instantané. Restaurer une ancienne sauvegarde ne restaure pas une base,
un paiement ou un courriel externe : rapprochez leurs registres avant reprise.

### Compatibilité des attentes en développement

Le serveur courant refuse l'ancien format JSON des stores, même vide. Si un
ancien store JSON par défaut reste à côté du store SQLite configuré, le démarrage
est refusé avant récupération ou exécution. Conservez une copie arrêtée cohérente
avec sa build d'origine ; ne renommez pas du JSON en SQLite et n'effacez pas
l'historique pour forcer le démarrage. L'entrée JSON distincte
`touba run --human-decisions` reste inchangée.

Les résultats persistés exigent maintenant `messages` et
`messages_truncated`. Un ancien résultat incomplet est refusé sans réécriture.
N'inventez pas un historique vide et ne supprimez pas le store pour démarrer.
Avant de changer de build, testez une copie arrêtée de l'état avec la nouvelle
installation. Si elle est incompatible, conservez l'ancienne installation
isolée et terminez ses attentes avec son propre état et ses décisions valides.

Une fois les opérations et effets rapprochés, conservez cet environnement en
archive protégée. Préparez une nouvelle instance avec les sources et décisions
hôte explicitement revues, sans y injecter l'état incompatible. Les anciens
identifiants, décisions et preuves restent attachés à l'archive, pas fusionnés
ni présentés comme natifs de la nouvelle instance. Aucun outil de conversion
historique automatique n'est livré. Une attente non résolue bloque ce transfert.

### Frontières à connaître

| Besoin | Engine/CLI | Serveur projet |
| --- | --- | --- |
| Attente humaine | checkpoint et reprise explicites par l'hôte | attente persistée et reprise corrélée à une décision autorisée |
| Échéance | pas de timer d'expiration automatique fourni par Engine | 24 heures après création ; durée fixe, contrôlée par l'horloge serveur |
| Identité du décideur | responsabilité de l'application hôte | attestation hôte, ou identité/appareil locaux et rôle/affectation vérifiés |
| Trace native | `run.trace` ou `--trace-out` | segments via `GET /runs/<run_id>/trace`, complétude explicite |

L'export OpenTelemetry est une projection de la trace native, pas son
remplacement pour l'audit. Il existe sous forme de fichier ; l'envoi natif
vers un collecteur n'est pas fourni. Voir [audit des traces](./audit-traces.md)
et [expiration des validations](./expiration-annulation-validations-humaines.md).

Voir aussi : [SDK](./sdk-javascript.md), [triggers](./triggers-gouvernes.md),
[effets idempotents](./effets-idempotents.md),
[agent et effets sortants](./agent-effets-sortants.md).

Avant de changer de build, utilisez le [contrôle d’état et la conservation des builds](../demarrer/installation.md#changer-de-build-sans-perdre-les-attentes).

## Capacité des approbations

```sh
touba serve --project-root . --max-pending-approvals 1000
```

La valeur par défaut est 100, le maximum 10 000. Chaque attente réserve une
place avant la pause. Quand la capacité est atteinte, une nouvelle attente est
refusée avant sa continuation. Réduire la limite après redémarrage conserve
les attentes déjà persistées ; elles peuvent encore être traitées.
Choisissez cette capacité selon les volumes et ressources mesurés de l’hôte.

Les événements de trace portent `observed_at`, instant UTC d’observation par
le runtime. `sequence_index` reste l’ordre de référence, notamment si
l’horloge système est corrigée.
