import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

// Execute the published blocks in order. No source substitution, hidden file,
// workspace SDK, or injected handler is allowed in an installed-user recipe.
export function runDocumentRecipe(documentPath, root, env) {
  const document = readFileSync(documentPath, "utf8");
  let cwd = root;
  let commands = 0;
  let files = 0;
  const outputs = [];
  const inside = path => {
    const rel = relative(root, path);
    assert.ok(!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"), "recipe must stay in its test directory");
    return path;
  };
  const execute = script => {
    if (!script.trim()) return;
    const result = spawnSync("/bin/sh", ["-eu", "-c", script], { cwd, env, encoding: "utf8", timeout: 300000 });
    assert.equal(result.status, 0, `${documentPath}\n${script}\n${result.error?.message ?? ""}\n${result.stderr}\n${result.stdout}`);
    outputs.push(result.stdout);
    commands++;
  };
  for (const match of document.matchAll(/```(\w+) title="([^"]+)"\n([\s\S]*?)\n```/g)) {
    const [, language, title, body] = match;
    if (language === "sh" && title === "Terminal") {
      let script = [];
      for (const line of body.split("\n")) {
        if (/^cd [A-Za-z0-9_./-]+$/.test(line)) {
          execute(script.join("\n")); script = [];
          cwd = inside(resolve(cwd, line.slice(3)));
          assert.ok(existsSync(cwd), "cd target must have been created by the published commands");
        } else script.push(line);
      }
      execute(script.join("\n"));
    } else if ((["js", "json", "touba", "yaml", "sql", "python", "py", "toml"].includes(language) && /\.(?:mjs|js|json|tb|ya?ml|sql|py|toml)$/.test(title))
        || (language === "dockerfile" && /(?:^|\/)Dockerfile(?:\.[A-Za-z0-9_-]+)?$/.test(title))) {
      // Syntax excerpts are not files to create. Complete tutorial sources must
      // carry the same explicit status enforced by documentation compilation.
      if (language === "touba" && document.slice(0, match.index).trimEnd().endsWith("<!-- touba-example: fragment -->")) continue;
      const destination = inside(resolve(cwd, title));
      assert.ok(existsSync(dirname(destination)), `parent directory not created by the recipe: ${title}`);
      writeFileSync(destination, body + "\n");
      files++;
    }
  }
  return { cwd, outputs, commands, files };
}
