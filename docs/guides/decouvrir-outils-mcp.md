# Découvrir un catalogue MCP

La découverte lit un catalogue réel avec `initialize` puis `tools/list`. Elle
ne demande aucun `tools/call`. Le transport disponible est `stdio`, avec la
version de protocole `2025-06-18`, identique au bridge MCP existant.

L'exploitant choisit le programme avant toute découverte. Son démarrage exécute
du code sur l'hôte : ce mécanisme n'est pas une sandbox. Utilisez un serveur
connu et des accès limités. Aucun programme issu d'un projet cloné ne démarre
automatiquement.

```json title="mcp-targets.json, configuration privée de l'exploitant"
{
  "schema_version": "touba-mcp-discovery-v1",
  "targets": [{
    "id": "catalogue",
    "label": "Catalogue local",
    "secret_handles": [],
    "max_pages": 8,
    "max_tools": 128,
    "config": {
      "mcp_bridge_config_version": "touba-mcp-bridge-config-v1",
      "server": {
        "transport": "stdio",
        "command": "/chemin/absolu/node",
        "args": ["/chemin/absolu/serveur-mcp.mjs"],
        "cwd": "/chemin/absolu/travail",
        "timeout_ms": 5000,
        "max_payload_bytes": 1048576,
        "env": {}
      }
    }
  }]
}
```

```sh title="Terminal"
touba mcp discover mcp-targets.json catalogue --confirm-process
```

Le rapport JSON contient `document.tools`, la cible, la date et l'empreinte du
catalogue. Cette empreinte identifie le contenu reçu, pas la confiance à accorder
au serveur. Les descriptions restent des données non fiables.

Le délai global est borné à 120 000 ms et le volume de réponse à 1 Mio. La
pagination accepte de 1 à 32 pages, avec au plus 256 outils. Les boucles de
curseur, sorties excessives, délais dépassés et duplications sont refusés.
L'environnement parent n'est pas transmis. Une variable nécessaire peut utiliser
`{"from_secret_handle":"NOM_DU_SECRET"}` et doit être accordée explicitement dans
`secret_handles`. Aucun secret en clair ne doit figurer dans ce fichier.

Le serveur de projet peut charger ces cibles avec
`--mcp-discovery-config /chemin/absolu/mcp-targets.json` ou le champ
`mcp_discovery_config` de son profil. La liste exige `governance.propose` ; la
découverte exige `governance.apply`, une confirmation explicite et un projet au
repos. Une clé applicative d'exécution n'autorise pas ces routes. Les clients
ne peuvent transmettre ni commande, ni URL, ni environnement arbitraire.

Après découverte, sélectionnez les outils, relisez leurs types et droits, puis
appliquez l'import. La connexion du handler reste une configuration distincte,
à préparer avant l'exécution. L'import d'un catalogue JSON existant reste
possible sans démarrer de serveur. Les URL HTTP distantes ne sont pas prises en
charge par cette découverte.
