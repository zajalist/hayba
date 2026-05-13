/**
 * L22 — Export formats.
 *
 * Pure string-manipulation exporters for the active language's lexicon:
 *   - CSV    (RFC-4180)
 *   - Anki   (TSV, two-column Front/Back; `<br>` for newlines inside Back)
 *   - Markdown (printable doc, grouped by POS)
 *
 * No external dependencies. The UI layer wraps these in Blob downloads or a
 * browser-print window.
 */

import type { Lexeme } from './lexicon.js';
import type { Phonology } from './phonology.js';
import type { PhonotacticSpec } from './phonotactics.js';
import type { RomanizationMap } from './romanization.js';
import { romanize } from './romanization.js';

export interface ExportContext {
  languageId: string;
  /**
   * The active language's lexicon. We accept the canonical `Lexeme` type whose
   * `gloss` field carries the concept. The demo stores entries as
   * `{ concept, lemma, … }`; callers should map `concept → gloss` before
   * invoking the exporter.
   */
  lexicon: ReadonlyArray<Lexeme & { concept?: string }>;
  romanization?: RomanizationMap;
  phonology: Phonology;
  /** Optional — used for the markdown "Syllable structure" header section. */
  phonotactics?: PhonotacticSpec;
}

/* ────────────────────────  helpers  ──────────────────────── */

function conceptOf(e: Lexeme & { concept?: string }): string {
  return e.concept ?? e.gloss ?? '';
}

function romanizedOf(e: Lexeme, rom?: RomanizationMap): string {
  if (!rom || rom.rules.length === 0) return '';
  // Romanize the IPA form (the source of truth for surface phonology).
  return romanize(e.ipa ?? '', rom);
}

/** RFC-4180 quoting: wrap in `"…"` and double internal quotes, but only when
 *  the field contains a comma, double-quote, CR, or LF. */
function csvField(s: string): string {
  if (s === '' || s == null) return '';
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** Tab- and newline-safe Anki cell. Anki conventionally uses `<br>` for
 *  in-cell line breaks; tabs would split into another column, so we strip. */
function ankiCell(s: string): string {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/\n/g, '<br>');
}

/* ──────────────────────────  CSV  ────────────────────────── */

const CSV_HEADERS = [
  'concept', 'lemma', 'ipa', 'romanized', 'pos', 'register', 'etymology',
] as const;

export function exportToCsv(ctx: ExportContext): string {
  const lines: string[] = [];
  lines.push(CSV_HEADERS.join(','));
  for (const e of ctx.lexicon) {
    const row = [
      conceptOf(e),
      e.lemma ?? '',
      e.ipa ?? '',
      romanizedOf(e, ctx.romanization),
      e.pos ?? '',
      e.register ?? '',
      e.etymology ?? '',
    ].map(csvField);
    lines.push(row.join(','));
  }
  // RFC-4180 records are CRLF-terminated.
  return lines.join('\r\n') + '\r\n';
}

/* ──────────────────────────  Anki  ───────────────────────── */

export function exportToAnkiTsv(ctx: ExportContext): string {
  const lines: string[] = [];
  lines.push(['Front', 'Back'].join('\t'));
  for (const e of ctx.lexicon) {
    const front = ankiCell(conceptOf(e));
    const backParts: string[] = [];
    if (e.lemma)               backParts.push(e.lemma);
    if (e.ipa)                 backParts.push('[' + e.ipa + ']');
    const rom = romanizedOf(e, ctx.romanization);
    if (rom && rom !== e.ipa)  backParts.push(rom);
    if (e.pos)                 backParts.push('(' + e.pos + ')');
    const gloss = e.gloss && e.gloss !== conceptOf(e) ? e.gloss : '';
    if (gloss)                 backParts.push(gloss);
    if (e.etymology)           backParts.push(e.etymology);
    const back = ankiCell(backParts.join('\n'));
    lines.push(front + '\t' + back);
  }
  return lines.join('\n') + '\n';
}

/* ────────────────────────  Markdown  ─────────────────────── */

/** POS order in the dictionary. Anything not in this list lands in "Other"
 *  which is always rendered last. */
const POS_ORDER = [
  'noun', 'verb', 'adjective', 'adverb',
  'pronoun', 'determiner', 'preposition',
  'conjunction', 'interjection', 'numeral', 'particle',
] as const;

function posLabel(pos: string): string {
  return pos.charAt(0).toUpperCase() + pos.slice(1) + 's';
}

function groupByPos(
  lexicon: ReadonlyArray<Lexeme & { concept?: string }>,
): Array<{ pos: string; label: string; entries: Array<Lexeme & { concept?: string }> }> {
  const buckets = new Map<string, Array<Lexeme & { concept?: string }>>();
  for (const e of lexicon) {
    const key = (e.pos && String(e.pos)) || '__untagged__';
    let bucket = buckets.get(key);
    if (!bucket) { bucket = []; buckets.set(key, bucket); }
    bucket.push(e);
  }
  const out: Array<{ pos: string; label: string; entries: Array<Lexeme & { concept?: string }> }> = [];
  for (const pos of POS_ORDER) {
    const bucket = buckets.get(pos);
    if (bucket) { out.push({ pos, label: posLabel(pos), entries: bucket }); buckets.delete(pos); }
  }
  // Custom POS tags — alphabetised — then untagged last.
  const untagged = buckets.get('__untagged__');
  buckets.delete('__untagged__');
  const customKeys = [...buckets.keys()].sort();
  for (const k of customKeys) out.push({ pos: k, label: posLabel(k), entries: buckets.get(k)! });
  if (untagged) out.push({ pos: 'untagged', label: 'Other', entries: untagged });
  return out;
}

export function exportToMarkdown(ctx: ExportContext): string {
  const out: string[] = [];
  out.push('# ' + ctx.languageId);
  out.push('');

  // Phoneme inventory.
  const consonantPhones: string[] = [];
  const vowelPhones: string[] = [];
  for (const p of ctx.phonology.phonemes) {
    const f = p.features ?? {};
    if (f.manner || f.place) consonantPhones.push(p.ipa);
    else if (f.height || f.backness) vowelPhones.push(p.ipa);
    else consonantPhones.push(p.ipa);
  }
  out.push('## Phoneme inventory');
  out.push('');
  out.push('**Consonants:** ' + (consonantPhones.length ? consonantPhones.join(' ') : '_(none)_'));
  out.push('');
  out.push('**Vowels:** ' + (vowelPhones.length ? vowelPhones.join(' ') : '_(none)_'));
  out.push('');

  // Syllable structure.
  out.push('## Syllable structure');
  out.push('');
  const templates = ctx.phonotactics?.syllable?.templates ?? [];
  if (templates.length) {
    out.push(templates.map(t => '`' + t + '`').join(', '));
  } else {
    out.push('_No phonotactic templates defined._');
  }
  out.push('');

  // Dictionary.
  out.push('## Dictionary');
  out.push('');
  if (ctx.lexicon.length === 0) {
    out.push('_Dictionary is empty._');
    out.push('');
    return out.join('\n');
  }

  const groups = groupByPos(ctx.lexicon);
  for (const g of groups) {
    out.push('### ' + g.label);
    out.push('');
    const sorted = [...g.entries].sort((a, b) => {
      const ca = conceptOf(a), cb = conceptOf(b);
      return ca < cb ? -1 : ca > cb ? 1 : 0;
    });
    for (const e of sorted) {
      const parts: string[] = [];
      parts.push('**' + conceptOf(e) + '**');
      parts.push('— *' + (e.lemma ?? '') + '*');
      if (e.ipa) parts.push('[' + e.ipa + ']');
      const rom = romanizedOf(e, ctx.romanization);
      if (rom && rom !== e.ipa) parts.push('· ' + rom);
      if (e.register) parts.push('· ' + e.register);
      if (e.etymology) parts.push('· ' + e.etymology);
      out.push('- ' + parts.join(' '));
    }
    out.push('');
  }
  return out.join('\n');
}
