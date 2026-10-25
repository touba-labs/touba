# Supply chain des handlers

## Inclure les packages installés

Dans un projet utilisant des packages, `touba supply-chain generate` ajoute
`package_installation` au lock d'exécution. Ce champ fixe l'empreinte du lock
d'installation ; la validation contrôle ensuite les fichiers de chaque
package, y compris les modules hôtes et les fichiers inutilisés par l'entrée
courante. Toute modification demande une nouvelle vérification et une revue
du lock. Conservez le lock d'exécution à la racine du projet pour inclure
l'inventaire `touba.packages.lock.json`.


## Verrou unique pour plusieurs modules

Un manifest projet partagé peut contenir les tools de plusieurs modules.
Déclarez tous les AIR assemblés nécessaires avec des `--air` répétés :

```sh
touba supply-chain generate \
  --air .touba/build/prod/air/app/expenses.air.json \
  --air .touba/build/prod/air/app/support.air.json \
  --manifest .touba/build/prod/touba.manifest.json \
  --out touba.lock.json
```

Le premier AIR est enregistré dans `air`, les suivants dans `additional_air`.
Chaque entrée porte un chemin relatif au lock et son empreinte.
La validation depuis n'importe lequel de ces AIR vérifie **tous** les AIR
déclarés, puis les bindings contre l'union de leurs tools. Un fichier modifié,
absent, dupliqué ou hors racine est refusé. Aucun scan implicite du projet,
grant supplémentaire ou approbation automatique n'est introduit.
Un binding absent de tous les AIR reste une erreur.
Après revue réelle du lock, le même verrou peut être exigé pour chacune
des entrées du profil `prod`.

Un handler Touba est du code hôte. Il peut appeler un réseau, un SDK, une API ou
un système externe si le manifest l'autorise. Cette puissance crée un risque :
le fichier exécuté peut dériver du fichier attendu.

Le lock supply chain des handlers (SC-1) ajoute une vérification de cohérence entre :

- l'AIR compilé ;
- le manifest runtime ;
- les fichiers handlers ;
- les métadonnées SDK déclarées ;
- l’identité déclarée du paquet handler.

L’extension artefacts de dépendances (SC-2) ajoute la vérification de fichiers de paquet handler
et d’artefacts de dépendances déclarés explicitement. Elle ne scanne pas votre
projet et ne fait pas d’audit de vulnérabilités.

L’extension provenance et revue (SC-3) ajoute une provenance et une revue déclarées du lock.
Elle permet d’exiger une revue approuvée avant d’accepter un lock, mais elle ne
remplace pas une signature cryptographique ni une revue de code réelle.

## Ce que le lock vérifie

La vérification supply chain des handlers vérifie des artefacts fournis explicitement.

| Élément | Vérification |
| --- | --- |
| AIR | digest `sha256` |
| Manifest | digest `sha256` |
| Handler | digest `sha256` |
| Commande handler | `command`, `cwd`, `args` |
| SDK | nom, version, protocole handler et statut déclaratifs |
| Paquet handler | identité déclarée, racine, fichiers déclarés |
| Artefacts de dépendances | digests de fichiers déclarés |
| Provenance | préparateur déclaré, source, timestamp |
| Revue | statut de revue, reviewers, evidence déclarée |
| Drift | `ok`, `missing`, `changed`, `unknown` |

Cette vérification n'exécute pas le handler.
L’extension artefacts de dépendances (SC-2) ne résout pas les dépendances transitives.
L’extension provenance et revue (SC-3) ne signe pas les artefacts.

## Rapport de validation

La commande de validation peut écrire un rapport local en plus de la sortie
terminal :

```sh title="Terminal"
touba supply-chain validate \
  --lock touba.lock.json \
  --air program.air.json \
  --manifest touba.manifest.json \
  --report-out project.supply-chain-report.json
```

Le fichier de rapport doit se terminer par `.supply-chain-report.json`. Le CLI
refuse un autre suffixe pour éviter de confondre un lock, un manifest et un
rapport de validation.

## Générer un lock à partir des fichiers réels

Après compilation de l'AIR et revue du manifest runtime :

```sh title="Terminal"
touba supply-chain generate \
  --air program.air.json \
  --manifest touba.manifest.json \
  --out touba.lock.json
```

Le générateur calcule les empreintes des octets réels de l'AIR, du manifest,
des points d'entrée handlers, de leur identité de paquet et des locks de
dépendances. Les imports locaux statiques JavaScript et Python sont suivis
transitivement sans exécuter le code. Ajoutez les autres ressources avec
`--file <chemin-relatif-au-paquet>`, répétable. Un paquet déclarant des
dépendances exige un lock de son gestionnaire ; son contenu est empreinté,
pas résolu ni installé. Un programme pur n'a besoin ni de manifest ni de paquet.

### Handlers Python

Placez un `pyproject.toml` dans la racine du paquet (par défaut, celle du lock) :

```toml
[project]
name = "business-handlers"
version = "0.1.0"
```

L'identité doit être statique. Déclarez vos dépendances applicatives dans ce
fichier et conservez le verrou produit par votre gestionnaire : `pylock.toml`,
`uv.lock` ou `poetry.lock`. Touba inventorie les fichiers présents ; il ne
vérifie pas que le venv installé correspond à leur résolution. L'interpréteur, ses
caches bytecode et modules natifs restent sous le contrôle de l'hôte.
La wheel SDK livrée avec Touba reste dans `vendor/touba-sdk` ; vous pouvez l'ajouter avec
`--file` et fournir ses métadonnées inspectées via `--sdk-metadata-json`.

L'analyse des scripts utilise Python 3.11+ isolé, sans `site`, `PYTHONPATH`,
import de handler ni chargement de son venv. `--python <interpréteur>`
choisit cet outil de confiance, pas la commande d'un binding.
Les modules voisins, packages, imports relatifs internes et cycles sont
inventoriés. Les fichiers doivent rester dans `--package-root`, y compris
à travers les liens symboliques. Les chargements dynamiques et changements
de chemins d'import détectés sont refusés. Ce contrôle statique n'est pas
une sandbox Python. Les bindings `python -m paquet.module` sont résolus depuis
leur `cwd` explicite ; les packages locaux portent un `__init__.py`. Les loaders
personnalisés et modifications de chemins d’import restent refusés.
Voir le [tutoriel Python](../tutoriels/handlers-python.md).

La sortie conserve `review.status: pending`. La génération n'approuve aucune
revue et refuse d'écraser un lock existant. Pour une mise à jour, choisissez un
nouveau nom, examinez les changements, puis sélectionnez ce lock explicitement.
Le mode strict refuse une revue en attente. Les métadonnées SDK restent
déclaratives : après inspection de la dépendance installée, fournissez le
résultat de `toubaSdkMetadata()` avec `--sdk-metadata-json`. Sans cela,
l'identité SDK reste inconnue et le mode strict refuse. Le générateur ne charge
et n'exécute jamais le code des handlers ou des paquets.

Règles de chemins :

- `handler.cwd` est relatif au manifest ; les `args` sont relatifs à ce cwd.
- Les chemins d'artefacts du lock, `handler.path` et `package_root` sont relatifs au dossier du lock.
- `entrypoint`, `files` et `dependency_artifacts` sont relatifs à la racine du paquet.
- L'inventaire doit inclure le point d'entrée. Les fichiers et liens symboliques doivent rester confinés.

L'argument du point d'entrée est celui d'index zéro par défaut. Utilisez
`--entrypoint-arg <index>` pour un interpréteur avec options, ou `command`
pour un binaire local exécuté directement. Le validateur vérifie le chemin
déclaré dans la commande ou ses arguments, sans deviner la sémantique d'une
commande arbitraire. Commande absente, chemins contradictoires et point d'entrée
absent de l'inventaire sont refusés.

Pour relocaliser, déplacez toute la racine du lock sans modifier les chemins
relatifs ni les octets des fichiers. Un chemin d'interpréteur absolu reste
spécifique à la machine et doit exister à destination. Changer le manifest ou
la commande exige un nouveau lock et une revue, jamais une approbation automatique.

## Valider le lock

```sh title="Terminal"
touba supply-chain validate \
  --lock touba.lock.json \
  --air program.air.json \
  --manifest touba.manifest.json
```

Sortie texte attendue :

```text title="Sortie"
Touba Supply Chain touba-supply-chain-validation-v1
Status ok
Lock touba-lock-v1
AIR ok
Manifest ok
Provenance ok
Review approved evidence=ok required=no
Handlers 1
- tool:examples.search/SearchDatasets drift=ok sdk=ok package=ok package_files=ok dependencies=ok
Diagnostics ok
```

Pour récupérer un rapport JSON :

```sh title="Terminal"
touba supply-chain validate \
  --lock touba.lock.json \
  --air program.air.json \
  --manifest touba.manifest.json \
  --output json
```

Le mode strict échoue aussi sur un warning :

```sh title="Terminal"
touba supply-chain validate \
  --lock touba.lock.json \
  --air program.air.json \
  --manifest touba.manifest.json \
  --strict
```

Pour exiger une revue approuvée :

```sh title="Terminal"
touba supply-chain validate \
  --lock touba.lock.json \
  --air program.air.json \
  --manifest touba.manifest.json \
  --require-review
```

Cette commande refuse un lock sans `review`, avec `status: "pending"` ou avec
`status: "rejected"`. Elle vérifie aussi les preuves de revue déclarées par
digest si `review.evidence` est présent.

## Exécuter avec le lock

`touba run` peut utiliser le lock comme gate explicite avant le dispatch des
handlers :

```sh title="Terminal"
touba run program.air.json \
  --manifest touba.manifest.json \
  --supply-chain-lock touba.lock.json \
  --require-supply-chain-lock
```

Dans ce mode, le runtime refuse avant l’exécution si le lock est absent, si la
validation du lock produit une erreur, ou si elle produit un warning. Sans
`--require-supply-chain-lock`, un warning reste visible mais non bloquant.

Ce gate ne donne aucun grant et ne remplace pas le manifest. Il vérifie
l’alignement entre AIR, manifest, handlers, métadonnées SDK,
`handler_package`, fichiers de paquet et artefacts de dépendances déclarés
avant de lancer le code hôte.

## Profil projet `prod`

Un projet initialisé par `touba init` contient aussi un profil de run `prod`
dans `touba.project.json` :

```json title="touba.project.json"
{
  "run_profiles": {
    "prod": {
      "require_supply_chain_lock": true,
      "supply_chain_lock": "touba.lock.json"
    }
  }
}
```

Vous pouvez donc lancer :

```sh title="Terminal"
touba run program.air.json \
  --profile prod \
  --manifest touba.manifest.json
```

La façade `touba` transforme ce profil en options explicites pour le runtime.
Elle ne génère pas le lock et ne cherche pas automatiquement un manifest ou un
handler. Le profil `dev` ne force pas le lock.

## Inspecter le lock supply chain

Pour lire un lock :

```sh title="Terminal"
touba inspect --supply-chain touba.lock.json
```

Pour lire un rapport de validation :

```sh title="Terminal"
touba inspect --supply-chain supply-chain.report.json
```

`inspect` affiche les chemins, digests, commandes, statuts SDK, identité
`handler_package`, provenance, revue et diagnostics. Il n'affiche pas le
contenu du handler ni le contenu des preuves de revue.

## Statuts de drift

| Statut | Sens |
| --- | --- |
| `ok` | l'artefact observé correspond au lock |
| `missing` | l'artefact attendu n'est pas trouvé |
| `changed` | digest ou métadonnée différente |
| `unknown` | la validation ne peut pas conclure |

`unknown` n'est pas un succès caché. C'est un signal à examiner.

Même chose pour `sdk.status = missing`, `unknown` ou `unsupported` : en
validation simple, c’est un warning ; en mode strict, le run est refusé avant le
handler.

Même règle pour `handler_package_status = unknown` : la validation simple reste
lisible, mais un profil strict refuse l’exécution parce que le paquet du
handler n’est pas explicitement identifié.

Les statuts `handler_package_files_status` et
`handler_dependency_artifacts_status` peuvent valoir `unknown` si aucun fichier
n’est déclaré, `ok` si les digests correspondent, `missing` si un fichier manque,
`changed` si un digest diffère, ou `invalid` si la forme ou le chemin est
refusé.

## Relation avec le manifest

Le manifest reste l'autorité runtime pour :

- handler ;
- grants ;
- secrets ;
- mémoires ;
- limites ;
- contraintes de payload ;
- triggers.

Le lock ne donne aucun droit supplémentaire. Il vérifie seulement que les
artefacts fournis correspondent à ce qui est attendu.

Exemple de contrainte bornée :

```json
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
          }
        }
      }
    }
  }
}
```

Cette contrainte est vérifiée par le runtime avant lancement du handler. Elle ne
remplace pas le schéma AIR et ne devient pas une expression hôte.

## Limites

:::caution
La vérification supply chain des handlers ne fournit pas :

- signature cryptographique ;
- registry ;
- installation de package ;
- audit de vulnérabilités ;
- résolution du graphe de dépendances ;
- sandbox système ;
- preuve que le handler est sûr ;
- prévention d'exfiltration par un handler autorisé ;
- statut `Verified / Unverified`.
:::

Utilisez le lock supply chain comme garde-fou de cohérence, pas comme garantie de
sécurité complète.

## Un module Python partagé

Organisez les handlers en un package Python local avec des `__init__.py` :

```text
pyproject.toml
handlers/
  __init__.py
  shared.py
  invoices/
    __init__.py
    apply.py
  payments/
    __init__.py
    apply.py
```

Les deux fichiers `apply.py` peuvent importer `from handlers.shared import …`.
Dans chaque binding, utilisez l’interpréteur du projet, `cwd: "."` et, par
exemple, `args: ["-m", "handlers.invoices.apply"]`. Le générateur résout le
module depuis ce `cwd`, inventorie les `__init__.py` et suit les imports locaux.
Le verrou inclut `shared.py` ; sa modification invalide le verrou.

La racine de package doit contenir l’ensemble de ces fichiers. Utilisez
`--package-root .` lors de la génération si cette racine est celle du projet.
Cette organisation conserve une seule copie des helpers et le même comportement
avec `run` et `serve`.
