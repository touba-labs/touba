# Conserver l'historique avec SQLite

Objectif : conserver les échanges d'un agent après l'arrêt du processus et
inspecter leur taille sans afficher les messages privés. SQLite est fourni par
Node.js 24 : aucune installation système ni paquet SQLite supplémentaire.
**Il n'est pas activé automatiquement** ; sans configuration, Touba utilise la RAM.

## 1. Préparer le projet

Suivez les prérequis et l'installation du SDK dans le
[tutoriel des appels natifs](https://toubalang.org/docs/tutoriels/provider-natif-gouverne), puis créez son programme
`native-calculator.tb` et compilez-le. Conservez les contrats et les commandes de
ce tutoriel ; seul le provider change ici. La même configuration fonctionne avec
`decisionInterface: "structured"`.

Ajoutez `.private-state/` au `.gitignore` du projet. Ce répertoire contient des
données privées, pas des ressources à publier.

## 2. Configurer le provider persistant

Remplacez le module provider par :

```js title="providers/calculator.provider.mjs"
import { mkdirSync, appendFileSync } from "node:fs";
import { createOpenAiDecisionProvider } from "@touba/sdk";
import { createSqliteDecisionHistoryStore } from "@touba/sdk/history/sqlite";

mkdirSync(".private-state", { recursive: true, mode: 0o700 });
const store = createSqliteDecisionHistoryStore({
  filename: ".private-state/conversations.sqlite",
  maxBytes: 32 * 1024 * 1024,
  ttlMs: 24 * 60 * 60 * 1000,
});

export const decideAgentCapability = createOpenAiDecisionProvider({
  model: "gpt-4.1-mini",
  decisionInterface: "native",
  maxOutputTokens: 1000,
  history: {
    store,
    namespace: "calculator-local",
    maxMessages: 128,
    maxBytes: 262144,
    maxRetainedBytes: 8 * 1024 * 1024,
    onEvent(event) {
      appendFileSync(".private-state/history-events.jsonl",
        JSON.stringify(event) + "\n", { mode: 0o600 });
    },
  },
});
```

Vérifiez les permissions d'un répertoire déjà existant : `mkdirSync` ne les
corrige pas. Les événements contiennent des compteurs et une clé de session
hachée, jamais les messages. Le fichier d'événements appartient à l'application :
prévoyez sa rotation si ce code est utilisé durablement.

## 3. Exécuter puis inspecter après fermeture du processus

Exécutez la commande `touba run` du tutoriel natif avec votre clé dans
l'environnement. Cela appelle réellement le fournisseur et peut être facturé.
Les deux appels à `Double` doivent rester deux opérations distinctes.

Créez ce lecteur, puis exécutez `node inspect-history.mjs` dans le même répertoire :

```js title="inspect-history.mjs"
import { readFileSync } from "node:fs";
import { createSqliteDecisionHistoryStore } from "@touba/sdk/history/sqlite";

const events = readFileSync(".private-state/history-events.jsonl", "utf8")
  .trim().split("\n").map(line => JSON.parse(line));
const sessionKey = events.at(-1).sessionKey;
const store = createSqliteDecisionHistoryStore({
  filename: ".private-state/conversations.sqlite",
});
try {
  const record = store.read(sessionKey);
  if (!record) throw new Error("History expired or absent.");
  console.log({
    retainedExchanges: record.turns.length,
    omittedFromContext: record.contextStart,
    pendingCall: record.pending !== null,
    closed: record.closed,
  });
} finally {
  store.close();
}
```

Ce second processus lit un instantané conservé, sans accès réseau. Un calcul
achevé doit avoir `closed: true`, sans appel en attente. `read` ne renouvelle pas
le TTL. Le contenu détaillé est privé ; évitez de l'imprimer dans vos logs.

## 4. Comprendre la reprise

Relancer la strategy crée un nouveau run et une nouvelle invocation. Il est
normal que son historique soit distinct : **la base ne rejoue pas un ancien run**.
Une vraie reprise d'approbation utilise le checkpoint, le même store, le même
namespace et le même modèle/interface ; le runtime conserve l'identité.
Voir le [guide des attentes et reprises humaines](https://toubalang.org/docs/guides/expiration-annulation-validations-humaines).

Après un arrêt brutal, `DecisionHistoryBusy` peut signaler une réservation
persistante. Vérifiez l'arrêt de l'ancien worker et réconciliez les effets avant
`store.recover(sessionKey, { workerStopped: true })`. Cette opération ne constitue
ni une approbation humaine ni une autorisation de répéter un effet.

## 5. Vérifier les limites

- La fenêtre envoyée et les échanges retenus ont des limites distinctes.
- Une compaction augmente `contextStart`, sans réduire `turns.length`.
- Le TTL et `store.delete(sessionKey)` peuvent supprimer une conversation inactive.
- Un stockage plein refuse ; il ne supprime pas automatiquement un ancien échange.
- Les identités et namespaces proviennent de l'hôte, jamais du modèle.

Pour les tokens, poursuivez avec le
[tutoriel contexte et compaction](./contexte-et-compaction.md).
