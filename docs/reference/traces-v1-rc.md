---
sidebar_position: 4
---

# Référence traces

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
`trace-audit-export-v0.1-local`.

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
