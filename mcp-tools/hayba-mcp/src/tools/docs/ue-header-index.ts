import { createHash } from 'node:crypto';
import { open, lstat, realpath, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Pure, deterministic foundation for the UE documentation index.
 *
 * This module deliberately does not know about MCP registration, SQLite, embeddings or the
 * editor.  It turns a confined Engine/Source tree into bounded, portable records and provides
 * the keyword half of search.  Keeping this seam independent makes the security properties
 * testable before a database or network-facing tool is allowed to consume it.
 */

export const UE_HEADER_INDEX_SCHEMA_VERSION = 1;
export const UE_HEADER_INDEXER_VERSION = 'bounded-header-v1';

export type UeHeaderSymbolKind = 'class' | 'struct' | 'enum' | 'function';
export type UeHeaderSourceScope = 'public' | 'classes' | 'private' | 'source';

export interface UeDeprecation {
  marker: 'UE_DEPRECATED' | 'UE_DEPRECATED_FORGAME' | 'metadata' | 'doc';
  version?: string;
  message?: string;
}

export interface UeHeaderSymbol {
  /** Stable across machines: it is derived only from portable record fields. */
  id: string;
  kind: UeHeaderSymbolKind;
  name: string;
  owner?: string;
  signature: string;
  include: string;
  include_confidence: 'canonical' | 'private' | 'fallback';
  source_relpath: string;
  source_scope: UeHeaderSourceScope;
  line: number;
  doc?: string;
  deprecated: boolean;
  deprecation?: UeDeprecation;
  /** Extraction is intentionally honest: this first indexer is not a C++ compiler. */
  extraction: 'bounded_heuristic';
}

export interface UeHeaderIndexBudgets {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxSymbols: number;
  maxDocChars: number;
  maxSignatureChars: number;
  maxRelativePathChars: number;
  maxWalkDepth: number;
  maxEntriesPerDirectory: number;
}

export interface UeHeaderIndexMetadata {
  schema_version: number;
  indexer_version: string;
  engine_version: string | null;
  source_kind: 'Engine/Source';
  parser: 'bounded_heuristic';
  search: { keyword: true; semantic: false };
  files_seen: number;
  files_indexed: number;
  bytes_indexed: number;
  symbols_indexed: number;
  truncated: boolean;
  skip_counts: Record<UeHeaderSkipReason, number>;
  budgets: UeHeaderIndexBudgets;
  fingerprint_sha256: string;
}

export interface UeHeaderIndex {
  metadata: UeHeaderIndexMetadata;
  symbols: UeHeaderSymbol[];
}

export type UeHeaderSkipReason =
  | 'directory_entry_limit'
  | 'file_limit'
  | 'file_too_large'
  | 'io_error'
  | 'path_too_long'
  | 'symbol_limit'
  | 'symlink'
  | 'total_byte_limit'
  | 'walk_depth';

export interface BuildUeHeaderIndexOptions {
  /** Absolute or relative path to the directory represented in metadata as Engine/Source. */
  sourceRoot: string;
  /** Supplied by the caller/build script; never guessed from a private installation path. */
  engineVersion?: string;
  budgets?: Partial<UeHeaderIndexBudgets>;
}

export interface UeHeaderSearchOptions {
  classFilter?: string;
  kindFilter?: UeHeaderSymbolKind | readonly UeHeaderSymbolKind[];
  limit?: number;
  maxQueryChars?: number;
  maxOutputChars?: number;
}

export interface UeHeaderSearchHit extends UeHeaderSymbol {
  score: number;
}

export interface UeHeaderSearchResult {
  query: string;
  mode: 'keyword';
  semantic_available: false;
  hits: UeHeaderSearchHit[];
  returned: number;
  matched: number;
  capped: boolean;
  cap_reasons: Array<'limit' | 'output_budget'>;
}

const DEFAULT_BUDGETS: UeHeaderIndexBudgets = {
  maxFiles: 250_000,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxSymbols: 1_000_000,
  maxDocChars: 2_048,
  maxSignatureChars: 4_096,
  maxRelativePathChars: 512,
  maxWalkDepth: 48,
  maxEntriesPerDirectory: 50_000,
};

const HARD_MAX_BUDGETS: UeHeaderIndexBudgets = {
  maxFiles: 500_000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
  maxSymbols: 2_000_000,
  maxDocChars: 16_384,
  maxSignatureChars: 16_384,
  maxRelativePathChars: 1_024,
  maxWalkDepth: 96,
  maxEntriesPerDirectory: 100_000,
};

const SKIP_REASONS: readonly UeHeaderSkipReason[] = [
  'directory_entry_limit',
  'file_limit',
  'file_too_large',
  'io_error',
  'path_too_long',
  'symbol_limit',
  'symlink',
  'total_byte_limit',
  'walk_depth',
];

function boundedInteger(name: keyof UeHeaderIndexBudgets, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > HARD_MAX_BUDGETS[name]) {
    throw new Error(`${name} must be a positive safe integer no greater than ${HARD_MAX_BUDGETS[name]}`);
  }
  return value;
}

export function resolveUeHeaderIndexBudgets(overrides: Partial<UeHeaderIndexBudgets> = {}): UeHeaderIndexBudgets {
  const resolved = { ...DEFAULT_BUDGETS };
  for (const name of Object.keys(DEFAULT_BUDGETS) as Array<keyof UeHeaderIndexBudgets>) {
    const value = overrides[name];
    if (value !== undefined) resolved[name] = boundedInteger(name, value);
  }
  return resolved;
}

function portablePath(value: string): string {
  return value.split(sep).join('/');
}

/** Locale-independent UTF-16 code-unit ordering for reproducible artifacts. */
function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function compactWhitespace(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function sanitizeArtifactText(value: string): string {
  return value
    .replace(/\b[A-Za-z]:[\\/][^\s"'`<>]+/gu, '[absolute-path]')
    .replace(/\\{2}[A-Za-z0-9.$_-]+[\\/][^\s"'`<>]+/gu, '[absolute-path]')
    .replace(/(^|\s)\/(?:Users|home|root|tmp|mnt|private\/var)\/[^\s"'`<>]+/gu, '$1[absolute-path]');
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function stableId(symbol: Omit<UeHeaderSymbol, 'id'>): string {
  return createHash('sha256')
    .update(
      [symbol.source_relpath, String(symbol.line), symbol.kind, symbol.owner ?? '', symbol.name, symbol.signature].join(
        '\0',
      ),
      'utf8',
    )
    .digest('hex')
    .slice(0, 24);
}

export function fingerprintUeHeaderSymbols(symbols: readonly UeHeaderSymbol[]): string {
  // Fingerprint field values, not JavaScript object insertion order. SQLite reconstruction and
  // JSON importers are allowed to materialize the same record with a different property order.
  const canonical = symbols.map((symbol) => [
    symbol.id,
    symbol.kind,
    symbol.name,
    symbol.owner ?? null,
    symbol.signature,
    symbol.include,
    symbol.include_confidence,
    symbol.source_relpath,
    symbol.source_scope,
    symbol.line,
    symbol.doc ?? null,
    symbol.deprecated,
    symbol.deprecation?.marker ?? null,
    symbol.deprecation?.version ?? null,
    symbol.deprecation?.message ?? null,
    symbol.extraction,
  ]);
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

function includeMetadata(sourceRelpath: string): {
  include: string;
  include_confidence: UeHeaderSymbol['include_confidence'];
  source_scope: UeHeaderSourceScope;
} {
  const parts = sourceRelpath.split('/');
  for (const marker of ['Public', 'Classes'] as const) {
    const index = parts.lastIndexOf(marker);
    if (index >= 0 && index + 1 < parts.length) {
      return {
        include: parts.slice(index + 1).join('/'),
        include_confidence: 'canonical',
        source_scope: marker === 'Public' ? 'public' : 'classes',
      };
    }
  }
  const privateIndex = parts.lastIndexOf('Private');
  if (privateIndex >= 0 && privateIndex + 1 < parts.length) {
    return {
      include: parts.slice(privateIndex + 1).join('/'),
      include_confidence: 'private',
      source_scope: 'private',
    };
  }
  return { include: sourceRelpath, include_confidence: 'fallback', source_scope: 'source' };
}

interface CommentBlock {
  endLine: number;
  text: string;
}

/** Replace comments with spaces while retaining line positions, and keep bounded doc text. */
function stripComments(source: string, maxDocChars: number): { code: string; docs: CommentBlock[] } {
  let code = '';
  const docs: CommentBlock[] = [];
  let line = 1;
  let i = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  while (i < source.length) {
    const char = source[i]!;
    const next = source[i + 1] ?? '';
    if (quote) {
      code += char;
      if (char === '\n') line++;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      i++;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      code += char;
      i++;
      continue;
    }
    if (char === '/' && next === '/') {
      const docLike = source[i + 2] === '/' || source[i + 2] === '!';
      const start = i + (docLike ? 3 : 2);
      let end = start;
      while (end < source.length && source[end] !== '\n') end++;
      if (docLike) {
        const text = truncate(sanitizeArtifactText(compactWhitespace(source.slice(start, end))), maxDocChars);
        if (text) docs.push({ endLine: line, text });
      }
      code += ' '.repeat(end - i);
      i = end;
      continue;
    }
    if (char === '/' && next === '*') {
      const docLike = source[i + 2] === '*' || source[i + 2] === '!';
      const start = i + (docLike ? 3 : 2);
      let end = start;
      while (end + 1 < source.length && !(source[end] === '*' && source[end + 1] === '/')) end++;
      const bodyEnd = end;
      end = Math.min(source.length, end + 2);
      const raw = source.slice(start, bodyEnd);
      if (docLike) {
        const text = truncate(
          sanitizeArtifactText(compactWhitespace(raw.replace(/^\s*\* ?/gmu, '').replace(/\s*\*\/$/u, ''))),
          maxDocChars,
        );
        if (text) docs.push({ endLine: line + (raw.match(/\n/gu)?.length ?? 0), text });
      }
      for (let cursor = i; cursor < end; cursor++) {
        if (source[cursor] === '\n') {
          code += '\n';
          line++;
        } else code += ' ';
      }
      i = end;
      continue;
    }
    code += char;
    if (char === '\n') line++;
    i++;
  }
  return { code, docs };
}

function docForLine(docs: readonly CommentBlock[], codeLines: readonly string[], line: number): string | undefined {
  for (let i = docs.length - 1; i >= 0; i--) {
    const doc = docs[i]!;
    if (doc.endLine >= line) continue;
    if (line - doc.endLine > 8) return undefined;
    const between = codeLines
      .slice(doc.endLine, line - 1)
      .join('\n')
      .trim();
    if (between && !containsOnlyReflectionMacros(compactWhitespace(between))) {
      return undefined;
    }
    return doc.text;
  }
  return undefined;
}

const REFLECTION_MACRO = /(?:UCLASS|USTRUCT|UENUM|UFUNCTION|UE_DEPRECATED(?:_FORGAME)?)\s*\([^;{}]*\)\s*/uy;

export function containsOnlyReflectionMacros(value: string): boolean {
  let offset = 0;
  while (offset < value.length) {
    REFLECTION_MACRO.lastIndex = offset;
    const match = REFLECTION_MACRO.exec(value);
    if (!match || match.index !== offset) return false;
    offset = REFLECTION_MACRO.lastIndex;
  }
  return offset > 0;
}

function unquoteCpp(value: string): string {
  return value.replace(/\\([\\"'])/gu, '$1').trim();
}

function deprecationFrom(declaration: string, doc: string | undefined): UeDeprecation | undefined {
  const macro =
    /\b(UE_DEPRECATED_FORGAME|UE_DEPRECATED)\s*\(\s*([^,)]{1,32})(?:\s*,\s*"((?:\\.|[^"\\]){0,1024})")?/u.exec(
      declaration,
    );
  if (macro) {
    return {
      marker: macro[1] as 'UE_DEPRECATED' | 'UE_DEPRECATED_FORGAME',
      version: compactWhitespace(macro[2]!),
      ...(macro[3] ? { message: unquoteCpp(macro[3]) } : {}),
    };
  }
  if (/\bDeprecatedFunction\b/u.test(declaration) || /\bDeprecatedProperty\b/u.test(declaration)) {
    const message = /\bDeprecationMessage\s*=\s*"((?:\\.|[^"\\]){0,1024})"/u.exec(declaration)?.[1];
    return { marker: 'metadata', ...(message ? { message: unquoteCpp(message) } : {}) };
  }
  if (/\b(?:UCLASS|USTRUCT|UENUM)\s*\([^)]*\bDeprecated\b[^)]*\)/u.test(declaration)) {
    const message = /\bDeprecationMessage\s*=\s*"((?:\\.|[^"\\]){0,1024})"/u.exec(declaration)?.[1];
    return { marker: 'metadata', ...(message ? { message: unquoteCpp(message) } : {}) };
  }
  const docMatch = doc ? /(?:^|\s)@deprecated\s+(.{0,1024})/iu.exec(doc) : undefined;
  if (docMatch) return { marker: 'doc', message: docMatch[1]!.trim() };
  return undefined;
}

function scrubDeclaration(value: string): string {
  return compactWhitespace(
    value
      .replace(/^\s*#.*$/gmu, ' ')
      .replace(/^(?:(?:public|protected|private)\s*:\s*)+/u, '')
      .replace(/\bGENERATED_(?:UCLASS_)?BODY\s*\(\s*\)\s*/gu, ' '),
  );
}

function classLike(declaration: string): { kind: 'class' | 'struct'; name: string } | undefined {
  const match = /\b(class|struct)\s+(.+)$/u.exec(declaration);
  if (!match) return undefined;
  let tail = match[2]!.split(/[:{;]/u, 1)[0]!;
  tail = tail
    .replace(/\bUE_DEPRECATED(?:_FORGAME)?\s*\([^)]*\)/gu, ' ')
    .replace(/\b[A-Z][A-Z0-9_]*_API\b/gu, ' ')
    .replace(/\balignas\s*\([^)]*\)/gu, ' ');
  const identifiers = [...tail.matchAll(/\b[A-Za-z_]\w*\b/gu)]
    .map((entry) => entry[0])
    .filter((name) => !['final', 'UE_NONCOPYABLE'].includes(name));
  const name = identifiers.at(-1);
  if (!name) return undefined;
  return { kind: match[1] as 'class' | 'struct', name };
}

function enumLike(declaration: string): { kind: 'enum'; name: string } | undefined {
  const match = /\benum(?:\s+class)?\s+([A-Za-z_]\w*)/u.exec(declaration);
  return match ? { kind: 'enum', name: match[1]! } : undefined;
}

function functionLike(declaration: string): { kind: 'function'; name: string } | undefined {
  if (!declaration.includes('(') || !declaration.includes(')')) return undefined;
  if (/^(?:if|for|while|switch|catch|return|sizeof|static_assert|typedef|using)\b/u.test(declaration)) {
    return undefined;
  }
  if (/\bDECLARE_[A-Za-z0-9_]+\s*\(/u.test(declaration)) return undefined;

  let parenDepth = 0;
  let angleDepth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < declaration.length; index++) {
    const char = declaration[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '<') angleDepth++;
    else if (char === '>' && angleDepth > 0) angleDepth--;
    else if (char === '(' && parenDepth === 0 && angleDepth === 0) {
      const prefix = declaration.slice(0, index).trimEnd();
      const name = /(?:operator\s*(?:\[\]|\(\)|[^\s(]+)|~?[A-Za-z_]\w*)$/u.exec(prefix)?.[0];
      if (!name) return undefined;
      const compactName = name.replace(/\s+/gu, '');
      if (['UFUNCTION', 'UCLASS', 'USTRUCT', 'UENUM', 'UE_DEPRECATED', 'UE_DEPRECATED_FORGAME'].includes(compactName)) {
        const closing = declaration.indexOf(')', index + 1);
        if (closing < 0) return undefined;
        index = closing;
        continue;
      }
      return { kind: 'function', name: compactName };
    } else if (char === '(') parenDepth++;
    else if (char === ')' && parenDepth > 0) parenDepth--;
  }
  return undefined;
}

interface ClassScope {
  name: string;
  depth: number;
}

/** Parse one already-confined header. Exported so fixtures can pin extraction behavior. */
export function parseUeHeader(
  source: string,
  sourceRelpath: string,
  budgets: Pick<UeHeaderIndexBudgets, 'maxDocChars' | 'maxSignatureChars' | 'maxSymbols'> = DEFAULT_BUDGETS,
): UeHeaderSymbol[] {
  if (isAbsolute(sourceRelpath) || sourceRelpath.includes('..') || sourceRelpath.includes('\\')) {
    throw new Error('sourceRelpath must be a confined portable relative path');
  }
  const pathValue = portablePath(sourceRelpath);
  const include = includeMetadata(pathValue);
  const stripped = stripComments(source, budgets.maxDocChars);
  let inPreprocessorDirective = false;
  const codeLines = stripped.code.split('\n').map((sourceLine) => {
    const startsDirective = /^\s*#/u.test(sourceLine);
    if (!startsDirective && !inPreprocessorDirective) {
      if (/^\s*GENERATED_(?:UCLASS_)?BODY\s*\(\s*\)\s*$/u.test(sourceLine)) {
        return ' '.repeat(sourceLine.length);
      }
      return sourceLine;
    }
    inPreprocessorDirective = /\\\s*$/u.test(sourceLine);
    return ' '.repeat(sourceLine.length);
  });
  const code = codeLines.join('\n');
  const docs = stripped.docs;
  const symbols: UeHeaderSymbol[] = [];
  const scopes: ClassScope[] = [];
  const functionBodies: number[] = [];
  let depth = 0;
  let statement = '';
  let statementLine = 1;
  let line = 1;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const add = (value: string, terminator: ';' | '{'): { openedClass?: { name: string }; openedFunction?: true } => {
    const declaration = scrubDeclaration(value);
    if (!declaration || declaration.length > budgets.maxSignatureChars * 4) return {};
    const doc = docForLine(docs, codeLines, statementLine);
    // `enum class` must be classified before the broader `class` recognizer.
    const enumSymbol = enumLike(declaration);
    const classSymbol = enumSymbol ? undefined : classLike(declaration);
    const functionSymbol = classSymbol || enumSymbol ? undefined : functionLike(declaration);
    const candidate = enumSymbol ?? classSymbol ?? functionSymbol;
    if (!candidate || symbols.length >= budgets.maxSymbols) return {};
    const portableDeclaration = sanitizeArtifactText(declaration);
    const signature = truncate(`${portableDeclaration}${terminator}`, budgets.maxSignatureChars);
    const deprecation = deprecationFrom(portableDeclaration, doc);
    const owner = candidate.kind === 'function' ? scopes.at(-1)?.name : undefined;
    const withoutId: Omit<UeHeaderSymbol, 'id'> = {
      kind: candidate.kind,
      name: candidate.name,
      ...(owner ? { owner } : {}),
      signature,
      ...include,
      source_relpath: pathValue,
      line: statementLine,
      ...(doc ? { doc } : {}),
      deprecated: deprecation !== undefined,
      ...(deprecation ? { deprecation } : {}),
      extraction: 'bounded_heuristic',
    };
    symbols.push({ id: stableId(withoutId), ...withoutId });
    if (classSymbol && terminator === '{') return { openedClass: { name: classSymbol.name } };
    if (functionSymbol && terminator === '{') return { openedFunction: true };
    return {};
  };

  for (let index = 0; index < code.length; index++) {
    const char = code[index]!;
    if (quote) {
      if (functionBodies.length === 0) statement += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      if (char === '\n') line++;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      if (functionBodies.length === 0) statement += char;
      continue;
    }
    if (char === '\n') {
      if (functionBodies.length === 0) statement += char;
      line++;
      continue;
    }
    if (char === '{') {
      if (functionBodies.length === 0) {
        const opened = add(statement, '{');
        depth++;
        if (opened.openedClass) scopes.push({ name: opened.openedClass.name, depth });
        if (opened.openedFunction) functionBodies.push(depth);
        statement = '';
        statementLine = line;
      } else depth++;
      continue;
    }
    if (char === '}') {
      if (functionBodies.at(-1) === depth) functionBodies.pop();
      if (scopes.at(-1)?.depth === depth) scopes.pop();
      depth = Math.max(0, depth - 1);
      if (functionBodies.length === 0) {
        statement = '';
        statementLine = line;
      }
      continue;
    }
    if (functionBodies.length > 0) continue;
    if (char === ':' && /^\s*(?:public|protected|private)\s*$/u.test(statement)) {
      statement = '';
      statementLine = line;
      continue;
    }
    if (char === ';') {
      add(statement, ';');
      statement = '';
      statementLine = line;
      continue;
    }
    if (!statement.trim() && !/\s/u.test(char)) statementLine = line;
    statement += char;
    if (statement.length > budgets.maxSignatureChars * 4) {
      statement = '';
      statementLine = line;
    }
  }
  return symbols;
}

function emptySkipCounts(): Record<UeHeaderSkipReason, number> {
  return Object.fromEntries(SKIP_REASONS.map((reason) => [reason, 0])) as Record<UeHeaderSkipReason, number>;
}

async function readBoundedFile(path: string, expectedSize: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const before = await handle.stat();
    if (before.size !== expectedSize) throw new Error('file_changed');
    const buffer = Buffer.allocUnsafe(expectedSize);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== expectedSize || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error('file_changed');
    }
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

export async function buildUeHeaderIndex(options: BuildUeHeaderIndexOptions): Promise<UeHeaderIndex> {
  const budgets = resolveUeHeaderIndexBudgets(options.budgets);
  if (!options.sourceRoot.trim()) throw new Error('sourceRoot is required');
  const requestedRoot = resolve(options.sourceRoot);
  const root = await realpath(requestedRoot);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new Error('sourceRoot must be a directory');
  const engineVersion = options.engineVersion?.trim() || null;
  if (engineVersion && (engineVersion.length > 64 || /[\\/\u0000-\u001f\u007f]/u.test(engineVersion))) {
    throw new Error('engineVersion must be a portable version label of at most 64 characters');
  }
  const skipCounts = emptySkipCounts();
  const symbols: UeHeaderSymbol[] = [];
  let filesSeen = 0;
  let filesIndexed = 0;
  let bytesIndexed = 0;
  let stop = false;

  const walk = async (directory: string, walkDepth: number): Promise<void> => {
    if (stop) return;
    if (walkDepth > budgets.maxWalkDepth) {
      skipCounts.walk_depth++;
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      skipCounts.io_error++;
      return;
    }
    entries.sort((a, b) => stableCompare(a.name, b.name));
    if (entries.length > budgets.maxEntriesPerDirectory) {
      skipCounts.directory_entry_limit += entries.length - budgets.maxEntriesPerDirectory;
      entries = entries.slice(0, budgets.maxEntriesPerDirectory);
    }
    for (const entry of entries) {
      if (stop) return;
      const candidate = resolve(directory, entry.name);
      let stat;
      try {
        stat = await lstat(candidate);
      } catch {
        skipCounts.io_error++;
        continue;
      }
      if (stat.isSymbolicLink()) {
        skipCounts.symlink++;
        continue;
      }
      let canonical: string;
      try {
        canonical = await realpath(candidate);
      } catch {
        skipCounts.io_error++;
        continue;
      }
      if (!isWithin(root, canonical)) {
        skipCounts.symlink++;
        continue;
      }
      if (stat.isDirectory()) {
        await walk(canonical, walkDepth + 1);
        continue;
      }
      if (!stat.isFile() || !entry.name.toLocaleLowerCase('en').endsWith('.h')) continue;
      filesSeen++;
      if (filesSeen > budgets.maxFiles) {
        skipCounts.file_limit++;
        stop = true;
        return;
      }
      const relpath = portablePath(relative(root, canonical));
      if (!relpath || relpath.length > budgets.maxRelativePathChars) {
        skipCounts.path_too_long++;
        continue;
      }
      if (stat.size > budgets.maxFileBytes) {
        skipCounts.file_too_large++;
        continue;
      }
      if (bytesIndexed + stat.size > budgets.maxTotalBytes) {
        skipCounts.total_byte_limit++;
        stop = true;
        return;
      }
      let source: string;
      try {
        source = await readBoundedFile(canonical, stat.size);
      } catch {
        skipCounts.io_error++;
        continue;
      }
      filesIndexed++;
      bytesIndexed += stat.size;
      const remainingSymbols = budgets.maxSymbols - symbols.length;
      if (remainingSymbols <= 0) {
        skipCounts.symbol_limit++;
        stop = true;
        return;
      }
      // Parse one sentinel record beyond the remaining budget. Equal-to-the-limit is not itself
      // evidence of truncation; the sentinel is what lets metadata distinguish exact fit from loss.
      const parsed = parseUeHeader(source, relpath, {
        ...budgets,
        maxSymbols: remainingSymbols + 1,
      });
      symbols.push(...parsed.slice(0, remainingSymbols));
      if (parsed.length > remainingSymbols) {
        skipCounts.symbol_limit++;
        stop = true;
      }
    }
  };

  await walk(root, 0);
  symbols.sort(
    (a, b) =>
      stableCompare(a.source_relpath, b.source_relpath) ||
      a.line - b.line ||
      stableCompare(a.kind, b.kind) ||
      stableCompare(a.name, b.name),
  );
  const fingerprint = fingerprintUeHeaderSymbols(symbols);
  const truncated = Object.values(skipCounts).some((count) => count > 0);
  return {
    metadata: {
      schema_version: UE_HEADER_INDEX_SCHEMA_VERSION,
      indexer_version: UE_HEADER_INDEXER_VERSION,
      engine_version: engineVersion,
      source_kind: 'Engine/Source',
      parser: 'bounded_heuristic',
      search: { keyword: true, semantic: false },
      files_seen: filesSeen,
      files_indexed: filesIndexed,
      bytes_indexed: bytesIndexed,
      symbols_indexed: symbols.length,
      truncated,
      skip_counts: skipCounts,
      budgets,
      fingerprint_sha256: fingerprint,
    },
    symbols,
  };
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en');
}

function scoreSymbol(symbol: UeHeaderSymbol, query: string, terms: readonly string[]): number {
  const name = normalizeSearchText(symbol.name);
  const owner = normalizeSearchText(symbol.owner ?? '');
  const signature = normalizeSearchText(symbol.signature);
  const doc = normalizeSearchText(symbol.doc ?? '');
  let score = 0;
  if (name === query) score += 1_000;
  else if (name.startsWith(query)) score += 650;
  else if (name.includes(query)) score += 450;
  if (owner === query) score += 500;
  else if (owner.includes(query)) score += 250;
  for (const term of terms) {
    if (name === term) score += 220;
    else if (name.includes(term)) score += 120;
    if (owner.includes(term)) score += 70;
    if (signature.includes(term)) score += 35;
    if (doc.includes(term)) score += 15;
  }
  // Prefer the supported spelling when relevance is otherwise close, while an exact search for
  // a deprecated API still finds it. Surfacing the warning is useful; recommending it first is not.
  return score;
}

export function searchUeHeaderIndex(
  index: UeHeaderIndex,
  rawQuery: string,
  options: UeHeaderSearchOptions = {},
): UeHeaderSearchResult {
  const maxQueryChars = options.maxQueryChars ?? 256;
  if (!Number.isSafeInteger(maxQueryChars) || maxQueryChars < 1 || maxQueryChars > 4_096) {
    throw new Error('maxQueryChars must be an integer between 1 and 4096');
  }
  const queryText = compactWhitespace(rawQuery);
  if (!queryText) throw new Error('query is required');
  if (queryText.length > maxQueryChars) throw new Error(`query exceeds ${maxQueryChars} characters`);
  const query = normalizeSearchText(queryText);
  const terms = [...new Set(query.match(/[\p{L}\p{N}_:]+/gu) ?? [])];
  if (terms.length === 0) throw new Error('query must contain a searchable letter, number, underscore or colon');
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('limit must be an integer between 1 and 200');
  }
  const maxOutputChars = options.maxOutputChars ?? 256_000;
  if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars < 512 || maxOutputChars > 2_000_000) {
    throw new Error('maxOutputChars must be an integer between 512 and 2000000');
  }
  const kinds = options.kindFilter
    ? new Set(Array.isArray(options.kindFilter) ? options.kindFilter : [options.kindFilter])
    : undefined;
  const classFilter = options.classFilter ? normalizeSearchText(compactWhitespace(options.classFilter)) : undefined;
  if (classFilter && classFilter.length > 256) throw new Error('classFilter exceeds 256 characters');

  const matches: UeHeaderSearchHit[] = [];
  for (const symbol of index.symbols) {
    if (kinds && !kinds.has(symbol.kind)) continue;
    if (classFilter) {
      const className = normalizeSearchText(symbol.kind === 'function' ? (symbol.owner ?? '') : symbol.name);
      if (className !== classFilter && !className.includes(classFilter)) continue;
    }
    const relevance = scoreSymbol(symbol, query, terms);
    if (relevance > 0) {
      // Deprecated APIs remain searchable, including doc-only matches, but supported APIs win
      // when relevance is close. An exact deprecated spelling still ranks strongly (900+).
      matches.push({ ...symbol, score: Math.max(1, relevance - (symbol.deprecated ? 100 : 0)) });
    }
  }
  matches.sort(
    (a, b) =>
      b.score - a.score ||
      Number(a.deprecated) - Number(b.deprecated) ||
      stableCompare(a.name, b.name) ||
      stableCompare(a.id, b.id),
  );

  const hits: UeHeaderSearchHit[] = [];
  const capReasons = new Set<'limit' | 'output_budget'>();
  for (const match of matches) {
    if (hits.length >= limit) {
      capReasons.add('limit');
      break;
    }
    const candidate = [...hits, match];
    // Size the entire public envelope, pessimistically including both cap reasons. That makes the
    // configured limit a real serialized-output budget instead of a budget for just the hit array.
    const maximumEnvelope = JSON.stringify({
      query: queryText,
      mode: 'keyword',
      semantic_available: false,
      hits: candidate,
      returned: candidate.length,
      matched: matches.length,
      capped: true,
      cap_reasons: ['limit', 'output_budget'],
    });
    if (maximumEnvelope.length > maxOutputChars) {
      capReasons.add('output_budget');
      break;
    }
    hits.push(match);
  }
  if (hits.length < matches.length && hits.length >= limit) capReasons.add('limit');
  return {
    query: queryText,
    mode: 'keyword',
    semantic_available: false,
    hits,
    returned: hits.length,
    matched: matches.length,
    capped: hits.length < matches.length,
    cap_reasons: [...capReasons].sort(),
  };
}
