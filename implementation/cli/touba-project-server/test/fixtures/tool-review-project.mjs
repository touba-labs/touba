import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject, prepareProject } from "../../../touba-project/src/project.mjs";
import { newPackage, addPackage } from "../../../touba-project/src/packages.mjs";

export const toolReviewRef = "tool:example.review/Record";
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
const read = path => JSON.parse(readFileSync(path, "utf8"));

// Disposable real package + process handler. The independent ledger has no
// deduplication, so duplicate dispatch remains observable outside the runtime.
export async function toolReviewFixture({ language = "javascript", sourceApproval = true, parallel = false } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "touba-tool-review-")));
  const source = newPackage("example.review", { root: directory }).path;
  const configPath = join(source, "touba.package.json"), config = read(configPath);
  const handler = language === "python" ? "handlers/record.py" : "handlers/record.mjs";
  Object.assign(config, { publisher: "test", license: "MIT", exports: { tools: [toolReviewRef] },
    handlers: [{ tool: toolReviewRef, path: handler, protocol: "touba-tool-handler-v1" }] });
  save(configPath, config);
  writeFileSync(join(source, "src/example/review.tb"), `module example.review
tool Record
    takes request as Text
    gives Text
    requires filesystem_write
${sourceApproval ? '    human.approve\n        with role as "reviewer"\n        with timeout_ms as 300000\n        with distinct_from as "initiator"\n' : ''}`);
  mkdirSync(join(source, "handlers"));
  writeFileSync(join(source, handler), language === "python" ? `import json, sys
call = json.load(sys.stdin)
with open("effect-ledger.jsonl", "a") as ledger:
    ledger.write(json.dumps(call["effect"]) + "\\n")
json.dump({"ok": True, "value": "Recorded", "effect_receipt": {"effect_id": call["effect"]["effect_id"], "request_digest": call["effect"]["request_digest"], "outcome": "applied", "receipt_ref": "opaque:review-ledger"}}, sys.stdout)
` : `import { appendFileSync } from 'node:fs';
let input = ''; for await (const part of process.stdin) input += part;
const call = JSON.parse(input);
appendFileSync('effect-ledger.jsonl', JSON.stringify(call.effect) + '\\n');
process.stdout.write(JSON.stringify({ ok: true, value: 'Recorded', effect_receipt: {
  effect_id: call.effect.effect_id, request_digest: call.effect.request_digest, outcome: 'applied', receipt_ref: 'opaque:review-ledger'
} }));
`);
  const root = join(directory, "consumer"); initProject({ root });
  mkdirSync(join(root, "src/client"), { recursive: true });
  writeFileSync(join(root, "src/client/main.tb"), `module client.main
import tool Record from example.review
strategy Run
    takes request as Text
    gives ${parallel ? 'List of Text' : 'Text'}
    uses Record
    do
${parallel ? `        parallel Record
            each item in [request, request]
            with request as item
            max_concurrency 2
            max_items 2
            into results
        give results` : `        Record
            with request as request
            into first
        Record
            with request as request
            into second
        give second`}
`);
  await addPackage(source, { root });
  const projectPath = join(root, "touba.project.json"), project = read(projectPath);
  project.entry = "strategy:client.main/Run";
  project.configuration = { ...project.configuration, binding_fragments: ["bindings.json"],
    ...(!sourceApproval ? { tool_policies: { [toolReviewRef]: { role: "reviewer", timeout_ms: 300000, distinct_from: "initiator" } } } : {}) };
  save(projectPath, project);
  save(join(root, "bindings.json"), { fragment_schema_version: "touba-binding-fragment-v1", source: { kind: "module", module: "example.review" },
    bindings: { [toolReviewRef]: { handler: { kind: "process", command: language === "python" ? "python3" : process.execPath,
      args: [`packages/example.review/${handler}`], cwd: root }, grants: ["filesystem_write"], secrets: [],
      effect_contract: { kind: "external_write", retry_mode: "none" }, timeout_ms: 10000, max_payload_bytes: 65536 } } });
  const prepared = await prepareProject({ root, mode: "write" });
  if (prepared.status !== "success") throw new Error(JSON.stringify(prepared.diagnostics));
  return { directory, root, ledgerPath: join(root, "effect-ledger.jsonl") };
}
