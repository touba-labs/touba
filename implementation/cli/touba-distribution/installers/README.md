# Construire les installateurs Touba

Les installateurs consomment une toolchain vérifiée, avec compilateur, Node,
CLI et archives SDK. Aucune installation Python/npm globale et aucun SDK de
projet ne sont modifiés. L'utilisateur choisit ensuite `touba sdk install
javascript` ou `touba sdk install python` dans son projet.

| Cible | Format et installation |
| --- | --- |
| macOS ARM64 | DMG, assistant AppKit, compte courant dans `~/.touba` |
| macOS Intel | Même assistant, compilé nativement pour Intel |
| Windows x64 | EXE Inno Setup, compte courant, sans droits administrateur |
| Linux x64 | DEB, gestionnaire système, `/opt/touba/toolchain` |

Chaque fichier doit être qualifié sur sa plateforme avant publication.

Le DEB cible Ubuntu 24.04+ ou une distribution compatible avec glibc >= 2.39,
pas toute distribution Linux. L'ouverture graphique dépend du gestionnaire
de logiciels installé. Aucun support RPM ou Linux ARM n'est annoncé ici.

## Construire et vérifier

Depuis `implementation`, après installation des dépendances verrouillées et
du builder Python décrit dans `runtime/touba-python-sdk/build-requirements.txt` :

```sh
node cli/touba-distribution/src/package-release.mjs --release-root /chemin/candidat --json
release_dir=/chemin/indique-par-release_dir
node cli/touba-distribution/src/check-desktop-install.mjs "$release_dir"
node cli/touba-distribution/src/package-installers.mjs --release-dir "$release_dir" --out /chemin/installateur-neuf
```

Le contrôle installe dans un répertoire temporaire, vérifie la réinstallation,
les SDK hors ligne et un vrai handler Python généré puis exécuté par le Core.
Il ne remplace pas l'installation personnelle. `INSTALLER.json` conserve le
hash et taille de l'artefact et l'identité exacte du payload, avec état de
validation en attente et état réel de signature. La sortie doit être un dossier
neuf ou vide : le manifeste d'un ancien candidat, même partiel, n'est jamais
écrasé. Le DMG est vérifié par `hdiutil verify` avant émission du manifeste.
Le smoke lit la version du payload et exerce aussi le launcher `.cmd` Windows ;
il n'exige pas le numéro de développement historique pour une future release.

## Recette native avant publication

Vérifier installation vierge, mise à jour, refus de payload altéré, annulation,
droits insuffisants, utilisateur non administrateur, chemins espaces/non-ASCII,
PATH depuis un nouveau terminal et désinstallation. macOS conserve les builds
précédentes, avec ajout PATH zsh explicite par case à cocher. Windows ajoute
optionnellement le PATH utilisateur ; la désinstallation laisse cette entrée
PATH à retirer manuellement. Les projets et leurs SDK restent en place.
Le DEB est géré et retiré par le gestionnaire système. Arrêter les services
avant mise à jour ; aucune reprise automatique de checkpoint.

La signature Developer ID et la notarisation macOS précèdent la distribution
publique. La signature éditeur Windows est prévue ultérieurement ; l'EXE reste
non signé et Windows peut afficher un avertissement. Ne désactiver ni
Gatekeeper ni SmartScreen. La construction d'un fichier n'est pas une preuve
de qualification de son interface ou d'acceptation par l'OS.

## Préparation des signatures

Pour l'assistant macOS distribué hors App Store, vérifier un certificat
**Developer ID Application** avec sa clé privée dans le trousseau du signataire.
Un certificat de distribution App Store ne remplace pas un Developer ID.
Le titulaire peut le créer dans Certificates, Identifiers & Profiles ; conserver
la clé privée localement ou dans le dispositif de signature approuvé, jamais
dans Git ou un message. Developer ID Installer concerne un PKG, pas cet
assistant AppKit en DMG.

La signature modifie les octets des exécutables : signer et vérifier le payload
avant de figer son identité et ses checksums, puis empaqueter/signer l'assistant.
Ne pas signer une copie après calcul de son identité tout en conservant l'ancien
manifeste. Le builder réalise cette séquence sur une copie neuve, conserve
`source_build` et enregistre la nouvelle identité `build` dans `INSTALLER.json`.
L'archive d'entrée reste inchangée. Les fichiers Mach-O du payload sont signés
individuellement avant le bundle, sans signature récursive aveugle.

```sh
security find-identity -v -p codesigning
node cli/touba-distribution/src/package-installers.mjs \
  --release-dir /chemin/candidat/touba-v1.0.0-darwin-arm64 \
  --out /chemin/candidat-signe \
  --macos-sign-identity EMPREINTE_SHA1_DEVELOPER_ID_APPLICATION
```

Le Node embarqué conserve les droits JIT et de chargement de modules natifs,
sans l'autorisation de débogage `get-task-allow` de son profil amont. Le
compilateur et l'assistant n'ont pas ces exceptions. Toutes les signatures
Developer ID utilisent le hardened runtime et un horodatage Apple.
Sans identité explicite, le bundle reçoit un sceau adhoc pour les essais locaux,
jamais présenté comme une signature éditeur.

Enregistrer une fois l'authentification de notarisation dans le trousseau :

```sh
xcrun notarytool store-credentials VOTRE_PROFIL_NOTARISATION --team-id VOTRE_TEAM_ID
```

Renseigner l'identifiant Apple et un mot de passe spécifique à l'app dans les
invites du terminal, jamais dans les commandes suivies, Git ou un message.
Puis, dans un autre dossier neuf :

```sh
node cli/touba-distribution/src/notarize-installer.mjs \
  --installer-dir /chemin/candidat-signe \
  --out /chemin/candidat-notarise \
  --keychain-profile VOTRE_PROFIL_NOTARISATION
```

Cette commande soumet une copie du DMG à Apple, exige `Accepted`, agrafe et
vérifie les tickets de l'application et du DMG, puis exige l'acceptation de
Gatekeeper. Les checksums finaux sont calculés **après** l'agrafage.
`NOTARIZATION.json` conserve le reçu ; aucun succès n'est déclaré pour une
soumission refusée ou encore en cours. L'authentification et la clé privée
restent dans le trousseau. La recette Finder après téléchargement et la
qualification fonctionnelle du payload signé restent des contrôles distincts.

Pour Windows, aucun abonnement de signature n'est requis pour construire l'EXE.
Lorsqu'une identité sera retenue, qualifier Authenticode, l'horodatage et
l'installation sous compte standard.
La signature ne promet pas la disparition immédiate de tout avertissement de
réputation. Aucun achat ni contournement des protections n'est automatique.

Références des outils : [installation Inno sans élévation](https://jrsoftware.org/ishelp/topic_setup_privilegesrequired.htm),
[construction Debian](https://manpages.debian.org/bookworm/dpkg/dpkg-deb.1.en.html),
[certificats Apple Developer ID](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/).
