import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Copy the original notices from the exact provisioned source distributions.
 * Packaging is offline and must fail when those notices have not been supplied. */
export function writeThirdPartyNotices({implementationRoot, toolchainRoot, nodeSource, metadata, rustLibrary}) {
  const nodeDirectory = dirname(realpathSync(nodeSource));
  const nodeLicense = [join(nodeDirectory, 'LICENSE'), join(dirname(nodeDirectory), 'LICENSE')]
    .find(path => existsSync(path) && readFileSync(path, 'utf8').includes('Node.js'));
  if (!nodeLicense) {
    throw new Error('Provision the official Node distribution with its complete LICENSE before packaging');
  }
  let compilerInfo;
  if (!metadata || !rustLibrary) {
    const compiler = spawnSync(process.env.RUSTC ?? 'rustc', ['-vV'], {cwd:implementationRoot,encoding:'utf8',timeout:10000});
    const host = compiler.stdout?.match(/^host: (\S+)$/m)?.[1];
    const version = compiler.stdout?.match(/^release: (\S+)$/m)?.[1];
    if (compiler.error || compiler.status !== 0 || !host || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version ?? '')) throw new Error('Cannot identify the native Rust toolchain for redistribution notices');
    compilerInfo = {host,version};
  }
  if (!metadata) {
    const command = spawnSync(process.env.CARGO ?? 'cargo', ['metadata', '--offline', '--locked', '--filter-platform', compilerInfo.host, '--format-version', '1'], {
      cwd: implementationRoot, encoding:'utf8', maxBuffer:16*1024*1024, timeout:30000,
    });
    if (command.error || command.status !== 0) throw new Error('Cannot read locked Cargo source metadata for redistribution notices');
    metadata = JSON.parse(command.stdout);
  }
  const out = join(toolchainRoot, 'licenses');
  mkdirSync(join(out, 'node'), {recursive:true});
  copyFileSync(nodeLicense, join(out, 'node', 'LICENSE'));
  const components = [{name:'Node.js', version:'24.22.3', license:'Node.js consolidated notices', files:[{path:'licenses/node/LICENSE',sha256:hash(nodeLicense)}]}];
  rustLibrary ??= {version:compilerInfo.version,noticePath:join(implementationRoot,'cli/touba-distribution/licenses',`rust-${compilerInfo.version}-COPYRIGHT-library.html`)};
  if (!existsSync(rustLibrary.noticePath) || !readFileSync(rustLibrary.noticePath,'utf8').includes('Rust Standard Library')) throw new Error('Missing original Rust Standard Library notices for the pinned compiler');
  const libraryTarget=join(out,'rust-standard-library','COPYRIGHT-library.html');
  mkdirSync(dirname(libraryTarget),{recursive:true});copyFileSync(rustLibrary.noticePath,libraryTarget);
  components.push({name:'Rust Standard Library',version:rustLibrary.version,license:'Original consolidated Rust library notices',files:[{path:'licenses/rust-standard-library/COPYRIGHT-library.html',sha256:hash(libraryTarget)}]});
  // Include the locked source dependency notices. This is an attribution
  // inventory, not a claim that every build dependency is linked into a binary.
  for (const item of [...metadata.packages].filter(item => item.source).sort((a,b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))) {
    if (!/^[A-Za-z0-9_-]+$/.test(item.name) || !/^[0-9A-Za-z.+-]+$/.test(item.version)) throw new Error('Invalid Cargo package identity for notices');
    const root = realpathSync(dirname(item.manifest_path));
    const candidates = new Set(readdirSync(root).filter(name => /^(?:licen[sc]e|copying|copyright|notice)(?:[._-].*)?$/i.test(name) && statSync(join(root,name)).isFile()).map(name => join(root,name)));
    if (item.license_file) candidates.add(resolve(root,item.license_file));
    if (!candidates.size) throw new Error(`Missing redistribution notice for ${item.name}@${item.version}`);
    const destination = join(out, 'rust', `${item.name}-${item.version}`);
    mkdirSync(destination, {recursive:true});
    const files=[];
    for (const source of [...candidates].sort()) {
      const actual = realpathSync(source);
      if (!actual.startsWith(root+sep)) throw new Error('Cargo notice must stay inside its source package');
      const target=join(destination,basename(actual));copyFileSync(actual,target);
      files.push({path:relative(toolchainRoot,target).split(sep).join('/'),sha256:hash(target)});
    }
    components.push({name:item.name,version:item.version,license:item.license,files});
  }
  const inventory={schema:'touba-third-party-notices-v1',inventoryScope:'Node distribution, Rust standard library and locked Rust source dependencies; source inventory does not assert binary linkage',components};
  writeFileSync(join(out,'manifest.json'),JSON.stringify(inventory,null,2)+'\n');
  writeFileSync(join(toolchainRoot,'THIRD_PARTY_NOTICES.md'),[
    '# Third-party notices','',
    'The bundled Node runtime and Rust source dependencies retain their licenses.',
    'The original notices are included under `licenses/`. JavaScript packages',
    'also retain their notices in their own installed directories.',
    'The Rust inventory includes build dependencies and does not assert that',
    'every source package is linked into the compiler executable.','',
    ...components.map(item=>`- ${item.name} ${item.version}: ${item.license}. ${item.files.map(file=>`[${basename(file.path)}](${file.path})`).join(', ')}`),''
  ].join('\n'));
  return {components:components.length,nodeLicenseSha256:hash(nodeLicense),manifestSha256:hash(join(out,'manifest.json'))};
}
