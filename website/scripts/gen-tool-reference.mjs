#!/usr/bin/env node
// Generates website/docs/tools/index.html, the public tool reference, from the
// MCP server's real tool catalogue. Nothing is copied by hand: the page lists
// exactly what the server on this checkout registers.
//
// Re-run after any tool changes (from the repo root):
//
//   npm install                                  (once; the tool schemas are zod values)
//   node website/scripts/gen-tool-reference.mjs
//
// Then commit website/docs/tools/index.html with the change that caused it.
//
// No build step is needed. The script loads mcp-tools/hayba-mcp/src directly,
// letting Node strip the TypeScript types (needs Node 22.18+ or 24+ for
// module.registerHooks). It uses only node: built-ins; the server's own
// dependencies (zod and friends) come from the repo's node_modules.
//
// What counts as a tool here is what an agent can reach on a default install
// (deferred routing, the server's default):
//   - every descriptor in STATIC_TOOL_CATALOGUE (hayba_invoke can call these);
//   - the runtime tools registerDeferredRouting adds (reachable after
//     hayba_pack_load; hayba_invoke does not know their schemas);
//   - sidecar.json commands marked agent_callable that have no wrapper of the
//     same name (hayba_invoke falls through to the plugin for these).
// Plugin commands with no agent wrapper, and sidecar entries marked
// agent_callable:false, are listed separately as not callable.

import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'mcp-tools', 'hayba-mcp', 'src');
const OUT = join(ROOT, 'website', 'docs', 'tools', 'index.html');
const HUB = join(ROOT, 'website', 'docs', 'index.html');

if (typeof registerHooks !== 'function') {
  console.error('gen-tool-reference: needs Node 22.18+ or 24+ (module.registerHooks).');
  process.exit(1);
}
if (!existsSync(join(ROOT, 'node_modules', 'zod'))) {
  console.error('gen-tool-reference: run `npm install` at the repo root first.');
  process.exit(1);
}

// Load the server's .ts sources as they are. Imports in src name the emitted
// .js file, so a missing .js resolves to its .ts sibling; workspace packages
// that have not been built resolve to their src entry.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
        const ts = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
        if (existsSync(fileURLToPath(ts))) return { url: ts.href, shortCircuit: true };
      }
      if (specifier.startsWith('@hayba/')) {
        const entry = join(ROOT, 'packages', specifier.slice('@hayba/'.length), 'src', 'index.ts');
        if (existsSync(entry)) return { url: pathToFileURL(entry).href, shortCircuit: true };
      }
      throw err;
    }
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts')) {
      const source = readFileSync(fileURLToPath(url), 'utf8');
      return {
        format: 'module',
        source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }),
        shortCircuit: true,
      };
    }
    return next(url, context);
  },
});

const load = (rel) => import(pathToFileURL(join(SRC, rel)).href);

// The routing layer writes a tool index and reads settings relative to the
// working directory. Point it at a throwaway folder so the repo stays clean.
const work = mkdtempSync(join(tmpdir(), 'hayba-toolref-'));
const repoCwd = process.cwd();
process.chdir(work);

const toolsIndex = await load('tools/index.ts');
const routing = await load('tools/routing/register.ts');
const { recordToolSchema } = await load('tools/register-tool.ts');
const { listToolCategoriesHandler } = await load('tools/code-mode/list-tool-categories.ts');
const { unwrapZod } = await load('tools/zod-unwrap.ts');
const { getSidecar } = await load('legacy-commands/index.ts');

const statics = new Map(toolsIndex.STATIC_TOOL_CATALOGUE.map((d) => [d.name, d]));

// Build the deferred surface exactly as the server does at startup.
const captured = toolsIndex.captureStaticToolCatalogue({});
// Stands in for McpServer and records what is registered at startup:
// server.tool(name, [description,] shape, handler) or registerTool(name, config, handler).
const startupTools = new Map();
const fakeServer = {
  tool: (name, ...rest) => {
    const described = typeof rest[0] === 'string';
    startupTools.set(name, { description: described ? rest[0] : '', schema: described ? rest[1] : rest[0] });
  },
  registerTool: (name, config) => {
    startupTools.set(name, { description: config.description ?? '', schema: config.inputSchema?.shape ?? {} });
  },
  sendToolListChanged() {},
};
await routing.registerDeferredRouting(fakeServer, captured, work, { selectBackend: async () => null });

// list_tool_categories reports plugin commands that have no agent wrapper.
for (const d of toolsIndex.STATIC_TOOL_CATALOGUE) recordToolSchema(d);
const categories = JSON.parse((await listToolCategoriesHandler({}, {})).content[0].text);

process.chdir(repoCwd);
rmSync(work, { recursive: true, force: true });

// ── Model ─────────────────────────────────────────────────────────────────────

const STARTUP = new Set(startupTools.keys());
const sidecar = getSidecar().commands;

// Sidecar-generated descriptions open with the C++ handler that serves them.
// Readers need what the tool does, so that preamble is dropped.
const LEGACY_PREAMBLE = /^UE command "[^"]+" \([^)]*\)\.\s*/;
const describe = (text) => (text ?? '').replace(LEGACY_PREAMBLE, '');

// Commands served by the optional satellite plugins, found from the sidecar's
// handler class. They answer only when that plugin is installed.
const SATELLITES = { FHaybaMCPGASHandler: 'HaybaMCPGAS', FHaybaMCPMetaSoundHandler: 'HaybaMCPMetaSound' };
const satelliteOf = (name) => SATELLITES[(sidecar[name]?.handler_cpp ?? '').split('::')[0]];

/** Short type text for a zod schema, after optional/default wrappers are removed. */
function zodType(t) {
  const { inner } = unwrapZod(t);
  const def = inner._zod?.def ?? inner.def ?? {};
  switch (def.type) {
    case 'string': return 'string';
    case 'number': return inner._zod?.bag?.format?.includes('int') ? 'integer' : 'number';
    case 'int': return 'integer';
    case 'boolean': return 'boolean';
    case 'enum': return inner.options.map((v) => JSON.stringify(v)).join(' | ');
    case 'literal': return def.values.map((v) => JSON.stringify(v)).join(' | ');
    case 'array': return `${zodType(def.element)}[]`;
    case 'tuple': return `[${def.items.map(zodType).join(', ')}]`;
    case 'object': case 'intersection': return 'object';
    case 'record': return 'object (map)';
    case 'lazy': return zodType(def.getter());
    case 'union': return [...new Set(def.options.map(zodType))].join(' | ');
    case 'any': case 'unknown': return 'any';
    default: return def.type ?? 'any';
  }
}

function zodParams(shape) {
  return Object.entries(shape ?? {}).map(([name, t]) => {
    const u = unwrapZod(t);
    return {
      name,
      type: zodType(t),
      required: !u.optional,
      defaultValue: u.hasDefault ? u.defaultValue : undefined,
      hasDefault: u.hasDefault,
      description: t.description ?? u.inner.description ?? '',
    };
  });
}

function sidecarParams(entry) {
  return (entry.params ?? []).map((p) => ({
    name: p.name,
    type: p.type,
    required: Boolean(p.required),
    defaultValue: p.default,
    hasDefault: 'default' in p,
    description: p.description ?? '',
  }));
}

const tools = [];
// The routing meta-tools (hayba_search_tools, hayba_invoke, ...) exist only as
// startup registrations, not in the captured catalogue.
for (const [name, t] of startupTools) {
  if (captured.has(name)) continue;
  tools.push({ name, description: describe(t.description), params: zodParams(t.schema), route: 'startup' });
}
for (const [name, t] of captured) {
  const d = statics.get(name);
  tools.push({
    name,
    description: describe(d ? d.description : t.description),
    params: zodParams(d ? d.schema : t.schema),
    route: STARTUP.has(name) ? 'startup' : d ? 'invoke' : 'pack',
    satellite: satelliteOf(name),
  });
}
for (const [name, entry] of Object.entries(sidecar)) {
  if (!entry.agent_callable || captured.has(name)) continue;
  tools.push({
    name,
    description: describe(entry.notes),
    params: sidecarParams(entry),
    route: 'legacy',
    satellite: satelliteOf(name),
    aliases: entry.aliases ?? [],
  });
}

// Sidecar notes say why a command is withheld, so they win over the generic line.
const notCallable = new Map();
for (const [name, entry] of Object.entries(sidecar)) {
  if (!entry.agent_callable) notCallable.set(name, describe(entry.notes) || 'Marked internal in the command sidecar.');
}
for (const d of categories.domains) {
  for (const name of d.unavailable) {
    if (!notCallable.has(name)) notCallable.set(name, 'The plugin has this command, but no agent wrapper reaches it yet.');
  }
}
const notCallableList = [...notCallable].map(([name, why]) => ({ name, why })).sort((a, b) => a.name.localeCompare(b.name));

// ── Domains ───────────────────────────────────────────────────────────────────
// Tool names carry their domain as a prefix (actor_, material_, ...). The
// hayba_* tools and a few one-off prefixes are grouped by hand below; anything
// unmatched falls back to its prefix, so a new tool always lands somewhere.

const DOMAIN_RULES = [
  ['startup', 'Startup and discovery', (n) => STARTUP.has(n) || n === 'hayba_introspect'],
  ['asset-sources', 'Asset search and sources', /^hayba_(polyhaven|ambientcg|sketchfab|asset)_|^(asset_search|asset_browse|describe_assets)$/],
  ['pcg', 'PCG', /^pcg_|pcg|node_catalog|pcgex|^hayba_(get_node_details|compatible_pins|match_pin_names|format_graph_topology|abstract_to_subgraph|parameterize_graph_inputs|get_pattern_template|scrape_node_registry|validate_attribute_flow|diff_against_working_asset)$|^(list_node_classes|read_node_output|get_node_details|export_graph|create_graph|validate_graph|execute_graph)$/],
  ['planning', 'Plans', /^hayba_(propose_plan|mark_plan_step|initiate_infrastructure_brainstorm)$/],
  ['zones', 'Zones and conventions', /^hayba_(setup_conventions|analyze_conventions|open_zone_painter|set_painter_heightmap|read_zones)$/],
  ['world', 'World and scene', /^(world|scene)_|^(hayba_)?import_landscape$/],
  ['level', 'Levels and World Partition', /^(level|wp)_/],
  ['editor', 'Editor and PIE', /^(editor|wait|render|selection|outliner)_/],
  ['history', 'History and journal', /^hayba_(dag|journal)_/],
  ['lighting', 'Lighting and post-process', /^(light|lighting|exposure|lumen|color_grading|fog|sky|postprocess)_/],
  ['asset', 'Assets and content', /^(asset|content|data)_/],
  ['object', 'Objects and reflection', /^(object|reflect)_/],
  ['lease', 'Leases and batches', /^(lease|batch)_/],
  ['sliver', 'Slivers', /^hayba_sliver_/],
  ['code-mode', 'Startup and discovery', /^(list_tool_categories|get_tool_signature)$/],
  ['docs', 'Unreal docs', /^(docs_|query_ue_docs$)/],
];
const LABELS = {
  actor: 'Actors', anim: 'Animation Blueprints', audio: 'Audio', blueprint: 'Blueprints',
  bt: 'Behavior trees', build: 'Build and cook', copilot: 'In-editor chat', foliage: 'Foliage',
  gas: 'Gameplay Ability System', input: 'Enhanced Input', ism: 'Instanced meshes',
  landscape: 'Landscape', material: 'Materials', memory: 'Agent memory', mesh: 'Static meshes',
  metasound: 'MetaSound', net: 'Networking', niagara: 'Niagara', physics: 'Physics',
  placement: 'Actors', plumb: 'PLUMB constraints', project: 'Project', python: 'Python',
  seq: 'Sequencer', spline: 'Splines', test: 'Automation tests', texture: 'Textures',
  ui: 'UMG widgets', validator: 'Validator', water: 'Water',
};

function domainOf(name) {
  for (const [id, label, test] of DOMAIN_RULES) {
    if (typeof test === 'function' ? test(name) : test.test(name)) {
      return id === 'code-mode' ? { id: 'startup', label } : { id, label };
    }
  }
  const prefix = name.replace(/^hayba_/, '').split('_')[0];
  const id = prefix === 'placement' ? 'actor' : prefix;
  return { id, label: LABELS[prefix] ?? prefix.charAt(0).toUpperCase() + prefix.slice(1) };
}

const domains = new Map();
for (const tool of tools) {
  const { id, label } = domainOf(tool.name);
  if (!domains.has(id)) domains.set(id, { id, label, tools: [] });
  domains.get(id).tools.push(tool);
}
for (const d of domains.values()) d.tools.sort((a, b) => a.name.localeCompare(b.name));
const domainList = [...domains.values()].sort((a, b) =>
  a.id === 'startup' ? -1 : b.id === 'startup' ? 1 : a.label.localeCompare(b.label));

// ── Rendering ─────────────────────────────────────────────────────────────────

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// House style has no arrow glyphs; source text uses them to mean "to" (or,
// two-headed, "and"). Written as escapes so this file has none either.
const ARROW_BOTH = /\s*(<-\u003e|\u2194)\s*/g;
const ARROW = /\s*(\u2192|-\u003e)\s*/g;
const prose = (s) => esc(String(s).replace(ARROW_BOTH, ' and ').replace(ARROW, ' to ').trim());

const MISSING = 'No description in source.';
const ROUTE_NOTE = {
  startup: 'Registered at startup.',
  invoke: '',
  pack: 'Not callable through hayba_invoke. Load its pack with hayba_pack_load first.',
  legacy: 'Plugin command. hayba_invoke passes it straight to the editor plugin.',
};

function renderDefault(p) {
  if (!p.hasDefault) return '';
  let text;
  try { text = JSON.stringify(p.defaultValue); } catch { text = null; }
  return text && text.length <= 40 ? ` Default: <code>${esc(text)}</code>.` : ' Has a default.';
}

function renderParams(params) {
  if (!params.length) return '<p class="tool-noparams">No parameters.</p>';
  const rows = params.map((p) => `
          <tr>
            <td class="tool-param-name"><code>${esc(p.name)}</code></td>
            <td class="tool-param-type"><code>${prose(p.type)}</code></td>
            <td class="tool-param-req">${p.required ? 'Required' : 'Optional'}</td>
            <td class="tool-param-desc">${prose(p.description)}${renderDefault(p)}</td>
          </tr>`).join('');
  return `
        <table class="tool-params">
          <thead><tr><th scope="col">Parameter</th><th scope="col">Type</th><th scope="col">Required</th><th scope="col">Description</th></tr></thead>
          <tbody>${rows}
          </tbody>
        </table>`;
}

function renderTool(t) {
  const desc = t.description.trim();
  const notes = [ROUTE_NOTE[t.route]];
  if (t.satellite) notes.push(`Needs the optional ${t.satellite} plugin in your project.`);
  if (t.aliases?.length) notes.push(`Also answers to ${t.aliases.map((a) => `<code>${esc(a)}</code>`).join(', ')}.`);
  const note = notes.filter(Boolean).join(' ');
  return `
      <article class="tool" id="${esc(t.name)}">
        <h3 class="tool-name"><a href="#${esc(t.name)}"><code>${esc(t.name)}</code></a></h3>${note ? `
        <p class="tool-route">${note}</p>` : ''}
        <p class="tool-desc${desc ? '' : ' is-missing'}">${desc ? prose(desc) : MISSING}</p>${renderParams(t.params)}
      </article>`;
}

function renderDomain(d) {
  return `
    <section class="tool-domain" id="domain-${esc(d.id)}" aria-labelledby="domain-${esc(d.id)}-title">
      <h2 id="domain-${esc(d.id)}-title">${esc(d.label)} <span class="tool-domain-count">${d.tools.length}</span></h2>${d.tools.map(renderTool).join('')}
    </section>`;
}

// The sidebar is the docs hub's, so every docs page shares one nav.
const hub = readFileSync(HUB, 'utf8');
const navMatch = hub.match(/<!-- docs-nav:start -->[\s\S]*?<!-- docs-nav:end -->/);
if (!navMatch) throw new Error('docs hub is missing its <!-- docs-nav:start/end --> markers');
const nav = navMatch[0]
  .replace(/ aria-current="page"/g, '')
  .replace(/ is-current/g, '')
  .replace('href="/docs/tools/" class="docs-toc-link', 'href="/docs/tools/" aria-current="page" class="docs-toc-link is-current');

const total = tools.length;
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tool reference | Hayba docs</title>
<meta name="description" content="Every tool an agent can call through the Hayba MCP server, grouped by domain, with parameters.">
<link rel="stylesheet" href="/style.css">
<link rel="stylesheet" href="/docs/docs.css">
<link rel="icon" type="image/svg+xml" href="/assets/Logo.svg">
</head>
<body class="page-docs">
<!-- Generated by website/scripts/gen-tool-reference.mjs. Do not edit by hand; re-run the script. -->
<a class="docs-skip" href="#main">Skip to content</a>
<aside class="docs-sidebar">
  <a href="/" class="brand-link brand-link-compact">
    <img src="/assets/Logo-white.svg" alt="" class="brand-mark">
    <span>Hayba</span>
  </a>
  ${nav}
</aside>

<main class="docs-main docs-main-wide" id="main">
  <h1>Tool reference</h1>
  <p class="docs-lead">
    Every tool an agent can call on a default install: ${total} tools in ${domainList.length} domains.
    This page is generated from the MCP server source, so it matches the code it ships with.
  </p>
  <p>
    The server starts with ${STARTUP.size} tools. An agent finds the rest with
    <code>hayba_search_tools</code> and calls them with <code>hayba_invoke</code>.
    <a href="/docs/concepts/code-mode/">How Code Mode works</a>.
  </p>

  <div class="tools-filter">
    <label for="tool-filter">Filter tools</label>
    <input id="tool-filter" type="search" autocomplete="off" spellcheck="false" placeholder="Name, description or parameter">
    <p id="tool-count" class="tools-count" role="status" aria-live="polite">${total} tools</p>
  </div>

  <nav class="tools-domains" aria-label="Tool domains">
    <ul role="list">${domainList.map((d) => `
      <li><a href="#domain-${esc(d.id)}">${esc(d.label)}</a> <span class="tool-domain-count">${d.tools.length}</span></li>`).join('')}
      <li><a href="#not-callable">Not callable yet</a> <span class="tool-domain-count">${notCallableList.length}</span></li>
    </ul>
  </nav>
${domainList.map(renderDomain).join('')}

    <section class="tool-domain" id="not-callable" aria-labelledby="not-callable-title">
      <h2 id="not-callable-title">Not callable yet <span class="tool-domain-count">${notCallableList.length}</span></h2>
      <p>
        The editor plugin handles these commands, but an agent cannot call them on this version.
        They are listed so you know the capability exists. Calling one returns an error.
      </p>
      <ul class="tools-unavailable">${notCallableList.map((n) => `
        <li class="tool" id="${esc(n.name)}"><code>${esc(n.name)}</code> <span>${prose(n.why)}</span></li>`).join('')}
      </ul>
    </section>

  <p class="tools-empty" id="tools-empty" hidden>No tools match that filter.</p>
</main>

<script type="module" src="/docs/docs.js"></script>
<script src="/docs/tools.js" defer></script>
</body>
</html>
`;

// ── Self-check ────────────────────────────────────────────────────────────────

const fail = (msg) => { console.error(`gen-tool-reference: ${msg}`); process.exit(1); };
if (total <= 100) fail(`found only ${total} tools; expected more than 100. Did the catalogue fail to load?`);
const blank = tools.filter((t) => !t.description.trim());
const renderedBlank = (html.match(/<p class="tool-desc">\s*<\/p>/g) ?? []).length;
const markedBlank = (html.match(/<p class="tool-desc is-missing">No description in source\.<\/p>/g) ?? []).length;
if (renderedBlank > 0 || markedBlank !== blank.length) fail('a tool has an empty description without the missing marker.');
const ids = html.match(/ id="[^"]+"/g) ?? [];
if (new Set(ids).size !== ids.length) fail('duplicate element ids in the output.');
if (/\u2192|\u2194|-\u003e|-&gt;/.test(html.replace(/<!--[\s\S]*?--\u003e/g, ''))) fail('an arrow survived into the output.');
// Tool text becomes public copy: no local machine paths.
if (/[A-Z]:\\Users\\/i.test(html)) fail('output contains a local user path.');

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
const summary = domainList.map((d) => `${d.label} ${d.tools.length}`).join(', ');
console.log(`gen-tool-reference: wrote ${total} tools (${blank.length} without a description), ${notCallableList.length} not callable.`);
console.log(summary);
process.exit(0);
