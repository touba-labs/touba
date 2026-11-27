import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { executeRunCommand } from "./command.mjs";

const code = await executeRunCommand(process.argv.slice(2), {
  async compileSource(sourcePath, stderr) {
    const { compileCommand } = await import("../../touba-project/src/compile-command.mjs");
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "touba-run-source-"));
    try {
      const airPath = join(temporaryDirectory, "program.air.json");
      const { exitCode } = await compileCommand([resolve(sourcePath), "--out", airPath], { stderr });
      return { json: exitCode === 0 ? readFileSync(airPath, "utf8") : undefined, exitCode };
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  },
});

// The CLI remains ephemeral even if a trusted provider retains handles.
process.exit(code);
