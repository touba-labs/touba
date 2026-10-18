# Vérifier la supply chain d’un handler

Relier par digest l’AIR compilé, le manifest, le vrai handler, le lockfile des
dépendances et les données locales déclarées. Détecter leurs modifications avant
dispatch, sans assimiler un digest à une preuve de sûreté du code.
Prérequis : Touba, Node.js 24 et npm.

## Créer le projet isolé

```sh title="Terminal"
mkdir -p supply-chain-demo
cd supply-chain-demo
mkdir -p handlers vendor
npm init -y
node --input-type=module -e 'import {execFileSync} from "node:child_process"; import {copyFileSync} from "node:fs"; const v=JSON.parse(execFileSync("touba",["version","--json"],{encoding:"utf8"})); copyFileSync(v.distribution.sdk_archive,"vendor/touba-sdk.tgz");'
npm install --offline --ignore-scripts --save-exact ./vendor/touba-sdk.tgz
```
<!-- touba-example: compile -->
```touba title="source.tb"
module examples.supply_chain

tool ReadCatalogue
    description "Read the local catalogue from the reviewed project file."
    gives Text
    requires filesystem_read

strategy RunCatalogue
    gives Text
    uses ReadCatalogue
    do
        ReadCatalogue
            into catalogue
        give catalogue
```
```json title="catalogue.json"
{"datasets":[{"id":"parks","title":"Public parks"}]}
```
```js title="handlers/read.mjs"
import { readFile } from "node:fs/promises";
import { defineTool } from "@touba/sdk";
await defineTool({ toolRef: "tool:examples.supply_chain/ReadCatalogue",
  inputSignature: [], outputType: "builtin:Text", requiredGrants: ["filesystem_read"],
  run: async () => (await readFile("catalogue.json", "utf8")).trim(),
});
```
```js title="configure.mjs"
import { writeFileSync } from "node:fs";
writeFileSync("touba.manifest.json", JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: {
  "tool:examples.supply_chain/ReadCatalogue": {
    handler: { kind: "process", command: process.execPath, args: ["handlers/read.mjs"], cwd: "." },
    grants: ["filesystem_read"], secrets: [], effect_contract: { kind: "none" },
    timeout_ms: 10000, max_payload_bytes: 65536,
  },
} }, null, 2));
```
## Générer, contrôler et invalider le lock

Le générateur calcule les digests réels et laisse le lock initial en attente de
revue. Le script prouve d’abord qu’exiger une revue refuse ce lock. Il exécute
ensuite le handler et consigne ses assertions dans un rapport automatisé. Un lock
distinct déclare ce contrôle limité avec un reviewer de type **tool**. Il ne
revendique ni revue humaine de sécurité, ni identité signée, ni approbation de
production. Votre politique de déploiement doit exiger les véritables revues
adaptées à votre environnement.

Chaque test de dérive restaure son fichier isolé. Le lock initial et ses digests
ne sont jamais recalculés silencieusement pour faire passer un contrôle échoué.

```js title="exercise.mjs"
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { TOUBA_SDK_METADATA } from "@touba/sdk";
function cli(args, expected = 0) {
  const child = spawnSync("touba", args, { encoding: "utf8" });
  assert.equal(child.status, expected, child.stderr || child.stdout);
  return JSON.parse(child.stdout);
}
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
const digest = path => ({ kind: "sha256", value: createHash("sha256").update(readFileSync(path)).digest("hex") });
cli(["supply-chain", "generate", "--air", "program.air.json", "--manifest", "touba.manifest.json",
  "--out", "touba.lock.json", "--file", "catalogue.json", "--file", "vendor/touba-sdk.tgz",
  "--sdk-metadata-json", JSON.stringify(TOUBA_SDK_METADATA)]);
const baseline = JSON.parse(readFileSync("touba.lock.json", "utf8"));
assert.equal(baseline.review.status, "pending");
const validate = (lock, expected, flags = []) => cli(["supply-chain", "validate", "--lock", lock,
  "--air", "program.air.json", "--manifest", "touba.manifest.json", "--output", "json", ...flags], expected);
const pending = validate("touba.lock.json", 1, ["--strict", "--require-review"]);
assert.ok(pending.diagnostics.some(item => item.code === "SupplyChainReviewNotApproved"));
const run = (lock, expected) => cli(["run", "program.air.json", "--entry", "strategy:examples.supply_chain/RunCatalogue",
  "--manifest", "touba.manifest.json", "--supply-chain-lock", lock, "--require-supply-chain-lock", "--output", "json"], expected);
const direct = cli(["run", "program.air.json", "--entry", "strategy:examples.supply_chain/RunCatalogue",
  "--manifest", "touba.manifest.json", "--output", "json"]);
assert.equal(direct.result, readFileSync("catalogue.json", "utf8").trim());
write("automated-check.json", { scope: "isolated tutorial: actual catalogue read, expected value, pending-review refusal",
  checked_at: new Date().toISOString(), result: "passed", security_review: false });
const checked = structuredClone(baseline);
checked.review = { status: "approved", reviewed_at: new Date().toISOString(),
  reviewers: [{ kind: "tool", id: "tutorial:automated-check", role: "isolated-functional-check" }],
  evidence: [{ kind: "validation_report", path: "automated-check.json", digest: digest("automated-check.json") }] };
write("automated.checked.lock.json", checked);
assert.equal(validate("automated.checked.lock.json", 0, ["--strict", "--require-review"]).status, "ok");
assert.equal(run("automated.checked.lock.json", 0).result, direct.result);
function variant(name, mutate, code) {
  const value = structuredClone(checked); mutate(value); const file = name + ".lock.json"; write(file, value);
  const report = validate(file, 1, ["--strict", "--require-review"]);
  assert.ok(report.diagnostics.some(item => item.code === code), JSON.stringify(report));
}
variant("protocol", lock => { lock.handlers[0].sdk.protocol = "unsupported-protocol"; }, "HandlerSdkUnsupported");
variant("package", lock => { delete lock.handlers[0].handler_package; }, "HandlerPackageUnknown");
variant("rejected", lock => { lock.review.status = "rejected"; }, "SupplyChainReviewRejected");
for (const [file, code] of [["handlers/read.mjs", "HandlerChanged"],
  ["package-lock.json", "HandlerDependencyArtifactChanged"], ["automated-check.json", "SupplyChainReviewEvidenceChanged"]]) {
  const original = readFileSync(file);
  try {
    writeFileSync(file, Buffer.concat([original, Buffer.from("\n ")]));
    const report = validate("automated.checked.lock.json", 1, ["--strict", "--require-review"]);
    assert.ok(report.diagnostics.some(item => item.code === code), JSON.stringify(report));
    const refused = run("automated.checked.lock.json", 1);
    assert.equal(refused.status, "failure");
    assert.ok(!refused.trace.events.some(event => event.kind === "tool_binding_authorized"));
  } finally { writeFileSync(file, original); }
}
assert.equal(JSON.parse(readFileSync("touba.lock.json", "utf8")).review.status, "pending");
console.log("LOCK_DIGEST_PROTOCOL_PACKAGE_REVIEW_AND_DRIFT_CHECKS_OK");
```
```sh title="Terminal"
node configure.mjs
touba compile source.tb --out program.air.json
node exercise.mjs
touba inspect --supply-chain touba.lock.json
```
Le script affiche `LOCK_DIGEST_PROTOCOL_PACKAGE_REVIEW_AND_DRIFT_CHECKS_OK`.
Le manifest runtime reste l’autorité ; le lock contraint l’identité des artefacts
et l’état de revue déclaré. Incluez explicitement les helpers importés avec
`--file` : ce mécanisme ne déduit ni n’audite un graphe transitif de dépendances
et ne constitue pas une sandbox système.
