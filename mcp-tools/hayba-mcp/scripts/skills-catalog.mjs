#!/usr/bin/env node
// The small skill index is derived from SKILL.md frontmatter. A model sees the
// index first and reads one body with `show`; no skill body enters every prompt.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultSkillsDir = join(packageRoot, 'addons', 'workflows');
const defaultCatalogPath = join(defaultSkillsDir, 'catalog.json');
const toolToken = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const validName = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;

function concreteToolReferences(text) {
  return [...text.matchAll(toolToken)]
    // `field:name` explicitly identifies a response field, not a command.
    .filter((match) => text.slice(Math.max(0, match.index - 6), match.index) !== 'field:')
    .map((match) => match[0]);
}

function parseFrontmatter(source, path) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw new Error(`${path}: missing YAML frontmatter`);
  const values = {};
  let section = '';
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const field = line.match(/^(\s*)([a-z][a-z0-9_-]*):\s*(.*)$/);
    if (!field) throw new Error(`${path}: unsupported frontmatter line: ${line}`);
    const [, indent, key, value] = field;
    if (!indent) {
      section = value ? '' : key;
      if (value) values[key] = value;
    } else if (indent === '  ' && section === 'metadata') {
      values[`metadata.${key}`] = value;
    } else {
      throw new Error(`${path}: unsupported frontmatter nesting: ${line}`);
    }
  }
  return { values, body: source.slice(match[0].length) };
}

function sourceFiles(directory) {
  const files = [];
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) files.push(...sourceFiles(path));
    else if (item.isFile() && item.name.endsWith('.ts') && !item.name.includes('.test.')) files.push(path);
  }
  return files;
}

export function knownToolNames(root = packageRoot) {
  const names = new Set();
  for (const path of sourceFiles(join(root, 'src', 'tools'))) {
    const source = readFileSync(path, 'utf8');
    // ToolDescriptor and Python-backed descriptor factories both declare name.
    for (const match of source.matchAll(/\bname:\s*['"]([a-z][a-z0-9_]+)['"]/g)) {
      if (toolToken.test(match[1])) names.add(match[1]);
      toolToken.lastIndex = 0;
    }
    // Runtime descriptors are assembled with defer(domain, name, ...).
    for (const match of source.matchAll(/\bdefer\(\s*['"][^'"]+['"]\s*,\s*['"]([a-z][a-z0-9_]+)['"]/g)) names.add(match[1]);
    for (const match of source.matchAll(/\bserver\.tool\(\s*['"]([a-z][a-z0-9_]+)['"]/g)) names.add(match[1]);
  }
  const sidecar = JSON.parse(readFileSync(join(root, 'src', 'legacy-commands', 'sidecar.json'), 'utf8'));
  for (const [name, entry] of Object.entries(sidecar.commands)) {
    if (entry.agent_callable === true) names.add(name);
  }
  return names;
}

export function buildCatalog(skillsDir = defaultSkillsDir, tools = knownToolNames()) {
  const errors = [];
  const entries = [];
  const seen = new Set();
  for (const item of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    const path = join(skillsDir, item.name, 'SKILL.md');
    if (!existsSync(path)) {
      errors.push(`${item.name}: missing SKILL.md`);
      continue;
    }
    let parsed;
    try {
      parsed = parseFrontmatter(readFileSync(path, 'utf8'), path);
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    const { values, body } = parsed;
    const name = values.name;
    const description = values.description;
    const category = values['metadata.category'];
    const tags = (values['metadata.tags'] ?? '').split(',').map((tag) => tag.trim()).filter(Boolean);
    if (!validName.test(name ?? '') || name !== item.name) errors.push(`${item.name}: frontmatter name must match its folder and use lowercase hyphens`);
    if (seen.has(name)) errors.push(`${item.name}: duplicate skill name`);
    seen.add(name);
    if (!description || description.length < 35 || description.length > 220) errors.push(`${item.name}: description must be 35–220 characters`);
    if (!category || !/^[a-z][a-z-]*$/.test(category)) errors.push(`${item.name}: metadata.category is required`);
    if (tags.length < 2 || tags.some((tag) => !/^[a-z][a-z0-9-]*$/.test(tag))) errors.push(`${item.name}: metadata.tags needs at least two comma-separated lowercase tags`);
    for (const heading of ['## When to use', '## Tool routing', '## Evidence']) {
      if (!body.includes(heading)) errors.push(`${item.name}: missing ${heading}`);
    }
    if (/\b(?:TODO|TBD|PLACEHOLDER)\b/i.test(body)) errors.push(`${item.name}: unfinished placeholder`);
    const references = [...new Set([...concreteToolReferences(description ?? ''), ...concreteToolReferences(body)])].sort();
    for (const reference of references) {
      if (!tools.has(reference)) errors.push(`${item.name}: unknown concrete tool ${reference}`);
    }
    if (references.includes('editor_start_pie') && !references.includes('editor_stop_pie')) {
      errors.push(`${item.name}: starts PIE without editor_stop_pie cleanup`);
    }
    if (/\b(?:[A-Z]:[\\/]|\/Users\/|\/home\/)[^\s)]*/.test(body)) errors.push(`${item.name}: machine-specific path in skill body`);
    entries.push({ name, category, tags, description, tools: references, path: `${item.name}/SKILL.md` });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { catalog: { version: 1, skills: entries }, errors };
}

export function searchCatalog(catalog, query, limit = 5) {
  const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 1))];
  if (terms.length === 0) return [];
  return catalog.skills.map((skill) => {
    const name = skill.name.toLowerCase();
    const category = skill.category.toLowerCase();
    const tags = skill.tags.join(' ').toLowerCase();
    const description = skill.description.toLowerCase();
    const score = terms.reduce((sum, term) => sum +
      (name.includes(term) ? 5 : 0) +
      (category.includes(term) ? 3 : 0) +
      (tags.includes(term) ? 2 : 0) +
      (description.includes(term) ? 1 : 0), 0);
    return { skill, score };
  }).filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, Math.max(1, Math.min(20, limit)))
    .map(({ skill, score }) => ({ name: skill.name, description: skill.description, category: skill.category, path: skill.path, score }));
}

function parseCli(argv) {
  const options = { skillsDir: defaultSkillsDir, catalogPath: defaultCatalogPath, write: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--skills-dir') options.skillsDir = resolve(argv[++i] ?? '');
    else if (arg === '--catalog') options.catalogPath = resolve(argv[++i] ?? '');
    else if (arg === '--write') options.write = true;
    else positional.push(arg);
  }
  return { options, positional };
}

function main(argv) {
  const { options, positional } = parseCli(argv);
  const [command, ...args] = positional;
  const { catalog, errors } = buildCatalog(options.skillsDir);
  if (errors.length) {
    for (const error of errors) process.stderr.write(`${error}\n`);
    process.exitCode = 1;
    return;
  }
  const json = `${JSON.stringify(catalog, null, 2)}\n`;
  if (command === 'index') {
    if (options.write) writeFileSync(options.catalogPath, json);
    else process.stdout.write(json);
    return;
  }
  if (command === 'validate') {
    if (!existsSync(options.catalogPath) || readFileSync(options.catalogPath, 'utf8') !== json) {
      process.stderr.write('catalog.json is stale; run node scripts/skills-catalog.mjs index --write\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Validated ${catalog.skills.length} skills and ${new Set(catalog.skills.flatMap((skill) => skill.tools)).size} referenced tools.\n`);
    return;
  }
  if (command === 'search') {
    process.stdout.write(`${JSON.stringify(searchCatalog(catalog, args.join(' ')), null, 2)}\n`);
    return;
  }
  if (command === 'show') {
    const skill = catalog.skills.find((entry) => entry.name === args[0]);
    if (!skill) throw new Error(`unknown skill: ${args[0] ?? ''}`);
    process.stdout.write(readFileSync(join(options.skillsDir, skill.path), 'utf8'));
    return;
  }
  throw new Error('usage: skills-catalog.mjs index [--write] | validate | search <query> | show <skill-name>');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
