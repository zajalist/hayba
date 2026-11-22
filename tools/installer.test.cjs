const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');

test('portable dependency graph preserves nested versions, cycles and optional peers', async () => {
  const { packageDependencies } = await import(pathToFileURL(join(__dirname, 'installer/package-runtime.mjs')));
  const root = mkdtempSync(join(tmpdir(), 'hayba-package-test-'));
  const put = (path, data) => { mkdirSync(require('node:path').dirname(path), { recursive: true }); writeFileSync(path, data); };
  try {
    const app = join(root, 'app'), out = join(root, 'portable');
    put(join(app, 'package.json'), JSON.stringify({ dependencies: { a: '1', b: '1' }, devDependencies: { never: '1' } }));
    put(join(root, 'node_modules/a/package.json'), JSON.stringify({ name: 'a', version: '1', dependencies: { b: '1' } }));
    put(join(root, 'node_modules/a/.env'), 'do not distribute');
    put(join(root, 'node_modules/b/package.json'), JSON.stringify({ name: 'b', version: '1', dependencies: { a: '2' }, peerDependencies: { absent: '*' }, peerDependenciesMeta: { absent: { optional: true } } }));
    put(join(root, 'node_modules/b/node_modules/a/package.json'), JSON.stringify({ name: 'a', version: '2', dependencies: { b: '1' } }));
    const inventory = packageDependencies(app, out);
    assert.equal(inventory.length, 3);
    assert.equal(JSON.parse(readFileSync(join(out, 'node_modules/a/package.json'))).version, '1');
    assert.equal(JSON.parse(readFileSync(join(out, 'node_modules/b/node_modules/a/package.json'))).version, '2');
    assert.equal(existsSync(join(out, 'node_modules/a/.env')), false);
    assert.equal(existsSync(join(out, 'node_modules/never')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Windows installer transactional and boundary checks', { skip: process.platform !== 'win32' }, () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(__dirname, 'installer/test-core.ps1')], { env, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /All installer checks passed/);
});
