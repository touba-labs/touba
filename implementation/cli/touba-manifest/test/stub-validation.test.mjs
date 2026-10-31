import assert from "node:assert/strict";
import test from "node:test";
import { generateHandlerStubFromAirTool } from "../src/stub.mjs";
import { isCanonicalHandlerStub } from "../src/stub-validation.mjs";

for (const language of ["javascript", "python"]) {
  test(`only canonical unimplemented ${language} handlers are accepted`, () => {
    const tool = { id: "tool:demo/Read", required_capabilities: ["network.http"], required_secrets: ["token"],
      signature: { inputs: [{ name: "request", type_ref: "builtin:Text" }], output_type: "builtin:Text" } };
    const source = generateHandlerStubFromAirTool(tool, { language });
    assert.equal(isCanonicalHandlerStub(source, language), true);
    for (const changed of [source + "\nprint('extra')\n", source.replace("HandlerNotImplemented", "Success"),
      source.replace(language === "python" ? "from touba_sdk" : 'from "@touba/sdk"', language === "python" ? "from other_sdk" : 'from "other-sdk"'),
      source.replace("network.http", "network.http\nmalicious()")]) {
      assert.notEqual(changed, source);
      assert.equal(isCanonicalHandlerStub(changed, language), false);
    }
    assert.equal(isCanonicalHandlerStub("// Touba generated handler stub v0.1\nprocess.exit(0);", language), false);
    assert.equal(isCanonicalHandlerStub(null, language), false);
  });
}
