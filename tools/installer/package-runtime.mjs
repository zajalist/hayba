import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, copyFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';

export function copyTree(source, target, filter = () => true) {
  const root = realpathSync(source);
  function visit(from, to) {
    if (!filter(from)) return;
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) {
      const actual = realpathSync(from);
      if (actual !== root && !actual.startsWith(root + sep)) throw new Error(`External link in package: ${relative(root, from)}`);
      return visit(actual, to);
    }
    if (stat.isDirectory()) {
      mkdirSync(to, { recursive: true });
      for (const item of readdirSync(from)) visit(join(from, item), join(to, item));
    } else { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
  }
  visit(root, target);
}

// Copy the installed production graph, retaining resolved versions and nested conflicts.
export function packageDependencies(sourcePackage, destination) {
  const installed = new Map();
  const inventory = [];
  const rootModules = join(destination, 'node_modules');
  const readPackage = dir => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  function findSource(name, from) {
    for (let cursor = resolve(from); ; cursor = dirname(cursor)) {
      const candidate = join(cursor, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
      if (dirname(cursor) === cursor) throw new Error(`Missing installed production dependency: ${name}`);
    }
  }
  function install(name, from, targetParent, optional) {
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error(`Invalid dependency name: ${name}`);
    let source;
    try { source = findSource(name, from); } catch (error) { if (optional) return; throw error; }
    for (let cursor = targetParent; cursor.startsWith(destination); cursor = dirname(cursor)) {
      const found = installed.get(join(cursor, 'node_modules', name));
      if (found) { if (found === source) return; break; }
      if (cursor === destination) break;
    }
    const hoisted = join(rootModules, name);
    const target = installed.has(hoisted) ? join(targetParent, 'node_modules', name) : hoisted;
    if (installed.get(target) === source) return;
    if (installed.has(target)) throw new Error(`Conflicting dependency resolution: ${name}`);
    installed.set(target, source);
    const pkg = readPackage(source);
    if (name === '@hayba/brain-protocol') {
      copyTree(join(source, 'dist'), join(target, 'dist'), path => !/\.test\./.test(path));
      writeFileSync(join(target, 'package.json'), JSON.stringify({ ...pkg, scripts: undefined, devDependencies: undefined }, null, 2));
    } else {
      copyTree(source, target, path => {
        const parts = relative(source, path).split(sep);
        return !parts.some(part => part === 'node_modules' || part === '.git' || part === '.npmrc' || part.startsWith('.env'));
      });
    }
    inventory.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? 'See package license', path: relative(destination, target).split(sep).join('/') });
    visitDependencies(pkg, source, target);
  }
  function visitDependencies(pkg, from, target) {
    const required = { ...pkg.peerDependencies, ...pkg.dependencies, ...pkg.optionalDependencies };
    for (const name of Object.keys(required).sort()) {
      const optional = Object.hasOwn(pkg.optionalDependencies ?? {}, name) || (!Object.hasOwn(pkg.dependencies ?? {}, name) && pkg.peerDependenciesMeta?.[name]?.optional);
      install(name, from, target, optional);
    }
  }
  visitDependencies(readPackage(sourcePackage), sourcePackage, destination);
  return inventory;
}
