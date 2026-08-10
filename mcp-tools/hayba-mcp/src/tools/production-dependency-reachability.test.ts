import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const sourceRoot = resolve(here, '..');
const packagePath = resolve(sourceRoot, '..', 'package.json');
const target = 'lru-cache';

function productionSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...productionSourceFiles(resolve(dir, entry.name)));
      continue;
    }
    if (!entry.isFile() || !/\.(?:[cm]?[jt]s)$/.test(entry.name) || /\.(?:test|spec)\./.test(entry.name)) continue;
    files.push(resolve(dir, entry.name));
  }
  return files.sort();
}

/** Remove comments without deleting quote delimiters or string contents. This
 *  keeps import specifiers available to the patterns below while preventing a
 *  commented-out import from preserving an otherwise dead dependency. */
function withoutComments(source: string): string {
  let out = '';
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (state === 'line') {
      if (char === '\n') {
        state = 'code';
        out += char;
      } else {
        out += ' ';
      }
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') {
        out += '  ';
        state = 'code';
        i += 1;
      } else {
        out += char === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (state !== 'code') {
      out += char;
      if (char === '\\' && next !== undefined) {
        out += next;
        i += 1;
        continue;
      }
      if (
        (state === 'single' && char === "'") ||
        (state === 'double' && char === '"') ||
        (state === 'template' && char === '`')
      ) {
        state = 'code';
      }
      continue;
    }
    if (char === '/' && next === '/') {
      out += '  ';
      state = 'line';
      i += 1;
    } else if (char === '/' && next === '*') {
      out += '  ';
      state = 'block';
      i += 1;
    } else {
      out += char;
      if (char === "'") state = 'single';
      else if (char === '"') state = 'double';
      else if (char === '`') state = 'template';
    }
  }
  return out;
}

function hasRuntimeSpecifier(rawSource: string): boolean {
  const source = withoutComments(rawSource);
  const specifier = String.raw`["']${target}(?:\/[^"']*)?["']`;
  return [
    new RegExp(String.raw`\bimport\s*\(\s*${specifier}`),
    new RegExp(String.raw`\brequire(?:\.resolve)?\s*\(\s*${specifier}`),
    new RegExp(String.raw`\bimport\s*${specifier}`),
    new RegExp(String.raw`\b(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s*${specifier}`),
    new RegExp(String.raw`\bimport\s+(?!type\b)[$\w]+\s*=\s*require\s*\(\s*${specifier}`),
  ].some((pattern) => pattern.test(source));
}

function hasRuntimeImport(file: string): boolean {
  return hasRuntimeSpecifier(readFileSync(file, 'utf8'));
}

describe('production dependency reachability', () => {
  it.each([
    `import { LRUCache } from 'lru-cache';`,
    `export { LRUCache } from 'lru-cache';`,
    `import 'lru-cache/register';`,
    `await import('lru-cache');`,
    `require('lru-cache');`,
    `require.resolve('lru-cache');`,
    `import cache = require('lru-cache');`,
  ])('recognizes a runtime call form: %s', (source) => {
    expect(hasRuntimeSpecifier(source)).toBe(true);
  });

  it.each([
    `// import { LRUCache } from 'lru-cache';`,
    `/* require('lru-cache') */`,
    `import type { LRUCache } from 'lru-cache';`,
    `export type { LRUCache } from 'lru-cache';`,
    `const packageName = 'lru-cache';`,
  ])('does not count a non-runtime reference: %s', (source) => {
    expect(hasRuntimeSpecifier(source)).toBe(false);
  });

  it('keeps the lru-cache declaration aligned with reachable production imports', () => {
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const runtimeConsumers = productionSourceFiles(sourceRoot)
      .filter(hasRuntimeImport)
      .map((file) => relative(sourceRoot, file).replaceAll('\\', '/'));
    const declared = Object.hasOwn(packageJson.dependencies ?? {}, target);

    expect(declared, `${target} manifest/runtime mismatch; consumers: ${runtimeConsumers.join(', ') || '(none)'}`).toBe(
      runtimeConsumers.length > 0,
    );
  });
});
