import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeAirDocument } from "../../../runtime/touba-runtime/src/index.mjs";

test("Text escapes survive compilation, function calls, runtime and JSON traces exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-text-escapes-"));
  try {
    const source = join(root, "text.tb");
    writeFileSync(source, String.raw`module text.check
define Header as Text = "Hello\n"
function Body
    gives Text
    do
        give Header ++ "Line\t\"two\"\r\n\uD83D\uDE00\b\f\/\\n"
strategy Run
    gives Text
    do
        Body
            into body
        show
            with message as body
        give body
`);
    const air = JSON.parse(execFileSync(process.env.CARGO ?? "cargo", ["run", "--quiet", "--manifest-path",
      new URL("../../../Cargo.toml", import.meta.url).pathname, "-p", "touba-cli", "--bin", "touba-compile", "--", source], { encoding: "utf8" }));
    const expected = 'Hello\nLine\t"two"\r\n😀\b\f/\\n';
    const result = await executeAirDocument(air, { entryRef: "strategy:text.check/Run" });
    assert.equal(result.status, "success", JSON.stringify(result));
    assert.equal(result.result, expected);
    assert.equal(result.messages[0].text, expected);
    assert.ok(!JSON.stringify(result.trace).includes(JSON.stringify(expected)), "private message stays outside the trace");
    assert.equal(JSON.parse(JSON.stringify(result)).result, expected);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
