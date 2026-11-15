# Projet Touba et `prepare`

## Choisir le processus d'un handler

Une décision hôte peut fournir le processus complet d'un binding :
`kind`, `command`, `args` et, si nécessaire, `cwd`.

```json title="host-decisions.json"
{
  "bindings": {
    "tool:orders.review/ReadOrder": {
      "handler": {
        "kind": "process",
        "command": ".venv/bin/python",
        "args": ["-B", "handlers/read_order.py"],
        "cwd": "."
      }
    }
  }
}
```

```sh
touba prepare --mode plan --host-decisions host-decisions.json
touba prepare --mode write --host-decisions host-decisions.json
```

Sous Windows, utilisez `.venv/Scripts/python.exe`. Le processus est remplacé
comme un ensemble : les anciens arguments ne sont pas conservés.
Choisissez `handler` ou `package_handler` pour un binding.
Un binding géré par fragment se modifie dans son fragment.
Grants, secrets et contrat d'effet restent des décisions explicites distinctes.


Ce guide explique comment organiser un petit projet Touba sans gérer manuellement les artefacts dérivés.

Les commandes de ce guide supposent que la CLI Touba est disponible dans le terminal. Installer seulement l’extension VS Code via VSIX ne suffit pas pour obtenir la commande `touba`.

## Rôle

Un projet Touba relie quatre éléments :

| Élément | Rôle |
| --- | --- |
| fichier `.tb` | source lisible par le développeur |
| module | identité logique déclarée dans le fichier |
| configuration projet | entrée, profils et références explicites vers les configurations d’autorité |
| projection de build | AIR, manifest assemblé et run plan dérivés pour un profil |
| manifest | contrat effectif d’exécution des tools, dérivé des autorités déclarées |
| handler | code hôte appelé par un tool |
| ownership | responsabilité équipe, owners et review gates |

Un fichier `.tb` n’a pas toujours besoin d’un manifest ou d’un handler. Un
projet en a besoin lorsque l’AIR préparé contient un `tool` à exécuter, que ce
tool soit déclaré dans le fichier courant ou importé depuis un autre module du
même projet.

## Décider explicitement des droits hôte

Pour éviter un script de modification du manifest, fournissez les décisions
à `prepare`. Exemple pour le tool `ReadOrder` du module `orders.review` :

```sh title="Terminal"
touba prepare --mode plan --host-decisions-json '{"bindings":{"tool:orders.review/ReadOrder":{"grants":["network"],"effect_contract":{"kind":"none"},"timeout_ms":5000}}}'
```

Le rapport montre le changement et les besoins source. Après revue, reprenez
la même commande avec `--mode write`, puis avec `--mode check`. Seul `write`
écrit. Remplacez la référence et les décisions par celles de votre projet ;
`kind: "none"` convient uniquement à un handler sans écriture externe.

Champs possibles : `grants`, `secrets` (handles, jamais valeurs), `memories`,
`effect_contract`, `timeout_ms`, `max_payload_bytes`, `sandbox`. La clé de premier niveau
`agent_secret_scopes` permet de sélectionner les handles autorisés par agent.
Les sélections doivent correspondre à des besoins déclarés par le source.
Les champs omis sont conservés ; une liste vide révoque le champ sélectionné.
Une permission manquante reste signalée, sans complément automatique.

Répéter les mêmes décisions ne change rien. Un objet invalide empêche toutes
les écritures. Un binding fourni par fragment se modifie dans son fragment,
selon le parcours ci-dessous. Le manifest reste l'autorité d'exécution. Un lock existant
doit être vérifié et renouvelé explicitement après une modification d'autorité.
Ne passez aucune valeur secrète sur la ligne de commande.

### Modifier un fragment déjà préparé

Modifiez le fragment, par exemple son `timeout_ms` ou sa configuration `sandbox`,
puis utilisez le même parcours :

```sh title="Terminal"
touba prepare --mode plan
touba prepare --mode write
touba prepare --mode check
```

Le plan montre les champs modifiés. Il affiche les limites, les droits connus,
la catégorie d'interpréteur, les accès relatifs au projet et le nombre de fichiers
de l'inventaire. Les arguments, chemins externes et noms de fichiers de code
restent masqués. Les empreintes lient aussi ces détails masqués à la revue.
Si l'ancienne projection n'est plus disponible, seule son empreinte est affichée :
le plan ne reconstruit pas ses valeurs.
`write` applique la configuration ; `check` signale une modification à appliquer.
Les exigences d'approbation du consommateur restent actives.

Touba conserve automatiquement `configuration.fragment_baselines` dans
`touba.project.json` : des empreintes par profil, à versionner avec le projet.
Elles permettent de distinguer la modification du fragment de celle du manifest
généré et de montrer les changements après nettoyage de `.touba/build`.
Leur rôle est la comparaison ; les permissions restent déclarées par l'hôte.

Pour un projet préparé par une ancienne build, lancez une première fois `write`
avant de modifier ses fragments. Si le fragment et le manifest diffèrent déjà,
le plan fournit une action `review_fragment_binding` avec une empreinte de revue.
Après vérification du fragment et des champs indiqués, renseignez cette empreinte
exacte dans un fichier de décisions, puis appliquez-le :

```json title="fragment-review.json"
{
  "review_fragments": {
    "tool:orders.review/ReadOrder": "sha256:<empreinte affichée par le plan>"
  }
}
```

```sh title="Terminal"
touba prepare --mode plan --host-decisions fragment-review.json
touba prepare --mode write --host-decisions fragment-review.json
touba prepare --mode check
```

Cette revue lie le profil, l'état observé et le fragment proposé. Régénérez-la
si l'un change ; retirez-la des commandes après application. Avec une référence
déjà enregistrée, une altération du manifest produit `BindingFragmentManifestDrift` :
restaurez sa dernière projection connue avant d'appliquer le fragment.

Le plan propose `restore_fragment_binding` si les sources déclarées correspondent
encore à la préparation enregistrée. Relisez les différences et utilisez son
empreinte exacte, avec un motif :

```json title="restore-review.json"
{
  "restore_fragments": {
    "tool:orders.review/ReadOrder": {
      "digest": "sha256:<empreinte affichée par le plan>",
      "reason": "Rétablir la projection conforme au fragment relu"
    }
  }
}
```

```sh title="Terminal"
touba prepare --mode plan --host-decisions restore-review.json
touba prepare --mode write --host-decisions restore-review.json
touba prepare --mode check
```

La restauration ne modifie que le manifeste généré. Elle conserve les sources,
le verrou des packages, les politiques d'approbation et les états d'exécution.
Son journal est conservé sous `.touba/change-transactions`. Aucun effet n'est
rejoué. Si une autre entrée préparée a changé, la restauration est refusée :
rétablissez d'abord les sources effectivement relues. Ne supprimez pas le dossier
de build pour contourner cette vérification.

## Ressources déclarées et déclencheurs

Référencez les fichiers de ressources dans la configuration du projet :

```json title="Extrait de touba.project.json"
{
  "configuration": {
    "resource_bindings": ["config/memory.json", "config/providers.json"]
  }
}
```

`prepare` vérifie ces fichiers ensemble et en conserve les empreintes.
`run --project`, le serveur projet et les SDK en mode projet transmettent les
liaisons à l'entrée sélectionnée. Chaque handler reçoit les ressources de son
tool, les droits read/write nécessaires à cet appel et les handles de secrets
déclarés. Les valeurs de connexion restent dans le profil de secrets.

Un doublon de ressource ou un fichier modifié après préparation est refusé.
Après revue des changements, relancez `prepare --mode write`.
Une option explicite `run --resource-bindings fichier.json` remplace l'ensemble
préparé pour cet appel ; elle reste soumise aux contrôles du runtime.

Pour activer un trigger déclaré, ajoutez une décision hôte :

```json title="host-decisions.json"
{
  "triggers": {
    "trigger:examples.daily_research/DailyResearchSchedule": {
      "enabled": true,
      "limits": {"max_runs_per_day": 1, "timeout_ms": 5000}
    }
  }
}
```

```sh
touba prepare --mode plan --host-decisions host-decisions.json
touba prepare --mode write --host-decisions host-decisions.json
touba prepare --mode check --host-decisions host-decisions.json
```

Les triggers sont désactivés à leur création. Leurs limites hôtes peuvent être
plus strictes que celles du source. Pour désactiver un trigger, choisissez
`enabled: false`. Les fragments décrivent les bindings de tools ;
`triggers` et `agent_secret_scopes` se placent dans les décisions hôtes.
Les clés inconnues, y compris imbriquées, sont refusées avec leur emplacement.

## Convention de module

Les clés de `touba.project.json` et de son objet `configuration` sont fermées :
une clé inconnue est refusée avec `ProjectConfigFieldUnknown`. Placez les
contextes dans `configuration.contexts`, jamais dans `contexts` à la racine.

Dans un projet, la convention est :

```text title="Structure"
src/examples/search.tb
```

avec :

<!-- touba-example: compile -->
```touba title="source.tb"
module examples.search
```

La partie dossier donne le domaine logique. Le nom du fichier donne le dernier segment du module.

## Initialiser un projet

Syntaxe :

```sh title="Terminal"
touba init
```

Effet :

- crée les dossiers de projet attendus ;
- crée `touba.project.json` avec le langage hôte JavaScript, le SDK `@touba/sdk`, le layout `touba-artifacts-v1` et les profils `pure` / `dev` / `prod` ;
- sépare les dérivés dans `.touba/build/`, l’état dans `.touba/state/` et les preuves locales dans `.touba/evidence/` ;
- prépare les exclusions de projet ;
- ne crée pas de manifest tant qu’aucun `tool` n’existe.

Pour les handlers Python, utilisez `touba init --language python`, puis
`touba sdk install python`. Pour JavaScript, utilisez `touba sdk install javascript`.
Les deux SDK suivent les mêmes concepts ; seul le langage hôte change.

## Autorité explicite de l’hôte

`prepare` expose les besoins du source dans `manifest_requirements`. Les manifests
générés ne donnent aucun grant, secret ou scope mémoire ; les triggers restent
désactivés. Relisez ces besoins, implémentez les handlers et configurez les
permissions hôte explicitement. `needs_changes` signifie que des actions restent
à faire, pas que l’exécution est prête.

Passez `--manifest touba.manifest.json` pour conserver le manifest relu hors du
build, ou configurez son chemin dans le projet. La préparation préserve les
décisions hôte et les handlers métier. Un nouveau besoin du source n’élargit
jamais les droits silencieusement.

Seul `touba-artifacts-v1` est accepté : `.touba/build/<profil>/` pour les builds,
`.touba/state/` pour l’état. La stratégie unique, ou à défaut l’entrée exécutable
unique, est choisie sans ambiguïté. Sinon utilisez `--entry <ref>`. Aucun repli
vers un ancien layout ni migration implicite n’est effectué.

## Entrée par défaut d'un projet

Avec plusieurs stratégies, ajoutez à la racine de `touba.project.json` la propriété `"entry": "strategy:app.support/Run"` en remplaçant la référence par une entrée réelle. Conservez les autres champs. Cette entrée est partagée par les préparations `write` et `check`.

Pour un choix ponctuel, passez le même `--entry <ref>` aux deux commandes. Un `write` avec cette option suivi d'un `check` sans elle ne vérifie pas le même projet effectif : `EffectiveProjectDrift` ou `select_entry` est attendu. Aucune stratégie n'est choisie arbitrairement.

## Créer un module

Syntaxe :

```sh title="Terminal"
touba new module examples.hello
```

Effet :

```text title="Structure"
src/examples/hello.tb
```

avec :

<!-- touba-example: compile -->
```touba title="source.tb"
module examples.hello
```

Un nom de module projet doit contenir au moins deux segments en minuscules, par exemple `examples.hello`.

## Créer un package contextuel

`touba package new acme.review --context --yes` crée le manifeste auteur, la procédure et le README.
Utilisez `touba package check review`, puis `touba package add ./review` pour l'enregistrer.
Voir les [packages](creer-partager-package.md) et [l'activation du contexte](skills-first.md).

## Préparer un projet sans tool

Exemple :

<!-- touba-example: compile -->
```touba title="source.tb"
module examples.hello

strategy RunHello
    gives Text
    do
        show
            with message as "Touba ready"
        give "done"
```

Commande :

```sh title="Terminal"
touba prepare --mode plan
```

Résultat attendu :

- le rapport indique l’AIR qui serait produit ;
- aucun manifest n’est demandé ;
- aucun handler n’est généré.

Pour écrire les artefacts dérivés :

```sh title="Terminal"
touba prepare --mode write --profile pure
```

Le projet obtient l’AIR sous `.touba/build/pure/air/`. Aucun manifest n’est
produit puisque le programme ne déclare pas de tool.

## Préparer un projet avec tool

Exemple :

<!-- touba-example: compile -->
```touba title="source.tb"
module examples.search

type SearchRequest
    query is Text

type SearchResult
    title is Text

tool SearchDatasets
    takes request as SearchRequest
    gives SearchResult
    requires network
```

Commande :

```sh title="Terminal"
touba prepare --mode write --profile dev
```

Résultat attendu :

- un AIR est produit ;
- `touba.project.json` fixe le langage hôte, le SDK, l’entrée et les références de configuration ;
- `.touba/build/dev/touba.manifest.json` reçoit le binding effectif pour `SearchDatasets` ;
- `.touba/build/dev/touba.run-plan.json` compose l’entrée et les dérivés si `entry` est déclarée ;
- `.touba/build/dev/touba.effective-project.json` explique le contrat résolu et la provenance de chaque section ;
- un stub de handler est créé sous `handlers/examples/search/`.

Le handler reste du code métier à compléter. Le stub ne doit pas être traité comme une implémentation fonctionnelle.

Le manifest ne contient pas de valeur de secret. Il est régénérable, mais doit
rester relisible comme projection des contrats d’exécution du projet.

## Composer un fragment de binding

Un fragment de binding décrit une intention explicite de wiring. Il peut venir
d’un module, d’un package local ou d’un outil de génération, mais il n’est pas
un artefact runtime.

```json title="bindings/search.json"
{
  "fragment_schema_version": "touba-binding-fragment-v1",
  "source": {
    "kind": "module",
    "module": "examples.search"
  },
  "bindings": {
    "tool:examples.search/SearchDatasets": {
      "handler": {
        "kind": "process",
        "command": "node",
        "args": ["handlers/examples/search/search_datasets.handler.mjs"],
        "cwd": "."
      },
      "grants": ["network"],
      "secrets": [],
      "timeout_ms": 10000,
      "max_payload_bytes": 1048576,
      "payload_constraints": {
        "input": {
          "request.query": {
            "non_empty": true,
            "max_length": 80
          }
        }
      }
    }
  }
}
```

Composition :

```sh title="Terminal"
touba prepare --binding-fragment bindings/search.json --mode write
```

`prepare` vérifie que le tool existe dans l’AIR assemblé, que les grants et
secrets requis sont présents, que les contraintes de payload sont valides, puis
écrit le manifest assemblé du profil. `touba run` reçoit ce manifest dérivé via
un run plan explicite, jamais le fragment.

Pour éviter de répéter le flag, référencez le fragment dans le projet :

```json title="touba.project.json (extrait)"
{
  "entry": "strategy:examples.search/RunSearch",
  "configuration": {
    "binding_fragments": ["bindings/search.json"],
    "resource_bindings": ["touba.resources.json"],
    "ownership": "touba.ownership.json"
  }
}
```

Ces chemins sont explicites. Leur présence sur disque ne suffit jamais à les
activer.

## Valider des resource bindings

Un resource binding relie une ressource logique Touba à un câblage hôte
explicite. Pour les resource bindings, Touba valide le contrat, mais ne fournit pas de backend
officiel. Avec la transmission des resource bindings (RB-2), `touba run --resource-bindings` transmet aussi au
handler les seuls bindings associés aux ressources effectivement utilisées par
le tool appelé.

```json title="touba.resources.json"
{
  "resource_bindings_schema_version": "touba-resource-bindings-v1",
  "resources": {
    "memory:examples.memory/Notes": {
      "kind": "memory_backend",
      "provider": "host.project_memory",
      "config": {
        "endpoint_url": "https://memory.example.internal/notes"
      },
      "grants": ["memory.read"],
      "secrets": ["DATABASE_URL"],
      "required_secrets": ["DATABASE_URL"],
      "limits": {
        "max_payload_bytes": 1048576
      }
    }
  }
}
```

Validation projet :

```sh title="Terminal"
touba prepare \
  --resource-bindings touba.resources.json \
  --require-resource-bindings \
  --mode check
```

Validation runtime :

```sh title="Terminal"
touba run --project . \
  --entry strategy:examples.memory/Run \
  --profile dev
```

Touba refuse une ressource inconnue, une famille non supportée, un binding
inactif, un grant ou secret requis absent, un scope mémoire manquant, ou un
champ qui contient un payload brut ou une valeur secrète.

## Binding transmis au handler

Dans le protocole handler, le binding transmis ressemble à ceci :

```json title="Extrait de requête handler"
{
  "resource_bindings": [
    {
      "resource_ref": "memory:examples.memory/Notes",
      "kind": "memory_backend",
      "provider": "host.project_memory",
      "grants": ["memory.read"],
      "secret_handles": ["DATABASE_URL"],
      "config": {
        "endpoint_url": "https://memory.example.internal/notes"
      },
      "limits": {
        "max_payload_bytes": 1048576
      }
    }
  ]
}
```

Le handler utilise ces informations comme câblage hôte. Il ne décide pas si la
ressource est autorisée : les vérifications AIR, manifest, scopes, grants,
secrets et resource bindings restent faites avant dispatch par Touba.

## Préparer un projet avec imports purs

La tranche d’imports purs (IM-1) autorise des imports explicites de `type`, `define` non sensible et `function` pure.

Module commun :

<!-- touba-example: compile -->
```touba title="src/examples/common.tb"
module examples.common

type SearchRequest
    query is Text
    rows is Int

define DefaultRows as Int = 5

function NormalizeQuery
    takes query as Text
    gives Text
    do
        give query
```

Module importeur :

<!-- touba-example: compile -->
```touba title="src/examples/search.tb"
module examples.search

import type SearchRequest from examples.common
import define DefaultRows from examples.common
import function NormalizeQuery from examples.common

strategy RunSearch
    gives Text
    do
        show
            with message as "search project ready"
        give "done"
```

Commande :

```sh title="Terminal"
touba prepare --mode write
```

Résultat attendu :

- les modules du projet sont compilés explicitement ;
- l’AIR préparé de `examples.search` contient les imports purs résolus ;
- aucun manifest ou handler n’est créé si aucun `tool` n’est déclaré ;
- les surfaces Touba peuvent inspecter les imports depuis l’AIR préparé.

## Préparer un projet avec imports effectifs locaux

Touba autorise les imports locaux de `tool`, `skill`, `strategy`, `agent` et
`memory` déclarés dans un autre module du même projet. L’import rend la
déclaration disponible pour composition, mais il ne déplace pas l’autorité
d’exécution.

Module déclarant :

<!-- touba-example: compile -->
```touba title="src/examples/data_tools.tb"
module examples.data_tools

type DatasetSearchRequest
    query is Text
    rows is Int

type DatasetSearchResult
    title is Text
    url is Text

tool SearchDatasets
    takes request as DatasetSearchRequest
    gives DatasetSearchResult
    requires network
```

Module importeur :

<!-- touba-example: compile -->
```touba title="src/examples/research_app.tb"
module examples.research_app

import type DatasetSearchRequest from examples.data_tools
import type DatasetSearchResult from examples.data_tools
import tool SearchDatasets from examples.data_tools

skill BuildDatasetBrief
    takes request as DatasetSearchRequest
    gives DatasetSearchResult
    uses SearchDatasets
    do
        SearchDatasets
            with request as request
            into result
        give result
```

Commande :

```sh title="Terminal"
touba prepare --mode write
```

Résultat attendu :

- l’AIR préparé de `examples.research_app` contient l’import `tool` résolu ;
- le tool garde sa référence canonique `tool:examples.data_tools/SearchDatasets` ;
- `touba.manifest.json` reçoit ou vérifie le binding de cette référence canonique ;
- le stub de handler est créé sous `handlers/examples/data_tools/`, pas sous le module importeur ;
- les grants, secrets, limites, contraintes payload et lock supply chain restent explicites.

Les autres imports effectifs suivent la même règle :

- une `skill` ou une `strategy` importée conserve son graphe et ses dépendances
  dans l’AIR préparé ;
- un `agent` importé reste fermé tant que son `callable_by` ne nomme pas
  explicitement l’appelant, y compris sous forme inter-module ;
- une `memory` importée reste une ressource logique ; un owner doit déclarer le
  scope `read` ou `write` requis avant d’appeler un tool d’accès.

## Préparer un projet avec package local

Un package local Touba rend des déclarations disponibles entre projets. Il ne
donne pas d’autorité d’exécution.

Structure possible :

```text title="Structure"
mon-projet/
  src/examples/package_app.tb
  authors/research/
    touba.package.json
    src/org/example/research.tb
```

Manifeste de package :

```json title="authors/research/touba.package.json"
{
  "package_schema_version": "touba-package-v1",
  "name": "org.example.research",
  "version": "0.1.0",
  "root": ".",
  "touba": {
    "air_profile": "touba-air-json-canonical-v1",
    "runtime_compatibility": ">=1.0 <2.0"
  },
  "exports": {
    "types": [
      "type:org.example.research/DatasetSearchRequest",
      "type:org.example.research/DatasetSearchResult"
    ],
    "defines": [],
    "functions": [],
    "tools": [
      "tool:org.example.research/SearchDatasets"
    ],
    "skills": [],
    "strategies": [],
    "agents": [],
    "memories": []
  },
  "provenance": {
    "kind": "local_path",
    "source": "."
  }
}
```

Configuration du projet :

```json title="touba.project.json"
{
  "project_version": "touba-project-v1",
  "language": "javascript",
  "sdk": "@touba/sdk",
  "packages": [
    {
      "manifest": "authors/research/touba.package.json",
      "editable": true,
      "version": "0.1.0"
    }
  ],
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

Module fourni par le package :

<!-- touba-example: compile -->
```touba title="authors/research/src/org/example/research.tb"
module org.example.research

type DatasetSearchRequest
    query is Text
    rows is Int

type DatasetSearchResult
    title is Text
    url is Text

tool SearchDatasets
    takes request as DatasetSearchRequest
    gives DatasetSearchResult
    requires network
```

Module du projet :

<!-- touba-example: compile -->
```touba title="src/examples/package_app.tb"
module examples.package_app

import type DatasetSearchRequest from org.example.research
import type DatasetSearchResult from org.example.research
import tool SearchDatasets from org.example.research

skill BuildDatasetBrief
    takes request as DatasetSearchRequest
    gives DatasetSearchResult
    uses SearchDatasets
    do
        SearchDatasets
            with request as request
            into result
        give result
```

Commande :

```sh title="Terminal"
touba prepare --mode write
```

Résultat attendu :

- le package est chargé parce qu’il est déclaré explicitement ;
- seuls les refs listés dans `exports` sont importables ;
- l’AIR préparé du projet contient les déclarations importées utiles ;
- si un `tool` exporté est réellement importé, `prepare` produit le binding
  attendu dans `touba.manifest.json` et le stub sous le module déclarant ;
- le package ne peut pas accorder un grant, un secret, un handler, un scope
  mémoire, un caller d’agent ou un trigger actif.

Option équivalente sans modifier `touba.project.json` :

```sh title="Terminal"
touba prepare --package authors/research/touba.package.json --mode write
```

## Préparer un run plan

Un run plan regroupe les chemins d’exécution du projet dans un artefact explicite.
Il pointe vers l’AIR préparé, le manifest si des tools existent, le profil de
secrets si des secrets sont requis, et le lock si le profil de run l’exige.

Pour un projet simple :

```sh title="Terminal"
touba prepare \
  --run-plan touba.run-plan.json \
  --entry skill:examples.package_app/BuildDatasetBrief \
  --mode write
```

Forme produite :

```json title="touba.run-plan.json"
{
  "run_plan_schema_version": "touba-run-plan-v1",
  "entry_ref": "skill:examples.package_app/BuildDatasetBrief",
  "air": ".touba/air/examples/package_app.air.json",
  "manifest": "touba.manifest.json",
  "secrets_profile": "touba.secrets.dev.json",
  "profile": "dev",
  "outputs": {
    "mode": "show"
  }
}
```

Le run plan ne contient pas d’inputs métier, de prompt brut ou de valeur
secrète. Les entrées d’exécution restent fournies au moment du run.

Pour un profil strict :

```sh title="Terminal"
touba prepare \
  --run-plan touba.run-plan.json \
  --entry skill:examples.package_app/BuildDatasetBrief \
  --profile prod \
  --mode write
```

Dans ce cas, si le profil `prod` exige un lock supply chain, le plan pointe aussi vers
`touba.lock.json`.

## Valider l’ownership multi-équipe

Un artefact `touba.ownership.json` décrit les équipes responsables, les owners,
les review gates et les reviews fournies pour un profil.

```json title="touba.ownership.json"
{
  "ownership_schema_version": "touba-ownership-v1",
  "teams": {
    "team:platform": {
      "display_name": "Platform"
    },
    "team:security": {
      "display_name": "Security"
    }
  },
  "owners": {
    "tool:examples.search/SearchDatasets": ["team:platform"]
  },
  "review_gates": {
    "prod": {
      "requires_review_for": ["tool_binding", "required_capability"],
      "reviewers": ["team:security"]
    }
  },
  "reviews": [
    {
      "review_id": "review:search/security-001",
      "profile": "prod",
      "target_ref": "tool:examples.search/SearchDatasets",
      "reviewer": "team:security",
      "decision": "approved"
    }
  ]
}
```

Validation :

```sh title="Terminal"
touba prepare \
  --ownership touba.ownership.json \
  --profile prod \
  --mode check
```

Avec `--require-ownership`, Touba refuse si le fichier d’ownership est absent.

`touba.ownership.json` ne donne aucune permission runtime. Il ne crée pas de
handler, grant, secret, scope mémoire, caller d’agent, provider, lock ou
manifest. Il permet de vérifier que la responsabilité et les reviews attendues
sont présentes avant d’avancer vers un profil sensible.

## Vérifier la cohérence

Syntaxe :

```sh title="Terminal"
touba prepare --mode check
```

Cette commande échoue si :

- le manifest attendu manque ;
- un binding de tool manque ;
- un handler attendu manque ;
- un grant, secret ou accès mémoire attendu n’est pas accordé ;
- le run plan attendu manque, dérive ou contient un champ sensible ;
- une review gate attendue manque pour le profil demandé ;
- l’artefact d’ownership tente d’introduire une autorité runtime ;
- le chemin du fichier source ne correspond pas au nom de module.

## Exécuter ensuite

`prepare` ne lance pas le runtime.

Pour exécuter un programme avec tool, le manifest reste explicite :

```sh title="Terminal"
touba run program.air.json \
  --manifest touba.manifest.json
```

Si un run plan a été préparé :

```sh title="Terminal"
touba run --run-plan touba.run-plan.json \
  --inputs-json '{"request":{"query":"transport"}}'
```

Le runtime refuse avant exécution si le plan pointe vers un AIR absent, une
entrée inconnue, un manifest ou profil secrets requis absent, ou un lock supply chain
strict incohérent.

Pour un run de profil `prod`, le projet force aussi le lock supply chain déclaré dans
`touba.project.json` :

```sh title="Terminal"
touba run program.air.json \
  --profile prod \
  --manifest touba.manifest.json
```

Pour un programme sans tool, aucun manifest n’est nécessaire :

```sh title="Terminal"
touba run program.air.json
```

## Portée et suites

- Imports purs (IM-1) : `type`, `define` non sensible et `function` pure.
- Imports effectifs (IM-2) : `tool`, `skill`, `strategy`, `agent` et `memory`, sans autorité implicite.
- Packages explicites (PKG-1) disponibles via `touba.project.json` ou `--package`, sans registre ni autorité implicite.
- Run plan (RP-1) disponible via `touba prepare --run-plan` et `touba run --run-plan`, sans payload sensible ni découverte automatique.
- Fragments de bindings (BF-1) disponibles via `touba prepare --binding-fragment`, composés dans le manifest assemblé sans exécution directe du fragment.
- Resource bindings (RB-1 / RB-2) validables via `touba prepare --resource-bindings` et `touba run --resource-bindings`, puis transmis aux handlers concernés sans backend officiel.
- Pas d’alias, wildcard ou re-export.
- Pas de handler inline dans `.tb`.
- Pas de découverte automatique de manifest par le runtime.
- Pas de lecture automatique de `.env`.
- Pas de grant ou secret ajouté silencieusement.

Ces limites évitent qu’un fichier importé ou préparé ajoute une autorité
d’exécution invisible. Pour les tools, l’import rend le tool disponible, tandis
que manifest, handler, grants, secrets, contraintes, lock supply chain et refus runtime
restent explicites. Pour les agents et les mémoires, les règles `callable_by` et
les scopes restent vérifiées par l’assemblage projet.

## Décisions hôte en fichier et par module

```sh
touba prepare --mode plan --host-decisions host-decisions.json
touba prepare --mode write --host-decisions host-decisions.json
touba prepare --mode check --host-decisions host-decisions.json
```

```json title="host-decisions.json"
{
  "modules": {
    "orders.review": { "grants": ["network"], "timeout_ms": 5000 }
  },
  "bindings": {
    "tool:orders.review/ReadOrder": {
      "effect_contract": { "kind": "none" }
    }
  }
}
```

Un module correspond exactement à son nom déclaré. Ses décisions portent
sur les grants, secrets et limites ; chaque tool reçoit uniquement les grants
et handles qu’il demande. Une décision de binding remplace la décision
correspondante du module, y compris avec une liste vide pour retirer un grant.
Le contrat d’effet reste explicite pour chaque binding.

Pour plusieurs parcours, conservez `entry` comme défaut et ajoutez
`entrypoints` dans `touba.project.json`. Le [serveur projet](api-serveur-projet.md)
et `touba run --project . --entry <référence>` utilisent cette même liste.

## Retirer un binding devenu inutile

Après suppression d’un tool dans les sources, demandez explicitement le retrait
de son ancien binding :

```json title="host-decisions.json"
{"remove_bindings":["tool:orders.review/OldTool"]}
```

```sh
touba prepare --mode plan --host-decisions host-decisions.json
touba prepare --mode write --host-decisions host-decisions.json
touba prepare --mode check
```

Le plan affiche `remove_binding`. Un tool encore déclaré est protégé ; un binding
fourni par fragment se retire dans ce fragment. Les fichiers handlers restent
en place pour votre revue. Les imports du rapport sont regroupés par relation
source, sans répéter une même relation lors de la préparation de plusieurs entrées.

Pour un trigger déjà retiré de la source, la décision correspondante est :

```json title="host-decisions.json"
{"remove_triggers":["trigger:orders.review/OldSchedule"]}
```

La même séquence `plan`, `write`, `check` retire sa configuration du manifeste
généré. Le plan affiche `remove_trigger`. Une déclaration encore présente dans
les sources ne peut pas être retirée ainsi ; désactivez-la avec `triggers` ou
modifiez d'abord la source. Les historiques de déclenchement et d'effets restent
conservés. La préparation n'exécute et ne rejoue aucune opération.
