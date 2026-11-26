# Dépannage

Ce guide part des symptômes courants. Pour les codes détaillés, lire la référence diagnostics.

## `zsh: command not found: code`

La commande terminal de VS Code n’est pas dans le `PATH`. Sur macOS,
[activez-la depuis la palette de commandes](https://toubalang.org/docs/guides/ide-vscode#code-cli-macos),
puis ouvrez un nouveau terminal. `code` et la CLI `touba` sont deux commandes
distinctes ; réinstaller Touba ne configure pas `code`.

Pour installer l’extension sans terminal, recherchez `@id:touba.touba-tools`
dans la vue **Extensions** de VS Code, puis cliquez sur **Installer**.

## `zsh: command not found: touba`

Cause probable :

- l’extension VS Code Touba est installée, mais la CLI Touba n’est pas disponible dans le `PATH` du terminal.

À retenir :

- le VSIX installe l’extension **Touba Language Toolkit** ;
- il ne crée pas automatiquement les commandes terminal `touba`, `touba run`, `touba compile`, `touba inspect`, `touba manifest` ou `touba handler stub` ;
- installer la CLI depuis [Installation](https://toubalang.org/docs/demarrer/installation), puis ouvrir un nouveau terminal ;
- pour un fichier `.tb` simple, utiliser la commande VS Code `Touba: Run Current File` ;
- pour `touba init`, `touba prepare` ou les commandes runtime, utiliser un environnement où la CLI Touba est explicitement disponible.

## `AirUnreadable` ou `AirInvalid`

`AirUnreadable` signifie que le fichier compilé n’a pas pu être lu.
Le message CLI précise s’il manque, si l’accès est refusé ou si le chemin
désigne un dossier. Vérifiez le chemin depuis votre dossier courant et les
permissions de lecture. Dans le SDK, les chemins sont relatifs à
`projectRoot` (JavaScript) ou `project_root` (Python).

`AirInvalid` signifie que le fichier a été lu mais que son contenu ne respecte
pas le format AIR attendu. Recompilez la source enregistrée avec la version
de Touba utilisée pour l’exécution.

Pour un fichier autonome, attendez la réussite de la compilation :

```sh
touba compile hello.tb --out hello.air.json
touba run hello.air.json
```

Pour un projet, lancez `touba prepare --mode write`, puis
`touba prepare --mode check` depuis sa racine. Une étape en erreur doit être
résolue avant l’exécution. Ces refus AIR surviennent avant tout appel de handler.
Dans votre application, affichez `error.message` et le code stable ; gardez les
détails de diagnostic pour un canal privé.

## Mes modifications ne sont pas visibles

Enregistrez le fichier, vérifiez le dossier de votre terminal et attendez la
fin de chaque commande. `touba run hello.air.json` lit le fichier AIR choisi ;
une modification du `.tb` demande une nouvelle compilation ou préparation.
Les appels SDK doivent être attendus avec `await` en JavaScript ou dans l’API
Python asynchrone. Explorer actualise les sources enregistrées ; si la nouvelle
source ne compile pas, la dernière vue valide reste signalée comme ancienne.
Aucun délai ajouté entre deux commandes ne remplace leur réussite.

## Le runtime refuse un tool avant handler

Causes probables :

- manifest absent ;
- binding absent ;
- grant manquant ;
- secret non résolu ;
- payload invalide.

Actions :

```sh title="Terminal"
touba inspect program.air.json --manifest touba.manifest.json
touba run program.air.json --manifest touba.manifest.json --inputs-json '{"request":{}}'
```

Lire `failure_detected` dans la trace ou l’erreur CLI.

## `touba prepare --mode check` échoue

Causes probables :

- module source hors convention ;
- manifest manquant alors qu’un `tool` existe ;
- binding absent ;
- stub handler absent ;
- grant, secret ou accès mémoire attendu absent ;
- binding resté dans le manifest alors que le tool n’existe plus.

Actions :

```sh title="Terminal"
touba prepare --mode plan
touba prepare --mode write
touba prepare --mode check
```

Relire les diagnostics avant d’ajouter un grant ou un secret. `prepare` ne doit pas élargir les droits silencieusement.

`PreparedAirDrift` signale un AIR absent ou différent de la préparation attendue.
Après une écriture inchangée, `check` ne réclame plus de réécriture de cet AIR.
`HandlerDeclaredContractDrift` signale un contrat de stub devenu obsolète
(grants, secrets, arguments ou retour). Mettez le handler à jour explicitement :
`write` préserve votre code. Le test de contrat généré vérifie l'admission et
les refus structurels ; ajoutez un test positif de votre logique métier.

## Le handler ne reçoit pas un secret

Vérifier :

- le tool déclare `secrets HANDLE` ;
- le binding contient `"secrets": ["HANDLE"]` ;
- le binding contient le grant attendu ;
- le fichier secrets est fourni à l’exécution ;
- la variable d’environnement existe ;
- si un agent est actif, le scope agent autorise ce handle.

## `ask` reste en pause

Touba ne lit pas `stdin`.

Fournir l’entrée explicitement :

```sh title="Terminal"
touba run program.air.json --user-inputs user-inputs.json
```

Pour un essai manuel, utiliser le mode hôte interactif :

```sh title="Terminal"
touba run program.air.json --interactive-user-inputs
```

La référence d’interaction est visible dans la trace de pause.

## Un test live échoue

Un live dépend du réseau, du service externe, des quotas et parfois d’une clé API.

Commencez par un dry-run quand il existe, puis passez au live seulement pour valider l’intégration réelle.

## Les traces semblent manquer une valeur

C’est parfois attendu.

Les traces ne doivent pas contenir :

- valeurs de secrets ;
- réponses exactes de `ask` dans `user_interaction_answered` ;
- payloads sensibles refusés.

Elles doivent contenir les références, handles, modes et raisons de refus nécessaires à l’audit.

## Packages et registre

| Diagnostic | Vérification et action |
| --- | --- |
| `RegistryUnavailable` ou `RegistryTimeout` | Vérifiez l'adresse configurée, le réseau et l'état du service, puis réessayez. `package audit --offline` consulte seulement un cache signé déjà obtenu, avec sa date et ses limites. |
| `RegistryFetchFailed` | Le message indique le statut HTTP. Les lectures 429/502/503/504 peuvent être réessayées dans une fenêtre bornée ; un refus d'authentification exige votre intervention. |
| `RegistryTrustTargetMismatch` | Le fichier de clés vise un autre registre. Choisissez les clés revues du registre sélectionné, sans supprimer l'état de continuité. |
| `RegistryPackageNotFound` ou `RegistryPackageVersionMissing` | Consultez `package search <texte>` puis `package info <nom>` ; reprenez le nom et une version exacte. |
| `PackageExactVersionRequired` | Utilisez `package add organisation.package@1.2.3`. Une étiquette `latest` ou une plage ne choisit pas une version automatiquement. |
| `PackageInstalledContentMissing` | Le nom du package manquant est indiqué. Utilisez `package restore <nom>` avec son registre de confiance ; les octets doivent correspondre au verrou. |
| `PackageIntegrityMismatch` | Conservez les fichiers suspects et le verrou pour examen. La restauration automatique n'écrase pas un dossier présent. Vérifiez la source avant toute intervention manuelle. |
| `PackageInstallationIncomplete` | Une autre opération utilise le projet ou a été interrompue. Attendez sa fin ou examinez son marqueur et ses fichiers de travail avant récupération. |
| `PackageInUse` | Retirez ou mettez à jour d'abord le package dépendant indiqué. Les points d'entrée du projet restent à réviser explicitement. |
| `PackageReviewChanged` ou `PackageProjectChanged` | Relancez l'aperçu et utilisez l'empreinte de revue exacte affichée. Une empreinte différente ou une modification concurrente exige une nouvelle revue. |

Le [guide de partage](creer-partager-package.md#registry-choisi-explicitement)
décrit la configuration versionnable, les clés publiques, les caches locaux,
la recherche et la restauration. Les credentials ne doivent pas être ajoutés
au dépôt avec ces fichiers.
