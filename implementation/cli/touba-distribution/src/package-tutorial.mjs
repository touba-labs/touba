import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

// An archive contains the published recipe and its literal named source blocks.
// Ordered steps retain intentional rewrites of the same file. No second author copy.
export function packageTutorial({ document, output, locale, slug, version }) {
  if (!/^[a-z0-9-]+$/.test(slug) || !['fr', 'en'].includes(locale)) throw new Error('Invalid tutorial identity');
  const source = readFileSync(document, 'utf8');
  if (!source.includes('```sh title="Terminal"')) throw new Error('Tutorial needs executable Terminal blocks');
  const root = mkdtempSync(join(tmpdir(), 'touba-tutorial-'));
  const name = `touba-tutorial-${slug}`;
  const directory = join(root, name);
  mkdirSync(directory);
  try {
    writeFileSync(join(directory, 'tutorial.md'), source);
    const runner = readFileSync(new URL('./tutorial-recipe.mjs', import.meta.url));
    writeFileSync(join(directory, 'recipe.mjs'), runner);
    const files = [];
    for (const [index, match] of [...source.matchAll(/```(\w+) title="([^"]+)"\n([\s\S]*?)\n```/g)].entries()) {
      const [, language, title, body] = match;
      if (!['js', 'json', 'touba', 'yaml', 'sql', 'python', 'py', 'toml', 'dockerfile'].includes(language)
        || (language === 'touba' && source.slice(0, match.index).trimEnd().endsWith('<!-- touba-example: fragment -->'))) continue;
      if (!/^[a-zA-Z0-9_./-]+$/.test(title) || title.startsWith('/') || title.split('/').includes('..')) throw new Error('Unsafe tutorial filename');
      const path = `steps/${String(index + 1).padStart(2, '0')}/${title}`;
      const target = join(directory, path);
      mkdirSync(resolve(target, '..'), {recursive:true});
      writeFileSync(target, body + '\n');
      files.push({path, destination:title, sha256:createHash('sha256').update(body + '\n').digest('hex')});
    }
    if (!files.length) throw new Error('Tutorial contains no source files');
    writeFileSync(join(directory, 'provenance.json'), JSON.stringify({schema_version:'touba-tutorial-v1',
      locale, slug, documentation_version:version, document_sha256:createHash('sha256').update(source).digest('hex'),
      runner_sha256:createHash('sha256').update(runner).digest('hex'), files}, null, 2) + '\n');
    writeFileSync(join(directory, 'validate.mjs'), `import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const provenance=JSON.parse(readFileSync(new URL('./provenance.json',import.meta.url)));
const digest=path=>createHash('sha256').update(readFileSync(new URL(path,import.meta.url))).digest('hex');
assert.equal(digest('./tutorial.md'),provenance.document_sha256);
assert.equal(digest('./recipe.mjs'),provenance.runner_sha256);
for(const file of provenance.files) assert.equal(digest('./'+file.path),file.sha256);
const version=execFileSync('touba',['version'],{encoding:'utf8'}).trim();
const root=mkdtempSync(join(tmpdir(),'touba-tutorial-run-'));
console.log('Workspace:',root);
const {runDocumentRecipe}=await import('./recipe.mjs');
const result=runDocumentRecipe(fileURLToPath(new URL('./tutorial.md',import.meta.url)),root,process.env);
assert.ok(result.commands && result.files);
const report={status:'passed',version,document_sha256:provenance.document_sha256,commands:result.commands,files:result.files,workspace:root};
writeFileSync(new URL('./validation.json',import.meta.url),JSON.stringify(report,null,2)+'\\n');
console.log(JSON.stringify(report));
`);
    writeFileSync(join(directory, 'README.txt'), locale === 'fr'
      ? `Tutoriel Touba ${version}\n\nPrérequis : Touba, Node.js 24, shell POSIX (macOS/Linux/WSL).\nLes SDK et services requis sont indiqués dans tutorial.md.\nLire le tutoriel, puis lancer : node validate.mjs\nLes commandes publiées créent un nouveau dossier temporaire, conservé pour inspection.\nsteps/ contient les sources exactes, dans leur ordre de présentation.\nprovenance.json identifie les sources ; validation.json consigne votre test et votre build.\nLa génération de cette archive ne constitue pas une nouvelle qualification de build.\n`
      : `Touba tutorial ${version}\n\nRequirements: Touba, Node.js 24, POSIX shell (macOS/Linux/WSL).\nSee tutorial.md for SDK and service requirements.\nRead the tutorial, then run: node validate.mjs\nPublished commands run in a new temporary directory, retained for inspection.\nsteps/ contains the exact sources in presentation order.\nprovenance.json identifies the sources; validation.json records your test and build.\nArchive generation does not qualify a new build.\n`);
    execFileSync('tar', ['-czf', resolve(output), '-C', root, name], {env:{...process.env,COPYFILE_DISABLE:'1'}});
    return {slug,files:files.length};
  } finally { rmSync(root,{recursive:true,force:true}); }
}
