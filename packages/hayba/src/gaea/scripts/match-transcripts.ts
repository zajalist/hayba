import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ParsedTerrain } from './parse-terrain-files.js';

export interface TranscriptMatch {
  filename: string;
  snippet: string;
  matchedTerms: string[];
}

interface MatchInput {
  nodeTypes: string[];
  biomeTerms: string[];
  terrainName: string;
  transcriptsDir: string;
}

function extractSnippet(text: string, matchIndex: number, maxLen = 800): string {
  const halfLen = Math.floor(maxLen / 2);
  const start = Math.max(0, matchIndex - halfLen);
  const end = Math.min(text.length, matchIndex + halfLen);
  let snippet = text.slice(start, end).trim();
  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';
  return snippet;
}

/**
 * Search transcripts for mentions of node types, biome terms, or terrain name.
 * Returns relevant snippets with surrounding context.
 * Requires at least 2 matching terms for a file to be included.
 */
export function matchTranscripts(input: MatchInput): TranscriptMatch[] {
  const { nodeTypes, biomeTerms, terrainName, transcriptsDir } = input;

  const searchTerms = [
    ...nodeTypes.map(n => n.toLowerCase()),
    ...biomeTerms.map(b => b.toLowerCase()),
    terrainName.toLowerCase(),
  ].filter(t => t.length > 2);

  let files: string[];
  try {
    files = readdirSync(transcriptsDir).filter(f => f.endsWith('.txt'));
  } catch {
    return [];
  }

  const matches: TranscriptMatch[] = [];

  for (const file of files) {
    const text = readFileSync(path.join(transcriptsDir, file), 'utf-8');
    const textLower = text.toLowerCase();

    const foundTerms: string[] = [];
    let bestMatchIndex = -1;

    for (const term of searchTerms) {
      const idx = textLower.indexOf(term);
      if (idx !== -1) {
        foundTerms.push(term);
        if (bestMatchIndex === -1) {
          bestMatchIndex = idx;
        }
      }
    }

    if (foundTerms.length >= 2 && bestMatchIndex >= 0) {
      matches.push({
        filename: file,
        snippet: extractSnippet(text, bestMatchIndex),
        matchedTerms: foundTerms,
      });
    }
  }

  matches.sort((a, b) => b.matchedTerms.length - a.matchedTerms.length);
  return matches;
}

// CLI runner
const isCLI = process.argv[1]
  ? path.resolve(process.argv[1]).endsWith('match-transcripts.ts') ||
    path.resolve(process.argv[1]).endsWith('match-transcripts.js')
  : false;

if (isCLI) {
  const __dirnameResolved = path.dirname(fileURLToPath(import.meta.url));
  const parsedDir = path.resolve(__dirnameResolved, '../knowledge/parsed-terrains');
  const transcriptsDir = path.resolve(__dirnameResolved, '../transcripts');
  const outputDir = path.resolve(__dirnameResolved, '../knowledge/transcript-matches');
  mkdirSync(outputDir, { recursive: true });

  const parsedFiles = readdirSync(parsedDir).filter(f => f.endsWith('.json'));

  for (const file of parsedFiles) {
    const parsed: ParsedTerrain = JSON.parse(readFileSync(path.join(parsedDir, file), 'utf-8'));
    const nodeTypes = [...new Set(parsed.nodes.map(n => n.type))];
    const terrainName = parsed.metadata.name;

    const biomeTerms: string[] = [];
    if (/snow|alpine|mountain|ridge/i.test(terrainName)) biomeTerms.push('alpine', 'mountain', 'snow');
    if (/desert|canyon|sand/i.test(terrainName)) biomeTerms.push('desert', 'arid', 'canyon');
    if (/volcanic|volcano|lava/i.test(terrainName)) biomeTerms.push('volcanic', 'lava');
    if (/river|valley|erosion/i.test(terrainName)) biomeTerms.push('river', 'valley', 'erosion');
    if (/island|coastal|ocean/i.test(terrainName)) biomeTerms.push('coastal', 'island');
    if (/thermal|pool/i.test(terrainName)) biomeTerms.push('thermal', 'geothermal');

    const matches = matchTranscripts({ nodeTypes, biomeTerms, terrainName, transcriptsDir });

    const output = {
      source_file: parsed.source_file,
      terrain_name: terrainName,
      node_types: nodeTypes,
      transcript_matches: matches,
    };

    const slug = file.replace('.json', '');
    writeFileSync(path.join(outputDir, `${slug}-matches.json`), JSON.stringify(output, null, 2));
    console.log(`${parsed.source_file}: ${matches.length} transcript matches`);
  }
}
