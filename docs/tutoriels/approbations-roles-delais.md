# Approbations avec rôles, délais et escalade

Ce tutoriel local utilise Touba et Node.js 24, sans modèle ni service payant.
Il sépare la règle métier dans Touba de l'identité vérifiée par l'hôte.

## 1. Déclarer la règle

Dans un dossier de test vide, créez `approval.tb` :

<!-- touba-example: compile -->
```touba title="approval.tb"
module examples.approval_roles

strategy ApproveInvoice
    takes invoice as Text
    gives Text
    do
        human.approve
            with context as invoice
            with role as "finance"
            with timeout_ms as 30000
            with distinct_from as "initiator"
            into approval
            on expired
                human.approve
                    with context as invoice
                    with role as "finance_manager"
                    with timeout_ms as 30000
                    with distinct_from as "initiator"
                    into escalation
                give "Accepted by the manager"
        give "Accepted by finance"
```

Seul un membre du rôle `finance`, différent de l'initiateur, peut libérer la
première continuation. Après 30 secondes, une nouvelle approbation demande
le rôle `finance_manager`. L'échéance est conservée après redémarrage ;
l'escalade ne vaut pas approbation. Les deux branches retournent ici un texte
pour rendre le résultat observable sans effet externe.

Pour deux signatures distinctes, écrivez deux approbations successives avec
`distinct_from as "initiator_and_previous"`. Touba conserve les signataires
déjà acceptés dans le run, même entre sous-appels et branches parallèles.

## 2. Fournir l'attestation hôte

```js title="host.mjs"
import { readFileSync } from "node:fs";

export const initiatorRef = "employee:requester";

export function attestHumanApproval({ request, decision, evidenceRef }) {
  // Local teaching adapter: these files are written only by the trusted host.
  const evidence = JSON.parse(readFileSync(new URL("./host-evidence.json", import.meta.url), "utf8"));
  const directory = JSON.parse(readFileSync(new URL("./host-directory.json", import.meta.url), "utf8"));
  if (evidence.id !== evidenceRef || evidence.request_id !== request.request_id
    || evidence.run_id !== request.run_id || evidence.decision !== decision) {
    throw new Error("Evidence does not match the current request");
  }
  const roles = directory[evidence.subject_ref];
  if (!Array.isArray(roles)) throw new Error("Signer is not active");
  return { request_id: request.request_id, run_id: request.run_id, decision,
    subject_ref: evidence.subject_ref, roles };
}
```

Cet adaptateur pédagogique lit une preuve et un annuaire **privés de l'hôte**.
En production, remplacez ces lectures par votre service d'identité et votre
stockage de décisions authentifiées. Le client fournit une référence opaque,
jamais les rôles faisant autorité. Vérifiez toujours demande, run, décision,
identité authentifiée et droits actuels. Le module est du code hôte de confiance,
pas un outil accessible au modèle.

## 3. Vérifier le refus et la reprise

```js title="exercise.mjs"
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

function run(args, expectedExit) {
  const child = spawnSync("touba", ["run", "approval.air.json", "--entry",
    "strategy:examples.approval_roles/ApproveInvoice",
    "--human-approval-host", "host.mjs", "--output", "json", ...args], { encoding: "utf8" });
  assert.equal(child.status, expectedExit, child.stdout + child.stderr);
  return JSON.parse(child.stdout);
}
function save(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}
const paused = run(["--inputs-json", JSON.stringify({ invoice: "Invoice INV-42" }),
  "--human-checkpoint-out", "approval.checkpoint.json"], 3);
assert.equal(paused.reason, "human_approval_pending");
const checkpoint = JSON.parse(readFileSync("approval.checkpoint.json", "utf8"));
const request = checkpoint.approval_state.requests[checkpoint.approval_ref];
save("host-evidence.json", { id: "signed-decision:42", request_id: request.request_id,
  run_id: request.run_id, decision: "approved", subject_ref: "employee:reviewer" });
save("decisions.json", { [checkpoint.approval_ref]: {
  decision: "approved", evidence_ref: "signed-decision:42" } });
const resume = ["--human-resume-checkpoint", "approval.checkpoint.json",
  "--human-decisions", "decisions.json"];
save("host-directory.json", { "employee:reviewer": [] });
assert.equal(run(resume, 1).reason, "HumanApprovalRoleRequired");
save("host-directory.json", { "employee:reviewer": ["finance"] });
const accepted = run(resume, 0);
assert.equal(accepted.result, "Accepted by finance");
assert.ok(!JSON.stringify(accepted.trace).includes("employee:reviewer"));
console.log("APPROVAL_ROLE_AND_RESUME_OK");
```

```sh title="Terminal"
touba compile approval.tb --out approval.air.json
node exercise.mjs
```

Résultat attendu : `APPROVAL_ROLE_AND_RESUME_OK`. Le premier essai échoue faute
de rôle ; le second réussit après mise à jour de l'annuaire hôte.
Ne réutilisez pas ces preuves de test dans une application métier.

Pour observer l'escalade, créez une nouvelle attente et attendez son échéance.
Reprenez son checkpoint **sans décision** avec une sortie de nouveau checkpoint.
Le résultat est une seconde attente, liée au rôle `finance_manager`, pas le
texte de réussite du chemin initial. La CLI constate l'expiration à la reprise ;
`touba serve` possède un worker local qui la constate aussi automatiquement.

## Intégration et stockage

- CLI et serveur : `--human-approval-host host.mjs`.
- SDK JavaScript `Engine` : option `humanApprovalHost` avec le chemin du module.
- Runtime embarqué : `humanApprovalAuthority` reçoit la fonction ;
  `humanApprovalInitiator` porte l'identité opaque de l'initiateur.
- L'adaptateur reçoit `request`, `decision`, `evidenceRef` et `signal`.
  Il retourne exactement `request_id`, `run_id`, `decision`, `subject_ref`,
  `roles`. Sa durée est bornée à 5 secondes par défaut.
- Le serveur vérifie l'attestation avant de persister l'acceptation. Une décision
  acceptée à temps reste valable pour cette occurrence après redémarrage.
  Une nouvelle demande vérifie à nouveau les droits.

Les checkpoints et les preuves sont privés, hors Git et logs publics. Ils
restent des états de l'hôte de confiance, pas des signatures contre cet hôte.
Une approbation ne remplace ni grants, ni contrat d'effet, ni journal d'effets.
Un service d'identité indisponible ou une preuve incorrecte arrête la décision
avant la continuation protégée.
