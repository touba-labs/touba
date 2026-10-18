# Tutoriel : contexte de package et tool gouverné

Ce parcours exécute une lecture réelle d'un catalogue JSON local. Le pack apporte
la procédure, le tool exécute la lecture et le runtime vérifie l'autorité. Aucun
appel payant ni accès réseau n'est nécessaire.

## 1. Préparer le projet

Prérequis : distribution Touba installée, Node.js 24 et npm. Les commandes
ci-dessous sont pour un terminal macOS/Linux. Le SDK livré est copié dans le
projet et installé hors ligne, sans lien vers le checkout Touba.

```sh title="Terminal"
mkdir -p dataset-brief-demo
cd dataset-brief-demo
mkdir -p vendor handlers providers data
npm init -y
node --input-type=module -e 'import {execFileSync} from "node:child_process"; import {copyFileSync} from "node:fs"; const v=JSON.parse(execFileSync("touba",["version","--json"],{encoding:"utf8"})); if(!v.distribution.sdk_archive) throw new Error("Install the Touba toolchain distribution first"); copyFileSync(v.distribution.sdk_archive,"vendor/touba-sdk.tgz");'
npm install --offline --ignore-scripts --save-exact ./vendor/touba-sdk.tgz
touba init
touba package new acme.dataset --context --yes
mkdir -p dataset/scripts
```

`package new --context` crée le manifeste auteur, la procédure et le README.
Les autres fichiers sont inclus lorsqu’ils sont déclarés.

## 2. Fournir les données, le script et la procédure

Créez chaque fichier au chemin indiqué, depuis la racine du nouveau projet.

```json title="data/datasets.json"
[
  {"title":"Montréal parks","topic":"public parks"},
  {"title":"Québec parks","topic":"public parks"},
  {"title":"Bicycle routes","topic":"transport"}
]
```

```js title="dataset/scripts/normalize_dataset.mjs"
import { readFile } from "node:fs/promises";

export async function normalizeDataset(request) {
  if (!Number.isInteger(request.max_rows) || request.max_rows < 1) {
    throw new Error("max_rows must be a positive integer");
  }
  const rows = JSON.parse(await readFile(
    new URL("../../../data/datasets.json", import.meta.url), "utf8"
  ));
  const selected = rows.filter(row => row.topic === request.query).slice(0, request.max_rows);
  return {
    title: request.query,
    summary: selected.map(row => row.title).join("; ") || "No matching dataset"
  };
}
```

```js title="configure-pack.mjs"
import { readFileSync, writeFileSync } from "node:fs";
const root = "dataset";
const manifest = JSON.parse(readFileSync(root + "/touba.package.json", "utf8"));
writeFileSync(root + "/SKILL.md", [
  "# Dataset brief", "",
  "Use BuildDatasetBrief to read the local dataset catalog for the requested topic.",
  "Return the resulting title and summary. Do not invent additional datasets.",
  "Scripts are resources; only the governed tool can execute the normalization."
].join("\n") + "\n");
manifest.contexts = [{
  id: "dataset-brief", description: "Prepare an accurate brief of local datasets.",
  procedure: "SKILL.md", activation: { model_invocable: true, user_invocable: true },
  resources: [{ name: "normalizer", path: "scripts/normalize_dataset.mjs", kind: "script",
    description: "Implementation used by the governed handler", loadable_as_context: false }],
  execution_links: [{ label: "Build dataset brief", target_ref: "skill:examples.dataset/BuildDatasetBrief",
    description: "Use the declared dataset skill." }]
}];
writeFileSync(root + "/touba.package.json", JSON.stringify(manifest, null, 2) + "\n");
```

```sh title="Terminal"
node configure-pack.mjs
touba package check dataset
touba package add ./dataset
```

L’installation calcule et verrouille l’inventaire réel des fichiers. Le script
reste non chargeable comme contexte et l’activation ne l’exécute jamais.

## 3. Déclarer le programme Touba

<!-- touba-example: compile -->
```touba title="dataset_brief.tb"
module examples.dataset

type DatasetBriefRequest
    query is Text
    max_rows is Int

type DatasetBrief
    title is Text
    summary is Text

tool RenderDatasetBrief
    description "Read the local dataset catalog and summarize matching entries."
    takes request as DatasetBriefRequest
    gives DatasetBrief
    requires filesystem_read

skill BuildDatasetBrief
    description "Build a brief from the requested topic and maximum row count."
    takes request as DatasetBriefRequest
    gives DatasetBrief
    uses RenderDatasetBrief
    do
        RenderDatasetBrief
            with request as request
            into brief
        give brief

agent DatasetAssistant
    responsibility "Produce an accurate brief of matching local datasets using the declared capability."
    takes request as DatasetBriefRequest
    gives DatasetBrief
    uses BuildDatasetBrief
    callable_by strategy RunDatasetBrief

strategy RunDatasetBrief
    takes request as DatasetBriefRequest
    gives DatasetBrief
    uses DatasetAssistant
    do
        DatasetAssistant
            with request as request
            into brief
        give brief
```

Les paramètres sont déclarés et transmis à chaque frontière. Le pack n'apparaît
pas dans `uses` : il n'est pas une capacité exécutable.

## 4. Relier le handler et le provider

```js title="handlers/render_dataset_brief.handler.mjs"
import { defineTool } from "@touba/sdk";
import { normalizeDataset } from "../packages/acme.dataset/scripts/normalize_dataset.mjs";

await defineTool({
  toolRef: "tool:examples.dataset/RenderDatasetBrief",
  inputSignature: [{ name: "request", type_ref: "type:examples.dataset/DatasetBriefRequest" }],
  outputType: "type:examples.dataset/DatasetBrief",
  requiredGrants: ["filesystem_read"],
  run: ({ request }) => normalizeDataset(request)
});
```

```json title="touba.manifest.json"
{
  "manifest_version": "touba-manifest-v1",
  "bindings": {
    "tool:examples.dataset/RenderDatasetBrief": {
      "effect_contract": { "kind": "none" },
      "handler": {
        "kind": "process",
        "command": "node",
        "args": [
          "handlers/render_dataset_brief.handler.mjs"
        ],
        "cwd": "."
      },
      "grants": [
        "filesystem_read"
      ],
      "timeout_ms": 5000,
      "max_payload_bytes": 1048576
    }
  }
}
```

Le provider local ci-dessous est déterministe : il demande le catalogue, appelle
la capacité métier puis retourne son observation. Il sert à vérifier le parcours
sans clé fournisseur ; il ne simule pas une réponse de modèle. Un provider de
modèle utilise la même interface gouvernée.

```js title="providers/dataset-provider.mjs"
export function decideAgentCapability(request) {
  if (request.observations?.length) {
    return { action: "answer_directly", result: request.observations.at(-1).value };
  }
  if (request.mode === "summary") {
    return { action: "request_capabilities" };
  }
  return {
    target_ref: "skill:examples.dataset/BuildDatasetBrief",
    arguments: { request: request.inputs.request }
  };
}
```

## 5. Valider, activer et exécuter

```sh title="Terminal"
touba compile dataset_brief.tb --out dataset_brief.air.json
touba package check packages/acme.dataset
touba run dataset_brief.air.json \
  --manifest touba.manifest.json \
  --agent-decision-provider providers/dataset-provider.mjs \
  --skill-pack packages/acme.dataset \
  --activate-skill-pack skill_pack:acme.dataset/dataset-brief \
  --skill-pack-discovery-max-bytes 4096 \
  --skill-pack-activation-max-bytes 16384 \
  --agent-model-input-max-bytes 65536 \
  --inputs-json '{"request":{"query":"public parks","max_rows":5}}' \
  --trace-out trace.json --output json
touba inspect trace.json
```

Le résultat attendu est `{"title":"public parks","summary":"Montréal parks; Québec parks"}`.
La trace contient `skill_pack_discovery_listed`, `skill_pack_activated`,
`skill_pack_resource_loaded`, `skill_pack_resource_refused` avec
`script_content_not_loaded`, puis la sélection de capacité et
`tool_binding_authorized`. Le refus de charger le script comme contexte est
normal : le handler l'importe explicitement pour effectuer le travail autorisé.

`--skill-pack` rend ce pack disponible à la découverte ; seul
`--activate-skill-pack` charge son contexte. Sans activation, le programme peut
toujours appeler sa capacité autorisée, mais aucune activation n'est attestée.
Les budgets ci-dessus sont ceux de cette exécution, pas des plafonds imposés aux
développeurs. Aucun dossier n'est découvert implicitement par `touba run`.

La vérification du package contrôle les fichiers déclarés. Le chargement
avec l’AIR vérifie les cibles des liens ; le runtime contrôle ensuite le uses
de l’agent actif.

## 6. Vérifier les refus

Utilisez des copies de test distinctes. Pour les variantes de manifeste,
modifiez le package auteur avant installation ; une modification du contenu
installé déclenche d’abord le contrôle d’intégrité.

- Modifiez le script après installation : `PackageIntegrityMismatch`, avant provider ou handler.
- Activez une référence non fournie par `--skill-pack` : configuration refusée.
- Fixez `--skill-pack-activation-max-bytes 1` : `SkillPackBudgetExceeded`, sans appel du tool.
- Marquez le script `loadable_as_context: true` : `PackageContextInvalid`.
- Retirez `filesystem_read` des grants du manifest : `ToolCapabilityNotGranted`, sans lecture par le handler.
- Faites pointer le lien vers une capacité absente : `SkillPackExecutionLinkUnauthorized`.
- Marquez `activation.user_invocable: false` : l'activation utilisateur est refusée.

Un pack ne donne ni grants, ni secrets, ni autorité. Un script est exécutable
uniquement par la capacité Touba et son binding explicite. Les grants ne sont
pas une sandbox du processus hôte.
