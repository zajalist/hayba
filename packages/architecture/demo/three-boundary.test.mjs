import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const demoRoot = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(demoRoot, '..');
const repoRoot = resolve(packageRoot, '..', '..');

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function sourceFiles(root) {
  const out = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (['.ts', '.mts', '.cts'].includes(extname(entry.name))) out.push(path);
  }
  return out.sort();
}

function importedSpecifiers(source) {
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

test('the Node workspace cannot reinstall the CDN-only Three.js runtime', async () => {
  const manifest = await readJson(join(packageRoot, 'package.json'));
  const lock = await readJson(join(repoRoot, 'package-lock.json'));
  const lockedWorkspace = lock.packages?.['packages/architecture'];

  assert.ok(lockedWorkspace, 'package-lock must record the architecture workspace');
  for (const name of ['three', '@types/three']) {
    assert.equal(manifest.dependencies?.[name], undefined, `${name} is browser-only, not a Node dependency`);
    assert.equal(manifest.devDependencies?.[name], undefined, `${name} types cannot describe CDN runtime code`);
    assert.equal(
      lockedWorkspace.dependencies?.[name],
      undefined,
      `${name} must not return in the workspace lock entry`,
    );
    assert.equal(lockedWorkspace.devDependencies?.[name], undefined, `${name} types must not return in the lock entry`);
  }
});

test('architecture TypeScript has no hidden Three.js reachability', async () => {
  const offenders = [];
  for (const path of await sourceFiles(join(packageRoot, 'src'))) {
    const source = await readFile(path, 'utf8');
    for (const specifier of importedSpecifiers(source)) {
      if (specifier === 'three' || specifier.startsWith('three/')) {
        offenders.push(`${path.slice(packageRoot.length + 1)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'Three.js belongs only to the browser import map');
});

test('the served browser entrypoint pins one coherent Three.js runtime', async () => {
  const html = await readFile(join(demoRoot, 'index.html'), 'utf8');
  const importMapText = html.match(/<script\s+type="importmap">\s*([\s\S]*?)\s*<\/script>/)?.[1];
  assert.ok(importMapText, 'demo/index.html must contain an import map');

  const imports = JSON.parse(importMapText).imports;
  assert.deepEqual(Object.keys(imports).sort(), ['three', 'three/addons/']);

  const runtime = imports.three.match(/^https:\/\/unpkg\.com\/three@(\d+\.\d+\.\d+)\/build\/three\.module\.js$/);
  const addons = imports['three/addons/'].match(/^https:\/\/unpkg\.com\/three@(\d+\.\d+\.\d+)\/examples\/jsm\/$/);
  assert.ok(runtime, 'the runtime URL must use an exact unpkg Three.js version');
  assert.ok(addons, 'the addon URL must use an exact unpkg Three.js version');
  assert.equal(addons[1], runtime[1], 'runtime and addon versions must migrate together');

  for (const browserContract of [
    "import * as THREE from 'three'",
    "from 'three/addons/loaders/GLTFLoader.js'",
    "from 'three/addons/controls/OrbitControls.js'",
    'new THREE.WebGLRenderer',
    'new THREE.SphereGeometry',
    'new GLTFLoader',
    'new OrbitControls',
    'renderer.setSize',
    'renderer.render',
  ]) {
    assert.match(html, new RegExp(browserContract.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
