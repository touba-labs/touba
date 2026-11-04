# Approbations avec rôles, délais et escalade

Pour protéger tous les chemins vers une opération, consultez aussi
[l’approbation déclarée sur un outil](../guides/approbation-operation-et-unicite.md),
préparée pour le prochain build.

## Délai du service d'attestation

La réponse technique de l'adaptateur est attendue pendant 5 000 ms par défaut.
Pour un service d'identité plus lent, réglez ce délai entre 1 et 60 000 ms :

```sh
touba run --project . --human-approval-host host/approval.mjs --human-approval-authority-timeout-ms 12000
touba serve --project-root . --human-approval-host host/approval.mjs --human-approval-authority-timeout-ms 12000
```

Le SDK JavaScript expose `humanApprovalAuthorityTimeoutMs`, Python
`human_approval_authority_timeout_ms`. Un dépassement refuse l'attestation ;
une réponse tardive ne libère pas l'opération.
Le délai métier accordé à l'approbateur reste celui déclaré dans le programme.


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
  Il retourne `request_id`, `run_id`, `decision`, `subject_ref` et `roles`,
  ainsi que `excluded_signers` lorsqu'une règle d'exclusion inter-runs est
  déclarée. Sa durée est bornée à 5 secondes par défaut.
- Le serveur vérifie l'attestation avant de persister l'acceptation. Une décision
  acceptée à temps reste valable pour cette occurrence après redémarrage.
  Une nouvelle demande vérifie à nouveau les droits.

Les checkpoints et les preuves sont privés, hors Git et logs publics. Ils
restent des états de l'hôte de confiance, pas des signatures contre cet hôte.
Une approbation ne remplace ni grants, ni contrat d'effet, ni journal d'effets.
Un service d'identité indisponible ou une preuve incorrecte arrête la décision
avant la continuation protégée.

## Résultat typé et branche de refus

`human.approve … into approval` produit une valeur `Approval`, dont les champs
sont vérifiés à la compilation. Utilisez `approval.decision`,
`approval.subject_ref`, `approval.attested_roles`, `approval.request_id`,
`approval.run_id`, `approval.accepted_at` et `approval.comment`.

<!-- touba-example: compile -->
```touba
module examples.approval_outcomes

strategy Review
    takes invoice as Text
    gives Text
    do
        human.approve
            with context as invoice
            with role as "finance"
            with timeout_ms as 30000
            into approval
            on rejected
                give approval.decision
            on expired
                give approval.decision
        give approval.decision
```

Les branches `on rejected` et `on expired` terminent leur parcours par
`give` ou `stop`. Elles peuvent appeler un tool de notification avec ses
grants habituels. Elles ne rejoignent pas le chemin réservé à l’approbation.

## Initiateur par run et séparation entre runs

Le module hôte peut exporter `resolveInitiator({run_id, entry_ref, inputs, signal})`
en JavaScript, ou `resolve_initiator(request)` en Python. Il vérifie la preuve
de soumission dans son stockage applicatif et renvoie un identifiant opaque.
Touba le résout une seule fois et le conserve dans le checkpoint.
Le champ client `requested_by` n’est pas une attestation.

Pour exclure les signataires d’autres dossiers, ajoutez
`with exclude_signers as "invoice_approvers"` à l’approbation.
L’hôte relit les preuves des factures du lot et complète son attestation :

```json
{
  "request_id": "request:example",
  "run_id": "run:example",
  "decision": "approved",
  "subject_ref": "employee:treasurer",
  "roles": ["finance"],
  "excluded_signers": {
    "rule": "invoice_approvers",
    "subject_refs": ["employee:reviewer"]
  }
}
```

La liste provient des preuves vérifiées par l’hôte. Touba exige la règle exacte
déclarée, refuse une preuve absente et bloque un signataire présent dans cette
liste. Cette attestation est privée ; le modèle ne la produit pas.

## Décision envoyée au serveur

`POST /decisions` accepte `evidence_ref`, référence opaque à la preuve hôte.
L’adaptateur reçoit aussi `hostDecision` dans les deux SDK,
le document de décision complet. Il doit lier le signataire attesté à
`user_ref` et `decided_by`, ainsi qu’à la demande, au run et à la décision.
Sans `evidence_ref`, la référence transmise vaut `request_id`.
La demande publique contient `policy`, pour présenter le rôle et les règles
de séparation à l’utilisateur. Voir [API du serveur](../guides/api-serveur-projet.md).

## Commenter une décision et partager le traitement du refus

Le corps de décision accepte `comment`, texte facultatif de 4 096 caractères
maximum. `approval.comment` est un `Optional of Text` : `some` porte le commentaire,
l’absence est explicite. Ce texte libre ne fournit aucun rôle ni preuve d’identité.

Pour partager la réponse de plusieurs branches `on rejected`, utilisez une
fonction pure, ou un skill avec ses propres effets déclarés :

<!-- touba-example: compile -->
```touba
module examples.shared_refusal

function RefusalMessage
    takes approval as Approval
    gives Text
    do
        if present approval.comment as message
            give message
        give "Request rejected"

strategy Review
    takes invoice as Text
    gives Text
    do
        human.approve
            with context as invoice
            into approval
            on rejected
                RefusalMessage
                    with approval as approval
                    into message
                give message
        give "Request approved"
```

La même fonction peut servir dans plusieurs branches. La décision et ses données
restent explicites à chaque appel.

## Même parcours avec le SDK Python

Réutilisez `approval.tb` ci-dessus, puis installez le SDK avec
`touba sdk install python`. L'adaptateur conserve le même contrat d'attestation
que celui en JavaScript ; seules les conventions de noms Python changent.

```python title="host.py"
import json
from pathlib import Path

initiator_ref = "employee:requester"

def attest_human_approval(payload):
    folder = Path(__file__).parent
    evidence = json.loads((folder / "host-evidence.json").read_text())
    directory = json.loads((folder / "host-directory.json").read_text())
    request = payload["request"]
    if (evidence["id"] != payload["evidenceRef"]
            or evidence["request_id"] != request["request_id"]
            or evidence["run_id"] != request["run_id"]
            or evidence["decision"] != payload["decision"]):
        raise ValueError("Evidence does not match the current request")
    roles = directory.get(evidence["subject_ref"])
    if not isinstance(roles, list):
        raise ValueError("Signer is not active")
    return {"request_id": request["request_id"], "run_id": request["run_id"],
            "decision": payload["decision"], "subject_ref": evidence["subject_ref"],
            "roles": roles}
```

```python title="exercise.py"
import json
import os
from pathlib import Path
from touba_sdk import ToubaEngine, ToubaEngineError

def save(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(value, stream)

engine = ToubaEngine(project_root=".")
options = dict(source="approval.tb",
    entry_ref="strategy:examples.approval_roles/ApproveInvoice",
    human_approval_host="host.py")
paused = engine.run(**options, inputs={"invoice": "Invoice INV-42"},
    human_checkpoint_out="approval.checkpoint.json")
assert paused.reason == "human_approval_pending"
checkpoint = json.loads(Path("approval.checkpoint.json").read_text())
request = checkpoint["approval_state"]["requests"][checkpoint["approval_ref"]]
save("host-evidence.json", {"id": "signed-decision:42",
    "request_id": request["request_id"], "run_id": request["run_id"],
    "decision": "approved", "subject_ref": "employee:reviewer"})
decisions = {checkpoint["approval_ref"]: {
    "decision": "approved", "evidence_ref": "signed-decision:42"}}
resume = dict(human_resume_checkpoint="approval.checkpoint.json",
    human_decisions=decisions)
save("host-directory.json", {"employee:reviewer": []})
try:
    engine.run(**options, **resume)
    raise AssertionError("Missing role was accepted")
except ToubaEngineError as error:
    assert error.code == "HumanApprovalRoleRequired"
save("host-directory.json", {"employee:reviewer": ["finance"]})
accepted = engine.run(**options, **resume)
assert accepted.result == "Accepted by finance"
try:
    engine.run(**options, **resume)
    raise AssertionError("Consumed approval was accepted")
except ToubaEngineError as error:
    assert error.code == "HumanApprovalCheckpointAlreadyConsumed"
print("APPROVAL_ROLE_AND_RESUME_OK")
```

Depuis le projet, lancez `.venv/bin/python exercise.py`
(`.venv\Scripts\python.exe exercise.py` sous Windows).
Cette recette vérifie rôle manquant, reprise autorisée et refus du rejeu.
Les deux fichiers de preuve sont privés et uniquement destinés à cet exemple local.
