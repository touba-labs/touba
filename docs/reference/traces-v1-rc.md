---
sidebar_position: 4
---

# Référence traces

## Provenance des packages et des approbations

**Disponible à partir de Touba 1.4.0.**

Une exécution issue d'un projet préparé enregistre `package_admission_verified`
après `run_started`. Cet inventaire contient les noms, versions et empreintes
vérifiées des packages installés, l'empreinte du verrou packages, de la
configuration et du manifest. Un verrou supply-chain accepté est indiqué
`verified`, avec son empreinte ; `absent` indique qu'aucun n'a été admis.
Un verrou refusé arrête l'exécution et produit une trace d'admission refusée.

`package_tool_admitted` relie l'outil à cet inventaire par `admission_id`.
`tool_approval_authorized` nomme la demande exacte et l'empreinte de sa
politique effective. Les événements de l'appel et de son effet portent
`approval_request_id`. La décision conserve une empreinte du signataire attesté,
liée au run, le rôle exigé et l'instant d'acceptation. L'identité brute et les
autres rôles restent dans le reçu de l'hôte ; aucun jeton d'attestation,
commentaire libre ni argument métier n'est ajouté à ces métadonnées.

L'inventaire est capturé à l'admission puis conservé dans SQLite et dans l'export.
Une reprise vérifie la même identité d'admission avant de poursuivre.
Les sources éditables sont comptées séparément. Un AIR autonome ou une ancienne
trace sans inventaire ne fournit pas de preuve de version de package.
La configuration et le système de fichiers restent sous la responsabilité de
l'hôte de confiance.



## Lecture et corrélations

`touba inspect trace.json` résume l’exécution exportée et ses événements marquants.
Le [guide de lecture](../guides/explorer-traces.md) explique comment les examiner.

Les nouveaux événements émis dans une invocation peuvent porter
`payload.trace_context` : `span_id`, `target_ref`, `parent_span_id`,
`call_event_id`, `agent_invocation_id` et `agent_ref`, selon le contexte disponible.
`call_completed.payload.call_started_event_id` relie un retour à son début
dans le segment courant. Chaque reprise a ses propres séquences et contextes.
Ces identifiants opaques relient les événements. Les lecteurs conservent les
traces sans ces champs et n’y inventent pas de relations.

## Choisir le détail des fonctions pures

`--trace-pure-functions full` conserve le détail complet, actif par défaut.
Avec `calls`, les branches, boucles, bindings et scopes réussis internes aux
fonctions pures sont omis. Les appels, retours, erreurs, budgets et événements
de gouvernance restent enregistrés. Le scope de la fonction d'entrée est conservé.

```sh
touba run --project . --trace-pure-functions calls --trace-out trace.json
```

La trace indique `run.pure_function_detail: "calls"`. Le filtrage précède la
numérotation, les observateurs et la persistance : tous reçoivent la même trace.
La CLI `serve` et les deux SDK exposent aussi ce réglage.


## Conserver les traces

```sh
touba run program.air.json --trace-store .touba/traces.sqlite --trace-out trace.json
```

SQLite conserve les traces par défaut dans `.touba/traces.sqlite` du projet.
Sans `touba.project.json` parent, la CLI utilise le dossier de l’AIR ou du
plan fourni. `--trace-store` choisit un autre journal privé. Les événements sont conservés
progressivement ; les détails purs sont regroupés en petits lots, enregistrés
avant les appels et checkpoints. Une panne de stockage interrompt la progression
avant le prochain effet. Chaque exécution ou reprise crée un segment distinct.

`--trace-out` exporte le document `touba-trace-v1`. Les modes `--output trace`,
`json` et `all` lisent le journal progressivement et attendent la disponibilité
de la sortie. Le fichier exporté est remplacé seulement une fois complet.

Le résumé `--output run-summary` et les preuves `--evidence-out` parcourent aussi
le journal progressivement. Les collections du résumé sont limitées à 16 Mio ;
en cas de dépassement, exportez la trace complète avec `--trace-out`.


Le journal autorise par défaut 512 Mio de données sérialisées et 1 Mio par
événement. Il reste conservé jusqu'à son archivage par l'hôte ; aucune purge
automatique n'est activée. Placez-le dans un dossier privé et sauvegardé.
Les SDK utilisent `traceStore` (JavaScript) et `trace_store` (Python).
Leurs résultats complets restent soumis à la limite de transport de 32 Mio.

### Archiver un journal

```sh
touba trace archive --store .touba/traces.sqlite
mkdir -m 700 archives
touba trace archive --store .touba/traces.sqlite --destination archives/traces.sqlite --apply
```

La première commande affiche le volume récupérable. La commande avec `--apply` crée
une archive vérifiée, puis libère les runs réussis de la source. Les pauses,
échecs et exécutions interrompues restent conservés. L'archive se lit avec les
mêmes références, en passant son chemin à `--store`. Sa destination doit être
nouvelle ; aucun fichier existant n'est remplacé.

Pour un serveur projet, archivez l'état complet, serveur arrêté : traces,
checkpoints et effets restent associés. Les aperçus serveur affichent les 200
derniers événements et le nombre total. L'index `GET /runs/{run_id}/trace?index=true`
et les pages `/runs/{run_id}/trace/segments/0?limit=100` donnent accès au journal
complet avec l'autorisation du projet. Sans `index`, la route exporte toute la trace.

## Lire une trace par pages

`--output json-reference` renvoie le résultat métier et une `trace_reference`.
Le journal par défaut suffit ; `--trace-store` permet de choisir un autre chemin.
Les événements se lisent séparément, par pages.
Pour lire une page, transmettez la référence JSON complète à :

```text
touba trace read --store .touba/traces.sqlite --reference-json '<référence JSON>' --limit 100
```

La réponse contient `header`, `events`, `next` et `done`. Passez `next` à
`--after` pour la page suivante, jusqu'à `done: true`. La première lecture
sans curseur vérifie aussi l'empreinte du segment complet, en mémoire bornée.
Les pages suivantes vérifient les événements lus et leur ordre.
Une lecture n'exécute aucun programme et ne modifie pas le journal.

Une page contient au plus 1 000 événements et 1 Mio de contenu d'événements ;
la référence et l'en-tête s'ajoutent à cette taille. Les exemples des
[SDK JavaScript](../guides/sdk-javascript.md#conserver-les-traces) et
[Python](../guides/sdk-python.md#conserver-les-traces) montrent la boucle complète.
La référence désigne un segment terminé, y compris en cas de pause ou d'échec.
Un refus d'admission conserve sa petite trace dans le résultat d'erreur.

## Provenance et décisions

Les nouveaux AIR produits par la CLI utilisent des identités de source relatives à une racine commune aux fichiers compilés, sans enregistrer le chemin absolu de cette racine dans l’AIR. Les traces héritent de ces identités. Le résultat technique de compilation `--json` fournit séparément `source_root` à l’éditeur ; les diagnostics locaux gardent leurs chemins pour ouvrir le fichier. Avant de partager un artefact, vérifiez aussi les données et métadonnées applicatives : ce changement n’est pas un anonymiseur général.

L’éditeur résout une source relative depuis le dossier de travail, ou demande la racine du projet. Un déplacement conserve l’identité AIR si les sources et leurs chemins relatifs restent identiques. Les anciens AIR et traces ne sont pas réécrits : recompilez et faites revoir les locks si vous migrez leur provenance.

Une répétition autorisée reste exécutable. Les observations et la chronologie exposent `repeated_from_step` et `identical_invocation_number`, sans créer de permission à usage unique. Une sélection native peut ne fournir aucun `reason` : cette absence n’est ni un raisonnement caché disponible ni une erreur ; aucun motif n’est inventé. Les métadonnées inchangées d’un skill pack ne sont tracées qu’une fois par invocation d’agent ; contrôles d’autorité et de budget restent évalués à chaque requête.

Le contrat machine courant est `touba-trace-v1` avec le profil
`touba-trace-capabilities-v1`. Les traces d'une autre version doivent être
migrées explicitement avant consommation.

Les traces rendent l'exécution observable. Elles ne sont pas une preuve de sandbox, de permission forte ou de vérification scientifique.

## Enveloppe

Une trace contient :

- `trace_protocol_version`
- `trace_capability_profile`
- `run`
- `events`

Chaque événement porte un `kind` et un `payload`, un identifiant unique et une
séquence continue. Les références de run et de module doivent rester cohérentes.
Une trace terminée contient exactement un événement terminal ; un ordre cassé,
un profil inconnu ou un payload sensible interdit sont refusés avant rendu.

## Événements principaux

| Événement | Signification |
| --- | --- |
| `call_started` | Entrée dans un appel AIR |
| `call_completed` | Sortie d'un appel AIR |
| `binding_created` | Valeur locale `bind` créée sans exposition de sa valeur |
| `tool_binding_authorized` | Tool autorisé avant dispatch handler |
| `secret_handle_authorized` | Handle de secret autorisé avant dispatch handler |
| `secret_handle_refused` | Handle de secret refusé avant dispatch handler |
| `memory_access_authorized` | Accès mémoire logique autorisé |
| `memory_provenance_observed` | Metadata de provenance mémoire observée |
| `memory_integrity_observed` | Evidence d’intégrité mémoire observée |
| `memory_metadata_refused` | Metadata mémoire refusée |
| `memory_integrity_refused` | Evidence d’intégrité mémoire refusée |
| `agent_invocation_authorized` | Entrée agent autorisée |
| `agent_invocation_refused` | Entrée agent refusée |
| `agent_capabilities_listed` | Capacités déclarées dans `uses` pour l'agent actif |
| `agent_capability_descriptions_diagnosed` | Qualité des descriptions de capacités exposées au decision provider |
| `agent_decision_requested` | Demande structurée envoyée au decision provider, avec `request_digest` et mode d'entrée modèle sans payload brut |
| `agent_decision_provider_call_attempted` | Appel au decision provider tenté avec tentative, timeout et metadata non secrètes |
| `agent_decision_catalog_requested` | Catalogue complet demandé par le provider |
| `agent_decision_provider_retry_scheduled` | Retry borné planifié après échec provider éligible |
| `agent_decision_provider_returned` | Réponse structurée du provider |
| `provider_cost_recorded` | Réservation ou règlement du coût hôte, corrélé à l'invocation d'agent ; un usage inconnu conserve sa borne |
| `agent_decision_recorded` | Décision d'agent reçue par le runtime |
| `agent_direct_answer_returned` | Réponse directe retournée sans présentation du catalogue |
| `skill_pack_discovery_listed` | Skill packs disponibles listés comme hints courts, sans contenu brut |
| `skill_pack_activated` | Skill pack explicitement activé comme contexte borné |
| `skill_pack_activation_refused` | Activation ou entrée modèle refusée par budget |
| `skill_pack_resource_loaded` | Ressource déclarée chargée comme contexte, sans contenu dans la trace |
| `skill_pack_resource_refused` | Ressource ou lien d’exécution de skill pack refusé |
| `agent_capability_selected` | Capacité autorisée sélectionnée |
| `agent_capability_result_returned` | Résultat de capacité rendu disponible comme observation pour la décision suivante |
| `agent_capability_refused` | Capacité refusée car hors périmètre déclaré |
| `agent_human_review_requested` | Review humain demandé par l’agent en mode catalogue |
| `agent_step_limit_exceeded` | Limite de pas agentiques dépassée |
| `trigger_event_received` | Événement trigger normalisé reçu |
| `trigger_event_accepted` | Trigger accepté avant exécution cible |
| `trigger_event_refused` | Trigger refusé avant exécution cible |
| `trigger_rate_limited` | Limite de run trigger atteinte |
| `trigger_execution_started` | Exécution cible déclenchée |
| `trigger_execution_completed` | Exécution cible terminée |
| `trigger_execution_failed` | Exécution cible échouée |
| `run_cancel_requested` | Annulation demandée par l’hôte, le timeout ou le kill switch |
| `run_cancelled` | Annulation coopérative terminée |
| `run_timeout_exceeded` | Timeout global de run observé |
| `kill_switch_enabled` | Kill switch activé par l’hôte |
| `kill_switch_disabled` | Kill switch désactivé par l’hôte |
| `dispatch_refused_cancelled` | Nouveau dispatch refusé après une demande de cancel |
| `budget_limit_checked` | Budget d’autonomie effectif établi |
| `budget_consumed` | Compteur de budget d’autonomie consommé |
| `budget_limit_exceeded` | Budget d’autonomie dépassé ou configuration refusée |
| `dispatch_refused_budget_exceeded` | Nouveau dispatch refusé par budget d’autonomie |
| `human_approval_requested` | Demande de validation humaine |
| `human_approval_paused` | Exécution suspendue |
| `human_approval_pause_refused` | Pause humaine refusée car une reprise durable serait nécessaire après effet externe |
| `human_approval_decided` | Décision humaine fournie |
| `user_interaction_shown` | `show` exécuté |
| `user_interaction_paused` | Exécution suspendue faute d'entrée |
| `user_interaction_answered` | Entrée fournie par l'hôte |
| `failure_detected` | Échec runtime observable |
| `fallback_selected` | Fallback sélectionné après égalité entre famille déclarée et famille observée |
| `run_completed` | Fin de run |

`run_started.payload.max_loop_iterations` expose le plafond effectif de chaque
boucle. Un `failure_detected` contient une famille stable (`business`,
`authority`, `provider` ou `handler`) et un `runtime_error_code`. Quand un
fallback existe, `declared_failure_family` permet de vérifier pourquoi il a été
sélectionné ou ignoré. Les valeurs métier brutes ne sont pas ajoutées pour
autant.

## Lire une trace

```sh title="Terminal"
touba inspect trace.json
```

L'inspecteur affiche les événements existants. Il ne relit pas les handlers, secrets ou backends.

## Export OpenTelemetry

Touba garde `touba-trace-v1` comme trace native lisible par les commandes
Touba. Pour l’observabilité externe, `touba inspect` peut produire une projection
JSON compatible avec les modèles de spans OpenTelemetry :

```sh title="Terminal"
touba inspect trace.json --otel-out trace.otel.json
```

Cet export sert de pont vers les stacks d’observabilité. Il ne remplace pas la
trace native, ne signe pas les événements et ne prouve pas une conformité. Les
événements Touba deviennent des spans GenAI quand le mapping est établi :
`invoke_workflow`, `invoke_agent` ou `execute_tool`. L’export conserve les
références AIR, le `run_id`, la séquence, les codes de refus et des compteurs
non sensibles.

L’export OpenTelemetry n’écrit pas les prompts complets, messages bruts,
réponses utilisateur, résultats de tools, observations brutes, valeurs secrètes
ou chemins locaux. La trace Touba reste l’artefact d’audit local.

Pour la provenance et l’intégrité mémoire (PI-1), les traces peuvent contenir des références de provenance mémoire, un digest et une `integrity_evidence`.
Ces champs décrivent l’évidence disponible ; ils ne prouvent pas que le contenu est vrai, sûr ou vérifié de bout en bout.

Pour les skill packs, les traces exposent les refs, compteurs, raisons
d'activation, budgets et codes de refus. Elles ne contiennent pas le contenu
complet du pack, le contenu d'un script, un payload brut, un prompt complet ou
une valeur de secret.

## Auditer une trace

```sh title="Terminal"
touba audit \
  --trace trace.json \
  --air program.air.json \
  --source source.tb \
  --manifest touba.manifest.json \
  --export trace-audit.export.json
```

L’audit des traces (TA-1) produit un rapport de validation et peut écrire un export
`trace-audit-export-v1-local`.

Il vérifie seulement les artefacts fournis explicitement : trace, AIR, source,
manifest runtime ou manifest d’audit. Il calcule des digests `sha256`,
contrôle des cohérences structurelles et refuse des fuites évidentes selon la
politique de redaction choisie.

L’audit des traces ne fournit pas de signature, d’horodatage légal, de stockage immuable ou de
garantie de conformité automatique.

## Données sensibles

:::info Ce que les traces contiennent
- Références AIR
- Noms de handles de secrets
- Autorisations ou refus de handles de secrets
- Capabilities
- Chemins de schéma
- Types attendus ou observés
:::

:::info Ce que les traces ne doivent pas contenir
- Valeurs de secrets
- Valeurs brutes envoyées au decision provider
- Prompt complet ou entrée modèle complète
- Observations runtime brutes retournées au decision provider
- Payload externe brut d’un trigger
- Valeurs exactes des bindings locaux
- Réponses exactes de `ask` dans `user_interaction_answered`
- Signal système de hard kill
- État d’un control plane distribué
- Coût fournisseur
- Tokens fournisseur
- Quota distribué
- Payloads sensibles complets
- Contenu brut de mémoire
- Score de confiance mémoire
- Statut `Verified` ou `Unverified`
:::


## Causalité parallèle

Le runtime émet `parallel_group_admitted`, `parallel_group_refused`,
`parallel_branch_started`, `parallel_branch_completed`,
`parallel_branch_suspended`, `parallel_join_completed`,
`parallel_join_failed` et `parallel_group_resumed`.
Les événements descendants portent `group_id`, `branch_id` et
`parent_branch_id`. Ces identités restent stables à la reprise ; l'ordre
local des événements ne constitue pas un ordre total des systèmes externes.
Les résultats et journaux de continuation privés ne sont pas des payloads
publics de trace. Les messages `show` sont restitués dans l'ordre d'entrée.

## Temps d’observation

Chaque nouvel événement natif contient `observed_at`, au format UTC
`YYYY-MM-DDTHH:mm:ss.sssZ`. L’horodatage fait partie du contenu couvert par
les empreintes de trace et de checkpoint. Une reprise conserve les événements
déjà enregistrés et horodate les nouveaux à leur exécution.
L’ordre causal reste donné par `sequence_index` ; l’heure provient de l’hôte.

L’export OpenTelemetry reprend ces instants. Pour une trace antérieure sans
horodatage, l’export indique explicitement sa projection temporelle synthétique.

## Admission, effet et reprise

| Événement ou phase | Lecture |
| --- | --- |
| `tool_binding_authorized`, `scope: binding_only` | Les droits du binding sont vérifiés. |
| `tool_execution_status`, `admission/accepted` | Les contrôles d'entrée sont passés. |
| `dispatch/started` | L'appel du handler commence. |
| `post_validation/accepted` ou `refused` | Le résultat reçu est accepté ou refusé ; un effet peut déjà avoir eu lieu. |
| `journal_restore/applied` | Un résultat appliqué est relu depuis le journal, sans nouvel appel du handler. |

Les invocations d'agents et les capacités refusées ont des compteurs distincts.
Les budgets comptent les tentatives selon leur contrat ; un refus ne rembourse
pas une tentative. Le journal d'effets porte l'issue appliquée ou inconnue.

Chaque run obtient un identifiant unique par défaut. Une reprise conserve son
`run_id` et ajoute un `run.segment_id` unique : ses `event_id` et ses spans
restent distincts, même après une tentative de reprise refusée. Les lecteurs
acceptent aussi les traces antérieures sans ce champ.

Les raisons libres du modèle, questions de revue et exceptions fournisseur
ne figurent pas dans la trace publique. Des indicateurs de présence et des codes
structurés permettent l'audit. Le `request_digest` fournisseur porte sur les
métadonnées expurgées (`request_digest_scope: redacted_metadata`), pas sur le
contenu métier intégral. Les checkpoints et historiques privés demandent leur
propre contrôle d'accès.
