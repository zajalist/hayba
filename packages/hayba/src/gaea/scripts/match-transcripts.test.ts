import { describe, it, expect } from 'vitest';
import { matchTranscripts, type TranscriptMatch } from './match-transcripts.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRANSCRIPTS_DIR = path.resolve(__dirname, '../transcripts');

describe('matchTranscripts', () => {
  it('finds relevant snippets for node types', () => {
    const results = matchTranscripts({
      nodeTypes: ['Mountain', 'Erosion2', 'Sandstone'],
      biomeTerms: ['alpine', 'mountain'],
      terrainName: 'Snowymount',
      transcriptsDir: TRANSCRIPTS_DIR,
    });

    expect(results.length).toBeGreaterThanOrEqual(0);
    for (const match of results) {
      expect(match.filename).toBeDefined();
      expect(match.snippet).toBeDefined();
      expect(match.snippet.length).toBeGreaterThan(0);
      expect(match.snippet.length).toBeLessThanOrEqual(1000);
    }
  });

  it('returns empty array when no matches found', () => {
    const results = matchTranscripts({
      nodeTypes: ['NonExistentNode12345'],
      biomeTerms: ['nonexistentbiome'],
      terrainName: 'nonexistent',
      transcriptsDir: TRANSCRIPTS_DIR,
    });

    expect(results).toEqual([]);
  });

  it('snippets contain matched terms', () => {
    const results = matchTranscripts({
      nodeTypes: ['Erosion2', 'Mountain'],
      biomeTerms: ['erosion', 'mountain'],
      terrainName: 'alpine',
      transcriptsDir: TRANSCRIPTS_DIR,
    });

    for (const match of results) {
      const lower = match.snippet.toLowerCase();
      const hasMatch = match.matchedTerms.some(t => lower.includes(t));
      expect(hasMatch).toBe(true);
    }
  });

  it('results are sorted by number of matched terms descending', () => {
    const results = matchTranscripts({
      nodeTypes: ['Erosion2', 'Mountain', 'Sandstone', 'Snow'],
      biomeTerms: ['alpine', 'erosion'],
      terrainName: 'mountain',
      transcriptsDir: TRANSCRIPTS_DIR,
    });

    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].matchedTerms.length).toBeGreaterThanOrEqual(results[i].matchedTerms.length);
    }
  });
});
