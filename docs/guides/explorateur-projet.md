# Explorer un projet Touba

L’explorateur donne une vue graphique des ressources, des parcours et des autorisations
déclarées dans votre code. Il aide à comprendre un projet, à relire une modification
et à retrouver la source d’une relation, y compris lorsque le code a été écrit avec
un assistant.

## Ouvrir l’explorateur

Depuis le dossier du projet :

```sh
touba explore
```

Le navigateur s’ouvre sur une adresse locale. Gardez le terminal ouvert ;
**Ctrl+C** ferme le service. Dans VS Code, lancez **Touba: Explore Project**.
Le menu contextuel d’un fichier `.tb` propose **Touba: View in Graph** pour
sélectionner l’élément situé sous le curseur.

## Choisir une vue

| Vue | Ce qu’elle montre | Question utile |
| --- | --- | --- |
| Architecture | Modules, packages, déclarations, imports et appels écrits | Quelles ressources composent ce projet ? |
| Parcours | Entrées, appels, conditions, boucles, approbations, opérations parallèles et reprises | Comment ce traitement est-il organisé ? |
| Gouvernance | Responsabilités, `uses`, `callable_by`, accès mémoire, capacités et noms de secrets requis | Quels droits le programme déclare-t-il ? |

Les flèches portent leur relation. **Peut utiliser** correspond à `uses` ;
**peut appeler l’agent** correspond à `callable_by`. Un appel écrit dans le
code apparaît dans Architecture et Parcours. Les décisions prises pendant
une exécution se consultent dans ses [traces d’exécution](explorer-traces.md).

Une opération `parallel` présente sa cible et les bornes `max_concurrency`
et `max_items`. Le nombre effectif de branches dépend de la liste reçue
pendant l’exécution ; la jointure restitue les résultats dans l’ordre d’entrée.

## Se repérer

1. Ouvrez un module ou un package regroupé avec **Explorer le contenu**.
2. Recherchez un nom ou filtrez par type, module et package.
3. Sélectionnez une ressource : le panneau de droite présente sa signature,
   sa responsabilité, ses contraintes et ses relations.
4. Utilisez **Voisinage** et **Profondeur** pour suivre les liens entrants ou sortants.
5. Choisissez **Ouvrir la source** pour atteindre le code dans VS Code ou lire
   l’extrait dans le navigateur.

La liste de ressources est utilisable au clavier. Le graphe propose zoom,
déplacement, cadrage et export en SVG ou en PNG. Les interfaces française et anglaise
partagent les mêmes vues, en thème clair ou sombre.

Les détails d’un module affichent directement ses budgets : nombre maximal
d’appels, d’invocations et d’étapes, ainsi que la durée autorisée.
Le nombre de ressources apparaît sur les cartes regroupées. Les cartes
module et type individuelles conservent leur libellé simple.

## Adapter l’affichage

Le bouton **Affichage** règle la présentation du graphe. Vos choix sont conservés :

- **Étiquettes des relations** : toujours visibles, seulement autour de la sélection, ou masquées ;
- **Orientation** : verticale ou horizontale ;
- **Densité** : confortable ou compacte ;
- **Niveau de détail** : **Complet** affiche tout ; **Essentiel** replie dans
  **Détails techniques** la signature typée, les chemins de fichiers et les champs
  propres à l’AIR ou au contrat de package.

Les panneaux des ressources et des détails se masquent pour agrandir le graphe.
Raccourcis clavier : `[` pour les ressources, `]` pour les détails, `\` pour le
graphe seul, `0` pour cadrer, `+` et `-` pour zoomer, **Échap** pour désélectionner.
Un second clic sur la ressource sélectionnée, ou **Réinitialiser**, la désélectionne
et réaffiche l’ensemble du graphe.
La molette zoome autour du pointeur ; un double-clic sur le fond recadre le graphe.

## Actualisation

Les fichiers sauvegardés sont analysés automatiquement. La sélection et le
cadrage sont conservés. Une erreur de compilation affiche ses diagnostics et,
lorsqu’il existe, le dernier graphe valide avec l’indication **dernier graphe
valide affiché**. Sa source reste celle du snapshot compilé.

L’analyse utilise les fichiers `.tb` et les métadonnées des packages enregistrés.
Les outils apparaissent comme des contrats vers leurs handlers JavaScript ou
Python. L’ouverture de l’explorateur effectue une compilation en lecture seule ;
elle n’exécute aucun traitement métier.

## Accès local et taille du projet

Le service écoute uniquement sur `127.0.0.1`. L’adresse affichée contient une clé
temporaire d’accès à ce projet. Fermez le terminal pour fermer cet accès.
L’explorateur ne charge ni fichiers `.env` ni valeurs du gestionnaire de secrets.

L’analyse est bornée à 512 sources, 8 Mio au total et 1 Mio par fichier.
Au-delà de 200 nœuds dans une vue, la liste reste complète et un message invite
à affiner les filtres. Les chemins sources doivent rester dans le projet ;
les liens symboliques sont refusés. Les packages sont vérifiés avec les mêmes
règles d’intégrité que les commandes de projet.

Pour choisir un port ou ouvrir le navigateur vous-même :

```sh
touba explore . --port 4180 --no-open
```

Voir le [tutoriel guidé](../tutoriels/explorer-un-projet.md) et la
[référence CLI](../reference/cli-v1-rc.md).

## Lire les détails
| Ressource | Informations affichées |
| --- | --- |
| Module | Budgets et entrées déclarées du projet |
| Constante | Type et valeur, y compris les dates civiles |
| Type | Champs, contraintes et valeurs par défaut |
| Appel ou condition | Arguments nommés et expression lisible |
| Approbation | Contexte, rôle, délai et règle de signataire |
| Package | Version, éditeur, licence, exports, dépendances et modules hôtes |

Les structures imbriquées sont présentées par champs. Les références de source
servent au bouton **Ouvrir la source**. Les valeurs calculées au cours d’un run
restent consultables dans ses traces.
