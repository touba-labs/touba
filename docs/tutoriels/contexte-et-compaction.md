# Borner le contexte et comprendre la compaction

Objectif : éviter d'envoyer une requête qui dépasse le plafond de contexte
configuré, sans confondre taille de prompt, historique conservé et autorisations.

## 1. Partir d'un agent fonctionnel

Utilisez le [calculateur du tutoriel natif](./provider-natif-gouverne.md).
Son programme Touba ne change pas. Dans son provider, utilisez :

```js title="providers/calculator.provider.mjs"
import { createOpenAiDecisionProvider } from "@touba/sdk";

export const decideAgentCapability = createOpenAiDecisionProvider({
  model: "gpt-4.1-mini",
  decisionInterface: "native",
  maxOutputTokens: 1000,
  maxRetries: 0,
  context: {
    contextWindowTokens: 32768,
    safetyMarginTokens: 512,
    inputTokenMultiplier: 1.2,
    onEvent(event) { console.error(JSON.stringify(event)); },
  },
  history: {
    maxMessages: 128,
    maxBytes: 262144,
    maxRetainedBytes: 8 * 1024 * 1024,
    onEvent(event) { console.error(JSON.stringify(event)); },
  },
});
```

32768 est ici un plafond choisi pour l'application, pas la fenêtre maximale
annoncée du modèle. Vérifiez que votre modèle accepte au moins ce plafond.
Changer de modèle exige de requalifier fenêtre, réserve de sortie et paramètres.
Le comptage est activé explicitement par `context` ; aucun catalogue périssable
de modèles n'est incorporé dans le langage.

## 2. Lire les événements

Lancez le calculateur avec la commande du tutoriel natif. Le comptage officiel
précède chaque génération et reçoit le corps réellement sérialisé, avec système,
outils, schémas et historique. Les événements restent sur stderr pour conserver
le résultat JSON de la commande sur stdout.

Par exemple, pour 1000 tokens d'entrée comptés, le SDK réserve
1200 + 512 + 1000 = 2712 tokens avec ces options. Le dernier terme réserve la
réponse, y compris le raisonnement décompté dans la sortie par le fournisseur.
Le comptage peut être estimatif ; la marge protège contre un écart raisonnable,
sans garantir le comportement futur d'une API externe.

| Événement / erreur | Ce qu'il signifie |
| --- | --- |
| `provider_context_count`, `fits: true` | le plafond autorise l'envoi |
| `fits: false` | pas de génération ; tentative de réduction locale |
| `decision_history_context` | taille des messages et échanges exclus de la fenêtre |
| `ProviderContextWindowExceeded` | même le minimum conservé ne tient pas |
| `ProviderContextCountUnavailable` | comptage indisponible, aucune génération envoyée |

## 3. Provoquer un refus maîtrisé

Dans une copie du provider, mettez `contextWindowTokens: 100`. Gardez
`maxOutputTokens: 1000`. Relancez le calculateur : la réserve de sortie seule
dépasse le plafond. Vous devez obtenir un refus avant toute génération et avant
toute sélection de skill. Si le comptage est indisponible, l'erreur correspondante
prime ; il n'y a toujours pas d'envoi de génération.

Remettez ensuite le plafond initial. Ne transformez pas ce refus en résultat
métier réussi. Le diagnostic est observable dans le `provider_error_code` de
l'erreur runtime quand il est disponible.

## 4. Comprendre ce qui est réduit

Le SDK retire du contexte les échanges complets les plus anciens. Un appel
natif reste associé à sa réponse et à ses métadonnées originales. Le dernier
échange et toutes les observations courantes du runtime restent présents.
Les instructions, signatures des capacités et autorisations ne sont pas résumées.

Les originaux restent dans le store jusqu'à expiration, suppression explicite
ou refus de capacité du stockage. Si les seules observations courantes sont
déjà trop volumineuses, aucun résumé ne peut contourner cette limite : il faut
revoir le volume des résultats, les budgets ou la décomposition du travail.

## 5. Ajouter un résumé seulement si nécessaire

La compaction par défaut n'appelle aucun résumeur. Si votre application dispose
d'un service de résumé qualifié, fournissez `history.summarize`. Son contrat est
décrit dans le [guide de l'historique](../guides/historique-conversationnel.md).
Il reçoit les échanges sortants et le résumé précédent ; il retourne un texte
borné. Le SDK ajoute ce texte comme donnée non fiable avec provenance, puis
recompte la requête. Les anciens échanges restent consultables dans le stockage.

Un résumé peut perdre des détails ou contenir une instruction malveillante.
Il ne sert jamais de preuve d'autorisation ou de validation humaine. Si le
service est un LLM, ses coûts, quotas et timeouts doivent être gérés par l'hôte :
ces appels supplémentaires ne sont pas des décisions runtime.

## 6. Utiliser Anthropic ou Gemini

Le garde est indépendant de la syntaxe Touba. Avec les connecteurs AI SDK
installés dans votre application, configurez leur transport :

```js title="providers/claude.provider.mjs"
import { createAnthropic } from "@ai-sdk/anthropic";
import { createAiSdkDecisionProvider, createProviderContextFetch } from "@touba/sdk";

const transport = createProviderContextFetch({
  provider: "anthropic",
  contextWindowTokens: 32768,
});
const anthropic = createAnthropic({ fetch: transport });

export const decideAgentCapability = createAiSdkDecisionProvider({
  model: anthropic(process.env.ANTHROPIC_MODEL),
  decisionInterface: "native",
  maxOutputTokens: 1000,
  maxRetries: 0,
});
```

Pour Gemini, utilisez `createGoogleGenerativeAI` de `@ai-sdk/google` avec
`provider: "google"`, un modèle explicite et `GOOGLE_GENERATIVE_AI_API_KEY`.
Ces connecteurs et leurs clés sont à installer/configurer par l'application.
Les exemples visent les endpoints directs officiels, pas Bedrock ni Vertex.
Le garde refuse un endpoint non pris en charge, sans transmettre la requête.

Le plafond de tokens ne remplace pas un budget monétaire, les budgets Touba,
ni la validation métier. Voir aussi le [tutoriel SQLite](./historique-sqlite.md).
