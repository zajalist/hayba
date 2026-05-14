import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeCulture } from '../dist/culture/io.js';
import { seedCulture } from '../dist/culture/presets.js';
import { validateCulture } from '../dist/culture/validate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const styleDir = join(root, 'src/data/style-guides');
const cultureDir = join(root, 'src/data/cultures');

const files = (await readdir(styleDir)).filter(f => f.endsWith('.json'));

// Map cultureId (from styleSheet.cultureId) to human-readable region/name
const CULTURE_META = {
  'andean':              { region: 'South America', climate: 'alpine' },
  'tang-chinese':        { region: 'East Asia',     climate: 'temperate' },
  'edo-japanese':        { region: 'East Asia',     climate: 'temperate' },
  'hausa':               { region: 'West Africa',   climate: 'arid' },
  'industrial-english':  { region: 'Western Europe', climate: 'temperate' },
  'medieval-european':   { region: 'Western Europe', climate: 'temperate' },
};

const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Group files by cultureId so each culture gets one Culture dir with all eras
const byCulture = new Map();
for (const f of files) {
  const sg = JSON.parse(await readFile(join(styleDir, f), 'utf8'));
  const sheet = sg.styleSheet ?? sg;
  const cultureId = sheet.cultureId ?? sg.id;
  if (!byCulture.has(cultureId)) byCulture.set(cultureId, []);
  byCulture.get(cultureId).push({ f, sg, sheet });
}

let failed = 0;

for (const [cultureId, entries] of byCulture) {
  const meta = CULTURE_META[cultureId] ?? {
    region: '(set during review)',
    climate: '(set during review)',
  };

  // Sort entries by start of dateRange so eras are chronological
  entries.sort((a, b) => {
    const aStart = Array.isArray(a.sheet.dateRange) ? a.sheet.dateRange[0] : 0;
    const bStart = Array.isArray(b.sheet.dateRange) ? b.sheet.dateRange[0] : 0;
    return aStart - bStart;
  });

  // Use the first entry's top-level id as culture name source
  const firstName = entries[0].sg.id ?? cultureId;
  // Build a nice display name from cultureId: "tang-chinese" -> "Tang Chinese"
  const cultureName = cultureId
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  const c = seedCulture({
    id: cultureId,
    name: cultureName,
    region: meta.region,
    climate: meta.climate,
  });

  // Track which material ids we add so we don't duplicate across eras
  const addedMaterialIds = new Set(c.materials.map(m => m.id));
  const addedOrnamentIds = new Set(c.ornaments.map(o => o.id));

  for (const { sg, sheet } of entries) {
    const core = sheet.core ?? {};
    const dateRange = Array.isArray(sheet.dateRange) && sheet.dateRange.length === 2
      ? [Number(sheet.dateRange[0]), Number(sheet.dateRange[1])]
      : [0, 100];

    // Use the file-level id as era id/name
    const eraId = sg.id;
    const eraName = sg.id
      .split('-')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    c.eras.push({
      id: eraId,
      name: eraName,
      dateRange,
      defaults: {
        roofType: core.roofType ?? 'gabled',
        proportions: { columnSlenderness: 1, storyHeight: 1, doorAspect: 1 },
        palette: [],
        ornamentDensity: 'moderate',
        technique: '',
      },
      typologyMix: Object.fromEntries(
        (sg.typologyWeights ?? []).map(tw => [tw.typologyId, tw.weight])
      ),
      rules: [],
    });

    // Lift primary + secondary materials
    for (const matName of [core.primaryMaterial, core.secondaryMaterial].filter(Boolean)) {
      const id = slug(matName);
      if (!id || addedMaterialIds.has(id)) continue;
      addedMaterialIds.add(id);
      c.materials.push({
        id,
        name: matName.charAt(0).toUpperCase() + matName.slice(1),
        color: '#888888',
        grain: '',
        properties: { durability: 0.5, cost: 0.5, workability: 0.5 },
      });
    }

    // Lift ornament tags from core.ornamentation
    for (const tag of core.ornamentation ?? []) {
      const id = slug(tag);
      if (!id || addedOrnamentIds.has(id)) continue;
      addedOrnamentIds.add(id);
      c.ornaments.push({
        id,
        name: String(tag),
        description: '',
        referenceImagePaths: [],
        scenarioWeights: {},
      });
    }
  }

  await writeCulture(cultureDir, c);
  const v = validateCulture(c);
  if (!v.ok) {
    console.error(`✗ ${cultureId} did not validate:`);
    for (const issue of v.issues.filter(i => i.severity === 'error')) {
      console.error(`   ${issue.path}: ${issue.message}`);
    }
    failed++;
  } else {
    console.log(`✓ ${cultureId} migrated (${v.issues.length} warnings, ${c.eras.length} era(s))`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} cultures failed validation`);
  process.exit(1);
}

console.log(`\nMigrated ${byCulture.size} cultures from ${files.length} style-guide files.`);
