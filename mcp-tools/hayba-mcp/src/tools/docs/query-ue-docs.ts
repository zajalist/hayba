import { lstat } from 'node:fs/promises';
import { dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { errorResult, okResult } from '../tool-result.js';
import type { ToolHandler } from '../types.js';
import { loadUeHeaderDatabase, UeHeaderDatabaseError, type UeHeaderDatabaseLocation } from './ue-header-database.js';
import { searchUeHeaderIndex, type UeHeaderIndex } from './ue-header-index.js';

const MAX_RESPONSE_BYTES = 96 * 1024;
const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(MODULE_DIRECTORY, '..', '..', '..');

const trimmedQuery = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim().length > 0, 'must contain searchable text')
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'must not contain control characters')
  .transform((value) => value.trim());

const trimmedClass = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0, 'must name a class')
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'must not contain control characters')
  .transform((value) => value.trim());

export const schema = z
  .object({
    query: trimmedQuery.describe(
      'UE C++ API name or concept. Examples: "FActorIterator", "iterate actors", "deprecated navigation".',
    ),
    class_filter: trimmedClass
      .optional()
      .describe('Optional declaring class/type filter, for example "AActor" or "FActorIterator".'),
    kind_filter: z
      .enum(['class', 'struct', 'enum', 'function'])
      .optional()
      .describe('Optional symbol kind. Omit to search classes, structs, enums and functions together.'),
    mode: z
      .literal('keyword')
      .optional()
      .default('keyword')
      .describe('Search mode. This database currently supports honest deterministic keyword search only.'),
    limit: z.number().int().min(1).max(50).optional().default(20).describe('Maximum results, from 1 to 50.'),
  })
  .strict();

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  pack: 'docs',
  when: 'you need a UE C++ signature, include path, doc context, or deprecation warning before generating code',
  not_when: 'you need live reflected Blueprint/editor properties — use docs_lookup_api for the loaded editor instead',
};

interface ResolvedDatabaseLocation extends UeHeaderDatabaseLocation {
  /** Internal cache identity. It is never included in an MCP result or error. */
  cacheKey: string;
}

export interface QueryUeDocsDependencies {
  resolveLocation(): ResolvedDatabaseLocation;
  statMarker(location: ResolvedDatabaseLocation): Promise<string>;
  loadIndex(location: ResolvedDatabaseLocation): Promise<UeHeaderIndex>;
}

function configuredLocation(): ResolvedDatabaseLocation {
  const override = process.env.HAYBA_UE_DOCS_DB?.trim();
  if (override && (override.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(override))) {
    throw new UeHeaderDatabaseError('invalid_location', 'configured UE docs database path is invalid');
  }
  const fullPath = resolve(override || resolve(PACKAGE_ROOT, 'data', 'ue-docs-5.7.sqlite'));
  return {
    outputRoot: dirname(fullPath),
    databaseFileName: basename(fullPath),
    cacheKey: fullPath,
  };
}

async function databaseStatMarker(location: ResolvedDatabaseLocation): Promise<string> {
  const stat = await lstat(resolve(location.outputRoot, location.databaseFileName));
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new UeHeaderDatabaseError('invalid_location', 'configured UE docs database is not a regular file');
  }
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

const defaultDependencies: QueryUeDocsDependencies = {
  resolveLocation: configuredLocation,
  statMarker: databaseStatMarker,
  loadIndex: (location) =>
    loadUeHeaderDatabase({
      outputRoot: location.outputRoot,
      databaseFileName: location.databaseFileName,
      budgets: {
        maxSymbols: 1_000_000,
        maxStoredTextChars: 256 * 1024 * 1024,
        maxDatabaseBytes: 1024 * 1024 * 1024,
      },
    }),
};

function databaseErrorResult(error: unknown) {
  if (!(error instanceof UeHeaderDatabaseError)) {
    return errorResult('query_ue_docs: the UE documentation database could not be read safely', {
      code: 'ue_docs_database_unavailable',
      recovery: 'Run the bounded UE docs rebuild CLI, then retry. No database path is included in this response.',
    });
  }
  const details: Record<UeHeaderDatabaseError['code'], { code: string; message: string; recovery: string }> = {
    aborted: {
      code: 'ue_docs_cancelled',
      message: 'query_ue_docs: database loading was cancelled',
      recovery: 'Retry when the server is not shutting down.',
    },
    budget_exceeded: {
      code: 'ue_docs_database_too_large',
      message: 'query_ue_docs: the configured database exceeds a safe read budget',
      recovery: 'Rebuild with the bounded CLI or raise the server-side budget after reviewing the corpus size.',
    },
    corrupt_database: {
      code: 'ue_docs_database_corrupt',
      message: 'query_ue_docs: the configured database failed integrity or record validation',
      recovery: 'Run the bounded UE docs rebuild CLI; the atomic publisher replaces it only after verification.',
    },
    invalid_index: {
      code: 'ue_docs_database_invalid',
      message: 'query_ue_docs: the configured database contains an invalid index',
      recovery: 'Rebuild it from Engine/Source with the current indexer.',
    },
    invalid_location: {
      code: 'ue_docs_database_location_rejected',
      message: 'query_ue_docs: the configured database location was rejected by path confinement',
      recovery: 'Set HAYBA_UE_DOCS_DB to one regular .sqlite file under a non-symlink directory.',
    },
    io_failure: {
      code: 'ue_docs_database_missing',
      message: 'query_ue_docs: no readable UE documentation database is installed',
      recovery: 'Run the bounded UE docs rebuild CLI for your Engine/Source tree, then retry.',
    },
    publish_failed: {
      code: 'ue_docs_database_busy',
      message: 'query_ue_docs: the documentation database is busy or has live SQLite sidecars',
      recovery: 'Let the rebuild finish or close its writer, then retry.',
    },
    schema_mismatch: {
      code: 'ue_docs_database_schema_mismatch',
      message: 'query_ue_docs: the database schema belongs to a different indexer version',
      recovery: 'Rebuild it with the current bounded UE docs CLI.',
    },
  };
  const detail = details[error.code];
  return errorResult(detail.message, { code: detail.code, recovery: detail.recovery });
}

function boundedSuccessPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const results = payload.results as unknown[];
  // okResult pretty-prints with two-space indentation, so budget the exact wire text rather than a
  // smaller compact approximation. Buffer.byteLength is intentional: JS string length counts
  // UTF-16 code units, while the MCP transport carries UTF-8 bytes. Non-ASCII source comments can
  // otherwise exceed the advertised cap by several times.
  const wireBytes = () => Buffer.byteLength(JSON.stringify(payload, null, 2), 'utf8');
  while (results.length > 0 && wireBytes() > MAX_RESPONSE_BYTES) results.pop();
  if (wireBytes() > MAX_RESPONSE_BYTES) {
    // All variable-sized result records are gone; fixed metadata is intentionally tiny. This is a
    // final invariant check rather than a reachable normal path.
    return {
      ok: false,
      error: 'query_ue_docs: response metadata exceeded its safety budget',
      code: 'ue_docs_response_budget',
    };
  }
  const originalReturned = payload.returned as number;
  if (results.length < originalReturned) {
    payload.returned = results.length;
    payload.capped = true;
    const reasons = new Set(payload.cap_reasons as string[]);
    reasons.add('response_budget');
    payload.cap_reasons = [...reasons].sort();
  }
  return payload;
}

export function createQueryUeDocsHandler(dependencies: QueryUeDocsDependencies = defaultDependencies): ToolHandler {
  let cached: { cacheKey: string; marker: string; index: UeHeaderIndex } | undefined;
  let pending: { cacheKey: string; marker: string; load: Promise<UeHeaderIndex> } | undefined;

  return async (rawArgs) => {
    const parsed = schema.safeParse(rawArgs);
    if (!parsed.success) {
      return errorResult('query_ue_docs: invalid input', {
        code: 'invalid_input',
        issues: parsed.error.issues.slice(0, 8).map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
        })),
      });
    }

    let index: UeHeaderIndex;
    try {
      const location = dependencies.resolveLocation();
      const marker = await dependencies.statMarker(location);
      if (cached?.cacheKey === location.cacheKey && cached.marker === marker) index = cached.index;
      else {
        if (!pending || pending.cacheKey !== location.cacheKey || pending.marker !== marker) {
          pending = { cacheKey: location.cacheKey, marker, load: dependencies.loadIndex(location) };
        }
        index = await pending.load;
        cached = { cacheKey: location.cacheKey, marker, index };
        pending = undefined;
      }
    } catch (error) {
      pending = undefined;
      return databaseErrorResult(error);
    }

    const result = searchUeHeaderIndex(index, parsed.data.query, {
      classFilter: parsed.data.class_filter,
      kindFilter: parsed.data.kind_filter,
      limit: parsed.data.limit,
      maxQueryChars: 256,
      // The indexer's character budget is a first-pass bound. The exact UTF-8 envelope is enforced
      // immediately below after provenance, warnings and pretty-print whitespace are included.
      maxOutputChars: MAX_RESPONSE_BYTES,
    });
    const warnings: string[] = [];
    const tips: string[] = [];
    if (index.metadata.truncated) {
      warnings.push(
        'The indexed corpus is partial because one or more build budgets were reached; absence is not proof that an API does not exist.',
      );
    }
    if (result.hits.some((hit) => hit.deprecated)) {
      warnings.push(
        'Deprecated API results are included for diagnosis; prefer a non-deprecated result or its replacement message.',
      );
    }
    if (result.hits.length === 0) {
      tips.push('Try the exact C++ symbol, remove class_filter, or use docs_search for live reflected class names.');
    }
    const payload = boundedSuccessPayload({
      ok: true,
      query: result.query,
      mode: result.mode,
      semantic_available: false,
      corpus: {
        engine_version: index.metadata.engine_version,
        indexer_version: index.metadata.indexer_version,
        schema_version: index.metadata.schema_version,
        fingerprint_sha256: index.metadata.fingerprint_sha256,
        complete: !index.metadata.truncated,
      },
      results: result.hits,
      returned: result.returned,
      matched: result.matched,
      capped: result.capped,
      cap_reasons: result.cap_reasons,
      ...(warnings.length ? { warnings } : {}),
      ...(tips.length ? { tips } : {}),
    });
    return payload.ok === false ? errorResult(payload.error as string, { code: payload.code }) : okResult(payload);
  };
}

export const queryUeDocsHandler: ToolHandler = createQueryUeDocsHandler();
