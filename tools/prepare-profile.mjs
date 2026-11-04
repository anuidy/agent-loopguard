import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
assert.equal(process.platform, 'win32', 'This preparation entry currently uses the Windows desktop CLI.');
const profileName = 'loopguard';
const profileDir = join(root, '.runtime', 'dsh-home', 'profiles', profileName);
const distributions = join(root, 'results', 'distributions');
const logs = join(root, 'results', 'environment');
const stateFile = join(profileDir, '.loopguard-install.json');
const digest = value => createHash('sha256').update(value).digest('hex');
mkdirSync(distributions, { recursive: true });
mkdirSync(logs, { recursive: true });

function dsh(args, label) {
  const run = spawnSync('powershell.exe', ['-NoProfile', '-File', join(root, 'tools', 'dsh.ps1'), ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120000,
  });
  writeFileSync(join(logs, `${label}.stdout.txt`), run.stdout ?? '', 'utf8');
  writeFileSync(join(logs, `${label}.stderr.txt`), run.stderr ?? '', 'utf8');
  assert(!run.error, `${label}: ${run.error?.message}`);
  assert.equal(run.status, 0, `${label} failed; see results/environment/${label}.stderr.txt`);
  return run.stdout;
}

if (!existsSync(join(profileDir, 'package.json'))) {
  console.log('Initialize project-local loopguard profile from headless.');
  dsh(['--profile', profileName, '--from-default-profile', 'headless', '--help'], 'profile-init');
}
const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
assert(manifest.dsh?.profile?.bundles?.includes('@deepseek-ai/dsh-headless'), 'Existing loopguard profile is not headless; left unchanged.');
const previous = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const patch = readFileSync(join(root, 'config', 'smoke-profile.patch.yml'), 'utf8');
const patchPath = join(profileDir, 'cordis.patch.yml');
const current = readFileSync(patchPath, 'utf8').trim();
const withoutComments = current.split(/\r?\n/u).filter(line => !line.trim().startsWith('#')).join('\n').trim();
assert(withoutComments === '[]' || current === patch.trim() || previous.patchHash === digest(current),
  'Existing profile overrides differ; left unchanged.');

console.log('Pack the actual plugin distribution (without install scripts).');
const npmCli = process.env.npm_execpath;
assert(npmCli && existsSync(npmCli), 'Run through npm.cmd run profile:prepare.');
const packed = spawnSync(process.execPath, [npmCli, 'pack', join(root, 'packages', 'loopguard'),
  '--pack-destination', distributions, '--ignore-scripts', '--json'], {
  cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
});
assert.equal(packed.status, 0, packed.stderr);
const [artifact] = JSON.parse(packed.stdout);
const archive = resolve(distributions, artifact.filename);
assert.equal(dirname(archive), resolve(distributions));
const included = new Set(artifact.files.map(x => x.path));
for (const file of ['package.json', 'cordis.patch.yml', 'LICENSE', 'lib/index.js',
  'lib/guard-state.js', 'lib/tool-semantics.js', 'lib/job-waits.js']) assert(included.has(file), `Missing ${file}`);
writeFileSync(join(logs, 'plugin-pack.json'), JSON.stringify(artifact, null, 2), 'utf8');

const packagePath = join(profileDir, 'node_modules', '@agent-loopguard', 'plugin', 'package.json');
if (previous.integrity !== artifact.integrity || !existsSync(packagePath)) {
  console.log('Install the local tarball into this profile.');
  dsh(['plugin', '--profile', profileName, 'add', archive, '--ignore-scripts', '--save-exact',
    '--store-dir', join(profileDir, '.pnpm-store'), '--config.enable-global-virtual-store=false'], 'profile-install');
} else console.log('Installed archive is unchanged; reuse it.');
const installed = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
const bundles = installed.dsh.profile.bundles;
assert(bundles.includes('@agent-loopguard/plugin'), 'CLI did not select the installed bundle.');

assert.equal(readFileSync(patchPath, 'utf8').trim(), current,
  'Profile overrides changed during installation; left unchanged.');
writeFileSync(patchPath, patch, 'utf8');
const composed = dsh(['--profile', profileName, '--dump-config'], 'profile-composed');
assert.match(composed, /- id: loopguard\r?\n\s+name: ['"]?@agent-loopguard\/plugin/);
for (const flag of ['semanticActions', 'semanticEvidence', 'semanticWaits']) assert.match(composed, new RegExp(`${flag}: true`));
const plugin = JSON.parse(readFileSync(packagePath, 'utf8'));
assert.equal(plugin.version, artifact.version);
writeFileSync(stateFile, JSON.stringify({ integrity: artifact.integrity, patchHash: digest(patch.trim()),
  package: plugin.name, version: plugin.version }, null, 2), 'utf8');
console.log(`Prepared ${profileName}: ${plugin.name}@${plugin.version}; bundle and semantic flags verified.`);
