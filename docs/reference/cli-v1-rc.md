# Référence CLI

## Explorateur de projet

```sh
touba explore [projet] [--port <nombre>] [--no-open]
```

Ouvre les vues Architecture, Parcours et Gouvernance dans le navigateur local.
Le projet courant est utilisé par défaut ; `--port` fixe le port et
`--no-open` affiche l’adresse sans ouvrir le navigateur. Les sauvegardes
actualisent le graphe. **Ctrl+C** ferme le service.
Voir le [guide de l’explorateur](../guides/explorateur-projet.md).

## Sorties et diagnostics

`--output json` écrit l’enveloppe complète avant de terminer, y compris via un tube ou une redirection. Le SDK consomme cette enveloppe ; une sortie JSON invalide reste une erreur, jamais un succès reconstitué depuis la trace. Les codes de sortie distinguent succès (0), échec (1), attente (3), arrêt ou rejet (4) et annulation (5).

Les erreurs d’entrée indiquent les champs déclarés manquants et le type attendu. Les champs inconnus sont comptés sans exposer leur nom, qui pourrait contenir une donnée sensible. Les refus de binding donnent une indication adaptée au motif ; un manifest présent n’est pas présenté comme manquant. `touba serve` affiche son adresse dès le démarrage, sauf avec `--quiet`.

Les commandes de cette page supposent que la commande `touba` est disponible dans le terminal.

L’extension VS Code Touba aide à travailler dans l’éditeur, mais elle ne remplace pas la CLI pour les commandes terminal.

## Arrêt des commandes et services

Sur POSIX, lorsqu'elle délègue une commande comme `run`, `serve` ou
`trigger serve`, la CLI transmet `SIGTERM`, `SIGINT` et `SIGHUP` à son
processus enfant direct, puis attend sa fin. Pour les deux services,
un `SIGTERM` envoyé au PID du lanceur arrête ainsi le serveur et libère son
port. Ctrl+C reste utilisable au terminal. Le code de sortie de l'enfant est
conservé ; s'il termine par un signal, le lanceur termine par le même signal.

Un signal système n'est pas une annulation gouvernée : il ne garantit ni
trace finale complète, ni checkpoint, ni annulation d'un effet déjà réalisé.
Utilisez les contrôles d'exécution pour une interruption gouvernée. `SIGKILL`
ne peut pas être relayé ; un superviseur qui force l'arrêt doit gérer tout
le groupe ou l'arbre de processus. L'arrêt forcé Windows n'est pas un signal
POSIX interceptable par la CLI.

## Admission des entrées et des ressources

Les clés de `--inputs-json` doivent correspondre exactement aux paramètres
`takes` de l'entrée choisie. Les paramètres manquants, supplémentaires,
mal typés et les records contenant des champs inconnus sont refusés avant
le premier appel. Les réponses `ask`, décisions humaines et décisions
d'agents doivent viser des références du programme courant. Une réponse
anticipée à une interaction déclarée reste permise.

Dans un fichier de resource bindings, `required_resources` liste les
ressources externes que l'hôte exige pour ce run, par exemple :

```json
"required_resources": ["memory:app/Records"]
```

Le champ appartient à la racine du document, à côté de `resources`.
Un binding requis absent, inactif ou visant une ressource inconnue est refusé
avant tout handler. Une mémoire logique seule n'implique pas un backend.
`--require-resource-bindings` impose, lui, tous les besoins de l'inventaire.
Le provider est un identifiant de l'adaptateur hôte, pas un catalogue fermé de
bases de données. Un `event_source` décrit le raccordement d'un trigger ;
l'adaptateur doit encore recevoir, authentifier et normaliser les événements.
Ce document n'active pas le trigger à la place du manifest hôte.

## Vue d’ensemble

| Commande | Rôle |
| --- | --- |
| `touba init` | Initialise un dossier projet Touba |
| `touba sdk` | Installe le SDK JavaScript ou Python du projet, ou indique son archive vérifiée |
| `touba new module` | Crée un fichier source `.tb` selon la convention projet |
| `touba package` | Créer, vérifier, archiver, installer et retirer des packages |
| `touba prepare` | Prépare ou vérifie les artefacts dérivés du projet |
| `touba secret` | Gère le store de secrets de développement |
| `touba compile` | Compile une source `.tb` vers AIR JSON |
| `touba run` | Exécute un AIR JSON |
| `touba trigger run` | Exécute un trigger `schedule` en runner foreground borné |
| `touba trigger serve` | Lance un service webhook pour triggers `request` |
| `touba serve` | Lance le serveur projet authentifié pour les clients de contrats |
| `touba deploy` | Planifie, publie, active ou restaure une révision immuable |
| `touba inspect` | Inspecte une source, un AIR, une trace ou un manifest |
| `touba audit` | Valide une trace et peut produire un export d’audit |
| `touba supply-chain generate` | Calcule un lock depuis les fichiers réels ; revue pending, sans écrasement |
| `touba supply-chain validate` | Valide un lock supply chain pour AIR, manifest, handlers, SDK, paquet handler, provenance et revue déclarées |
| `touba registry resolve` | Résout une entrée de registry statique vers un lock local sans installer ni exécuter de package |
| `touba registry check` | Vérifie le catalogue, ses métadonnées et les fichiers disponibles ; compare un instantané précédent si fourni |
| `touba manifest generate` | Génère un manifest de binding à partir d’un AIR |
| `touba handler stub` | Génère un squelette de handler pour les tools |
| `touba version` | Affiche la version Touba et la build ; détails avec `--json` |
| `touba update` | Vérifie et installe une mise à jour de la toolchain |

## `touba sdk`

```sh
touba sdk install javascript
touba sdk install python
touba sdk install python --python python3.12
touba sdk install python --manager uv
touba sdk install python --manager pip
touba sdk path javascript
touba sdk path python
touba sdk sandbox javascript --handler handlers/read.mjs
touba sdk sandbox python --handler packages/example.reader/handlers/read.py
```

`install` travaille dans le dossier courant, ou celui de `--root <projet>`.
Les archives sont vérifiées et copiées dans `vendor/touba-sdk`.
JavaScript utilise npm hors ligne sans scripts ; Python crée/réutilise
`.venv` sans installation globale. Un lockfile pnpm/Yarn/Bun est respecté :
utilisez `path` et ce gestionnaire, sans créer un second lockfile.
`path` est en lecture seule et imprime le chemin absolu vérifié.
La distribution installée doit inclure les archives SDK ; un checkout source
non packagé n'en fabrique pas implicitement.
Détails : [choisir le SDK](https://toubalang.org/docs/demarrer/installation#choisir-le-sdk-de-son-application).

`sandbox` produit les sections `handler` et `sandbox` pour le fichier choisi,
sans les écrire dans la configuration. Il vérifie le SDK et sélectionne ses
fichiers de code ; pour Python, il interroge explicitement l'interpréteur de
confiance du projet, hooks de démarrage désactivés. Relisez l'inventaire avant
de l'appliquer au fragment. Les grants et chemins de données restent à choisir.
Exemple complet : [confinement d'un package Python](https://toubalang.org/docs/guides/profil-execution-durci#python--package-et-fragment-explicite).

## `touba init`

```sh title="Terminal"
touba init
```

Initialise le dossier courant comme projet Touba.

La commande crée les supports locaux nécessaires sans valeur secrète :

```text title="Structure"
.touba/
.touba/build/
.touba/state/secrets.local.json
.touba/evidence/
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
  "artifact_layout": "touba-artifacts-v1",
  "run_profiles": {
    "pure": {
      "require_supply_chain_lock": false
    },
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

Choisissez le langage de vos handlers à la création du projet :

```sh title="Terminal"
touba init --language javascript
# ou, dans un autre projet :
touba init --language python
```

Installez ensuite le SDK correspondant avec `touba sdk install javascript`
ou `touba sdk install python`. Le choix Python génère des handlers `.py`,
leurs tests et un binding utilisant l'interpréteur local de `.venv`.

Aujourd’hui, la CLI refuse les langages hôtes qui ne sont pas encore
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

<!-- touba-example: compile -->
```touba title="source.tb"
module examples.search
```

Options utiles :

```sh title="Terminal"
touba new module examples.search --force
touba new module examples.search --root mon-projet
```

`--force` remplace le fichier s’il existe déjà.

## `touba package`

`new [nom] [--org <organisation>] [--context] [--yes]` crée le projet auteur
dans un dossier portant son nom court ; sans arguments, un questionnaire confirme
l'identité `organisation.nom` avant création.
`check [dossier] [--publishing]` vérifie sources, fichiers et prérequis sans
exécuter le code auteur.
`test [dossier] [--env NOM]` lance uniquement les tests Node déclarés.
`version [patch|minor|major|version]` met à jour la version canonique, sans Git.
`pack [dossier] [--output <archive.tar.gz>]` crée par défaut
`dist/<nom>-<version>.tar.gz`, sans écrasement.
`add <nom|dossier|archive.tar.gz>` vérifie, installe et verrouille le contenu.
`add org.nom@1.0.0 --registry <dossier|URL-HTTPS>` sélectionne une archive indexée.
`list` vérifie et liste les dépendances ; `remove <nom>` retire une dépendance
non requise par une autre. Sans cible dans une application, `check` vérifie
les dépendances ; dans un projet auteur, il vérifie le package lui-même.

`checkout <identifiant> --registry <URL> [--root <parent>]` récupère un brouillon
privé dans un nouveau dossier auteur.
`submit [dossier] [--registry <URL>] [--draft <identifiant>]` vérifie et soumet
l’archive vers un brouillon privé. Le registre peut venir du lien local créé
par checkout ou une soumission précédente. Ces deux opérations acceptent
`--no-browser` ; elles authentifient le terminal sans publication implicite.

`submit [dossier] --ci <autorisation> --registry <URL>` prépare un nouveau
brouillon depuis un job GitHub Actions autorisé. OIDC temporaire, permission
`id-token: write`, dépôt GitHub, workflow, branche et environnement exacts ; publication
finale dans l’interface par un membre habilité. Options `--draft` et
`--no-browser` incompatibles avec ce mode.

Toutes acceptent `--json` et `--root`. La racine est découverte depuis les
sous-dossiers. `packages/` est réservé aux copies installées. Installation,
check et pack n'exécutent aucun test ou hook et n'accordent aucune autorisation.
Voir le [guide](../guides/creer-partager-package.md) et la [référence](packages.md).

`touba registry check --registry <source> [--source-root <dossier>]` vérifie
index, métadonnées et éventuellement archives. `--previous <snapshot-fiable>`
vérifie aussi la continuité des identités et versions déjà publiées.

## `touba prepare`

`--host-decisions host-decisions.json` lit un fichier JSON local (64 Kio maximum,
chemin relatif à `--root`). L’alternative `--host-decisions-json '<objet>'`
accepte le même document en ligne. Choisissez une seule forme. Le document
sélectionne explicitement grants, handles,
effets et limites dans le manifest. `plan` montre le diff, `check` refuse
un diff non appliqué, `write` applique les décisions idempotemment. Voir
[le guide projet](../guides/projet-touba-prepare.md).

Les modifications de fragments suivent aussi `plan`, `write`, `check`. Touba
conserve leurs empreintes par profil dans `configuration.fragment_baselines`.
Pour réconcilier un ancien projet dont le fragment diffère déjà du manifest,
`review_fragments` associe une référence d'outil à l'empreinte exacte de revue
fournie par le plan. Voir la [procédure de migration](../guides/projet-touba-prepare.md#modifier-un-fragment-déjà-préparé).

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
.touba/build/<profil>/air/...
.touba/build/<profil>/touba.manifest.json
.touba/build/<profil>/touba.run-plan.json
.touba/build/<profil>/touba.effective-project.json
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
touba prepare --package authors/research/touba.package.json --mode write
touba prepare --binding-fragment bindings/search.json --mode write
touba prepare --resource-bindings touba.resources.json --require-resource-bindings --mode check
touba prepare --run-plan touba.run-plan.json --entry strategy:examples.search/Run --mode write
touba prepare --run-plan touba.run-plan.json --mode check
touba prepare --ownership touba.ownership.json --profile prod --mode check
touba prepare --handler-root handlers --handler-command node --mode write
```

Pour un projet `touba-artifacts-v1`, `entry` et les chemins de fragments,
resource bindings et ownership peuvent être référencés dans
`touba.project.json`. Un flag explicite reste prioritaire et visible dans le
rapport.

`prepare` ne lance pas le runtime et n’exécute pas les handlers.

La projection `touba-effective-project-v1` explique source, AIR, entry,
handlers, grants, handles de secrets, scopes, callers, budgets, sandbox, lock,
triggers et preuves avec leur provenance. Elle est dérivée et ne devient jamais
une autorité runtime.

`--package` ne fait pas de recherche par nom global et ne télécharge rien. Le
chemin pointe vers un manifeste local `touba-package-v1`.

`--binding-fragment` lit un fragment explicite `touba-binding-fragment-v1` et
le compose dans le manifest projet. Le fragment peut proposer handler, grants,
secrets, limites et contraintes de payload, mais il n’est jamais consommé
directement par `touba run`. Le manifest assemblé reste l’autorité runtime.

`--resource-bindings` valide un artefact explicite
`touba-resource-bindings-v1` contre l’AIR préparé. Les resource bindings
couvrent les familles rattachables à l’AIR actuel : `memory_backend`,
`event_source` et `decision_provider`. La CLI vérifie ressource connue, famille
supportée, grants, handles de secrets requis, scopes mémoire et absence de
payload brut. Pendant `touba run`, le runtime transmet ensuite au handler les
seuls bindings associés aux ressources utilisées par le tool appelé. La CLI ne
choisit pas de backend officiel.

`--require-resource-bindings` refuse si une ressource logique requise par l’AIR
n’a pas de binding actif.

`--run-plan` demande à `prepare` de produire ou vérifier un plan d’exécution
explicite `touba-run-plan-v1`. Le plan pointe vers l’AIR préparé, le manifest
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
`touba-ownership-v1` contre l’AIR préparé et le profil courant. La validation
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

## Layout projet canonique

Les projets déclarent `artifact_layout: "touba-artifacts-v1"`. Un seul layout
est utilisé : `.touba/build/<profil>` pour les artefacts préparés et
`.touba/state` pour les états. Les anciens layouts sont refusés sans réécrire
les fichiers utilisateur. Prepare et le lancement projet utilisent `dev`
par défaut. Une entrée unique est déduite ; sinon, renseignez `entry` dans
la configuration projet ou passez `--entry` à prepare.

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

Dans un projet, la commande retrouve la racine depuis le fichier et résout les
imports des packages installés après contrôle d'intégrité, même si le terminal
est ouvert ailleurs. Un import depuis l’application ou un autre package
doit désigner un export déclaré par le package qui le fournit.
`touba prepare` prépare en plus les manifests, bindings et plans d'exécution
de l'ensemble du projet.

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

Pour le diagnostic local, `--handler-diagnostics <fichier-neuf>` exige un
run plan `dev` sur POSIX, sans profil durci ni lock obligatoire. Voir
[le canal privé du handler](https://toubalang.org/docs/guides/tool-binding-handler-manifest).

```sh title="Terminal"
touba run program.air.json
```

Exécute un AIR JSON.

Les traces sont conservées par défaut dans `.touba/traces.sqlite` du projet.
`--trace-store <base.sqlite>` choisit un autre journal SQLite privé.
`--trace-out <trace.json>` exporte le document JSON. Voir
[la conservation des traces](traces-v1-rc.md#conserver-les-traces).

`--output json-reference` retourne le résultat avec une référence au journal.
`touba trace read --store <base.sqlite> --reference-json <json> --limit 100`
lit ensuite les événements par pages. Voir la
[lecture paginée](traces-v1-rc.md#lire-une-trace-par-pages).

`touba trace archive --store <base.sqlite>` prévisualise la rétention.
Ajoutez `--destination <nouvelle-archive.sqlite> --apply` pour archiver et
retirer les runs réussis de la source après vérification de la copie.
Pour un serveur projet, archivez plutôt l’état complet, serveur arrêté.

`--trace-pure-functions full|calls` choisit le détail des fonctions pures.
`full` est le défaut ; `calls` conserve leurs appels, résultats et échecs,
ainsi que tous les événements de gouvernance. Cette option est aussi disponible
avec `touba serve`. Voir [les niveaux de trace](traces-v1-rc.md).

Avec run plan explicite :

```sh title="Terminal"
touba run --run-plan touba.run-plan.json
```

Depuis une entrée projet explicite :

```sh title="Terminal"
touba run --project . --entry strategy:examples.search/Run --profile dev
```

La facade résout `.touba/build/dev/touba.run-plan.json`, vérifie que l’entrée
demandée correspond, puis transmet ce plan au runner bas niveau. Le runtime ne
découvre pas les artefacts par convention.

Le run plan remplace les options répétitives d’artefacts, pas les inputs métier.
Il peut pointer vers :

```json title="touba.run-plan.json"
{
  "run_plan_schema_version": "touba-run-plan-v1",
  "entry_ref": "strategy:examples.search/Run",
  "air": "air/examples/search.air.json",
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

Si `--manifest` pointe vers un fragment `touba-binding-fragment-v1` au lieu
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
PostgreSQL, HTTP, files de messages ou gestionnaires de secrets.

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
  --human-decisions-json '{"human:review/Approval":{"decision":"approved","comment":"reviewed locally"}}'
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

La reprise vérifie le checkpoint complet dans le registre de l'hôte :
`approval-checkpoints.sqlite`, à côté du magasin de traces. L'option
`--human-checkpoint-store <path.sqlite>` permet de choisir un autre emplacement
stable, identique pour la pause et la reprise. Une seule reprise peut réserver
une attente. Un fichier modifié, consommé ou sans enregistrement est refusé.

Conservez ensemble checkpoints, registre et journaux d'effets. Après une panne
pendant une reprise séquentielle, vérifiez l'issue de l'opération auprès du
service métier avant de demander une nouvelle approbation. Les anciens
checkpoints sans registre de confiance doivent être rapprochés manuellement ;
ils ne sont pas adoptés automatiquement.

| Cas | Comportement |
| --- | --- |
| `--human-decisions-json` sans checkpoint | le run démarre depuis le début avec décisions pré-fournies |
| `human_approval` dans le graph d’entrée | écriture puis reprise locale supportées |
| `request_human_review` demandé par un agent appelé depuis le graph d’entrée | écriture puis reprise locale supportées |
| pile source/agent imbriquée | continuations validées, budgets conservés et reprise sans redemander les sélections achevées |
| groupe `parallel` | attentes par occurrence de branche et suspension coordonnée ; progression persistable avec `--parallel-checkpoint-out` |

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
  --state touba.triggers.sqlite \
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

`--state <touba.triggers.sqlite>` active l’état durable de trigger
`touba-trigger-state-v1`. Le runner y conserve les `event_id` consommés, les
acceptations, les refus et la clé du jour UTC utilisée pour appliquer
`max_runs_per_day`. Un même `event_id` déjà consommé pour le même `trigger_ref`
est refusé avec `TriggerReplayRejected` avant de relancer la stratégie. Une
acceptation enregistrée un jour précédent ne bloque pas le premier événement du
jour courant. Ce fichier ne contient pas de payload brut et n’accorde aucune
autorité runtime. Le chemin fourni à `--state` doit se terminer par
`.triggers.sqlite`.

Avec le service webhook :

```sh title="Terminal"
touba trigger serve program.air.json \
  --manifest touba.manifest.json \
  --state touba.triggers.sqlite \
  --queue touba.trigger-queue.sqlite \
  --host 127.0.0.1 \
  --port 8787 \
  --trace-dir traces \
  --max-attempts 3 \
  --signature-secret-env TOUBA_TRIGGER_SIGNATURE_SECRET
```

Le service route les triggers `request` activés par le manifest. Chaque requête
acceptée est ajoutée à la queue `touba-trigger-queue-v1`, puis remise au même
runtime que `--trigger-event-json`. La queue conserve l’identité d’événement, la
méthode, le chemin, la taille et le digest SHA-256 du payload ; elle ne conserve
pas le corps brut. Si le manifest déclare `payload`, seuls les champs JSON
référencés par `payload.map` deviennent des arguments persistés pour la
stratégie. Le runtime revalide ces arguments contre la signature de la cible.
Le mapping peut être déclaré directement dans le source Touba avec
`with message as payload.message` sur un trigger `on request`; `touba manifest
generate` émet alors l’entrée `payload.map` correspondante.
`--state` et `--queue` doivent pointer vers des chemins terminant par
`.triggers.sqlite` et `.trigger-queue.sqlite`.

Avec un `x-touba-event-id` explicite, `(trigger_ref, event_id)` identifie une
réception logique. Le même digest de payload réutilise l'entrée existante et son
`queue_id`, sans nouvel enqueue. Un digest différent sous la même identité est
refusé avec `TriggerEventPayloadConflict` avant enqueue. Une redelivery pendant
que l'entrée est active répond `deduplicated: true` ; une entrée terminale déjà
consommée produit `TriggerReplayRejected`, toujours avec le même `queue_id`.
Sans cet en-tête stable, chaque requête reçoit une nouvelle identité et la
déduplication des retries de l'émetteur n'est pas possible.
Un en-tête présent mais invalide produit `TriggerEventIdInvalid` avant enqueue.
Sa valeur doit contenir de 1 à 128 lettres ASCII, chiffres, points, tirets bas,
deux-points ou tirets.

Options principales :

| Option | Rôle |
| --- | --- |
| `--trigger <trigger_ref>` | limite le service à un trigger `request` |
| `--trace-dir <dir>` | écrit une trace JSON par entrée traitée |
| `--max-events <n>` | arrête le service après `n` entrées traitées |
| `--max-attempts <n>` | borne les retries des échecs non structurels |
| `--processing-timeout-ms <n>` | signale une interruption après disparition du worker ; ne relance pas sa stratégie |
| `--effect-journal <path>` | persiste `touba-effect-journal-v1` pour les bindings `external_write` |
| `--auth-token-env <NAME>` | exige un bearer token ou `x-touba-trigger-token` |
| `--signature-secret-env <NAME>` | exige `x-touba-signature: v1=<hex>`, timestamp et identifiant signés ; voir le guide des triggers |
| `--secrets <path>` | résout les handles de secrets déclarés par les runs déclenchés |
| `--agent-decision-provider <path>` | charge explicitement un fournisseur JavaScript ou Python |
| `--human-approval-host <path>` | charge l'hôte d'attestation des décisions humaines |
| `--human-checkpoint-store <path.sqlite>` | garde privée et à usage unique des continuations |
| `--management-token-env <NAME>` | jeton distinct pour les routes privées `/_touba/approvals` |
| `--project-root <path>` | racine des modules hôtes de package explicitement activés |
| `--agent-decision-provider-timeout-ms <n>` | borne un appel du fournisseur, de 1 à 60 000 ms |
| `--human-approval-authority-timeout-ms <n>` | borne une attestation, de 1 à 60 000 ms |

Le service utilise un worker unique par processus et réveille de lui-même les
retries arrivés à `next_attempt_at`. Un couple `--queue` / `--state` ne doit pas
être partagé entre plusieurs processus. Une pause devient `awaiting_human`,
sans retry. Sa reprise vérifie la demande, l'attestation et le checkpoint
conservé. Après disparition d'un worker actif, l'entrée devient `interrupted` :
`recovery_effect_outcome: "unknown"` signale qu'un effet peut avoir eu lieu.
La stratégie n'est pas relancée automatiquement. Les transactions SQLite ne
constituent pas une transaction avec l'effet externe. Voir le
[parcours d'approbation du webhook](../guides/triggers-gouvernes.md#modèles-et-approbations-du-service-autonome).

`--effect-journal` devient obligatoire si le manifest V1 contient au moins un
binding `external_write` ; son chemin doit se terminer par
`.effect-journal.sqlite`. Le service utilise le `queue_id` comme portée stable.
Une issue `unknown` n'est répétée que pour le mode `idempotency_key` ; les modes
`reconcile` et `none` bloquent explicitement. Le package reste responsable de
transmettre réellement la clé au service externe. La CLI directe accepte aussi `--effect-journal`, le SDK accepte
`effectJournal`, et le serveur projet dispose de son journal. Chaque hôte
possède ses fichiers et sa portée ; leur partage concurrent n'est pas supporté. Les fichiers de queue, d'état et de journal sont locaux et ne doivent
pas être partagés entre plusieurs processus ou machines. Aucune garantie
`exactly-once` n'est annoncée.

Exemple source et manifest pour un webhook typé :

<!-- touba-example: compile -->
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
  "manifest_version": "touba-manifest-v1",
  "bindings": {},
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
import { isDeepStrictEqual } from "node:util";

export function decideAgentCapability(request) {
  const target = "skill:examples.research/BuildBrief";
  const input = request.inputs.request;
  const completed = request.observations?.findLast((item) =>
    item.target_ref === target
    && isDeepStrictEqual(item.arguments, { request: input })
    && typeof item.value?.summary === "string");
  if (completed) return {
    action: "answer_directly", source: "custom_provider",
    reason: "The requested dataset brief is available in the matching observation.",
    result: completed.value.summary,
  };
  if (request.mode === "finalization") return {
    action: "cannot_complete", source: "custom_provider",
    reason: "No matching brief is available within the execution budget.",
  };
  if (request.mode === "summary") {
    if (input?.query === "hello") return {
      action: "answer_directly", source: "custom_provider",
      reason: "A greeting needs no dataset operation.", result: "Hello.",
    };
    return { action: "request_capabilities", source: "custom_provider",
      reason: "The requested brief still requires execution." };
  }
  if (!request.capability_refs.includes(target)) throw new Error("Brief capability unavailable");
  return { target_ref: target, source: "custom_provider",
    reason: "The authorized skill produces the requested dataset brief.",
    arguments: { request: input } };
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

`--max-loop-iterations <entier-positif>` borne chaque boucle `for` ou `while`
(100 par défaut). La valeur effective apparaît dans l'événement `run_started`.
Une valeur nulle, négative ou non entière est refusée avant l'exécution.

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


## Sorties de `touba run`

### Contrat de sortie pour les intégrations

Utilisez `touba run program.air.json --output json` : l'enveloppe
`touba-run-result-v1` contient `status`, `reason`, `result`, `messages` et
`trace`. Les questions en attente sont dans `pending_interactions`, une liste
d'objets `{interaction_ref, prompt}`. Pour `user_input_pending`,
`pending_interaction` désigne aussi la première question. La liste peut être
présente lors d'une pause mixte avec approbation humaine ; les branches non
démarrées n'y figurent pas. Répondez par référence d'occurrence, puis reprenez
avec le checkpoint sauvegardé. Les messages métier restent séparés de la trace ; aucun checkpoint
privé n'est inclus. Ne parsez pas l'affichage humain.

| Code | Signification |
| --- | --- |
| 0 | Réussite |
| 1 | Échec d'admission ou d'exécution |
| 2 | Options CLI invalides |
| 3 | Attente d'approbation humaine ou de saisie |
| 4 | Arrêt explicite, approbation rejetée ou expirée |
| 5 | Annulation, y compris timeout ou décision humaine d'annuler |

`reason` distingue notamment `completed`, `explicit_stop`,
`human_approval_pending`, `user_input_pending`, `human_approval_rejected`,
`human_approval_expired`, `human_approval_cancelled`, `cancelled`, `timeout`
et `kill_switch`. Pour un échec runtime, il contient le code machine.
Les scripts doivent traiter le code 3 comme une attente, pas comme une réussite.

`touba inspect trace.json` présente une chronologie compacte et les limites
observées. `--json` conserve la chronologie complète. Une justification fournie
est signalée comme `reported_reason` ; aucune intention du modèle n'est inventée.


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

Le manifeste `touba-run-evidence-v1` référence le run, le digest de la trace,
le digest du résultat, le checkpoint éventuel et les références externes
déclarées avec `--evidence-ref`. Il ne copie pas le contenu métier et ne remplace
pas la trace. L'utilisateur choisit où sauvegarder l'evidence externe :
répertoire local, base de données, backend mémoire, stockage hôte ou autre
support explicite.

## `touba serve`

Le [guide API du serveur projet](../guides/api-serveur-projet.md) décrit les routes d'interaction, l'identité de décision, le contexte d'approbation, la reprise et les providers.

`--schedule-triggers` active les occurrences planifiées du projet.
`--request-triggers --webhook-signature-secret-env NOM_VARIABLE` active ses
webhooks signés sous `/_touba/events`, avec les mêmes dossiers d'approbation et
le même journal d'effets que les autres exécutions. La variable contient une
clé dédiée d'au moins 32 octets. Ce choix et son nom peuvent être conservés dans
`touba.server.json` ; la valeur secrète reste dans l'environnement de l'exploitant.
Voir [les triggers gouvernés](../guides/triggers-gouvernes.md) pour la signature,
la consultation de la file et la transition depuis un service autonome.

```sh title="Terminal"
export TOUBA_PROJECT_TOKEN='replace-with-a-strong-token'

touba serve \
  --project-root . \
  --auth-token-env TOUBA_PROJECT_TOKEN
```

Le serveur projet expose les contrats versionnés du projet, les événements
live, les décisions humaines, les propositions de changement, les exécutions
sandbox et les révisions de déploiement. Les entrypoints de test passent par le
runtime et l’autorité déclarée du projet.

Par défaut, `touba serve` charge `touba.secrets.dev.json` lorsqu’il est présent
à la racine du projet. `--secrets <fichier>` sélectionne un autre profil
explicitement. Les handles restent soumis au manifest, aux scopes des agents et
aux grants des bindings ; les clients ne reçoivent jamais les valeurs résolues.

```sh title="Terminal"
touba serve \
  --project-root . \
  --auth-token-env TOUBA_PROJECT_TOKEN \
  --secrets touba.secrets.prod.json
```

Pour relier une cible de déploiement :

```sh title="Terminal"
touba serve \
  --project-root . \
  --auth-token-env TOUBA_PROJECT_TOKEN \
  --deployment-target-url https://deploy.example.com \
  --deployment-target-token-env TOUBA_DEPLOY_TOKEN
```

Le token de déploiement reste côté serveur. Le client n’en reçoit ni la valeur ni
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

Une cible hors loopback exige `--tls-cert` et `--tls-key`. La publication
vérifie le bundle avant matérialisation ; l’activation vérifie à nouveau les
artefacts de la révision. Le serveur conserve les contrôles et les décisions de déploiement.

## `touba inspect`

```sh title="Terminal"
touba inspect program.air.json
touba inspect trace.json
touba inspect touba.manifest.json
touba inspect touba.package.json
touba inspect touba.resources.json
touba inspect touba.run-plan.json
touba inspect .touba/build/dev/touba.effective-project.json
touba inspect .touba/build/dev/touba.effective-project.json --json
touba inspect touba.ownership.json
touba trigger state touba.triggers.sqlite --trigger trigger:examples.daily_research/DailyResearchSchedule
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
Pour `touba-effective-project-v1`, le rendu texte et `--json` reposent sur le
même document déterministe. Les états `absent`, `non_applicable`, `derived`,
`declared` et `effective` sont conservés. La projection ne contient ni valeur
secrète, payload, prompt, résultat métier ou contenu mémoire.
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
  --package authors/research/touba.package.json \
  --resource-bindings touba.resources.json \
  --run-plan touba.run-plan.json \
  --ownership touba.ownership.json
```

Le fragment `touba-binding-fragment-v1` peut aussi être inspecté avec
`--binding-fragment`, mais il reste affiché comme non autoritaire pour le
runtime. Seul le manifest assemblé est une autorité d’exécution.

Avec `--source`, l'inspection compare les références des artefacts au fichier
fourni. Sous Windows, `D:\projet\main.tb` et `d:\projet\main.tb` désignent le
même lecteur. Cette comparaison conserve la casse des noms de dossiers et de
fichiers, ainsi que les références originales ; elle ne modifie pas les artefacts.

## `touba audit`

```sh title="Terminal"
touba audit --trace trace.json
```

Valide une trace Touba et produit un rapport `trace-audit-validation-v1`.

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
| `--source` | source `.tb` explicite, option répétable pour les modules importés |
| `--manifest` | manifest runtime associé, optionnel |
| `--audit-manifest` | manifest d’audit existant à vérifier |
| `--retention-class` | classe de rétention déclarative |
| `--redaction-policy` | politique de redaction attendue |
| `--export` | fichier d’export écrit seulement si le rapport est `ok` |
| `--report-out` | fichier de rapport `trace-audit-validation-v1` écrit avec le suffixe `.trace-audit-report.json` |
| `--output text\|json` | format du rapport |

`touba audit` ne signe pas les artefacts, ne crée pas d’horodatage légal et ne
déclare pas une conformité réglementaire.

## `touba supply-chain generate`

Calcule un verrou en attente de revue, sans écraser un verrou existant ni
exécuter les handlers. Les imports locaux statiques JavaScript et Python sont
inventoriés avec l'identité `package.json` ou `pyproject.toml`.

```sh
touba supply-chain generate --air program.air.json \
  --manifest touba.manifest.json --out touba.lock.json
```

Options complémentaires : `--air` répétable, `--package-root`, `--file`
répétable, `--entrypoint-arg <index|command>`, `--sdk-metadata-json`,
`--python <interpréteur-de-confiance>` (analyse Python 3.11+ isolée).
Les dépendances déclarées exigent le verrou de leur gestionnaire. Les octets
des artefacts sont contrôlés, pas la résolution ni l'environnement installé.
Voir le [guide supply chain](../guides/supply-chain-handlers.md).

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
| `--lock` | lock `touba-lock-v1`, obligatoire |
| `--air` | AIR attendu par le lock, obligatoire |
| `--manifest` | manifest attendu par le lock, requis si le lock en déclare un |
| `--report-out` | fichier de rapport `touba-supply-chain-validation-v1` écrit avec le suffixe `.supply-chain-report.json` |
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

Cette commande d'inspection sélectionne une entrée exacte d'un registry local
ou HTTPS choisi explicitement. Elle vérifie index, métadonnées, empreintes,
version, protocoles et statut. Avec `--source-root`, elle vérifie aussi les
empreintes des artefacts locaux. La référence est `pkg:<nom.qualifie>`.

```sh title="Forme de la commande"
touba registry resolve --registry ./registry --package pkg:acme.review \
  --version 0.1.0 --source-root ./registry --json
```

Votre registry doit contenir ce package. Aucun registry par défaut ni package
métier d'exemple n'est installé. `--out <fichier.json>` sert uniquement à conserver
le constat d'inspection (`touba-static-registry-lock-v1`), si vous en avez besoin.

Les statuts draft et deprecated exigent respectivement `--allow-draft` et
`--allow-deprecated` ; yanked est refusé. `registry check` peut auditer toutes les
métadonnées, y compris retirées. Aucune de ces commandes n'accorde d'autorité.

Pour installer, utilisez `touba package add` : l'archive, les contrats source,
la compatibilité et les dépendances exactes sont également vérifiés, puis un
lock d'installation est enregistré. Le constat optionnel de registry ne le
remplace pas.

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
Si deux tools donnent le même nom de fichier, la commande refuse le lot avant
de créer les squelettes. Choisissez des noms qui donnent des chemins distincts.

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

Affiche deux lignes : `touba <version>` et `build <identifiant court>`.
L'identifiant correspond aux 12 premiers caractères de l'empreinte SHA-256
du contenu assemblé de la toolchain. Deux builds de développement peuvent
ainsi être distinguées sans créer de sous-version.

`--json` conserve les versions de tous les composants, les schémas, les
capacités publiques, Node, le canal de distribution et le chemin de l'archive
SDK. `build.id` contient l'empreinte complète de l'assemblage installé. Utiliser
ce format pour les scripts et les rapports de support ; `touba doctor` vérifie
l'installation.

Depuis le checkout source non assemblé, la build indique `source-local`.
Une installation sans identité d'assemblage reconnue indique `unknown` :
réassembler et réinstaller la toolchain pour obtenir cette identité.
L'identifiant ne dépend ni du dossier d'installation ni d'une variable
d'environnement. Il identifie le contenu au moment de l'assemblage ; ce n'est
ni une signature ni une revérification des fichiers à chaque appel.

La source courante affiche les composants du langage en `1.0.0`. Les champs de schémas
restent versionnés séparément, par exemple `touba-air-v1` ou
`touba-trace-v1`.

Le champ `distribution.channel` identifie le mode d'installation :

| Canal | Sens |
| --- | --- |
| `local-development` | exécution depuis le workspace source |
| `local-archive` | archive locale installée |
| `macos-local-release` | bundle macOS local, non signé et sans canal public |

Si `touba version --json` affiche encore `0.0.0` ou `unknown`, l'installation
active est ancienne ou incomplète. Regénérer puis réinstaller la toolchain locale
ou le bundle local avant de diagnostiquer le code courant.

## `touba doctor`

```sh title="Terminal"
touba doctor
touba doctor --json
```

Vérifie l'installation active : version Node, versions des composants Touba,
présence des scripts publics et profils projet disponibles dans le dossier
courant.

`touba doctor --json` produit un rapport `touba-doctor-v1` avec un statut
`ok`, `warning` ou `error`. C'est la commande à demander en priorité quand un
utilisateur voit une différence entre la documentation, `touba run --help` et
le comportement de son binaire.

Le diagnostic ne lit pas les secrets et ne remplace pas les validations de
projet. Il permet d'abord de savoir si le bon binaire est utilisé.

## `touba update`

```sh title="Terminal"
touba update --check
touba update
touba update --rollback
```

Vérifie le dernier build signé pour votre plateforme, puis demande confirmation
avant de l’installer. `--check` consulte la disponibilité sans remplacer
l’installation. `--yes` confirme une installation non interactive ; `--rollback`
restaure explicitement le build précédent conservé, sans accès réseau.

Touba vérifie le catalogue, l’archive et la nouvelle installation. En cas d’échec
d’un contrôle après remplacement, le build précédent est rétabli. Arrêtez les
services utilisant cette installation avant la mise à jour. Les projets,
leurs données, leurs packages et leurs SDK restent inchangés.

Les anciennes installations qui affichent une politique de réinstallation
passent une première fois par l’installateur des [Téléchargements](/hub/telechargements).
Les installations système, dont
le paquet DEB, restent mises à jour par leur gestionnaire de paquets.

Retour : `0` pour une vérification ou une installation réussie, `2` pour une
annulation, un refus ou une erreur. La [page Installation](https://toubalang.org/docs/demarrer/installation)
explique la mise à jour des SDK et la reprise des traitements en attente.


## Exécutions parallèles

`touba run` accepte `--parallel-checkpoint-out <path>`,
`--parallel-resume-checkpoint <path>` et `--parallel-limits-json <object>`.
Le checkpoint est privé, écrit atomiquement avec permissions 0600 avant
dispatch, après résultat et avant jointure. Pour une validation en attente,
utiliser `--human-decisions-json` avec son `approval_ref` exact, propre à
l'occurrence ; une décision ne libère pas une autre branche.

Les plafonds hôte sont `maxBranches` (1024), `maxExternalCalls` (16),
`maxDepth` (64), `maxConcurrency` et `maxItems` (1024 chacun),
`maxJournalEntries` (100000), `maxCheckpointBytes` (16777216).
L'hôte peut resserrer les bornes source ; une reprise n'élargit pas les anciens
plafonds. Garder le journal d'effets avec le checkpoint lorsqu'un tool écrit.
Une issue externe inconnue sans preuve de journal est refusée, pas rejouée.
Ce mécanisme sauvegarde le groupe avant sa jointure, pas arbitrairement tout
le workflow après celle-ci. Voir le [tutoriel](../tutoriels/orchestration-multi-agent-sequentielle.md).

## Adaptateur d'approbation de confiance

`touba run` et `touba serve` acceptent
`--human-approval-host <host.mjs|host.py|pkg:organisation.nom/identifiant>`.
Le module exporte `attestHumanApproval` et éventuellement `initiatorRef` en
JavaScript, `attest_human_approval` et `initiator_ref` en Python.
Le [package sélectionné](packages.md) est vérifié avant son chargement.
`--human-approval-authority-timeout-ms` fixe le délai technique d'attestation
entre 1 et 60 000 ms (défaut : 5 000). Une expiration refuse la décision ;
elle ne modifie pas l'échéance métier déclarée dans le programme.
Une décision contrainte contient une référence opaque `evidence_ref`, pas
des rôles fournis par le client. Voir le [tutoriel exécutable](../tutoriels/approbations-roles-delais.md).
Une échéance source atteinte permet une reprise sans décision ; utiliser un
chemin distinct `--human-checkpoint-out` pour conserver la nouvelle attente
d'escalade.

## Génération par SDK et journaux directs

`touba manifest generate` et `touba handler stub` acceptent
`--language javascript|python`. Le manifest reprend la langue de
`touba.project.json` dans un projet. Hors projet, le défaut est JavaScript.

Pour une exécution directe avec écriture externe :

```sh
touba run program.air.json --manifest touba.manifest.json --effect-journal payment.effect-journal.sqlite
```

Le suffixe `.effect-journal.sqlite` identifie le journal local. Le SDK expose
`effectJournal` en JavaScript et `effect_journal` en Python.
Conservez-le avec le checkpoint et la base de garde des approbations lors des
reprises et sauvegardes. Un journal neuf ne remplace pas celui d'une opération
déjà commencée.

Le code de sortie `1` couvre un refus d'admission ou une erreur d'exécution ;
l'enveloppe précise le code et l'étape. Le code `4` couvre un arrêt explicite
ou un rejet humain. Lisez `status` et `reason` pour les distinguer.
