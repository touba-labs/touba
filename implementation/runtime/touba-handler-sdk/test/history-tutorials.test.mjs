import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const siteRoot = process.env.TOUBA_TUTORIAL_SITE_ROOT;
const sdk = new URL("../src/index.mjs", import.meta.url).href;
const sqlite = new URL("../src/sqlite-decision-history.mjs", import.meta.url).href;
const blocks = text => [...text.matchAll(/```js[^\n]*\n([\s\S]*?)```/g)].map(match => match[1]);
const rewrite = text => text.replaceAll('"@touba/sdk"', JSON.stringify(sdk))
  .replaceAll('"@touba/sdk/history/sqlite"', JSON.stringify(sqlite));

for (const name of ["historique-sqlite", "contexte-et-compaction"]) {
  test(`${name}: canonical tutorial parses and runs through real OpenAI serialization offline`, () => {
    const examples = [blocks(readFileSync(new URL(`../../../../docs/tutoriels/${name}.md`, import.meta.url), "utf8"))];
    for (const example of examples[0]) execFileSync(process.execPath, ["--input-type=module", "--check"], { input: example });
    const directory = mkdtempSync(join(tmpdir(), "touba-history-tutorial-"));
    try {
      mkdirSync(join(directory, "providers"));
      writeFileSync(join(directory, "providers/calculator.provider.mjs"), rewrite(examples[0][0]));
      const script = `
        import assert from "node:assert/strict";
        let generated = 0, counted = 0;
        globalThis.fetch = async (url, init) => {
          const body = JSON.parse(init.body);
          if (String(url).endsWith("/input_tokens")) { counted++; return Response.json({ input_tokens: 500 }); }
          assert.equal(String(url), "https://api.openai.com/v1/responses");
          generated++;
          const finish = body.tools.find(tool => tool.name === "touba_finish");
          assert(finish);
          return Response.json({ object: "response", id: "resp_fixture", model: "gpt-4.1-mini", status: "completed", created_at: 1,
            output: [{ type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: finish.name,
              arguments: JSON.stringify({ result: 34, reason: "The input already provides the result." }), status: "completed" }],
            usage: { input_tokens: 500, output_tokens: 10, total_tokens: 510 } });
        };
        const { decideAgentCapability } = await import("./providers/calculator.provider.mjs");
        const decision = await decideAgentCapability({ protocol: "touba-agent-decision-v1", mode: "capabilities",
          run_id: "tutorial-test", invocation_id: "invocation-test", agent_ref: "agent:tutorial/Calculator", step_index: 0,
          inputs: { value: 34 }, observations: [], capability_refs: [], capabilities: [],
          agent_signature: { output_type: "builtin:Int" },
          model_input: { protocol: "touba-agent-model-input-v1", agent: { responsibility: "Return the provided integer." },
            agent_state: {}, decision_policy: {}, output_contract: {}, user_input: { value: 34 } } });
        assert.equal(decision.action, "answer_directly"); assert.equal(decision.result, 34);
        assert.equal(generated, 1); assert.equal(counted, ${name === "contexte-et-compaction" ? 1 : 0});
      `;
      writeFileSync(join(directory, "check.mjs"), script);
      const env = { ...process.env, OPENAI_API_KEY: "offline-fixture", TOUBA_AGENT_DECISION_OPENAI_API_KEY: "offline-fixture" };
      execFileSync(process.execPath, ["check.mjs"], { cwd: directory, env, stdio: "pipe", timeout: 15000 });
      if (name === "historique-sqlite") {
        writeFileSync(join(directory, "inspect-history.mjs"), rewrite(examples[0][1]));
        const output = execFileSync(process.execPath, ["inspect-history.mjs"], { cwd: directory, encoding: "utf8" });
        assert.match(output, /retainedExchanges: 1/); assert.match(output, /closed: true/); assert.match(output, /pendingCall: false/);
      } else {
        writeFileSync(join(directory, "providers/calculator.provider.mjs"), rewrite(examples[0][0]).replace("32768", "100"));
        const refused = script.replace('const decision = await decideAgentCapability(', 'const decision = await assert.rejects(decideAgentCapability(')
          .replace('user_input: { value: 34 } } });', 'user_input: { value: 34 } } }), { code: "ProviderContextWindowExceeded" });')
          .replace('assert.equal(decision.action, "answer_directly"); assert.equal(decision.result, 34);', '')
          .replace('assert.equal(generated, 1)', 'assert.equal(generated, 0)');
        writeFileSync(join(directory, "refuse.mjs"), refused);
        execFileSync(process.execPath, ["refuse.mjs"], { cwd: directory, env, stdio: "pipe", timeout: 15000 });
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  const translations = siteRoot ? [`docs/tutoriels/${name}.md`,
    `i18n/en/docusaurus-plugin-content-docs/current/tutoriels/${name}.md`]
    .map(path => resolve(siteRoot, path)) : [];
  // Cross-repository parity is independent of executing the mandatory Core
  // tutorial above. An explicitly requested site must exist and match; missing
  // translations fail instead of silently disabling this optional integration.
  test(`${name}: site FR/EN JavaScript matches the canonical tutorial`, {
    skip: siteRoot ? false : "Set TOUBA_TUTORIAL_SITE_ROOT to check a separate documentation site",
  }, () => {
    const canonical = blocks(readFileSync(new URL(`../../../../docs/tutoriels/${name}.md`, import.meta.url), "utf8"));
    for (const path of translations) assert.deepEqual(blocks(readFileSync(path, "utf8")), canonical);
  });
}
