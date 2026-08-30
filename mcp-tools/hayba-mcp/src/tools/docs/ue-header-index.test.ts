import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildUeHeaderIndex,
  containsOnlyReflectionMacros,
  parseUeHeader,
  resolveUeHeaderIndexBudgets,
  searchUeHeaderIndex,
  type UeHeaderIndex,
} from './ue-header-index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporarySourceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hayba-ue-docs-'));
  roots.push(root);
  const source = join(root, 'Engine', 'Source');
  await mkdir(source, { recursive: true });
  return source;
}

const HEADER = `#pragma once

/** A small actor used to pin the header indexer's extraction contract. */
UCLASS(BlueprintType)
class ENGINE_API AExampleActor final : public UObject
{
    GENERATED_BODY()
public:
    /** Old operation. @deprecated Use NewThing instead. */
    UFUNCTION(meta=(DeprecatedFunction, DeprecationMessage="Use NewThing instead"))
    int32 OldThing(const FString& Name) const;

    /// Legacy operation retained for source compatibility.
    UE_DEPRECATED(5.7, "Use BetterThing")
    static void LegacyThing(int32 Count = 1);

    /** Preferred operation. */
    void NewThing() { DangerousCallInsideBody(); }
};

/** Public mode. */
UENUM()
enum class EExampleMode : uint8 { First, Second };
`;

describe('parseUeHeader', () => {
  it('extracts portable include, owner, signatures, docs and stable deprecations', () => {
    const symbols = parseUeHeader(HEADER, 'Runtime/Engine/Public/GameFramework/ExampleActor.h');

    expect(symbols.map(({ kind, name, owner }) => ({ kind, name, owner }))).toEqual([
      { kind: 'class', name: 'AExampleActor', owner: undefined },
      { kind: 'function', name: 'OldThing', owner: 'AExampleActor' },
      { kind: 'function', name: 'LegacyThing', owner: 'AExampleActor' },
      { kind: 'function', name: 'NewThing', owner: 'AExampleActor' },
      { kind: 'enum', name: 'EExampleMode', owner: undefined },
    ]);

    const actor = symbols[0]!;
    expect(actor.include).toBe('GameFramework/ExampleActor.h');
    expect(actor.include_confidence).toBe('canonical');
    expect(actor.source_scope).toBe('public');
    expect(actor.source_relpath).toBe('Runtime/Engine/Public/GameFramework/ExampleActor.h');
    expect(actor.doc).toContain('small actor');
    expect(actor.extraction).toBe('bounded_heuristic');

    const old = symbols.find((symbol) => symbol.name === 'OldThing')!;
    expect(old.signature).toContain('int32 OldThing(const FString& Name) const;');
    expect(old.deprecated).toBe(true);
    expect(old.deprecation).toEqual({ marker: 'metadata', message: 'Use NewThing instead' });
    expect(old.doc).toContain('@deprecated Use NewThing instead.');

    const legacy = symbols.find((symbol) => symbol.name === 'LegacyThing')!;
    expect(legacy.deprecation).toEqual({
      marker: 'UE_DEPRECATED',
      version: '5.7',
      message: 'Use BetterThing',
    });
    expect(legacy.signature).toContain('UE_DEPRECATED(5.7, "Use BetterThing")');
    expect(symbols.some((symbol) => symbol.name === 'DangerousCallInsideBody')).toBe(false);

    const secondPass = parseUeHeader(HEADER.replace(/\r?\n/gu, '\r\n'), actor.source_relpath);
    expect(secondPass.map((symbol) => symbol.id)).toEqual(symbols.map((symbol) => symbol.id));
  });

  it('caps docs/signatures and rejects an unconfined artifact path', () => {
    const [symbol] = parseUeHeader(
      `/** ${'documentation '.repeat(50)} */\nclass FVeryLong final;`,
      'Runtime/Core/Public/VeryLong.h',
      { maxDocChars: 48, maxSignatureChars: 24, maxSymbols: 1 },
    );
    expect(symbol?.doc?.length).toBeLessThanOrEqual(48);
    expect(symbol?.signature.length).toBeLessThanOrEqual(24);
    expect(() => parseUeHeader('class FEscape;', '../private/header.h')).toThrow(/confined portable/u);
    expect(() => parseUeHeader('class FEscape;', 'C:\\private\\header.h')).toThrow(/confined portable/u);
  });

  it('does not turn control flow or UE declaration macros into function records', () => {
    const symbols = parseUeHeader(
      `DECLARE_DELEGATE_OneParam(FOnThing, int32);\n` +
        `static_assert(sizeof(int32) == 4);\n` +
        `class FOkay { public: void Real(); };`,
      'Runtime/Core/Public/Okay.h',
    );
    expect(symbols.map((symbol) => symbol.name)).toEqual(['FOkay', 'Real']);
  });

  it('recognizes reflected type deprecation metadata without requiring a C++ macro', () => {
    const [symbol] = parseUeHeader(
      `UCLASS(Deprecated, meta=(DeprecationMessage="Use UNewThing"))\nclass UOldThing {};`,
      'Runtime/Engine/Classes/OldThing.h',
    );
    expect(symbol).toMatchObject({
      name: 'UOldThing',
      deprecated: true,
      deprecation: { marker: 'metadata', message: 'Use UNewThing' },
      source_scope: 'classes',
      include: 'OldThing.h',
    });
  });

  it('scans reflection macro chains without backtracking across malformed repetitions', () => {
    expect(containsOnlyReflectionMacros('UCLASS() UENUM(meta=(Bitflags))')).toBe(true);
    expect(containsOnlyReflectionMacros(')UENUM('.repeat(5_000))).toBe(false);

    const valid = parseUeHeader(
      `/** Reflected and deprecated. */\nUCLASS() UE_DEPRECATED(5.8, "Use UNewThing")\nclass UOldThing {};`,
      'Runtime/Engine/Public/OldThing.h',
    );
    expect(valid[0]?.doc).toContain('Reflected and deprecated');

    const malformed = parseUeHeader(
      `/** Must not attach. */\n${')UENUM('.repeat(5_000)}\nclass UMalformedThing {};`,
      'Runtime/Engine/Public/MalformedThing.h',
    );
    expect(malformed.some((symbol) => symbol.name === 'UMalformedThing')).toBe(true);
  });

  it('redacts private absolute paths embedded in otherwise public comments and signatures', () => {
    const symbols = parseUeHeader(
      String.raw`/** Generated from C:\Users\Alice\Secret\Engine. */
class FPortable {
public:
    void Load(const TCHAR* Path = TEXT("C:\Users\Alice\Secret\Settings.ini"));
};`,
      'Runtime/Core/Public/Portable.h',
    );
    const artifact = JSON.stringify(symbols);
    expect(artifact).toContain('[absolute-path]');
    expect(artifact).not.toContain('Alice');
    expect(artifact).not.toContain('C:\\');
  });
});

describe('buildUeHeaderIndex', () => {
  it('walks deterministically, skips symlinks and oversized files, and leaks no source root', async () => {
    const sourceRoot = await temporarySourceRoot();
    const publicDir = join(sourceRoot, 'Runtime', 'Engine', 'Public', 'GameFramework');
    const privateDir = join(sourceRoot, 'Runtime', 'Engine', 'Private');
    await mkdir(publicDir, { recursive: true });
    await mkdir(privateDir, { recursive: true });
    await writeFile(join(publicDir, 'Zed.h'), 'class FZed {};\n', 'utf8');
    await writeFile(join(publicDir, 'Actor.h'), HEADER, 'utf8');
    await writeFile(join(privateDir, 'PrivateThing.h'), 'struct FPrivateThing {};\n', 'utf8');
    await writeFile(join(privateDir, 'TooLarge.h'), `class FTooLarge {};${'x'.repeat(2_000)}`, 'utf8');

    const outside = join(sourceRoot, '..', '..', 'outside-secret.h');
    await writeFile(outside, 'class FOutsideSecret {};\n', 'utf8');
    let symlinkCreated = false;
    try {
      await symlink(outside, join(publicDir, 'Outside.h'), 'file');
      symlinkCreated = true;
    } catch (error) {
      // Windows without Developer Mode may forbid unprivileged symlink creation. Confinement is
      // still pinned by parseUeHeader's portable-path rejection and the artifact leak assertion.
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }

    const budgets = { maxFileBytes: 1_000 };
    const first = await buildUeHeaderIndex({ sourceRoot, engineVersion: '5.7.0', budgets });
    const second = await buildUeHeaderIndex({ sourceRoot, engineVersion: '5.7.0', budgets });

    expect(second).toEqual(first);
    expect(first.metadata.fingerprint_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.metadata.engine_version).toBe('5.7.0');
    expect(first.metadata.parser).toBe('bounded_heuristic');
    expect(first.metadata.search).toEqual({ keyword: true, semantic: false });
    expect(first.metadata.skip_counts.file_too_large).toBe(1);
    if (symlinkCreated) expect(first.metadata.skip_counts.symlink).toBe(1);
    expect(first.symbols.some((symbol) => symbol.name === 'FOutsideSecret')).toBe(false);
    expect(first.symbols.some((symbol) => symbol.name === 'FTooLarge')).toBe(false);
    expect(first.symbols.find((symbol) => symbol.name === 'FPrivateThing')).toMatchObject({
      include: 'PrivateThing.h',
      include_confidence: 'private',
      source_scope: 'private',
    });

    const artifact = JSON.stringify(first);
    expect(artifact).not.toContain(sourceRoot);
    expect(artifact).not.toContain(outside);
    expect(first.symbols.map((symbol) => symbol.source_relpath)).toEqual(
      [...first.symbols.map((symbol) => symbol.source_relpath)].sort((a, b) => a.localeCompare(b, 'en')),
    );
  });

  it('reports budget truncation honestly instead of silently returning a partial corpus', async () => {
    const sourceRoot = await temporarySourceRoot();
    await writeFile(join(sourceRoot, 'A.h'), 'class FA {};\n', 'utf8');
    await writeFile(join(sourceRoot, 'B.h'), 'class FB {};\n', 'utf8');

    const result = await buildUeHeaderIndex({ sourceRoot, budgets: { maxFiles: 1 } });
    expect(result.metadata.truncated).toBe(true);
    expect(result.metadata.skip_counts.file_limit).toBe(1);
    expect(result.metadata.files_indexed).toBe(1);
    expect(result.metadata.symbols_indexed).toBe(1);
  });

  it('does not call an exact symbol-budget fit truncated', async () => {
    const sourceRoot = await temporarySourceRoot();
    await writeFile(join(sourceRoot, 'Only.h'), 'class FOnly {};\n', 'utf8');
    const result = await buildUeHeaderIndex({ sourceRoot, budgets: { maxSymbols: 1 } });
    expect(result.metadata.symbols_indexed).toBe(1);
    expect(result.metadata.skip_counts.symbol_limit).toBe(0);
    expect(result.metadata.truncated).toBe(false);
  });

  it('rejects budgets that could bypass hard process limits', () => {
    expect(() => resolveUeHeaderIndexBudgets({ maxFiles: 0 })).toThrow(/positive safe integer/u);
    expect(() => resolveUeHeaderIndexBudgets({ maxFileBytes: Number.MAX_SAFE_INTEGER })).toThrow(/no greater/u);
  });

  it('rejects an engine version label that could smuggle an installation path into metadata', async () => {
    const sourceRoot = await temporarySourceRoot();
    await expect(buildUeHeaderIndex({ sourceRoot, engineVersion: 'C:\\Private\\UE_5.7' })).rejects.toThrow(
      /portable version label/u,
    );
  });
});

function fixtureIndex(): UeHeaderIndex {
  const symbols = parseUeHeader(
    `class FActorIterator {\npublic:\n/** Iterates live actors without allocating an array. */\nvoid Iterate();\n};\n` +
      `/** @deprecated Use FActorIterator. */\nclass FDeprecatedActorIterator {};\n` +
      `class FUnrelated {};`,
    'Runtime/Engine/Public/EngineUtils.h',
  );
  return {
    metadata: {
      schema_version: 1,
      indexer_version: 'test',
      engine_version: '5.7',
      source_kind: 'Engine/Source',
      parser: 'bounded_heuristic',
      search: { keyword: true, semantic: false },
      files_seen: 1,
      files_indexed: 1,
      bytes_indexed: 1,
      symbols_indexed: symbols.length,
      truncated: false,
      skip_counts: {
        directory_entry_limit: 0,
        file_limit: 0,
        file_too_large: 0,
        io_error: 0,
        path_too_long: 0,
        symbol_limit: 0,
        symlink: 0,
        total_byte_limit: 0,
        walk_depth: 0,
      },
      budgets: resolveUeHeaderIndexBudgets(),
      fingerprint_sha256: 'test',
    },
    symbols,
  };
}

describe('searchUeHeaderIndex', () => {
  it('ranks deterministically, exposes deprecation and supports class/kind filters', () => {
    const index = fixtureIndex();
    const first = searchUeHeaderIndex(index, 'Actor Iterator');
    const second = searchUeHeaderIndex(index, 'Actor Iterator');
    expect(second).toEqual(first);
    expect(first.mode).toBe('keyword');
    expect(first.semantic_available).toBe(false);
    expect(first.hits[0]?.name).toBe('FActorIterator');
    expect(first.hits.some((hit) => hit.deprecated)).toBe(true);

    const functions = searchUeHeaderIndex(index, 'iterate', {
      classFilter: 'FActorIterator',
      kindFilter: 'function',
    });
    expect(functions.hits.map((hit) => [hit.owner, hit.name])).toEqual([['FActorIterator', 'Iterate']]);
  });

  it('enforces query, result and serialized-output budgets with explicit cap reasons', () => {
    const index = fixtureIndex();
    expect(() => searchUeHeaderIndex(index, 'x'.repeat(257))).toThrow(/exceeds 256/u);
    expect(() => searchUeHeaderIndex(index, '***')).toThrow(/searchable/u);

    const limited = searchUeHeaderIndex(index, 'actor', { limit: 1 });
    expect(limited).toMatchObject({ returned: 1, capped: true });
    expect(limited.cap_reasons).toContain('limit');

    const outputLimited = searchUeHeaderIndex(index, 'actor', { maxOutputChars: 512 });
    expect(outputLimited.capped).toBe(true);
    expect(outputLimited.cap_reasons).toContain('output_budget');
    expect(JSON.stringify(outputLimited).length).toBeLessThanOrEqual(512);
  });
});
