---
sidebar_position: 16
---

# Responsabilités multi-équipe et review gates

La plateforme possède un package local et son tool ; les opérations client
possèdent la mémoire ; la sécurité revoit le profil de production. Ces déclarations
d’équipes sont illustratives, dans un projet isolé : ni signatures authentifiées
ni approbations d’une véritable organisation. Le handler lit un vrai fichier
client local ; il ne simule pas une API CRM.

Prérequis : Touba, Node.js 24 et npm. Terminal macOS/Linux.

```sh title="Terminal"
mkdir -p team-review-demo
cd team-review-demo
mkdir -p packages/customer/src/org/example src/examples handlers/org/example/customer vendor
npm init -y
node --input-type=module -e 'import {execFileSync} from "node:child_process"; import {copyFileSync} from "node:fs"; const v=JSON.parse(execFileSync("touba",["version","--json"],{encoding:"utf8"})); copyFileSync(v.distribution.sdk_archive,"vendor/touba-sdk.tgz");'
npm install --offline --ignore-scripts --save-exact ./vendor/touba-sdk.tgz
```
## Package et module importeur

<!-- touba-example: compile -->
```touba title="packages/customer/src/org/example/customer.tb"
module org.example.customer

memory CustomerNotes

type CustomerRequest
    customer_id is Text

type CustomerProfile
    customer_id is Text
    segment is Text
    status is Text

tool FetchCustomerProfile
    uses memory CustomerNotes read
    takes request as CustomerRequest
    gives CustomerProfile
    requires filesystem_read, secret_read, memory_read
    secrets CRM_API_TOKEN
```
```json title="packages/customer/touba.package.json"
{
  "package_schema_version": "touba-package-v1",
  "name": "org.example.customer",
  "version": "0.1.0",
  "root": ".",
  "touba": {
    "air_profile": "touba-air-json-canonical-v1",
    "runtime_compatibility": ">=1.0 <2.0"
  },
  "exports": {
    "types": [
      "type:org.example.customer/CustomerRequest",
      "type:org.example.customer/CustomerProfile"
    ],
    "defines": [],
    "functions": [],
    "tools": [
      "tool:org.example.customer/FetchCustomerProfile"
    ],
    "skills": [],
    "strategies": [],
    "agents": [],
    "memories": [
      "memory:org.example.customer/CustomerNotes"
    ]
  },
  "provenance": {
    "kind": "local_path",
    "source": "."
  }
}
```
Les tests d'intégration de ce package local sont exécutés par `exercise.mjs`
dans la dernière section, avec les contrôles positifs et les refus attendus.

<!-- touba-example: compile -->
```touba title="src/examples/customer_review_app.tb"
module examples.customer_review_app

import type CustomerRequest from org.example.customer
import type CustomerProfile from org.example.customer
import memory CustomerNotes from org.example.customer
import tool FetchCustomerProfile from org.example.customer

skill BuildCustomerReview
    takes request as CustomerRequest
    gives CustomerProfile
    uses FetchCustomerProfile
    memory CustomerNotes read
    do
        FetchCustomerProfile
            with request as request
            into profile
        give profile

strategy RunCustomerReview
    takes request as CustomerRequest
    gives CustomerProfile
    uses BuildCustomerReview
    do
        BuildCustomerReview
            with request as request
            into profile
        show
            with message as "Customer profile ready"
        give profile
```
## Ressources, ownership et autorité runtime explicites

```json title="customer-notes.json"
[
  {
    "customer_id": "CUST-001",
    "segment": "enterprise",
    "status": "review_ready"
  }
]
```
```json title="touba.resources.json"
{
  "resource_bindings_schema_version": "touba-resource-bindings-v1",
  "resources": {
    "memory:org.example.customer/CustomerNotes": {
      "kind": "memory_backend",
      "provider": "host.local.customer_notes",
      "config": {
        "path": "customer-notes.json"
      },
      "grants": [
        "memory.read"
      ],
      "secrets": [],
      "limits": {
        "max_payload_bytes": 65536
      }
    }
  }
}
```
```json title="touba.ownership.json"
{
  "ownership_schema_version": "touba-ownership-v1",
  "teams": {
    "team:platform": {
      "display_name": "Platform"
    },
    "team:security": {
      "display_name": "Security"
    },
    "team:customer_ops": {
      "display_name": "Customer Operations"
    }
  },
  "owners": {
    "package:org.example.customer": [
      "team:platform"
    ],
    "tool:org.example.customer/FetchCustomerProfile": [
      "team:platform"
    ],
    "memory:org.example.customer/CustomerNotes": [
      "team:customer_ops"
    ],
    "resource_bindings:touba.resources": [
      "team:platform"
    ],
    "run_plan:touba.run-plan": [
      "team:platform"
    ],
    "lock:touba.lock.json": [
      "team:security"
    ]
  },
  "review_gates": {
    "prod": {
      "requires_review_for": [
        "package_export",
        "tool_binding",
        "required_capability",
        "required_secret",
        "resource_binding",
        "run_plan",
        "supply_chain_lock"
      ],
      "reviewers": [
        "team:security"
      ]
    }
  },
  "reviews": [
    {
      "review_id": "review:customer/security-package",
      "profile": "prod",
      "target_ref": "package:org.example.customer",
      "reviewer": "team:security",
      "decision": "approved"
    },
    {
      "review_id": "review:customer/security-tool",
      "profile": "prod",
      "target_ref": "tool:org.example.customer/FetchCustomerProfile",
      "reviewer": "team:security",
      "decision": "approved"
    },
    {
      "review_id": "review:customer/security-resources",
      "profile": "prod",
      "target_ref": "resource_bindings:touba.resources",
      "reviewer": "team:security",
      "decision": "approved"
    },
    {
      "review_id": "review:customer/security-run-plan",
      "profile": "prod",
      "target_ref": "run_plan:touba.run-plan",
      "reviewer": "team:security",
      "decision": "approved"
    },
    {
      "review_id": "review:customer/security-lock",
      "profile": "prod",
      "target_ref": "lock:touba.lock.json",
      "reviewer": "team:security",
      "decision": "approved"
    }
  ]
}
```
```json title="touba.manifest.json"
{
  "manifest_version": "touba-manifest-v1",
  "bindings": {
    "tool:org.example.customer/FetchCustomerProfile": {
      "handler": {
        "kind": "process",
        "command": "node",
        "cwd": ".",
        "args": [
          "handlers/org/example/customer/fetch_customer_profile.handler.mjs"
        ]
      },
      "grants": [
        "filesystem_read",
        "secret_read",
        "memory_read"
      ],
      "secrets": [
        "CRM_API_TOKEN"
      ],
      "memories": [
        {
          "ref": "memory:org.example.customer/CustomerNotes",
          "access": "read"
        }
      ],
      "timeout_ms": 5000,
      "max_payload_bytes": 1048576,
      "effect_contract": {
        "kind": "none"
      }
    }
  }
}
```
```js title="handlers/org/example/customer/fetch_customer_profile.handler.mjs"
import { readFile } from "node:fs/promises";
import { defineTool, ToubaHandlerError } from "@touba/sdk";
await defineTool({ toolRef: "tool:org.example.customer/FetchCustomerProfile",
  requiredGrants: ["filesystem_read", "secret_read", "memory_read"], requiredSecretHandles: ["CRM_API_TOKEN"],
  inputSignature: [{ name: "request", type_ref: "type:org.example.customer/CustomerRequest" }],
  outputType: "type:org.example.customer/CustomerProfile",
  run: async ({ request, context }) => {
    const memory = context.resourceBindings.find(item => item.resource_ref === "memory:org.example.customer/CustomerNotes");
    if (!memory || memory.provider !== "host.local.customer_notes" || !context.env.CRM_API_TOKEN)
      throw new ToubaHandlerError("CustomerStoreUnavailable", "The authorized customer store is not configured.");
    const profiles = JSON.parse(await readFile(memory.config.path, "utf8"));
    const profile = profiles.find(item => item.customer_id === request.customer_id);
    if (!profile) throw new ToubaHandlerError("CustomerNotFound", "No profile matches the requested customer.");
    return profile;
  },
});
```
```js title="configure.mjs"
import { readFileSync, writeFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync("touba.manifest.json", "utf8"));
manifest.bindings["tool:org.example.customer/FetchCustomerProfile"].handler.command = process.execPath;
writeFileSync("touba.manifest.json", JSON.stringify(manifest, null, 2));
```
```js title="prepare.mjs"
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
export function prepare({ mode = "check", ownership = "touba.ownership.json", resources = "touba.resources.json", expected = 0 } = {}) {
  const child = spawnSync("touba", ["prepare", "--source", "src/examples/customer_review_app.tb",
    "--package", "packages/customer/touba.package.json", "--manifest", "touba.manifest.json",
    "--resource-bindings", resources, "--require-resource-bindings", "--run-plan", "touba.run-plan.json",
    "--entry", "strategy:examples.customer_review_app/RunCustomerReview", "--ownership", ownership,
    "--require-ownership", "--profile", "prod", "--handler-command", process.execPath, "--mode", mode, "--json"], { encoding: "utf8" });
  assert.equal(child.status, expected, child.stderr || child.stdout);
  return JSON.parse(child.stdout);
}
if (process.argv.includes("--write")) console.log(JSON.stringify(prepare({ mode: "write" }), null, 2));
```
```sh title="Terminal"
node configure.mjs
node prepare.mjs --write
```
La préparation résout les imports, préserve le handler complété et les grants,
puis écrit l’AIR du profil et le run plan. L’ownership n’accorde jamais de permissions
runtime. Le credential synthétique du script teste seulement l’injection d’un
secret ; aucun compte ni service externe n’est utilisé.

## Exercer les parcours positifs et négatifs

Le lock généré reste en attente jusqu’à ce qu’une revue automatisée explicitement
identifiée consigne les contrôles d’admission. Sa version en attente est conservée.
Cette revue scriptée n’est pas une approbation humaine de sécurité. Une véritable
équipe doit fournir ses propres preuves selon sa politique de publication.

Chaque exécution utilise des noms uniques pour les locks, preuves et états de trigger dans le dossier du projet. Elle n’écrase aucune revue précédente. Conservez le préfixe affiché pour inspecter cet essai.

```js title="exercise.mjs"
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { TOUBA_SDK_METADATA } from "@touba/sdk";
import { prepare } from "./prepare.mjs";
const read = path => JSON.parse(readFileSync(path, "utf8"));
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));
const attempt = `exercise-${randomUUID()}`;
const artifact = name => `${attempt}.${name}`;
const pendingPath = artifact("pending.lock.json");
const checkedPath = artifact("checked.lock.json");
console.log("Exercise artifacts:", attempt);
const ownership = read("touba.ownership.json");
for (const [name, mutate, code] of [
  ["missing-review", value => { value.reviews = []; }, "ReviewGateMissing"],
  ["missing-owner", value => { delete value.owners["run_plan:touba.run-plan"]; }, "OwnershipMissing"],
  ["unknown-reviewer", value => { value.reviews[0].reviewer = "team:unknown"; }, "ReviewReviewerUnknown"],
  ["rejected-review", value => { value.reviews[0].decision = "rejected"; }, "ReviewRejected"],
  ["authority", value => { value.grants = ["network"]; }, "OwnershipAuthorityFieldForbidden"],
]) {
  const variant = structuredClone(ownership); mutate(variant); const path = name + ".ownership.json"; write(path, variant);
  const report = prepare({ ownership: path, expected: 1 });
  assert.ok(report.diagnostics.some(item => item.code === code), JSON.stringify(report));
}
const deniedResources = read("touba.resources.json");
deniedResources.resources["memory:org.example.customer/CustomerNotes"].grants = [];
write("denied.resources.json", deniedResources);
assert.ok(prepare({ resources: "denied.resources.json", expected: 1 }).diagnostics.some(item => item.code === "ResourceBindingGrantMissing"));
function cli(args, expected = 0) {
  const child = spawnSync("touba", args, { encoding: "utf8", env: { ...process.env, CRM_API_TOKEN: "isolated-customer-credential" } });
  assert.equal(child.status, expected, child.stderr || child.stdout);
  assert.ok(!(child.stdout + child.stderr).includes("isolated-customer-credential"));
  return JSON.parse(child.stdout);
}
cli(["supply-chain", "generate", "--air", ".touba/build/prod/air/examples/customer_review_app.air.json",
  "--manifest", "touba.manifest.json", "--out", pendingPath, "--file", "customer-notes.json",
  "--file", "vendor/touba-sdk.tgz", "--sdk-metadata-json", JSON.stringify(TOUBA_SDK_METADATA)]);
const pending = read(pendingPath);
assert.equal(pending.review.status, "pending");
const run = (expected, lockPath = checkedPath) => cli(["run", "--run-plan", "touba.run-plan.json", "--supply-chain-lock", lockPath, "--resource-bindings", "touba.resources.json",
  "--require-resource-bindings", "--inputs-json", JSON.stringify({ request: { customer_id: "CUST-001" } }), "--output", "json"], expected);
assert.equal(run(1, pendingPath).status, "failure");
write(artifact("automated-review.json"), { scope: "tutorial ownership and resource admission checks", status: "passed", human_security_review: false });
const checked = structuredClone(pending);
checked.review = { status: "approved", reviewed_at: new Date().toISOString(),
  reviewers: [{ kind: "tool", id: "tutorial:team-check", role: "isolated-contract-validation" }],
  evidence: [{ kind: "validation_report", path: artifact("automated-review.json"), digest: { kind: "sha256",
    value: createHash("sha256").update(readFileSync(artifact("automated-review.json"))).digest("hex") } }] };
write(checkedPath, checked);
const result = run(0);
assert.deepEqual(result.result, read("customer-notes.json")[0]);
for (const kind of ["tool_binding_authorized", "memory_access_authorized", "run_completed"])
  assert.ok(result.trace.events.some(event => event.kind === kind));
const incomplete = structuredClone(checked); incomplete.handlers = [];
const incompletePath = artifact("incomplete.lock.json");
write(incompletePath, incomplete);
assert.equal(run(1, incompletePath).status, "failure");
const handler = "handlers/org/example/customer/fetch_customer_profile.handler.mjs";
const original = readFileSync(handler);
try {
  writeFileSync(handler, Buffer.concat([original, Buffer.from("\n// isolated drift check\n")]));
  const refused = run(1);
  assert.ok(!refused.trace.events.some(event => event.kind === "tool_binding_authorized"));
} finally { writeFileSync(handler, original); }
write(artifact("run.result.json"), result);
console.log("TEAM_REVIEWS_RESOURCES_LOCK_AND_REAL_FILE_READ_OK");
```
```sh title="Terminal"
node exercise.mjs
# Rejouer : les locks et preuves précédents sont conservés.
node exercise.mjs
touba inspect .touba/build/prod/air/examples/customer_review_app.air.json
```
Marqueur attendu : TEAM_REVIEWS_RESOURCES_LOCK_AND_REAL_FILE_READ_OK. Consultez
`exercise-<id>.run.result.json` pour le résultat et la trace. Reviews, owners, reviewers, grants
de ressource et entrées de lock manquants, revue rejetée, autorité placée dans
l’ownership et dérive du handler sont refusés. Les imports rendent des déclarations
disponibles sans autoriser leurs effets. Cet exemple ne fournit ni SSO ni sandbox OS.
