import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listToolCategoriesHandler } from '../code-mode/list-tool-categories.js';
import { captureStaticToolCatalogue, STATIC_TOOL_CATALOGUE } from '../index.js';
import { recordToolSchema } from '../register-tool.js';
import { UeHeaderDatabaseError } from './ue-header-database.js';
import { buildUeHeaderIndex, type UeHeaderIndex } from './ue-header-index.js';
import { createQueryUeDocsHandler, schema, type QueryUeDocsDependencies } from './query-ue-docs.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureIndex(extraFunctions = 0, docContext = 'bounded context '.repeat(100)): Promise<UeHeaderIndex> {
  const root = await mkdtemp(join(tmpdir(), 'hayba-query-docs-'));
  roots.push(root);
  const source = join(root, 'Engine', 'Source', 'Runtime', 'Engine', 'Public');
  await mkdir(source, { recursive: true });
  const largeFunctions = Array.from(
    { length: extraFunctions },
    (_, index) => `/** ${docContext} */\nvoid Function${index}();`,
  ).join('\n');
  await writeFile(
    join(source, 'ActorIterator.h'),
    `/** Iterates live actors without allocating an array. */
class FActorIterator {
public:
    void Iterate();
    ${largeFunctions}
};

/** @deprecated Use FActorIterator instead. */
UE_DEPRECATED(5.7, "Use FActorIterator")
class FOldActorIterator {};
`,
    'utf8',
  );
  return buildUeHeaderIndex({
    sourceRoot: join(root, 'Engine', 'Source'),
    engineVersion: '5.7.0',
  });
}

function dependencies(index: UeHeaderIndex, overrides: Partial<QueryUeDocsDependencies> = {}) {
  return {
    resolveLocation: () => ({
      outputRoot: 'C:\\Private\\NeverExpose',
      databaseFileName: 'ue.sqlite',
      cacheKey: 'C:\\Private\\NeverExpose\\ue.sqlite',
    }),
    statMarker: async () => '1:2:3',
    loadIndex: async () => index,
    ...overrides,
  } satisfies QueryUeDocsDependencies;
}

function payload(result: Awaited<ReturnType<ReturnType<typeof createQueryUeDocsHandler>>>) {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe('query_ue_docs MCP boundary', () => {
  it('is registered exactly once and discoverable in the docs domain from the canonical #319 catalogue', async () => {
    const descriptors = STATIC_TOOL_CATALOGUE.filter((descriptor) => descriptor.name === 'query_ue_docs');
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.schema).toBe(schema.shape);
    expect(descriptors[0]).toMatchObject({ cost: 'low', niche: 'docs' });
    expect(captureStaticToolCatalogue({}).get('query_ue_docs')?.dir).toBe('docs');
    recordToolSchema(descriptors[0]!);
    const categories = payload(await listToolCategoriesHandler({}, {}));
    const docs = (categories.domains as Array<{ domain: string; callable: string[] }>).find(
      (domain) => domain.domain === 'docs',
    );
    expect(docs?.callable).toContain('query_ue_docs');
    expect((categories.domains as Array<{ domain: string }>).some((domain) => domain.domain === 'query')).toBe(false);
  });

  it('returns signatures, includes, source context and explicit deprecation guidance without private paths', async () => {
    const index = await fixtureIndex();
    const handler = createQueryUeDocsHandler(dependencies(index));
    const result = await handler({ query: 'Actor Iterator', mode: 'keyword', limit: 10 }, {});
    const body = payload(result);

    expect(result.isError).not.toBe(true);
    expect(body).toMatchObject({
      ok: true,
      mode: 'keyword',
      semantic_available: false,
      corpus: {
        engine_version: '5.7.0',
        complete: true,
        fingerprint_sha256: index.metadata.fingerprint_sha256,
      },
    });
    const results = body.results as Array<Record<string, unknown>>;
    expect(results[0]).toMatchObject({
      name: 'FActorIterator',
      include: 'ActorIterator.h',
      deprecated: false,
    });
    expect(results.some((entry) => entry.name === 'FOldActorIterator' && entry.deprecated === true)).toBe(true);
    expect(body.warnings).toContain(
      'Deprecated API results are included for diagnosis; prefer a non-deprecated result or its replacement message.',
    );
    expect(result.content[0]!.text).not.toContain('NeverExpose');
    expect(result.content[0]!.text).not.toContain('C:\\');
  });

  it('supports declaring-type and symbol-kind filters', async () => {
    const index = await fixtureIndex();
    const handler = createQueryUeDocsHandler(dependencies(index));
    const body = payload(
      await handler({ query: 'iterate', class_filter: 'FActorIterator', kind_filter: 'function', limit: 5 }, {}),
    );
    expect((body.results as Array<Record<string, unknown>>).map(({ owner, name }) => [owner, name])).toEqual([
      ['FActorIterator', 'Iterate'],
    ]);
  });

  it('fails closed on hostile or unsupported input without echoing it', async () => {
    const index = await fixtureIndex();
    const handler = createQueryUeDocsHandler(dependencies(index));
    for (const args of [
      { query: `actor\u0000SECRET_VALUE` },
      { query: 'actor', mode: 'semantic' },
      { query: 'actor', unexpected: 'SECRET_VALUE' },
      { query: 'x'.repeat(257) },
    ]) {
      const result = await handler(args, {});
      expect(result.isError).toBe(true);
      expect(payload(result)).toMatchObject({ ok: false, code: 'invalid_input' });
      expect(result.content[0]!.text).not.toContain('SECRET_VALUE');
    }
  });

  it('classifies database failures with recovery but never returns configured paths or raw causes', async () => {
    const index = await fixtureIndex();
    const handler = createQueryUeDocsHandler(
      dependencies(index, {
        loadIndex: async () => {
          throw new UeHeaderDatabaseError(
            'corrupt_database',
            'C:\\Private\\NeverExpose\\ue.sqlite contained SECRET_ROW',
          );
        },
      }),
    );
    const result = await handler({ query: 'Actor' }, {});
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({
      ok: false,
      code: 'ue_docs_database_corrupt',
      recovery: expect.stringContaining('atomic publisher'),
    });
    expect(result.content[0]!.text).not.toMatch(/NeverExpose|SECRET_ROW|C:\\/u);
  });

  it('coalesces concurrent loads, caches an unchanged database and reloads after replacement', async () => {
    const index = await fixtureIndex();
    let marker = 'first';
    const loadIndex = vi.fn(async () => index);
    const handler = createQueryUeDocsHandler(
      dependencies(index, {
        statMarker: async () => marker,
        loadIndex,
      }),
    );

    await Promise.all([handler({ query: 'Actor' }, {}), handler({ query: 'Iterator' }, {})]);
    await handler({ query: 'Actor' }, {});
    expect(loadIndex).toHaveBeenCalledTimes(1);
    marker = 'replacement';
    await handler({ query: 'Actor' }, {});
    expect(loadIndex).toHaveBeenCalledTimes(2);
  });

  it('caps the exact pretty-printed MCP payload, not only the compact internal search result', async () => {
    // A UTF-16 character count is not a UTF-8 transport budget. Multibyte source comments make
    // that difference material, so this fixture pins the actual serialized byte count.
    const index = await fixtureIndex(80, '🧭'.repeat(700));
    const handler = createQueryUeDocsHandler(dependencies(index));
    const result = await handler({ query: 'Function', limit: 50 }, {});
    const body = payload(result);
    expect(Buffer.byteLength(result.content[0]!.text, 'utf8')).toBeLessThanOrEqual(96 * 1024);
    expect(body).toMatchObject({ ok: true, capped: true });
    expect(body.cap_reasons).toContain('response_budget');
    expect(body.returned).toBeLessThan(50);
  });

  it('gives an actionable no-result tip rather than implying the API does not exist', async () => {
    const index = await fixtureIndex();
    const handler = createQueryUeDocsHandler(dependencies(index));
    const body = payload(await handler({ query: 'DefinitelyNotAnApi' }, {}));
    expect(body).toMatchObject({ ok: true, returned: 0, matched: 0 });
    expect(body.tips).toContain(
      'Try the exact C++ symbol, remove class_filter, or use docs_search for live reflected class names.',
    );
  });
});
