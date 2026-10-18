# Tutoriel - Interaction humaine et validation

Ce parcours complet, sans réseau, distingue affichage, saisie, approbation
obligatoire et revue déclarée dans le source. Il vérifie aussi une reprise de
checkpoint. Il requiert Touba et Node.js 24, sans SDK, secret ni modèle.

## 1. Créer les deux programmes

Dans un terminal macOS/Linux, créez ce dossier puis les fichiers indiqués :

```sh title="Terminal"
mkdir -p human-validation-demo
cd human-validation-demo
```
<!-- touba-example: compile -->
```touba title="human-validation.tb"
module examples.human_validation

type ChangeRequest
    summary is Text

strategy RunHumanValidation
    takes request as ChangeRequest
    gives Text
    do
        show
            with message as "Review required"
        ask
            with prompt as "Ticket?"
            into ticket
        human.approve
            with context as request
            into approved
        give ticket
```

<!-- touba-example: compile -->
```touba title="review.tb"
module examples.human_review

type Analysis
    confidence is Float
    summary is Text

skill ReviewWhenNeeded
    takes analysis as Analysis
    gives Analysis
    do
        if analysis.confidence < 0.8
            human.review
                with context as analysis
                into decision
            give analysis
        else
            give analysis
```

`human.approve` et `human.review` bloquent tous deux tant que la décision
n'est pas approuvée. Le rejet arrête les deux chemins. La différence porte sur
l'intention et le mode de trace, pas sur la force du verrou :
`required_approval` contre `agent_review`. Ce dernier nom désigne aussi la
revue écrite dans le source ; il n'implique pas qu'un modèle l'a demandée.

## 2. Obtenir les références de l'exécution courante

Ce script lance chaque étape par la CLI publique, vérifie le code de sortie et
écrit les vrais fichiers de réponses. Il n'invente aucune référence. Les réponses
approuvées et rejetées sont des décisions de test explicites, pas des décisions
à réutiliser pour une validation métier réelle.

```js title="exercise.mjs"
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

function run(args, expectedExit) {
  const child = spawnSync("touba", ["run", ...args, "--output", "json"], { encoding: "utf8" });
  assert.equal(child.status, expectedExit, child.stderr);
  return JSON.parse(child.stdout);
}
function save(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}
const base = ["human-validation.air.json", "--entry", "strategy:examples.human_validation/RunHumanValidation",
  "--inputs-json", JSON.stringify({ request: { summary: "Publish the reviewed report" } })];
const waiting = run(base, 3);
assert.equal(waiting.reason, "user_input_pending");
assert.equal(waiting.messages[0].text, "Review required");
const interactionRef = waiting.pending_interaction.interaction_ref;
save("user-inputs.json", { [interactionRef]: "TICKET-42" });
save("ask.trace.json", waiting.trace);

const paused = run([...base, "--user-inputs", "user-inputs.json",
  "--human-checkpoint-out", "human.checkpoint.json"], 3);
assert.equal(paused.reason, "human_approval_pending");
const checkpoint = JSON.parse(readFileSync("human.checkpoint.json", "utf8"));
const approvalRef = checkpoint.approval_ref;
save("human-decisions.json", { [approvalRef]: "approved" });
save("approval.trace.json", paused.trace);

const resumed = run(["human-validation.air.json", "--entry", "strategy:examples.human_validation/RunHumanValidation",
  "--human-resume-checkpoint", "human.checkpoint.json", "--human-decisions", "human-decisions.json"], 0);
assert.equal(resumed.reason, "completed");
assert.equal(resumed.result, "TICKET-42");
save("resumed.trace.json", resumed.trace);

save("rejected-decisions.json", { [approvalRef]: "rejected" });
const refused = run([...base, "--user-inputs", "user-inputs.json", "--human-decisions", "rejected-decisions.json"], 4);
assert.equal(refused.reason, "human_approval_rejected");
assert.equal(refused.result, null);
save("rejected.trace.json", refused.trace);
assert.ok(!JSON.stringify(resumed.trace).includes("TICKET-42"));

const reviewArgs = ["review.air.json", "--entry", "skill:examples.human_review/ReviewWhenNeeded",
  "--inputs-json", JSON.stringify({ analysis: { confidence: 0.5, summary: "Check the source" } })];
const reviewPending = run(reviewArgs, 3);
const reviewRef = reviewPending.trace.events.find(event => event.kind === "human_approval_requested").payload.approval_ref;
const reviewed = run([...reviewArgs, "--human-decisions-json", JSON.stringify({ [reviewRef]: "approved" })], 0);
assert.equal(reviewed.result.summary, "Check the source");
assert.equal(run([...reviewArgs, "--human-decisions-json", JSON.stringify({ [reviewRef]: "rejected" })], 4).reason, "human_approval_rejected");
console.log(JSON.stringify({ interactionRef, approvalRef, reviewRef, result: resumed.result }));
console.log("ASK_APPROVAL_RESUME_REJECTION_AND_REVIEW_OK");
```
```sh title="Terminal"
touba compile human-validation.tb --out human-validation.air.json
touba compile review.tb --out review.air.json
node exercise.mjs
```

Résultat attendu : `ASK_APPROVAL_RESUME_REJECTION_AND_REVIEW_OK` et
`TICKET-42`. Les fichiers JSON générés contiennent les références exactes.
Elles dépendent de l'AIR courant : une instruction ajoutée avant peut les
modifier. Ne réutilisez jamais décisions ou checkpoint après une modification
du programme. Le runtime contrôle l'identité complète de l'AIR avant reprise.

## 3. Comprendre les résultats publics

| Situation | Code CLI | `reason` |
| --- | --- | --- |
| attente d'une réponse | 3 | `user_input_pending` |
| attente d'une approbation | 3 | `human_approval_pending` |
| approbation puis fin | 0 | `completed` |
| rejet humain | 4 | `human_approval_rejected` |

`--output json` sépare `result`, `messages`, `pending_interaction` et
`trace`. Messages et réponses sont des sorties métier ; la trace conserve
les événements et références, pas leur texte brut. Une pause n'est pas un succès.

Le checkpoint humain conserve entrées métier et valeurs intermédiaires en JSON
lisible. Ses permissions locales sont restrictives, mais il n'est pas chiffré.
Conservez-le dans un emplacement protégé, hors Git et journaux publics. Les
secrets résolus ne doivent pas y entrer. Le checkpoint reprend la continuation
sauvegardée sans rejouer les effets précédents. Relancer simplement
`touba run` démarre une nouvelle exécution.

## Pour continuer

Pour un effet réel après approbation, voir
[validation avant effet externe](validation-avant-effet-externe.md).
Un provider peut aussi choisir `request_human_review` ; ce choix dynamique
ne remplace pas une barrière d'approbation source. Voir
[décision agentique gouvernée](decision-agentique-gouvernee.md).
