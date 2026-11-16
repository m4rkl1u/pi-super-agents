import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pkg = createRequire(import.meta.url)('../../package.json');

function temporary(t: TestContext): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'super-agents-install-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixture(t: TestContext) {
  const dir = temporary(t), source = join(dir, 'source with spaces');
  for (const path of ['scripts', 'src']) mkdirSync(join(source, path), { recursive: true });
  for (const script of ['install.sh', 'uninstall.sh']) copyFileSync(join(root, 'scripts', script), join(source, 'scripts', script));
  for (const file of ['src/cli.ts', 'package-lock.json']) writeFileSync(join(source, file), 'fixture');
  const bin = join(dir, 'bin'), home = join(dir, 'home'), log = join(dir, 'npm.log');
  mkdirSync(bin); mkdirSync(home);
  // Stub only npm; execute the actual shell scripts, node checks and path handling.
  writeFileSync(join(bin, 'npm'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_NPM_LOG, args.join('\\0') + '\\n');
if (process.env.TEST_NPM_FAIL === args[0]) process.exit(42);
if (args[0] === 'prefix') console.log(process.env.TEST_GLOBAL_PREFIX);
if (args[0] === 'pack') fs.writeFileSync(path.join(args[args.indexOf('--pack-destination') + 1], 'pi-agent-workspace-0.1.0.tgz'), 'archive');
`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, TEST_NPM_LOG: log, TEST_GLOBAL_PREFIX: join(dir, 'global prefix') };
  const run = (script: string, args: string[] = [], extra: NodeJS.ProcessEnv = {}) => spawnSync('bash', [join(source, 'scripts', script), ...args], { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8', timeout: 10000 });
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => line.split('\0')) : [];
  return { dir, source, home, env, run, calls, reset: () => rmSync(log, { force: true }) };
}

test('installer builds and installs an independent archive in user, global and custom prefixes', t => {
  const f = fixture(t);
  for (const [args, prefix] of [
    [[], join(f.home, '.local')],
    [['--global'], f.env.TEST_GLOBAL_PREFIX],
    [['--global', '--prefix', 'custom prefix'], resolve(f.dir, 'custom prefix')],
    [['--user'], join(f.home, '.local')],
  ] as [string[], string][]) {
    f.reset();
    const result = f.run('install.sh', args);
    assert.equal(result.status, 0, result.stderr);
    const calls = f.calls().filter(args => args[0] !== 'prefix');
    assert.deepEqual(calls.map(args => args[0]), ['ci', 'run', 'pack', 'install']);
    assert.ok(calls[0].includes('--include=dev'));
    assert.ok(calls[0].includes('--ignore-scripts'));
    assert.deepEqual(calls[1], ['run', 'build']);
    const install = calls[3];
    assert.deepEqual(install.slice(0, 4), ['install', '--global', '--prefix', prefix]);
    assert.ok(install.includes('--ignore-scripts'));
    assert.ok(install.at(-1)!.endsWith('.tgz'));
    assert.equal(existsSync(dirname(install.at(-1)!)), false, 'temporary archive is cleaned up');
    assert.match(result.stdout, /export PATH=/);
  }
});

test('uninstaller uses the same prefix without requiring source or touching workspace data', t => {
  const f = fixture(t);
  rmSync(join(f.source, 'src'), { recursive: true });
  rmSync(join(f.source, 'package-lock.json'));
  const data = join(f.home, '.pi-workspaces');
  mkdirSync(data); writeFileSync(join(data, 'keep'), 'history');
  for (const [args, prefix] of [[[], join(f.home, '.local')], [['--global'], f.env.TEST_GLOBAL_PREFIX], [['--prefix', 'custom prefix'], join(f.dir, 'custom prefix')]] as [string[], string][]) {
    f.reset();
    const result = f.run('uninstall.sh', args);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.calls().filter(args => args[0] !== 'prefix'), [['uninstall', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--', 'pi-agent-workspace']]);
    assert.equal(readFileSync(join(data, 'keep'), 'utf8'), 'history');
  }
});

test('installer validates options, exposes help and stops on npm failures', t => {
  const f = fixture(t);
  for (const args of [['--prefix'], ['--prefix', ''], ['--prefix', '--global'], ['--unknown']]) {
    assert.notEqual(f.run('install.sh', args).status, 0);
    assert.deepEqual(f.calls(), []);
  }
  assert.match(f.run('install.sh', ['--help']).stdout, /Usage:/);
  assert.deepEqual(f.calls(), []);
  for (const command of ['ci', 'pack', 'install', 'uninstall']) {
    f.reset();
    const result = f.run(command === 'uninstall' ? 'uninstall.sh' : 'install.sh', [], { TEST_NPM_FAIL: command });
    assert.equal(result.status, 42);
    assert.equal(f.calls().at(-1)![0], command);
    assert.doesNotMatch(result.stdout, /Installed super-agents|Removed super-agents/);
    const pack = f.calls().find(args => args[0] === 'pack');
    if (pack) assert.equal(existsSync(pack[pack.indexOf('--pack-destination') + 1]), false);
  }
});

test('super-agents help and version work outside the source directory without creating state', t => {
  const dir = temporary(t), env = { ...process.env, HOME: dir, PI_CODING_AGENT_DIR: join(dir, 'pi') };
  for (const flag of ['--help', '-h', '--version', '-v']) {
    const result = spawnSync(process.execPath, [join(root, 'dist/src/cli.js'), flag], { cwd: dir, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    if (flag === '--help' || flag === '-h') assert.match(result.stdout, /Usage: super-agents/);
    else assert.equal(result.stdout.trim(), `super-agents ${pkg.version}`);
  }
  assert.deepEqual(readdirSync(dir), []);
});

test('distribution includes the CLI and uninstall scripts but no local state, tests or dependencies', t => {
  const dir = temporary(t);
  const result = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json', '--cache', join(dir, 'cache')], { cwd: root, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  let files: string[] = [];
  assert.doesNotThrow(() => { files = JSON.parse(result.stdout)[0].files.map((file: { path: string }) => file.path); });
  for (const file of ['package.json', 'README.md', 'dist/src/cli.js', 'scripts/install.sh', 'scripts/uninstall.sh']) assert.ok(files.includes(file), file);
  assert.ok(files.every(file => /^(package\.json|README\.md|dist\/src\/.*\.js|docs\/.*\.md|scripts\/(un)?install\.sh)$/.test(file)), files.join('\n'));
  assert.equal(pkg.bin['super-agents'], 'dist/src/cli.js');
});
