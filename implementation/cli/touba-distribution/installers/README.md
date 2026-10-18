# Installateurs natifs : candidats de développement

Les installateurs consomment une toolchain vérifiée, avec compilateur, Node,
CLI et archives SDK. Aucune installation Python/npm globale et aucun SDK de
projet ne sont modifiés. L'utilisateur choisit ensuite `touba sdk install
javascript` ou `touba sdk install python` dans son projet.

| Cible | Format et installation | Qualification de ce lot |
| --- | --- | --- |
| macOS ARM64 | DMG, assistant AppKit, compte courant dans `~/.touba` | compilation et backend réel testés localement ; parcours graphique/signature à qualifier |
| macOS Intel | même assistant, build native requise | non exécutée sur cet hôte |
| Windows x64 | EXE Inno Setup, sans droits admin, compte courant | source préparée, compilation et parcours natif non exécutés |
| Linux x64 | DEB, gestionnaire système, `/opt/touba/toolchain` | source préparée, build/installation native non exécutées |

Le DEB cible Ubuntu 24.04+ ou une distribution compatible avec glibc >= 2.39,
pas toute distribution Linux. L'ouverture graphique dépend du gestionnaire
de logiciels installé. Aucun support RPM ou Linux ARM n'est annoncé ici.

## Construire et vérifier

Depuis `implementation`, après installation des dépendances verrouillées et
du builder Python décrit dans `runtime/touba-python-sdk/build-requirements.txt` :

```sh
node cli/touba-distribution/src/package-release.mjs --release-root /chemin/candidat --json
node cli/touba-distribution/src/check-desktop-install.mjs /chemin/candidat/touba-v0.1.0-darwin-arm64
node cli/touba-distribution/src/package-installers.mjs --release-dir /chemin/candidat/touba-v0.1.0-darwin-arm64 --out /chemin/installateur-neuf
```

Le contrôle installe dans un répertoire temporaire, vérifie la réinstallation,
les SDK hors ligne et un vrai handler Python généré puis exécuté par le Core.
Il ne remplace pas l'installation personnelle. `INSTALLER.json` conserve le
hash de l'artefact et l'identité exacte du payload, avec état de validation
en attente et candidat non signé.

## Recette native avant publication

Vérifier installation vierge, mise à jour, refus de payload altéré, annulation,
droits insuffisants, utilisateur non administrateur, chemins espaces/non-ASCII,
PATH depuis un nouveau terminal et désinstallation. macOS conserve les builds
précédentes, avec ajout PATH zsh explicite par case à cocher. Windows ajoute
optionnellement le PATH utilisateur ; la désinstallation laisse cette entrée
PATH à retirer manuellement. Les projets et leurs SDK restent en place.
Le DEB est géré et retiré par le gestionnaire système. Arrêter les services
avant mise à jour ; aucune reprise automatique de checkpoint.

Les certificats éditeur, signature Windows, signature et notarisation macOS
restent à fournir/qualifier avant distribution publique. Ne désactiver ni
Gatekeeper ni SmartScreen. La construction d'un fichier n'est pas une preuve
de qualification de son interface ou d'acceptation par l'OS.

Références des outils : [installation Inno sans élévation](https://jrsoftware.org/ishelp/topic_setup_privilegesrequired.htm),
[construction Debian](https://manpages.debian.org/bookworm/dpkg/dpkg-deb.1.en.html),
[certificats Apple Developer ID](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/).
