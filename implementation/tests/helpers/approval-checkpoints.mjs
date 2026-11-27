import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { executeAirDocument } from "../../runtime/touba-runtime/src/index.mjs";

export function createApprovalTestRunner() {
  const directory = mkdtempSync(join(tmpdir(), "touba-approval-test-"));
  const humanCheckpointStorePath = join(directory, "approval-checkpoints.sqlite");
  after(() => rmSync(directory, { recursive: true, force: true }));
  return (document, options) => executeAirDocument(document, { humanCheckpointStorePath, ...options });
}
