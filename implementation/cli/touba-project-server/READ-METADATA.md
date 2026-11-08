# Métadonnées de consultation du serveur de projet

Avec l'identité Cloud, les rôles sans `projects.manage` voient une référence
`project:<audience>` dans les champs de racine des surfaces de consultation.
Cloud utilise le même identifiant d'enregistrement dans son inventaire. Le type
de ces champs reste `string` ; les clients ne doivent pas supposer un chemin
local exploitable. Sans identité Cloud, le bearer explicite conserve la lecture
historique ; propriétaires et éditeurs gardent la racine de gestion.

La projection est faite à la sortie HTTP et SSE, sur une liste explicite de
métadonnées. L'état interne, les empreintes, les artefacts, les valeurs métier
et les traces canoniques gardent leurs octets. L'introspection compare toujours
la racine réelle avant admission. Ce filtre ne garantit pas que le code métier
ou un handler n'écrit jamais un chemin dans une trace.

Les tests couvrent les lectures simples et composites, les événements rejoués
et vivants, l'absence de mutation des preuves et le refus d'une autre racine.
