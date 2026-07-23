# Référence CLI

Les commandes de cette page supposent que la commande `touba` est disponible dans le terminal.

L’extension VS Code Touba aide à travailler dans l’éditeur, mais elle ne remplace pas la CLI pour les commandes terminal.

## Vue d’ensemble

| Commande | Rôle |
| --- | --- |
| `touba init` | Initialise un dossier projet Touba |
| `touba new module` | Crée un fichier source `.tb` selon la convention projet |
| `touba skill` | Crée et valide des skill packs locaux |
| `touba prepare` | Prépare ou vérifie les artefacts dérivés du projet |
| `touba secret` | Gère le store de secrets de développement |
| `touba compile` | Compile une source `.tb` vers AIR JSON |
| `touba run` | Exécute un AIR JSON |
| `touba trigger run` | Exécute un trigger `schedule` en runner foreground borné |
| `touba trigger serve` | Lance un service webhook pour triggers `request` |
| `touba serve` | Lance le serveur projet authentifié pour client, Mobile et les clients de contrats |
| `touba deploy` | Planifie, publie, active ou restaure une révision immuable |
| `touba inspect` | Inspecte une source, un AIR, une trace ou un manifest |
| `touba audit` | Valide une trace et peut produire un export d’audit |
| `touba supply-chain validate` | Valide un lock supply chain pour AIR, manifest, handlers, SDK, paquet handler, provenance et revue déclarées |
| `touba registry resolve` | Résout une entrée de registry statique vers un lock local sans installer ni exécuter de package |
| `touba manifest generate` | Génère un manifest de binding à partir d’un AIR |
| `touba handler stub` | Génère un squelette de handler pour les tools |
| `touba version` | Affiche les versions CLI, runtime, schémas et distribution |
| `touba update` | Explique la politique de mise à jour du canal courant |

## `touba init`

```sh title="Terminal"
touba init
```

Initialise le dossier courant comme projet Touba.

La commande crée les supports locaux nécessaires sans valeur secrète :

```text title="Structure"
.touba/
.touba/secrets.local.json
touba.project.json
.env
.gitignore
```

Elle ajoute `.touba/` et `.env` au `.gitignore`.

`touba.project.json` est versionnable. Il contient le langage hôte, le SDK Touba
du projet et les profils de run :

```json title="touba.project.json"
{
  "project_version": "touba-project-v1",
  "language": "javascript",
  "sdk": "@touba/sdk",
  "run_profiles": {
    "dev": {
      "require_supply_chain_lock": false
    },
    "prod": {
      "require_supply_chain_lock": true,
      "supply_chain_lock": "touba.lock.json"
    }
  }
}
```

JavaScript est le langage hôte disponible aujourd’hui :

```sh title="Terminal"
touba init --language javascript
```

Python est la cible naturelle pour un second SDK lorsqu’un chantier dédié sera
ouvert. Aujourd’hui, la CLI refuse les langages hôtes qui ne sont pas encore
livrés.

Pour cibler un autre dossier :

```sh title="Terminal"
touba init --root mon-projet
```

## `touba new module`

```sh title="Terminal"
touba new module examples.search
```

Crée un fichier source `.tb` selon la convention projet.

Pour `examples.search`, la commande crée :

```text title="Structure"
src/examples/search.tb
```

avec :

```touba title="source.tb"
module examples.search
```

Options utiles :

```sh title="Terminal"
touba new module examples.search --force
touba new module examples.search --root mon-projet
```

`--force` remplace le fichier s’il existe déjà.

## `touba skill`

```sh title="Terminal"
touba skill new research-review
touba skill validate research-review
touba skill validate
```

`touba skill new` crée un skill pack local dans `skills/<skill-id>/` :

```text title="Structure"
skills/research-review/
  skill.json
  SKILL.md
  resources/
    references/
    examples/
    templates/
    samples/
  scripts/
  tests/
```

Le descriptor `skill.json` utilise le schéma `touba-skill-pack-v0.1`. Il
déclare les métadonnées, l’activation, les ressources et les liens informatifs
vers des capacités Touba.

`touba skill validate` vérifie notamment :

- la version de schéma ;
- la référence `skill_pack:<namespace>/<skill-id>` ;
- le layout standard ;
- les chemins relatifs confinés au dossier du pack ;
- les digests `sha256` des ressources déclarées ;
- l’absence de champs d’autorité runtime comme `handler`, `command`, `grants`,
 `secrets`, `callable_by`, `memory_scope`, `backend` ou `provider`.

Le rapport expose les packs valides, leurs refs, leur version, le nombre de
ressources déclarées, le nombre de liens informatifs et les diagnostics. Il
n'affiche pas le contenu des ressources, n'exécute pas les scripts et ne résout
aucun secret.

Un script placé dans `scripts/` reste une ressource du pack. Pour l’exécuter, il
faut le relier à un `tool` Touba gouverné par AIR, manifest, grants, limites,
lock et traces.

## `touba prepare`

```sh title="Terminal"
touba prepare --mode plan
touba prepare --mode write
touba prepare --mode check
```

Prépare les artefacts dérivés d’un projet Touba.

Modes :

| Mode | Rôle |
| --- | --- |
| `plan` | affiche ce qui serait produit sans écrire |
| `write` | écrit les artefacts manquants |
| `check` | vérifie la cohérence sans écrire |

Un projet sans `tool` exécutable produit un AIR, mais pas de manifest ni de
handler.

Un module avec imports purs produit un AIR préparé où les imports de `type`, `define` non sensible et `function` pure sont représentés et résolus par l’assemblage projet.

Un projet avec imports effectifs peut aussi assembler `tool`,
`skill`, `strategy`, `agent` et `memory` entre modules du même projet. Les
références restent canoniques, `callable_by` inter-module et les scopes mémoire
sont vérifiés, et les tools produisent les artefacts d’exécution explicites :

```text title="Structure"
.touba/air/...
touba.manifest.json
handlers/...
touba.secrets.dev.json
touba.secrets.prod.json
```

Un projet peut aussi charger un package explicite si ce package est fourni
explicitement dans `touba.project.json` ou par `--package`. Le package rend ses
exports disponibles pour les imports, mais il n’accorde aucun handler, grant,
secret, scope mémoire, caller d’agent ou trigger actif.

Options fréquentes :

```sh title="Terminal"
touba prepare --source src/examples/search.tb --mode write
touba prepare --air program.air.json --mode check
touba prepare --package packages/research/touba.package.json --mode write
touba prepare --binding-fragment bindings/search.json --mode write
touba prepare --resource-bindings touba.resources.json --require-resource-bindings --mode check
touba prepare --run-plan touba.run-plan.json --entry strategy:examples.search/Run --mode write
touba prepare --run-plan touba.run-plan.json --mode check
touba prepare --ownership touba.ownership.json --profile prod --mode check
touba prepare --handler-root handlers --handler-command node --mode write
```

`prepare` ne lance pas le runtime et n’exécute pas les handlers.

`--package` ne fait pas de recherche par nom global et ne télécharge rien. Le
chemin pointe vers un manifeste local `touba-package-v0.1`.

`--binding-fragment` lit un fragment explicite `touba-binding-fragment-v0.1` et
le compose dans le manifest projet. Le fragment peut proposer handler, grants,
secrets, limites et contraintes de payload, mais il n’est jamais consommé
directement par `touba run`. Le manifest assemblé reste l’autorité runtime.

`--resource-bindings` valide un artefact explicite
`touba-resource-bindings-v0.1` contre l’AIR préparé. Les resource bindings
couvrent les familles rattachables à l’AIR actuel : `memory_backend`,
`event_source` et `decision_provider`. La CLI vérifie ressource connue, famille
supportée, grants, handles de secrets requis, scopes mémoire et absence de
payload brut. Pendant `touba run`, le runtime transmet ensuite au handler les
seuls bindings associés aux ressources utilisées par le tool appelé. La CLI ne
choisit pas de backend officiel.

`--require-resource-bindings` refuse si une ressource logique requise par l’AIR
n’a pas de binding actif.

`--run-plan` demande à `prepare` de produire ou vérifier un plan d’exécution
explicite `touba-run-plan-v0.1`. Le plan pointe vers l’AIR préparé, le manifest
si un tool est utilisé, le profil de secrets si un secret est requis, et le lock
supply chain si le profil l’exige. Il ne contient pas d’inputs métier, de prompt brut ou
de valeur secrète.

Si l’entrée ne peut pas être déduite sans ambiguïté, préciser :

```sh title="Terminal"
touba prepare --run-plan touba.run-plan.json \
  --entry strategy:examples.search/Run \
  --mode write
```

`--ownership` demande à `prepare` de valider un artefact
`touba-ownership-v0.1` contre l’AIR préparé et le profil courant. La validation
couvre teams, owners, review gates et reviews. Elle refuse les reviews
manquantes, les owners manquants pour les cibles sensibles et les champs qui
tentent d’accorder une autorité runtime comme `grants`, `secrets`, `handler`,
`provider`, `callable_by` ou des champs de conformité automatique.

```sh title="Terminal"
touba prepare \
  --ownership touba.ownership.json \
  --profile prod \
  --mode check
```

`--require-ownership` refuse si aucun artefact d’ownership n’est fourni.
`touba.ownership.json` ne modifie jamais le manifest, les resource bindings, le
run plan, les locks, les secrets, les handlers ou les scopes mémoire.

## `touba secret`

```sh title="Terminal"
touba secret set OPENAI_API_KEY --value-stdin
touba secret list
touba secret check OPENAI_API_KEY
touba secret remove OPENAI_API_KEY
```

Gère un store de secrets pour le développement.

La commande affiche les handles, pas les valeurs.

Exemple :

```sh title="Terminal"
printf '%s' "$OPENAI_API_KEY" | touba secret set OPENAI_API_KEY --value-stdin
touba secret check OPENAI_API_KEY
```

Pour cibler un projet :

```sh title="Terminal"
touba secret list --root mon-projet
```

Le runtime ne lit ce store que si un fichier de secrets explicite le demande avec une source `touba_store`.

## `touba compile`

```sh title="Terminal"
touba compile source.tb --out program.air.json
```

Compile une source `.tb` vers un AIR JSON.

Le chemin `--out` est le mode recommandé : Touba vérifie que la cible se termine
par `.air.json` et que la sortie du compilateur est bien un document AIR JSON
avant d'écrire le fichier.

La redirection shell reste possible pour les usages avancés :

```sh title="Terminal"
touba compile source.tb --stdout > program.air.json
```

Dans ce cas, `--stdout` rend le pipeline explicite. Le shell crée quand même le
fichier à droite de `>` ; Touba ne peut donc pas valider son extension. Sans
`--out` ou `--stdout`, `touba compile` refuse l'exécution.

Le runtime Touba exécute l’AIR, pas directement le fichier `.tb`.

## `touba run`

```sh title="Terminal"
touba run program.air.json
```

Exécute un AIR JSON.

Avec run plan explicite :

```sh title="Terminal"
touba run --run-plan touba.run-plan.json
```

Le run plan remplace les options répétitives d’artefacts, pas les inputs métier.
Il peut pointer vers :

```json title="touba.run-plan.json"
{
  "run_plan_schema_version": "touba-run-plan-v0.1",
  "entry_ref": "strategy:examples.search/Run",
  "air": ".touba/air/examples/search.air.json",
  "manifest": "touba.manifest.json",
  "secrets_profile": "touba.secrets.dev.json",
  "profile": "dev",
  "outputs": {
    "mode": "show"
  }
}
```

Le runtime refuse avant exécution si l’AIR est absent, si `entry_ref` n’existe
pas, si l’AIR exige un manifest ou un profil de secrets absent, si un profil
strict exige un lock absent, si le lock supply chain est en drift, ou si le run plan
contient des champs sensibles comme `inputs`, `payload`, `prompt`, `secret` ou
`secrets`.

Si `--manifest` pointe vers un fragment `touba-binding-fragment-v0.1` au lieu
d’un manifest assemblé `touba-manifest-v1`, le runtime refuse avec
`BindingFragmentNotAssembled`.

Les inputs restent fournis séparément :

```sh title="Terminal"
touba run --run-plan touba.run-plan.json \
  --inputs-json '{"request":{"topic":"demo"}}'
```

Resource bindings explicites :

```sh title="Terminal"
touba run program.air.json \
  --resource-bindings touba.resources.json \
  --require-resource-bindings
```

Le runner valide l’artefact avant dispatch, mais il ne crée pas de connexion
PostgreSQL, HTTP, queue, Vault, client ou Mobile.

Avec entrées explicites :

```sh title="Terminal"
touba run program.air.json \
  --inputs-json '{"request":{"topic":"demo"}}'
```

Avec manifest :

```sh title="Terminal"
touba run program.air.json \
  --manifest touba.manifest.json \
  --inputs-json '{"request":{"topic":"demo"}}'
```

Avec secrets :

```sh title="Terminal"
touba run program.air.json \
  --manifest touba.manifest.json \
  --secrets touba.secrets.dev.json
```

Avec un lock supply chain :

```sh title="Terminal"
touba run program.air.json \
  --manifest touba.manifest.json \
  --supply-chain-lock touba.lock.json \
  --require-supply-chain-lock
```

`--supply-chain-lock` demande à `touba run` de valider le lock avant le
dispatch. `--require-supply-chain-lock` rend ce gate strict : absence de lock,
erreur ou warning de supply chain refusent l’exécution avant le lancement d’un handler.

Sans `--require-supply-chain-lock`, un warning de supply chain reste non bloquant. Le lock
ne donne aucun grant, ne lit pas les secrets et ne prouve pas que le handler est
sûr. Le manifest reste l’autorité runtime pour handlers, grants, secrets,
mémoires, limites et triggers.

Avec un profil projet :

```sh title="Terminal"
touba run program.air.json \
  --profile prod \
  --manifest touba.manifest.json
```

`--profile prod` lit `touba.project.json` dans le dossier courant et applique le
profil `prod`. Par défaut, ce profil exige `touba.lock.json` et active le gate
strict de supply chain avant dispatch. `--profile dev` garde le comportement courant sans
lock obligatoire.

Avec entrées `ask` fournies par fichier :

```sh title="Terminal"
touba run program.air.json \
  --user-inputs user-inputs.json
```

Avec saisie terminal explicite pour un essai manuel :

```sh title="Terminal"
touba run program.air.json \
  --interactive-user-inputs
```

`--interactive-user-inputs` ne peut pas être combiné avec `--user-inputs` ou `--user-inputs-json`.

Avec décisions humaines explicites :

```sh title="Terminal"
touba run program.air.json \
  --human-decisions human-decisions.json
```

La variante inline est utile pour un test court :

```sh title="Terminal"
touba run program.air.json \
  --human-decisions-json '{"human:review/Approval":{"decision":"approved","reason":"reviewed locally"}}'
```

Ces options alimentent les noeuds `human_approval` déjà présents dans l'AIR. Elles
servent à fournir une décision dès le lancement du run. Elles ne reprennent pas
un run suspendu : pour une reprise locale, il faut utiliser un checkpoint.

Pour le cas borné d’un noeud `human_approval` explicite dans le graph d’entrée,
ou d’un `request_human_review` agentique dont le `call_agent` appartient au
graph d’entrée, `touba run` peut écrire puis consommer un checkpoint local :

```sh title="Terminal"
touba run program.air.json \
  --human-checkpoint-out human.checkpoint.json \
  --output trace
```

Puis, après décision humaine explicite :

```sh title="Terminal"
touba run program.air.json \
  --human-resume-checkpoint human.checkpoint.json \
  --human-decisions-json '{"approval:example":"approved"}' \
  --output trace
```

Ce checkpoint local évite de redispatcher les effets déjà produits dans ce cas
borné.

| Cas | Comportement |
| --- | --- |
| `--human-decisions-json` sans checkpoint | le run démarre depuis le début avec décisions pré-fournies |
| `human_approval` dans le graph d’entrée | écriture puis reprise locale supportées |
| `request_human_review` demandé par un agent appelé depuis le graph d’entrée | écriture puis reprise locale supportées |
| pile agentique imbriquée plus profonde | refus explicite au lieu d’une reprise ambiguë |

Dans les événements de trace, `decision_binding` désigne le nom de binding où le
résultat de décision est écrit. Ce n’est pas l’identifiant d’une décision
humaine.

Avec budgets d’autonomie explicites :

```sh title="Terminal"
touba run program.air.json \
  --max-run-ms 30000 \
  --max-steps 100 \
  --max-tool-calls 20 \
  --max-agent-invocations 5 \
  --output trace
```

Avec budgets d’autonomie en JSON :

```sh title="Terminal"
touba run program.air.json \
  --run-limits-json '{"max_steps":100,"max_tool_calls":20}' \
  --output trace
```

`--run-timeout-ms` produit une annulation `cancelled`. `--max-run-ms` produit un refus de budget avec statut `failure`.

Avec un événement trigger explicite :

```sh title="Terminal"
touba run program.air.json \
  --manifest touba.manifest.json \
  --trigger-event-json '{"trigger_ref":"trigger:examples.daily/DailyRun","event_id":"evt-001","source_kind":"schedule"}' \
  --output trace
```

Le manifest doit activer le trigger. Le runtime refuse avant l’exécution si le
trigger n’existe pas dans l’AIR, si l’entrée du manifest est absente ou inactive,
si la source de l’événement ne correspond pas, ou si le manifest tente d’élargir
les limites déclarées dans l’AIR.

Avec un fichier d’événement :

```sh title="Terminal"
touba run program.air.json \
  --manifest touba.manifest.json \
  --trigger-event trigger-event.json \
  --output trace
```

Avec dry-run :

```sh title="Terminal"
touba run program.air.json \
  --manifest touba.manifest.json \
  --trigger-event trigger-event.json \
  --trigger-dry-run
```

Le dry-run affiche les checks sans lancer la cible du trigger. Il sert à vérifier
l’alignement AIR, manifest, source événementielle et limites.

Avec le runner foreground :

```sh title="Terminal"
touba trigger run program.air.json \
  --manifest touba.manifest.json \
  --trigger trigger:examples.daily/DailyRun \
  --max-runs 1 \
  --state touba.trigger-state.json \
  --trace-out trace.json
```

Le runner attend un intervalle réel déclaré dans le source avec l’un de ces
formats :

```text
every <n>s
every <n>m
every <n>h
```

Il génère ensuite un événement trigger normalisé sans payload brut et appelle le
même runtime que le mode `--trigger-event-json`. `--max-runs` et `--state` sont
obligatoires pour le runner foreground.

`--state <touba.trigger-state.json>` active l’état durable de trigger
`touba-trigger-state-v0.1`. Le runner y conserve les `event_id` consommés, les
acceptations, les refus et la clé du jour UTC utilisée pour appliquer
`max_runs_per_day`. Un même `event_id` déjà consommé pour le même `trigger_ref`
est refusé avec `TriggerReplayRejected` avant de relancer la stratégie. Une
acceptation enregistrée un jour précédent ne bloque pas le premier événement du
jour courant. Ce fichier ne contient pas de payload brut et n’accorde aucune
autorité runtime. Le chemin fourni à `--state` doit se terminer par
`.trigger-state.json`.

Avec le service webhook :

```sh title="Terminal"
touba trigger serve program.air.json \
  --manifest touba.manifest.json \
  --state touba.trigger-state.json \
  --queue touba.trigger-queue.json \
  --host 127.0.0.1 \
  --port 8787 \
  --trace-dir traces \
  --max-attempts 3 \
  --signature-secret-env TOUBA_TRIGGER_SIGNATURE_SECRET
```

Le service route les triggers `request` activés par le manifest. Chaque requête
acceptée est ajoutée à la queue `touba-trigger-queue-v0.1`, puis remise au même
runtime que `--trigger-event-json`. La queue conserve l’identité d’événement, la
méthode, le chemin, la taille et le digest SHA-256 du payload ; elle ne conserve
pas le corps brut. Si le manifest déclare `payload`, seuls les champs JSON
référencés par `payload.map` deviennent des arguments persistés pour la
stratégie. Le runtime revalide ces arguments contre la signature de la cible.
Le mapping peut être déclaré directement dans le source Touba avec
`with message as payload.message` sur un trigger `on request`; `touba manifest
generate` émet alors l’entrée `payload.map` correspondante.
`--state` et `--queue` doivent pointer vers des chemins terminant par
`.trigger-state.json` et `.trigger-queue.json`.

Options principales :

| Option | Rôle |
| --- | --- |
| `--trigger <trigger_ref>` | limite le service à un trigger `request` |
| `--trace-dir <dir>` | écrit une trace JSON par entrée traitée |
| `--max-events <n>` | arrête le service après `n` entrées traitées |
| `--max-attempts <n>` | borne les retries des échecs non structurels |
| `--processing-timeout-ms <n>` | remet en queue une entrée `processing` périmée |
| `--auth-token-env <NAME>` | exige un bearer token ou `x-touba-trigger-token` |
| `--signature-secret-env <NAME>` | exige `x-touba-signature: sha256=<hex>` |
| `--secrets <path>` | résout les handles de secrets déclarés par les runs déclenchés |

Exemple source et manifest pour un webhook typé :

```touba title="webhook.tb"
module examples.webhook

strategy RunWebhook
    takes message as Text
    gives Text
    do
        give message

trigger WebhookRun
    on request POST "/webhook/run"
    runs strategy RunWebhook
    with message as payload.message
    limits
        max_runs_per_day as 100
        timeout_ms as 30000
```

```json title="touba.manifest.json"
{
  "triggers": {
    "trigger:examples.webhook/WebhookRun": {
      "enabled": true,
      "source": { "kind": "request" },
      "payload": {
        "format": "json",
        "content_types": ["application/json"],
        "max_bytes": 4096,
        "map": {
          "message": "$.message"
        }
      },
      "limits": {
        "max_runs_per_day": 100,
        "timeout_ms": 30000
      }
    }
  }
}
```

Touba fournit ici un daemon explicite pour `request -> strategy`. Les schedulers
distribués, queues distribuées, adapters cloud, supervision système et reprise
durable multi-process complète restent des couches séparées.

Avec contrôles de run :

```sh title="Terminal"
touba run program.air.json \
  --cancel-before-dispatch \
  --output trace
```

```sh title="Terminal"
touba run program.air.json \
  --cancel-on-pause \
  --output trace
```

```sh title="Terminal"
touba run program.air.json \
  --run-timeout-ms 5000 \
  --output trace
```

```sh title="Terminal"
touba run program.air.json \
  --manifest touba.manifest.json \
  --trigger-event-json '{"trigger_ref":"trigger:examples.daily/DailyRun","event_id":"evt-001","source_kind":"schedule"}' \
  --kill-switch-enabled \
  --output trace
```

Ces options produisent des traces de cancel, timeout ou kill switch. Elles
ne fournissent pas de hard kill système ni de control plane distribué.

Avec une entrée AIR explicite :

```sh title="Terminal"
touba run program.air.json \
  --entry skill:examples.project/RunGreeting
```

`--entry` attend une référence AIR existante dans le programme compilé. Sans `--entry`, le runtime choisit l’entrée par défaut de l’AIR courant.

Avec une décision d’agent explicite :

```sh title="Terminal"
touba run program.air.json \
  --agent-decisions-json '{"agent:examples.research/Researcher":{"target_ref":"skill:examples.research/BuildBrief","reason":"brief requested"}}'
```

La décision doit sélectionner une capacité déclarée dans `uses` pour cet agent.
Si la référence demandée n’est pas autorisée, le runtime refuse avant d’entrer
dans la capacité.

Pour un fichier de décisions :

```sh title="Terminal"
touba run program.air.json \
  --agent-decisions agent-decisions.json
```

Les options `--agent-decisions` et `--agent-decisions-json` sont exclusives.

Avec un decision provider agentique :

```sh title="Terminal"
touba run program.air.json \
  --agent-decision-provider providers/researcher.provider.mjs \
  --agent-decision-provider-content-mode opaque_refs \
  --agent-decision-provider-initial-mode capabilities \
  --agent-decision-provider-timeout-ms 30000 \
  --agent-decision-provider-max-retries 1 \
  --max-agent-steps 8 \
  --max-provider-calls 4
```

Le module provider exporte `decideAgentCapability`, `decide` ou une fonction par
défaut. Le runtime l’appelle avec le protocole `touba-agent-decision-v1`.
La requête contient aussi `model_input.protocol = "touba-agent-model-input-v1"` :
une entrée modèle structurée qui distingue responsabilité de l’agent, instructions,
données utilisateur, contenu externe et exposition progressive des capacités.

`--agent-decision-provider-content-mode` accepte `inline` ou `opaque_refs`.
Le mode par défaut est `inline`. En mode `opaque_refs`, les observations
externes et les entrées runtime qui ne sont pas une intention utilisateur
explicite sont remplacées par des références opaques et des métadonnées ; leur
payload brut n’est pas inclus dans la requête provider. Les clés courtes
`user_goal`, `goal`, `user_request`, `request`, `task` et `objective` restent
visibles avec `trust: "user_intent"` pour permettre le routage de la tâche. La
trace enregistre `content_mode` et `external_content_access` pour rendre cette
exposition vérifiable. Ce mode réduit l’exposition de contenu au provider, mais
ne rend pas un modèle tiers fiable par défaut : le runtime revérifie toujours
`uses`, `callable_by`, arguments, budgets et manifest avant toute exécution.

`--agent-decision-provider-initial-mode` accepte `summary` ou `capabilities`.
Le mode par défaut est `summary` pour préserver l’exposition progressive du
catalogue. Le mode `capabilities` présente le catalogue autorisé dès la première
requête provider ; il est recommandé lorsque l’hôte sait que l’agent doit
choisir parmi ses capacités déclarées et que l’on veut réduire les allers-retours
modèle. Dans les deux modes, le runtime vérifie toujours la capacité sélectionnée
avant exécution. Les capacités exposées à un decision provider doivent déclarer
une `description` source explicite. Si une capacité de `agent.uses` n’en a pas,
le runtime refuse avant tout appel provider avec
`AgentCapabilityDescriptionRequired`. Les descriptors de capacités incluent la
source de description (`source`, `responsibility`, `generated` ou `absent`) pour
rendre ce contrôle auditable.

Le module peut exporter des metadata non secrètes. Elles sont reprises dans la
trace pour rendre le provider, le modèle ou le template de prompt identifiables
sans exposer de payload brut.

```js title="researcher.provider.mjs"
export const provider_metadata = {
  provider_kind: "sdk_ai",
  provider_name: "researcher-provider",
  provider_version: "1.0.0",
  model_family: "openai",
  prompt_template_id: "researcher-v1",
  decision_schema_version: "touba-agent-decision-v1",
};
```

Le provider peut répondre directement ou demander le catalogue complet :

```js title="researcher.provider.mjs"
export function decideAgentCapability(request) {
  if (request.mode === "summary") {
    if (request.inputs.request?.query === "bonjour") {
      return {
        action: "answer_directly",
        source: "custom_provider",
        reason: "Aucune capacité Touba n’est nécessaire",
        result: "Bonjour.",
      };
    }

    return {
      action: "request_capabilities",
      source: "custom_provider",
      reason: "Comparer les contrats disponibles",
    };
  }

  return {
    target_ref: "skill:examples.research/BuildBrief",
    source: "custom_provider",
    reason: "La demande exige une synthèse",
    arguments: {
      request: request.inputs.request,
    },
  };
}
```

En mode catalogue, il peut aussi demander un review humain gouverné :

```js title="researcher.provider.mjs"
return {
  action: "request_human_review",
  target_ref: "human_review",
  source: "custom_provider",
  reason: "Le résultat doit être confirmé avant de continuer",
  review_prompt: "Valider ce résultat intermédiaire.",
};
```

Le runtime vérifie ensuite `target_ref` contre `uses`, mappe `arguments` sur la
signature de la capacité et refuse avant exécution si la cible ou les arguments
sont invalides.

`--max-agent-steps` borne la boucle séquentielle d’un agent piloté par provider.
`--max-provider-calls` borne le nombre d’appels au provider. En cas de
dépassement, le run échoue avec un refus observable au lieu de continuer
indéfiniment.

Un provider peut appeler un modèle externe. En JavaScript, `@touba/sdk` fournit
`createAiSdkDecisionProvider` comme adaptateur générique, puis des helpers de
convenance comme `createOpenAiDecisionProvider` et `createOllamaDecisionProvider`.
Aucun fournisseur LLM ne devient l’autorité officielle de Touba : le provider
reste configuré explicitement, puis le runtime revalide.

```js title="researcher-ollama.provider.mjs"
import { createOllamaDecisionProvider } from "@touba/sdk";

export const provider_metadata = {
  provider_kind: "sdk_ai",
  provider_name: "researcher-ollama",
  provider_version: "1.0.0",
  model_family: "ollama",
  endpoint_family: "openai_compatible",
  prompt_template_id: "researcher-v1",
  decision_schema_version: "touba-agent-decision-v1",
};

export const decideAgentCapability = createOllamaDecisionProvider({
  model: process.env.TOUBA_AGENT_DECISION_OLLAMA_MODEL ?? "llama3.2",
  baseURL: process.env.TOUBA_AGENT_DECISION_OLLAMA_BASE_URL
    ?? "http://127.0.0.1:11434/v1",
});
```

Pour un endpoint Ollama local standard, aucune clé n’est requise. Si l’endpoint
compatible exige une clé, elle doit venir d’un secret hôte ou de l’environnement,
pas des inputs Touba ni d’un fichier versionné.

### Options historiques de compatibilité locale

`touba run` conserve trois options de compatibilité pour les premiers corpus :

```sh title="Terminal"
touba run program.air.json --stubs
touba run program.air.json --local-fetch-source-text "source locale"
touba run program.air.json --local-apply-change-summary "résumé local"
```

Ces options sont des stubs historiques de validation locale. Elles ne constituent
pas le chemin recommandé pour un projet, ne peuvent pas être combinées avec
`--manifest`, et ne doivent pas être utilisées comme preuve d'un handler réel.
Pour un usage normal, déclarer les tools dans l'AIR, générer ou écrire un
manifest, puis exécuter avec `--manifest`, `--secrets` si nécessaire et les
handlers projet.

## Sorties de `touba run`

```sh title="Terminal"
touba run program.air.json --output show
touba run program.air.json --output result
touba run program.air.json --output trace
touba run program.air.json --output all
```

Modes :

| Mode | Rôle |
| --- | --- |
| `show` | affiche seulement les messages `show` ; mode par défaut |
| `result` | affiche la valeur retournée |
| `trace` | affiche la trace JSON complète |
| `all` | affiche `show`, `result` et `trace` en sections |

Pour garder une trace dans un fichier tout en conservant la sortie utilisateur :

```sh title="Terminal"
touba run program.air.json \
  --trace-out trace.json
```

Pour produire un manifeste d'evidence séparé de la trace :

```sh title="Terminal"
touba run program.air.json \
  --trace-out trace.json \
  --evidence-out run.evidence.json \
  --evidence-ref db=postgres://example.local/runs/123
```

Le manifeste `touba-run-evidence-v0.1` référence le run, le digest de la trace,
le digest du résultat, le checkpoint éventuel et les références externes
déclarées avec `--evidence-ref`. Il ne copie pas le contenu métier et ne remplace
pas la trace. L'utilisateur choisit où sauvegarder l'evidence externe :
répertoire local, base de données, backend mémoire, stockage hôte ou autre
support explicite.

## `touba serve`

```sh title="Terminal"
export TOUBA_STUDIO_TOKEN='replace-with-a-strong-token'

touba serve \
  --project-root . \
  --auth-token-env TOUBA_STUDIO_TOKEN
```

Le serveur projet expose les contrats versionnés du projet, les événements
live, les décisions humaines, les propositions de changement, les exécutions
sandbox et les révisions de déploiement. Les entrypoints de test passent par le
runtime et l’autorité déclarée du projet.

Pour relier une cible de déploiement :

```sh title="Terminal"
touba serve \
  --project-root . \
  --auth-token-env TOUBA_STUDIO_TOKEN \
  --deployment-target-url https://deploy.example.com \
  --deployment-target-token-env TOUBA_DEPLOY_TOKEN
```

Le token de déploiement reste côté serveur. client n’en reçoit ni la valeur ni
le nom de variable.

## `touba deploy`

Créer un plan :

```sh title="Terminal"
touba deploy plan --root . --profile prod --target https://deploy.example.com
```

Publier sans activer :

```sh title="Terminal"
touba deploy publish \
  --root . \
  --profile prod \
  --target https://deploy.example.com \
  --auth-token-env TOUBA_DEPLOY_TOKEN
```

Consulter et promouvoir les révisions :

```sh title="Terminal"
touba deploy list \
  --target https://deploy.example.com \
  --auth-token-env TOUBA_DEPLOY_TOKEN

touba deploy activate \
  --target https://deploy.example.com \
  --auth-token-env TOUBA_DEPLOY_TOKEN \
  --revision sha256:...

touba deploy rollback \
  --target https://deploy.example.com \
  --auth-token-env TOUBA_DEPLOY_TOKEN
```

Lancer une cible :

```sh title="Terminal"
touba deploy target serve \
  --storage /srv/touba/revisions \
  --auth-token-env TOUBA_DEPLOY_TOKEN \
  --host 127.0.0.1 \
  --port 8792
```

## `touba inspect`

```sh title="Terminal"
touba inspect program.air.json
touba inspect trace.json
touba inspect touba.manifest.json
touba inspect touba.package.json
touba inspect touba.resources.json
touba inspect touba.run-plan.json
touba inspect touba.ownership.json
touba inspect touba.trigger-state.json
touba inspect trace-audit.export.json
touba inspect --supply-chain touba.lock.json
touba inspect --supply-chain supply-chain.report.json
touba inspect program.air.json --report-out program.inspect.txt
touba inspect trace.json --otel-out trace.otel.json
```

Inspecte un artefact Touba sans inventer de données absentes.

Selon le fichier fourni, la commande peut afficher :

- déclarations AIR ;
- graphes d’exécution ;
- traces ;
- compteurs de provenance et d’intégrité mémoire observés dans les traces ;
- bindings de manifest ;
- packages locaux, fragments de bindings, resource bindings et run plans fournis explicitement ;
- `Availability graph`, qui montre modules, imports, déclarations et exports disponibles ;
- `Authority graph`, qui montre exigences AIR, manifest, resource bindings, run plan et lock fournis ;
- `Ownership` et `Responsibility graph`, qui montrent teams, owners, review gates et reviews sans autorité runtime ;
- états durables des triggers, avec acceptations, refus et `event_id` consommés ;
- manifestes, rapports et exports d’audit ;
- locks et rapports de supply chain ;
- données absentes utiles à connaître.

`touba inspect` ne relit pas les handlers, backends mémoire, fichiers `.env`, fichiers de secrets ou stores locaux.
Il ne scanne pas le workspace pour découvrir un package ou un manifest voisin.
Avec `--report-out <rapport.inspect.txt>`, la commande écrit le même rapport
texte dans un fichier à suffixe explicite `.inspect.txt` et conserve l’affichage
standard dans le terminal.
Avec `--otel-out <trace.otel.json>`, la commande écrit une projection JSON
OpenTelemetry d’une trace native. L’option demande soit un fichier trace unique,
soit `--trace <trace.json>` dans une inspection multi-artefacts.
La projection mappe les événements en spans GenAI `invoke_workflow`,
`invoke_agent` ou `execute_tool` quand c’est possible, et n’exporte que des
références, compteurs, codes et metadata non sensibles.

Inspection multi-artefacts explicite :

```sh title="Terminal"
touba inspect \
  --air build/touba/project.air.json \
  --manifest build/touba/touba.manifest.json \
  --package packages/research/touba.package.json \
  --resource-bindings touba.resources.json \
  --run-plan touba.run-plan.json \
  --ownership touba.ownership.json
```

Le fragment `touba-binding-fragment-v0.1` peut aussi être inspecté avec
`--binding-fragment`, mais il reste affiché comme non autoritaire pour le
runtime. Seul le manifest assemblé est une autorité d’exécution.

## `touba audit`

```sh title="Terminal"
touba audit --trace trace.json
```

Valide une trace Touba et produit un rapport `trace-audit-validation-v0.1`.

Avec plus de contexte :

```sh title="Terminal"
touba audit \
  --trace trace.json \
  --air program.air.json \
  --source source.tb \
  --manifest touba.manifest.json
```

Avec export :

```sh title="Terminal"
touba audit \
  --trace trace.json \
  --air program.air.json \
  --source source.tb \
  --manifest touba.manifest.json \
  --retention-class project_audit \
  --redaction-policy no_secrets_no_raw_prompts_no_memory_content \
  --export trace-audit.export.json \
  --report-out trace-audit.trace-audit-report.json
```

Options :

| Option | Rôle |
| --- | --- |
| `--trace` | trace à valider, obligatoire |
| `--air` | AIR associé, optionnel |
| `--source` | source `.tb` associée, optionnelle |
| `--manifest` | manifest runtime associé, optionnel |
| `--audit-manifest` | manifest d’audit existant à vérifier |
| `--retention-class` | classe de rétention déclarative |
| `--redaction-policy` | politique de redaction attendue |
| `--export` | fichier d’export écrit seulement si le rapport est `ok` |
| `--report-out` | fichier de rapport `trace-audit-validation-v0.1` écrit avec le suffixe `.trace-audit-report.json` |
| `--output text\|json` | format du rapport |

`touba audit` ne signe pas les artefacts, ne crée pas d’horodatage légal et ne
déclare pas une conformité réglementaire.

## `touba supply-chain validate`

```sh title="Terminal"
touba supply-chain validate \
  --lock touba.lock.json \
  --air program.air.json \
  --manifest touba.manifest.json \
  --require-review \
  --report-out project.supply-chain-report.json
```

Valide un lock supply chain contre les artefacts fournis explicitement.

La validation couvre :

- digest `sha256` de l’AIR ;
- digest `sha256` du manifest ;
- digest `sha256` des handlers listés ;
- commande, `cwd` et `args` de handler ;
- metadata SDK déclarative, dont nom, version et protocole handler attendu ;
- identité déclarée `handler_package` des handlers ;
- fichiers de paquet handler et artefacts de dépendances déclarés sous
 `handler_package` ;
- provenance déclarée du lock ;
- revue déclarée du lock et preuves associées ;
- diagnostics anti-fuite sur les champs d’autorité.

Options :

| Option | Rôle |
| --- | --- |
| `--lock` | lock `touba-lock-v0.1`, obligatoire |
| `--air` | AIR attendu par le lock, obligatoire |
| `--manifest` | manifest attendu par le lock, requis si le lock en déclare un |
| `--report-out` | fichier de rapport `touba-supply-chain-validation-v0.1` écrit avec le suffixe `.supply-chain-report.json` |
| `--output text\|json` | format du rapport |
| `--strict` | échoue aussi sur les warnings |
| `--require-review` | exige une revue `approved` cohérente dans le lock |

Exemple JSON :

```sh title="Terminal"
touba supply-chain validate \
  --lock touba.lock.json \
  --air program.air.json \
  --manifest touba.manifest.json \
  --output json
```

Exemple avec revue obligatoire :

```sh title="Terminal"
touba supply-chain validate \
  --lock touba.lock.json \
  --air program.air.json \
  --manifest touba.manifest.json \
  --require-review
```

`touba supply-chain validate` n’exécute pas les handlers, ne scanne pas le
workspace, ne lit pas les secrets, ne signe pas les artefacts, ne vérifie pas de
registry et ne réalise pas d’audit de vulnérabilités. `handler_package` est une
identité déclarée et une racine d’artefacts déclarés, pas une source de confiance.
Une revue `approved` est une discipline déclarée, pas une signature, une preuve
de conformité ou un statut `Verified / Unverified`.

## `touba registry resolve`

```sh title="Terminal"
touba registry resolve \
  --registry ../touba-registry \
  --package pkg:touba-library/donnees-quebec-dataset-brief \
  --version 0.1.0 \
  --source-root ../touba-library \
  --allow-draft \
  --out donnees-quebec.lock.json
```

Résout une entrée d’un registry statique par fichier local ou URL brute.

La commande lit `index.json`, le metadata package référencé, puis vérifie le
digest du metadata. Si `--source-root` est fourni, elle vérifie aussi les
digests des artefacts source listés dans le metadata.

Elle produit un lock local `touba-static-registry-lock-v0.1`.

Options principales :

| Option | Rôle |
| --- | --- |
| `--registry` | dossier registry, fichier `index.json` ou URL brute vers un registry statique |
| `--package` | référence `pkg:<namespace>/<name>` |
| `--version` | version exacte à résoudre |
| `--source-root` | checkout local utilisé pour vérifier les artefacts source |
| `--allow-draft` | autorise explicitement une entrée `draft` |
| `--allow-deprecated` | autorise explicitement une entrée `deprecated` |
| `--out` | écrit le lock dans un fichier `.json` |
| `--json` | affiche le lock JSON sur stdout |

Comportement des statuts :

- `reviewed` et `validated` peuvent être résolus ;
- `draft` exige `--allow-draft` ;
- `deprecated` exige `--allow-deprecated` ;
- `yanked` est toujours refusé.

Refus distingués :

- schéma invalide ;
- digest metadata différent de l’index ;
- digest artefact différent de la source locale ;
- version absente ;
- protocole incompatible ;
- statut non autorisé.

`touba registry resolve` ne télécharge pas de package, n’installe rien et
n’exécute aucun script. Un lock local vérifie des digests ; il ne constitue pas
une signature, un audit de vulnérabilités, un endorsement ou une autorité
runtime.

## `touba manifest generate`

```sh title="Terminal"
touba manifest generate program.air.json --out touba.manifest.json
```

Génère un manifest de binding à partir des tools déclarés dans l’AIR.

Options fréquentes :

```sh title="Terminal"
touba manifest generate program.air.json \
  --out touba.manifest.json \
  --handler-command node \
  --handler-root handlers
```

Le manifest généré est un point de départ. Il doit être relu avant exécution d’un programme avec tools.

Le manifest peut aussi porter des contraintes de payload, par
exemple :

```json title="touba.manifest.json"
{
  "bindings": {
    "tool:examples.fetch_source/FetchSource": {
      "payload_constraints": {
        "input": {
          "request.query": {
            "non_empty": true,
            "max_length": 120
          },
          "request.mode": {
            "allowed_values": ["dry_run", "review", "execute"]
          },
          "request.recipients": {
            "min_items": 1,
            "max_items": 5
          }
        }
      }
    }
  }
}
```

Ces contraintes sont évaluées par `touba run` après le schéma AIR et avant le
handler. Un refus produit `ToolPayloadConstraintViolation` sans afficher la
valeur brute refusée.

Les contraintes de base couvrent `non_empty`, `max_length`, `min` et `max`.
L’extension valeurs autorisées ajoute `allowed_values` pour borner un champ à une liste explicite de valeurs
scalaires JSON (`Text`, `Boolean`, `Int`, `Float`). Touba ne traite pas ces
contraintes comme des expressions, des regex ou un langage de policy.
Les contraintes de cardinalité de listes ajoutent `min_items` et `max_items`
sur des valeurs déjà validées comme `List<T>` par l’AIR.

## `touba handler stub`

```sh title="Terminal"
touba handler stub program.air.json
```

Génère des squelettes de handlers pour les tools déclarés dans l’AIR.

Options fréquentes :

```sh title="Terminal"
touba handler stub program.air.json \
  --handler-root handlers
```

Pour générer seulement un tool :

```sh title="Terminal"
touba handler stub program.air.json \
  --tool-ref tool:examples.search/SearchDatasets \
  --handler-root handlers
```

Le stub généré n’implémente pas l’effet externe. Il pose le contrat de handler à compléter.

## `touba version`

```sh title="Terminal"
touba version
touba version --json
```

Affiche les versions de la CLI, du runtime, des schémas AIR/trace/manifest/secrets/audit, les capacités publiques déclarées par ce binaire et le canal de distribution courant.

`--json` est utile pour identifier précisément un binaire dans un rapport ou une session de support.

La source courante affiche les packages Touba en `0.1.0`. Les champs de schémas
restent versionnés séparément, par exemple `air-minimal-v0.1` ou
`trace-minimal-v0.1`.

Le champ `distribution.channel` identifie le mode d'installation :

| Canal | Sens |
| --- | --- |
| `local-development` | exécution depuis le workspace source |
| `local-archive` | archive locale installée |
| `macos-local-release` | bundle macOS local, non signé et sans canal public |

Si `touba version --json` affiche encore `0.0.0` ou `unknown`, l'installation
active vient d'un ancien build. Regénérer puis réinstaller la toolchain locale
ou le bundle local avant de diagnostiquer le code courant.

## `touba doctor`

```sh title="Terminal"
touba doctor
touba doctor --json
```

Vérifie l'installation active : version Node, versions des composants Touba,
présence des scripts publics et profils projet disponibles dans le dossier
courant.

`touba doctor --json` produit un rapport `touba-doctor-v0.1` avec un statut
`ok`, `warning` ou `error`. C'est la commande à demander en priorité quand un
utilisateur voit une différence entre la documentation, `touba run --help` et
le comportement de son binaire.

Le diagnostic ne lit pas les secrets et ne remplace pas les validations de
projet. Il permet d'abord de savoir si le bon binaire est utilisé.

## `touba update`

```sh title="Terminal"
touba update
touba update --json
```

Explique la politique de mise à jour du canal courant.

La commande affiche la version installée, le canal, la plateforme, le lien
Touba Hub, l’archive attendue et les commandes de réinstallation. `--json`
renvoie le même contrat sous forme machine-readable.

La V1 utilise une réinstallation explicite depuis une archive plus récente ou
depuis le canal de package manager qui a installé Touba. L’update automatique
reste une couche de distribution ultérieure.
