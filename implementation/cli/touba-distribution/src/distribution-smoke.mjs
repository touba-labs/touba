import { join } from "node:path";
import { writeFileSync } from "node:fs";

export const smokeSource = `module examples.linear_skill

type SourceRequest
    topic is Text

type SourceText
    content is Text

tool FetchSource
    description "Returns the supplied topic from the isolated smoke process."
    takes request as SourceRequest
    gives SourceText

skill BuildNote
    description "Calls the declared process and returns its typed result."
    takes request as SourceRequest
    gives SourceText
    uses FetchSource
    do
        FetchSource
            with request as request
            into source
        give source
`;

export function writeSmokeBinding(projectRoot, nodeExecutable) {
  const handler = join(projectRoot, "read.handler.mjs");
  writeFileSync(handler, `let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { data += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(data);
  if (request.protocol !== "touba-tool-handler-v1" || request.operation !== "invoke") process.exit(2);
  process.stdout.write(JSON.stringify({ ok: true, value: { content: request.arguments.request.topic } }));
});
`);
  const manifest = join(projectRoot, "touba.manifest.json");
  writeFileSync(manifest, JSON.stringify({
    manifest_version: "touba-manifest-v1",
    bindings: {
      "tool:examples.linear_skill/FetchSource": {
        handler: { kind: "process", command: nodeExecutable, args: [handler], cwd: projectRoot },
        grants: [], effect_contract: { kind: "none" },
        timeout_ms: 5000, max_payload_bytes: 65536,
      },
    },
  }, null, 2) + "\n");
  return manifest;
}
