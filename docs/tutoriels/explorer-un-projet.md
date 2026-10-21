# Comprendre un projet avec l’explorateur

Ce tutoriel suit une revue d’incident : une stratégie demande une approbation
humaine, puis appelle un agent autorisé à lire l’incident. L’exploration compile
le code ; aucun accès à un modèle ou à un service métier n’est nécessaire.

## 1. Préparer le programme

Créez un projet avec `touba init`, puis enregistrez ce programme dans
`src/exploration.tb` :

<!-- touba-example: compile -->
```touba
module exploration

tool ReadIncident
    description "Read the incident and return a diagnosis."
    takes request as Text
    gives Text

agent Specialist
    takes request as Text
    gives Text
    responsibility "Diagnose the incident using the authorized reading tool."
    uses ReadIncident
    callable_by strategy Review

strategy Review
    takes request as Text
    gives Text
    uses Specialist
    do
        human.approve
            with context as request
            with role as "incident_manager"
            with timeout_ms as 60000
            into approval
        Specialist
            with request as request
            into diagnosis
        give diagnosis
```

## 2. Lire l’architecture

Depuis le projet, lancez :

```sh
touba explore
```

Sélectionnez le module **exploration**, puis **Explorer le contenu**.
La stratégie **Review**, l’agent **Specialist** et l’outil **ReadIncident**
apparaissent dans la liste. Sélectionnez l’agent pour lire sa responsabilité
et sa signature `request: Text → Text`.

Dans VS Code, la commande **Touba: Explore Project** ouvre les mêmes vues.

## 3. Suivre le parcours

Ouvrez **Parcours**. Suivez l’entrée de **Review**, l’approbation humaine,
l’appel de **Specialist**, puis le retour. Sélectionnez l’approbation :
le panneau présente le rôle `incident_manager` et le délai de 60 secondes.

**Ouvrir la source** permet de vérifier ces déclarations dans le programme.

## 4. Examiner les droits

Dans **Gouvernance**, recherchez les relations suivantes :

| Origine | Relation | Cible |
| --- | --- | --- |
| Review | peut utiliser | Specialist |
| Review | peut appeler l’agent | Specialist |
| Specialist | peut utiliser | ReadIncident |

La première relation vient du `uses` de la stratégie ; la deuxième vient du
`callable_by` de l’agent. Elles répondent à deux contrôles complémentaires.

## 5. Vérifier l’actualisation

Modifiez la responsabilité de l’agent puis sauvegardez : son panneau est
actualisé. Introduisez temporairement une erreur de syntaxe et sauvegardez :
les diagnostics apparaissent et le dernier graphe valide reste identifié.
Corrigez le fichier pour retrouver l’état **À jour**.

Terminez avec l’export **SVG** ou **PNG**, puis fermez le service avec **Ctrl+C**.
Pour explorer un traitement parallèle, poursuivez avec le
[tutoriel parallèle](./traitement-parallele.md).
