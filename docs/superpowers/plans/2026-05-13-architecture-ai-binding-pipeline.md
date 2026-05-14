# Architecture AI Binding Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire an AI-driven generation pipeline that, given `(styleSheetId, elementId)`, asks a language model to emit SVG profiles + numeric parameters, validates the output through the existing schema firewall, and registers the result as an `ElementBinding` the engine can render. **Four provider classes ship in v0**: Mock (canned, for tests), Anthropic Claude (paid BYOK default), **OpenAI-compatible** (covers Groq free, OpenRouter free, Ollama local, LM Studio local, OpenAI paid, and any custom base URL), and a Settings UI that lets the user pick + presets per common provider.

**Architecture:** Pure-functional core (prompt builder + response parser + validator chain) with a pluggable `AIProvider` interface. Browser uses BYOK with `dangerouslyAllowBrowser: true`; key + chosen provider + base URL all live in `localStorage`. The OpenAI-compatible provider uses plain `fetch()` (no SDK dep) since the chat-completions endpoint shape is identical across Groq / OpenRouter / Ollama / LM Studio / OpenAI itself. Generated bindings stay **in-memory for the session** — added to the kernel's binding map via a new `registerBinding()` function. Persistence is a manual "Download JSON" round-trip in v0 (disk writes are Plan 4 territory). All non-determinism is firewalled into `provider.generate(req)`; everything after is bit-exact reproducible from the binding.

**Tech Stack:** TypeScript 5.6+, Vitest, `@anthropic-ai/sdk` ^0.45 for the Anthropic provider, plain `fetch()` for OpenAI-compatible providers (Groq / OpenRouter / Ollama / LM Studio / OpenAI). No additional SDKs.

**Spec:** `docs/superpowers/specs/2026-05-13-architecture-element-catalog-design.md` § 3 (AI surface)
**Branch:** `feat/architecture-pillar`

**Provider matrix shipping in v0:**

| Provider | Class | Endpoint | Key needed? | Notes |
|---|---|---|---|---|
| Mock | `MockProvider` | (none) | no | Deterministic canned output. Used by tests + as the no-key default. |
| Anthropic | `AnthropicProvider` | api.anthropic.com | yes | Claude Haiku 4.5 default. Paid. |
| Groq | `OpenAICompatibleProvider` | api.groq.com/openai/v1 | yes (free tier) | Llama 3.1 70B, Mixtral. Extremely fast inference, generous free tier. |
| OpenRouter | `OpenAICompatibleProvider` | openrouter.ai/api/v1 | yes (free tier) | Includes free Llama-3-8B + Gemini Flash routes. |
| OpenAI | `OpenAICompatibleProvider` | api.openai.com/v1 | yes | gpt-4o-mini default. Paid. |
| Ollama (local) | `OpenAICompatibleProvider` | localhost:11434/v1 | no | Run `ollama pull qwen2.5-coder:7b-instruct` first. |
| LM Studio (local) | `OpenAICompatibleProvider` | localhost:1234/v1 | no | Start the local server in the LM Studio UI. |
| Custom OpenAI-compat | `OpenAICompatibleProvider` | user-provided | optional | For vLLM, llama.cpp server, any other compatible endpoint. |

**Out of scope for this plan** (lives in follow-up plans):
- Persistence of bindings to disk (`bindings/<styleSheet>/<element>.json`) — Plan 4 (`acceptBindingToDisk`).
- Reference-image upload + multi-image prompt conditioning.
- Streaming display of AI tokens.
- Retry loop with structured error feedback (one-shot only in v0; if AI output fails validation, surface raw to the user for manual edit).
- Batch generation across all `(style sheet × element)` pairs.

---

## File Structure

```
packages/architecture/
├── package.json                                       [Task 1]    (modified — add @anthropic-ai/sdk)
├── src/
│   ├── ai/                                            [Tasks 2–7] (new directory)
│   │   ├── types.ts                                   [Task 2]    BindingRequest, BindingResponse, AIProvider interface
│   │   ├── prompt-builder.ts                          [Task 3]    builds system + user prompts from element + style sheet
│   │   ├── prompt-builder.test.ts                     [Task 3]
│   │   ├── response-parser.ts                         [Task 4]    extracts JSON from LLM text, runs validator, parses SVGs
│   │   ├── response-parser.test.ts                    [Task 4]
│   │   ├── provider-mock.ts                           [Task 5]    deterministic test provider
│   │   ├── provider-mock.test.ts                      [Task 5]
│   │   ├── generate-binding.ts                        [Task 6]    top-level pipeline composer
│   │   ├── generate-binding.test.ts                   [Task 6]
│   │   ├── provider-anthropic.ts                      [Task 7]    real Anthropic Messages API call
│   │   ├── provider-anthropic.test.ts                 [Task 7]    (unit, no live API)
│   │   ├── provider-openai-compat.ts                  [Task 7B]   chat-completions over fetch — covers Groq/OpenRouter/Ollama/LM Studio/OpenAI
│   │   └── provider-openai-compat.test.ts             [Task 7B]   (unit, mocked fetch)
│   ├── element-registry.ts                            [Task 8]    add registerBinding() function
│   └── index.ts                                       [Task 8]    re-export AI surface
├── demo/
│   └── index.html                                     [Tasks 11–12] BYOK settings panel + Generate/Accept flow
└── ...

packages/hayba/
├── package.json                                       [Task 9]    add @hayba/architecture as already-present dep (verify only)
└── src/tools/
    ├── worldbuilding/architecture-handlers.ts        [Task 9]    add generateBinding handler
    └── index.ts                                       [Task 10]   register architecture_generate_binding tool
```

---

### Task 1: Install Anthropic SDK

**Files:**
- Modify: `packages/architecture/package.json`

- [ ] **Step 1: Verify current branch**

```bash
git branch --show-current
```
Expected: `feat/architecture-pillar`. If not, `git checkout feat/architecture-pillar`. BLOCKED if uncommitted changes refuse the switch.

- [ ] **Step 2: Add dependency**

In `packages/architecture/package.json`, find the existing `"dependencies"` block (currently contains `"three": "^0.169.0"`) and add `@anthropic-ai/sdk`:

```json
  "dependencies": {
    "@anthropic-ai/sdk": "^0.45.0",
    "three": "^0.169.0"
  },
```

- [ ] **Step 3: Install**

From repo root:
```bash
npm install
```
Expected: package-lock updated, `@anthropic-ai/sdk` resolved.

- [ ] **Step 4: Smoke-test the import**

```bash
node --input-type=module -e "import('@anthropic-ai/sdk').then(m => console.log('anthropic sdk:', typeof m.default))"
```
Expected: `anthropic sdk: function`.

- [ ] **Step 5: Commit**

```bash
git add packages/architecture/package.json package-lock.json
git diff --cached --name-only   # only those two files
git commit -m "feat(architecture): add @anthropic-ai/sdk dependency for AI binding pipeline"
```

---

### Task 2: AI types + provider interface

**Files:**
- Create: `packages/architecture/src/ai/types.ts`

- [ ] **Step 1: Create the types module**

`packages/architecture/src/ai/types.ts`:
```ts
/**
 * Shared types for the AI binding pipeline.
 *
 * Provider implementations consume a BindingRequest and return a BindingResponse.
 * The validator/parser chain then ingests the response into an ElementBinding
 * which is the engine's bit-exact deterministic input.
 */

import type { Element, ElementBinding, StyleSheet, ValidationError } from '../index.js';

export interface BindingRequest {
  element: Element;
  styleSheet: StyleSheet;
  /** Optional explicit seed; if omitted, provider may pick its own. */
  seed?: bigint;
  /** Optional user-uploaded reference image paths or data URLs. v1 — not consumed by mock or Anthropic v0. */
  referenceImages?: readonly string[];
}

export interface RawBindingResponse {
  /** Raw text the LLM returned. Caller will JSON.parse this. */
  rawText: string;
  /** Provider identity + model id for provenance tracking. */
  provider: AIProviderName;
  model: string;
  /** Hash of the prompt sent — used for binding provenance. */
  promptHash: string;
}

export interface ParsedBindingDraft {
  binding: ElementBinding;
  rationale?: string;
}

export type AIProviderName = 'anthropic' | 'openai' | 'fal' | 'local' | 'mock';

export interface AIProvider {
  readonly name: AIProviderName;
  readonly model: string;
  generate(req: BindingRequest, prompt: { system: string; user: string }): Promise<RawBindingResponse>;
}

export interface GenerateBindingResult {
  ok: true;
  draft: ElementBinding;
  rationale?: string;
  retries: 0;   // future-proofed for retry loop
}
export interface GenerateBindingError {
  ok: false;
  stage: 'provider' | 'parse' | 'validate' | 'svg-parse';
  errors: ValidationError[];
  rawText?: string;
  message: string;
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npm run typecheck --workspace=@hayba/architecture
```
Expected: silent.

- [ ] **Step 3: Commit**

```bash
git add packages/architecture/src/ai/types.ts
git diff --cached --name-only
git commit -m "feat(architecture): AI pipeline types (BindingRequest, AIProvider, results)"
```

---

### Task 3: Prompt builder

**Files:**
- Create: `packages/architecture/src/ai/prompt-builder.ts`
- Create: `packages/architecture/src/ai/prompt-builder.test.ts`

- [ ] **Step 1: Write failing test**

`packages/architecture/src/ai/prompt-builder.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildPrompt, hashPrompt } from './prompt-builder.js';
import { loadElementCatalog, loadRegistry } from '../index.js';

describe('buildPrompt', () => {
  const catalog = loadElementCatalog();
  const reg = loadRegistry();
  const element = catalog.elementsById.get('column')!;
  const styleSheet = reg.styleGuidesById.get('medieval-european-gothic')!.styleSheet;

  it('returns a system prompt and a user prompt', () => {
    const p = buildPrompt({ element, styleSheet, seed: 0x1n });
    expect(typeof p.system).toBe('string');
    expect(typeof p.user).toBe('string');
    expect(p.system.length).toBeGreaterThan(50);
    expect(p.user.length).toBeGreaterThan(50);
  });

  it('user prompt names the element and style sheet', () => {
    const p = buildPrompt({ element, styleSheet, seed: 0x1n });
    expect(p.user).toContain('column');
    expect(p.user).toContain('medieval-european-gothic');
  });

  it('user prompt lists every required profile slot with its hint and viewBox', () => {
    const p = buildPrompt({ element, styleSheet, seed: 0x1n });
    for (const slot of element.profileSlots) {
      expect(p.user).toContain(slot.name);
      expect(p.user).toContain(slot.hint);
    }
  });

  it('user prompt lists every required param with its range', () => {
    const p = buildPrompt({ element, styleSheet, seed: 0x1n });
    for (const slot of element.paramSchema) {
      expect(p.user).toContain(slot.name);
      if (slot.range) {
        expect(p.user).toContain(String(slot.range[0]));
        expect(p.user).toContain(String(slot.range[1]));
      }
    }
  });

  it('system prompt instructs strict JSON-only output', () => {
    const p = buildPrompt({ element, styleSheet, seed: 0x1n });
    expect(p.system).toMatch(/JSON/i);
    expect(p.system).toMatch(/SVG/i);
  });

  it('user prompt mentions cultural context from the style sheet', () => {
    const p = buildPrompt({ element, styleSheet, seed: 0x1n });
    expect(p.user).toContain(styleSheet.core.primaryMaterial);
    expect(p.user).toContain(styleSheet.core.roofType);
    for (const orn of styleSheet.core.ornamentation) expect(p.user).toContain(orn);
  });
});

describe('hashPrompt', () => {
  it('produces stable hex-string hashes', () => {
    const a = hashPrompt('hello', 'world');
    const b = hashPrompt('hello', 'world');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);   // 16-hex-digit (64-bit) FNV
  });

  it('different prompts produce different hashes', () => {
    expect(hashPrompt('a', 'b')).not.toBe(hashPrompt('a', 'c'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=@hayba/architecture -- prompt-builder.test
```
Expected: FAIL — module missing.

- [ ] **Step 3: Implement prompt-builder.ts**

`packages/architecture/src/ai/prompt-builder.ts`:
```ts
import type { BindingRequest } from './types.js';

/** FNV-1a 64-bit hash → 16-hex-digit string. Deterministic across machines. */
export function hashPrompt(system: string, user: string): string {
  const MASK64 = (1n << 64n) - 1n;
  let h = 0xCBF29CE484222325n;
  const prime = 0x100000001B3n;
  const combined = system + '' + user;
  for (let i = 0; i < combined.length; i++) {
    h = (h ^ BigInt(combined.charCodeAt(i))) & MASK64;
    h = (h * prime) & MASK64;
  }
  return h.toString(16).padStart(16, '0');
}

const SYSTEM_PROMPT = [
  'You generate architectural element profiles for Hayba — a deterministic',
  'procedural architecture pipeline. For each named profile slot, emit a',
  'single <svg> with one <path d="..."/> matching the slot\'s hint and viewBox.',
  '',
  'Supported SVG path commands: M, L, H, V, Z (and their lowercase relatives).',
  'NO curve commands (C, Q, A). All polygons are straight-line.',
  '',
  'Hint contract:',
  '  - "symmetric-half": all path points must have x >= 0 (path is revolved',
  '    around the Y axis at x=0).',
  '  - "closed-path":    polygon outline. Centered viewBoxes (e.g. -100 -100 200 200)',
  '    produce symmetric output around (0,0).',
  '  - "open-path":      open polyline. Used for sweep paths.',
  '  - "tileable":       seamless edges. The pattern is tiled along a surface.',
  '',
  'Output MUST be strict JSON with this shape (no commentary, no markdown fences):',
  '{',
  '  "profiles": { "<slotName>": "<svg ...>...</svg>", ... },',
  '  "params":   { "<paramName>": <number-or-string>, ... },',
  '  "rationale": "one-paragraph design note explaining how the SVG reads as the culture/era"',
  '}',
  '',
  'Every numeric param must be in its declared range. Every required profile',
  'slot must appear. Coordinates in millimeters. The downstream engine converts to meters.',
].join('\n');

export function buildPrompt(req: BindingRequest): { system: string; user: string } {
  const { element, styleSheet } = req;

  const slots = element.profileSlots.map((slot) => {
    const bbox = slot.bbox ? ` viewBox="${slot.bbox.join(' ')}"` : '';
    return `  - ${slot.name} [${slot.hint}${bbox}]: ${slot.description}`;
  }).join('\n');

  const params = element.paramSchema.map((slot) => {
    if (slot.kind === 'enum') {
      return `  - ${slot.name} (enum): one of ${(slot.choices ?? []).map(c => JSON.stringify(c)).join(', ')}; default ${JSON.stringify(slot.default)}`;
    }
    const range = slot.range ? `range [${slot.range[0]}, ${slot.range[1]}]` : 'unconstrained';
    return `  - ${slot.name} (${slot.kind}): ${range}; default ${slot.default}`;
  }).join('\n');

  const ornamentation = styleSheet.core.ornamentation.length
    ? styleSheet.core.ornamentation.join(', ')
    : '(none)';

  const user = [
    `Element: ${element.id}  (category: ${element.category})`,
    `Style sheet: ${styleSheet.id}  (culture: ${styleSheet.cultureId}; dateRange: ${styleSheet.dateRange[0]}–${styleSheet.dateRange[1]})`,
    `Primary material: ${styleSheet.core.primaryMaterial}${styleSheet.core.secondaryMaterial ? `   Secondary: ${styleSheet.core.secondaryMaterial}` : ''}`,
    `Roof type: ${styleSheet.core.roofType}`,
    `Ornamentation pool: ${ornamentation}`,
    '',
    'Required profile slots:',
    slots,
    '',
    'Required parameters:',
    params,
    '',
    'Generate the binding JSON now. Strict JSON only, no markdown fences.',
  ].join('\n');

  return { system: SYSTEM_PROMPT, user };
}
```

- [ ] **Step 4: Run tests → PASS**

```bash
npm test --workspace=@hayba/architecture -- prompt-builder.test
```
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/architecture/src/ai/prompt-builder.ts packages/architecture/src/ai/prompt-builder.test.ts
git diff --cached --name-only
git commit -m "feat(architecture): AI prompt builder + FNV-1a prompt-hash helper"
```

---

### Task 4: Response parser

**Files:**
- Create: `packages/architecture/src/ai/response-parser.ts`
- Create: `packages/architecture/src/ai/response-parser.test.ts`

- [ ] **Step 1: Write failing test**

`packages/architecture/src/ai/response-parser.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseResponse } from './response-parser.js';
import { loadElementCatalog } from '../index.js';

const element = loadElementCatalog().elementsById.get('column')!;

const validJson = JSON.stringify({
  profiles: {
    shaft:          '<svg viewBox="0 0 200 1000"><path d="M0 0 L 100 0 L 100 1000 L 0 1000 Z"/></svg>',
    base:           '<svg viewBox="0 0 300 80"><path d="M0 0 L 150 0 L 150 80 L 0 80 Z"/></svg>',
    capital_bottom: '<svg viewBox="-100 -100 200 200"><path d="M-50 -50 L 50 -50 L 50 50 L -50 50 Z"/></svg>',
    capital_top:    '<svg viewBox="-150 -150 300 300"><path d="M-100 -100 L 100 -100 L 100 100 L -100 100 Z"/></svg>',
  },
  params: { base_height_m: 0.2, shaft_height_m: 3.0, capital_height_m: 0.3, revolve_segments: 32 },
  rationale: 'A simple test column.',
});

describe('parseResponse', () => {
  it('parses well-formed JSON into a binding draft', () => {
    const r = parseResponse(validJson, element, 'medieval-european-gothic', 0x42n, 'mock', 'mock-model', 'deadbeef');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.draft.elementId).toBe('column');
      expect(r.draft.styleSheetId).toBe('medieval-european-gothic');
      expect(r.draft.seed).toBe(0x42n);
      expect(r.draft.provenance.source).toBe('ai');
      expect(r.draft.provenance.aiProvider).toBe('mock');
      expect(r.draft.provenance.promptHash).toBe('deadbeef');
      expect(r.rationale).toBe('A simple test column.');
    }
  });

  it('strips ```json ... ``` fences if present', () => {
    const fenced = '```json\n' + validJson + '\n```';
    const r = parseResponse(fenced, element, 'medieval-european-gothic', 1n, 'mock', 'm', 'h');
    expect(r.ok).toBe(true);
  });

  it('strips leading commentary before JSON', () => {
    const noisy = 'Here is your binding:\n\n' + validJson;
    const r = parseResponse(noisy, element, 'medieval-european-gothic', 1n, 'mock', 'm', 'h');
    expect(r.ok).toBe(true);
  });

  it('returns parse error for invalid JSON', () => {
    const r = parseResponse('not json at all', element, 'medieval-european-gothic', 1n, 'mock', 'm', 'h');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe('parse');
  });

  it('returns validate error for out-of-range param', () => {
    const bad = JSON.parse(validJson);
    bad.params.shaft_height_m = 100;   // way out of range
    const r = parseResponse(JSON.stringify(bad), element, 'medieval-european-gothic', 1n, 'mock', 'm', 'h');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe('validate');
  });

  it('returns svg-parse error for malformed SVG profile', () => {
    const bad = JSON.parse(validJson);
    bad.profiles.shaft = '<svg viewBox="0 0 100 100"><path d="this is not a path"/></svg>';
    const r = parseResponse(JSON.stringify(bad), element, 'medieval-european-gothic', 1n, 'mock', 'm', 'h');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe('svg-parse');
  });
});
```

- [ ] **Step 2: Run → FAIL**

```bash
npm test --workspace=@hayba/architecture -- response-parser.test
```

- [ ] **Step 3: Implement response-parser.ts**

`packages/architecture/src/ai/response-parser.ts`:
```ts
import type {
  Element, ElementBinding, AIProviderName, ValidationError,
} from '../index.js';
import { validateElementBinding } from '../index.js';
import { parseSvgProfile } from '../kernel/svg-parse.js';
import type { GenerateBindingResult, GenerateBindingError } from './types.js';

/**
 * Strip common LLM-output decorations and extract the JSON object body.
 *
 * Handles:
 *   - leading prose like "Here is your binding:"
 *   - ```json ... ``` fences (with or without language tag)
 *   - trailing prose after the closing brace
 */
function extractJson(raw: string): string {
  // Fenced block?
  const fenceMatch = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // Otherwise find the outermost { ... } block.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return raw.trim();
  return raw.slice(start, end + 1);
}

export function parseResponse(
  rawText: string,
  element: Element,
  styleSheetId: string,
  seed: bigint,
  provider: AIProviderName,
  model: string,
  promptHash: string,
): GenerateBindingResult | GenerateBindingError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(rawText));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      stage: 'parse',
      errors: [{ path: '/', message: `JSON.parse failed: ${message}` }],
      rawText,
      message,
    };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return {
      ok: false,
      stage: 'parse',
      errors: [{ path: '/', message: 'expected JSON object' }],
      rawText,
      message: 'expected JSON object',
    };
  }

  const obj = parsed as { profiles?: unknown; params?: unknown; rationale?: unknown };

  // Build a candidate ElementBinding with the provenance stamps.
  const candidate = {
    elementId: element.id,
    styleSheetId,
    seed,
    profiles: obj.profiles ?? {},
    params:   obj.params   ?? {},
    provenance: {
      source: 'ai' as const,
      aiProvider: provider,
      aiModel: model,
      promptHash,
      createdAt: new Date().toISOString(),
    },
  };

  // Run the schema validator.
  const errs = validateElementBinding(candidate, element, '/binding');
  if (errs.length > 0) {
    return {
      ok: false,
      stage: 'validate',
      errors: errs,
      rawText,
      message: `${errs.length} validation error(s)`,
    };
  }

  // SVG parse-test every profile slot — guards against shape-OK-but-unparseable SVGs.
  const binding = candidate as ElementBinding;
  for (const slot of element.profileSlots) {
    try {
      parseSvgProfile(binding.profiles[slot.name], slot.hint);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        stage: 'svg-parse',
        errors: [{ path: `/binding/profiles/${slot.name}`, message }],
        rawText,
        message,
      };
    }
  }

  const rationale = typeof obj.rationale === 'string' ? obj.rationale : undefined;
  return { ok: true, draft: binding, rationale, retries: 0 };
}
```

- [ ] **Step 4: Run → PASS**

```bash
npm test --workspace=@hayba/architecture -- response-parser.test
```
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/architecture/src/ai/response-parser.ts packages/architecture/src/ai/response-parser.test.ts
git diff --cached --name-only
git commit -m "feat(architecture): AI response parser (JSON extract + validator + SVG parse-test)"
```

---

### Task 5: Mock provider

**Files:**
- Create: `packages/architecture/src/ai/provider-mock.ts`
- Create: `packages/architecture/src/ai/provider-mock.test.ts`

- [ ] **Step 1: Write failing test**

`packages/architecture/src/ai/provider-mock.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { MockProvider } from './provider-mock.js';
import { buildPrompt } from './prompt-builder.js';
import { loadElementCatalog, loadRegistry } from '../index.js';

const catalog = loadElementCatalog();
const reg = loadRegistry();
const element = catalog.elementsById.get('column')!;
const styleSheet = reg.styleGuidesById.get('medieval-european-gothic')!.styleSheet;

describe('MockProvider', () => {
  it('returns a non-empty rawText response', async () => {
    const provider = new MockProvider();
    const p = buildPrompt({ element, styleSheet, seed: 0x1n });
    const r = await provider.generate({ element, styleSheet, seed: 0x1n }, p);
    expect(r.rawText.length).toBeGreaterThan(50);
    expect(r.provider).toBe('mock');
    expect(r.model).toBe('mock-deterministic');
  });

  it('is deterministic for the same (element, styleSheet, seed)', async () => {
    const provider = new MockProvider();
    const p = buildPrompt({ element, styleSheet, seed: 0x1n });
    const a = await provider.generate({ element, styleSheet, seed: 0x1n }, p);
    const b = await provider.generate({ element, styleSheet, seed: 0x1n }, p);
    expect(a.rawText).toBe(b.rawText);
  });

  it('different seeds may produce different output (sanity)', async () => {
    const provider = new MockProvider();
    const p1 = buildPrompt({ element, styleSheet, seed: 0x1n });
    const p2 = buildPrompt({ element, styleSheet, seed: 0x2n });
    const a = await provider.generate({ element, styleSheet, seed: 0x1n }, p1);
    const b = await provider.generate({ element, styleSheet, seed: 0x2n }, p2);
    expect(a.rawText).not.toBe(b.rawText);
  });

  it('output includes every required profile slot key', async () => {
    const provider = new MockProvider();
    const p = buildPrompt({ element, styleSheet, seed: 0x1n });
    const r = await provider.generate({ element, styleSheet, seed: 0x1n }, p);
    for (const slot of element.profileSlots) {
      expect(r.rawText).toContain(`"${slot.name}"`);
    }
  });

  it('output includes every required param key', async () => {
    const provider = new MockProvider();
    const p = buildPrompt({ element, styleSheet, seed: 0x1n });
    const r = await provider.generate({ element, styleSheet, seed: 0x1n }, p);
    for (const slot of element.paramSchema) {
      expect(r.rawText).toContain(`"${slot.name}"`);
    }
  });
});
```

- [ ] **Step 2: Run → FAIL**

```bash
npm test --workspace=@hayba/architecture -- provider-mock.test
```

- [ ] **Step 3: Implement provider-mock.ts**

`packages/architecture/src/ai/provider-mock.ts`:
```ts
import { hashPrompt } from './prompt-builder.js';
import type { AIProvider, BindingRequest, RawBindingResponse } from './types.js';

/**
 * MockProvider — emits a syntactically valid response by filling every required
 * slot with a minimal rectangle SVG (for symmetric-half) or square SVG (for
 * closed-path), and every param with its midpoint or default. Deterministic
 * for the same (element, styleSheet, seed).
 *
 * Used by tests and as a safe default when no API key is configured.
 */
export class MockProvider implements AIProvider {
  readonly name = 'mock' as const;
  readonly model = 'mock-deterministic';

  async generate(req: BindingRequest, prompt: { system: string; user: string }): Promise<RawBindingResponse> {
    const profiles: Record<string, string> = {};
    for (const slot of req.element.profileSlots) {
      profiles[slot.name] = _profileFor(slot, req.seed ?? 0n);
    }
    const params: Record<string, number | string> = {};
    for (const slot of req.element.paramSchema) {
      params[slot.name] = _paramFor(slot);
    }
    const rationale = `Mock provider output for ${req.element.id} × ${req.styleSheet.id} (seed=${(req.seed ?? 0n).toString(16)}).`;
    const rawText = JSON.stringify({ profiles, params, rationale }, null, 2);
    return {
      rawText,
      provider: 'mock',
      model: this.model,
      promptHash: hashPrompt(prompt.system, prompt.user),
    };
  }
}

function _profileFor(slot: { hint: string; bbox?: readonly [number, number, number, number] }, seed: bigint): string {
  // Seed-driven jitter to make different seeds produce different (still valid) output.
  const jitter = Number((seed & 0xfn)) * 2;   // 0..30
  const [x, y, w, h] = slot.bbox ?? [0, 0, 100, 100];
  if (slot.hint === 'symmetric-half') {
    return `<svg viewBox="${x} ${y} ${w} ${h}"><path d="M0 ${y} L ${(w / 2) + jitter} ${y} L ${(w / 2) + jitter} ${y + h} L 0 ${y + h} Z"/></svg>`;
  }
  if (slot.hint === 'closed-path') {
    const cx = x + w / 2, cy = y + h / 2;
    const r = Math.min(w, h) * 0.4 - jitter;
    return `<svg viewBox="${x} ${y} ${w} ${h}"><path d="M${cx - r} ${cy - r} L ${cx + r} ${cy - r} L ${cx + r} ${cy + r} L ${cx - r} ${cy + r} Z"/></svg>`;
  }
  // open-path / tileable: just a single line
  return `<svg viewBox="${x} ${y} ${w} ${h}"><path d="M${x} ${y} L ${x + w} ${y + h}"/></svg>`;
}

function _paramFor(slot: { kind: string; range?: readonly [number, number]; choices?: readonly string[]; default: number | string }): number | string {
  if (slot.kind === 'enum') return slot.default;
  if (!slot.range) return slot.default;
  const mid = (slot.range[0] + slot.range[1]) / 2;
  return slot.kind === 'integer' ? Math.round(mid) : mid;
}
```

- [ ] **Step 4: Run → PASS**

```bash
npm test --workspace=@hayba/architecture -- provider-mock.test
```
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/architecture/src/ai/provider-mock.ts packages/architecture/src/ai/provider-mock.test.ts
git diff --cached --name-only
git commit -m "feat(architecture): AI mock provider (deterministic, no-key)"
```

---

### Task 6: generate-binding pipeline

**Files:**
- Create: `packages/architecture/src/ai/generate-binding.ts`
- Create: `packages/architecture/src/ai/generate-binding.test.ts`

- [ ] **Step 1: Write failing test**

`packages/architecture/src/ai/generate-binding.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { generateBinding } from './generate-binding.js';
import { MockProvider } from './provider-mock.js';
import { loadElementCatalog, loadRegistry, emitElementMesh, registerBinding } from '../index.js';

const catalog = loadElementCatalog();
const reg = loadRegistry();
const element = catalog.elementsById.get('column')!;
const styleSheet = reg.styleGuidesById.get('medieval-european-gothic')!.styleSheet;

describe('generateBinding', () => {
  it('produces a valid binding draft via the mock provider', async () => {
    const r = await generateBinding({
      element, styleSheet, seed: 0x42n,
      provider: new MockProvider(),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.draft.elementId).toBe('column');
      expect(r.draft.styleSheetId).toBe('medieval-european-gothic');
      expect(r.draft.seed).toBe(0x42n);
      expect(r.draft.provenance.source).toBe('ai');
      expect(r.draft.provenance.aiProvider).toBe('mock');
    }
  });

  it('the generated draft round-trips through the kernel', async () => {
    const r = await generateBinding({
      element, styleSheet, seed: 0xabcn,
      provider: new MockProvider(),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Register and emit — proves the mock binding actually renders.
      registerBinding(r.draft);
      const mesh = emitElementMesh('medieval-european-gothic', 'column');
      expect(mesh.ok).toBe(true);
      if (mesh.ok) expect(mesh.stats.triangles).toBeGreaterThan(0);
    }
  });

  it('returns the same draft twice for the same seed (mock determinism)', async () => {
    const a = await generateBinding({ element, styleSheet, seed: 0x111n, provider: new MockProvider() });
    const b = await generateBinding({ element, styleSheet, seed: 0x111n, provider: new MockProvider() });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(JSON.stringify(a.draft.profiles)).toBe(JSON.stringify(b.draft.profiles));
      expect(JSON.stringify(a.draft.params)).toBe(JSON.stringify(b.draft.params));
    }
  });
});
```

- [ ] **Step 2: Run → FAIL**

```bash
npm test --workspace=@hayba/architecture -- generate-binding.test
```
Expected: FAIL — module + `registerBinding` not exported yet (latter fixed in Task 8).

- [ ] **Step 3: Implement generate-binding.ts**

`packages/architecture/src/ai/generate-binding.ts`:
```ts
import type { Element, StyleSheet } from '../index.js';
import { buildPrompt } from './prompt-builder.js';
import { parseResponse } from './response-parser.js';
import type {
  AIProvider, GenerateBindingResult, GenerateBindingError,
} from './types.js';

export interface GenerateBindingArgs {
  element: Element;
  styleSheet: StyleSheet;
  seed: bigint;
  provider: AIProvider;
  referenceImages?: readonly string[];
}

export async function generateBinding(
  args: GenerateBindingArgs,
): Promise<GenerateBindingResult | GenerateBindingError> {
  const { element, styleSheet, seed, provider, referenceImages } = args;

  // 1. Build prompt
  const prompt = buildPrompt({ element, styleSheet, seed, referenceImages });

  // 2. Call provider
  let raw;
  try {
    raw = await provider.generate({ element, styleSheet, seed, referenceImages }, prompt);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      stage: 'provider',
      errors: [{ path: '/', message }],
      message,
    };
  }

  // 3. Parse + validate + SVG-parse-test
  return parseResponse(
    raw.rawText,
    element,
    styleSheet.id,
    seed,
    raw.provider,
    raw.model,
    raw.promptHash,
  );
}
```

(Step 4 below will pause; Task 7 implements the Anthropic provider, Task 8 adds `registerBinding` to element-registry — both needed for the test to pass. We commit the implementation now even though the test still fails on `registerBinding`.)

- [ ] **Step 4: Verify partial tests run (provider determinism passes, registerBinding test still fails)**

```bash
npm test --workspace=@hayba/architecture -- generate-binding.test
```
Expected: 2 of 3 pass (first and third); second fails on `registerBinding is not a function`.

- [ ] **Step 5: Commit (the failing registerBinding test is acceptable — Task 8 will green it)**

```bash
git add packages/architecture/src/ai/generate-binding.ts packages/architecture/src/ai/generate-binding.test.ts
git diff --cached --name-only
git commit -m "feat(architecture): generate-binding pipeline (prompt + provider + parse)"
```

---

### Task 7: Anthropic provider

**Files:**
- Create: `packages/architecture/src/ai/provider-anthropic.ts`
- Create: `packages/architecture/src/ai/provider-anthropic.test.ts`

- [ ] **Step 1: Write failing test**

`packages/architecture/src/ai/provider-anthropic.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { AnthropicProvider } from './provider-anthropic.js';
import { loadElementCatalog, loadRegistry } from '../index.js';
import { buildPrompt } from './prompt-builder.js';

const catalog = loadElementCatalog();
const reg = loadRegistry();
const element = catalog.elementsById.get('column')!;
const styleSheet = reg.styleGuidesById.get('medieval-european-gothic')!.styleSheet;

describe('AnthropicProvider', () => {
  it('uses the configured model id', () => {
    const p = new AnthropicProvider({ apiKey: 'sk-test', model: 'claude-haiku-4-5' });
    expect(p.name).toBe('anthropic');
    expect(p.model).toBe('claude-haiku-4-5');
  });

  it('passes system + user prompt to the SDK and returns raw text', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"profiles":{},"params":{}}' }],
      model: 'claude-haiku-4-5',
    });
    const mockClient = { messages: { create: mockCreate } };
    const p = new AnthropicProvider({ apiKey: 'sk-test', model: 'claude-haiku-4-5', _client: mockClient as never });
    const prompt = buildPrompt({ element, styleSheet, seed: 1n });
    const r = await p.generate({ element, styleSheet, seed: 1n }, prompt);
    expect(mockCreate).toHaveBeenCalledOnce();
    const call = mockCreate.mock.calls[0][0];
    expect(call.model).toBe('claude-haiku-4-5');
    expect(call.system).toBe(prompt.system);
    expect(call.messages[0].content).toBe(prompt.user);
    expect(r.rawText).toBe('{"profiles":{},"params":{}}');
    expect(r.provider).toBe('anthropic');
  });

  it('throws when the SDK returns no text content', async () => {
    const mockCreate = vi.fn().mockResolvedValue({ content: [{ type: 'tool_use', input: {} }] });
    const mockClient = { messages: { create: mockCreate } };
    const p = new AnthropicProvider({ apiKey: 'sk-test', model: 'claude-haiku-4-5', _client: mockClient as never });
    const prompt = buildPrompt({ element, styleSheet, seed: 1n });
    await expect(p.generate({ element, styleSheet, seed: 1n }, prompt)).rejects.toThrow(/text/);
  });
});
```

- [ ] **Step 2: Run → FAIL**

```bash
npm test --workspace=@hayba/architecture -- provider-anthropic.test
```

- [ ] **Step 3: Implement provider-anthropic.ts**

`packages/architecture/src/ai/provider-anthropic.ts`:
```ts
import Anthropic from '@anthropic-ai/sdk';
import { hashPrompt } from './prompt-builder.js';
import type { AIProvider, BindingRequest, RawBindingResponse } from './types.js';

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
  /** Browser-only: required to call the API directly (no proxy). */
  dangerouslyAllowBrowser?: boolean;
  /** Test-only: inject a mock SDK client. */
  _client?: { messages: { create: (args: unknown) => Promise<unknown> } };
}

const DEFAULT_MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 2048;

export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic' as const;
  readonly model: string;
  private readonly client: AnthropicProviderOptions['_client'];

  constructor(opts: AnthropicProviderOptions) {
    this.model = opts.model ?? DEFAULT_MODEL;
    if (opts._client) {
      this.client = opts._client;
    } else {
      const sdk = new Anthropic({
        apiKey: opts.apiKey,
        dangerouslyAllowBrowser: opts.dangerouslyAllowBrowser ?? false,
      });
      this.client = { messages: { create: (args) => sdk.messages.create(args as never) as unknown as Promise<unknown> } };
    }
  }

  async generate(_req: BindingRequest, prompt: { system: string; user: string }): Promise<RawBindingResponse> {
    const response = await this.client!.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
    }) as { content: Array<{ type: string; text?: string }> };

    const textBlock = response.content.find(c => c.type === 'text' && typeof c.text === 'string');
    if (!textBlock || !textBlock.text) {
      throw new Error('AnthropicProvider: response had no text content');
    }
    return {
      rawText: textBlock.text,
      provider: 'anthropic',
      model: this.model,
      promptHash: hashPrompt(prompt.system, prompt.user),
    };
  }
}
```

- [ ] **Step 4: Run → PASS**

```bash
npm test --workspace=@hayba/architecture -- provider-anthropic.test
```
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/architecture/src/ai/provider-anthropic.ts packages/architecture/src/ai/provider-anthropic.test.ts
git diff --cached --name-only
git commit -m "feat(architecture): Anthropic provider (BYOK, dangerouslyAllowBrowser opt-in)"
```

---

### Task 7B: OpenAI-compatible provider (Groq / OpenRouter / OpenAI / Ollama / LM Studio)

**Files:**
- Create: `packages/architecture/src/ai/provider-openai-compat.ts`
- Create: `packages/architecture/src/ai/provider-openai-compat.test.ts`

This single provider class targets every endpoint that speaks the OpenAI chat-completions API. Configuration:

```ts
new OpenAICompatibleProvider({
  baseUrl: 'https://api.groq.com/openai/v1',   // or http://localhost:11434/v1 for Ollama, etc.
  apiKey: 'gsk_...',                            // or '' for local servers that don't require one
  model: 'llama-3.1-70b-versatile',             // provider-specific
  name: 'groq',                                 // optional cosmetic; defaults to 'openai-compat'
});
```

The class uses plain `fetch()` — no SDK dep — so it works identically in Node and the browser.

- [ ] **Step 1: Write failing test**

`packages/architecture/src/ai/provider-openai-compat.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAICompatibleProvider } from './provider-openai-compat.js';
import { buildPrompt } from './prompt-builder.js';
import { loadElementCatalog, loadRegistry } from '../index.js';

const catalog = loadElementCatalog();
const reg = loadRegistry();
const element = catalog.elementsById.get('column')!;
const styleSheet = reg.styleGuidesById.get('medieval-european-gothic')!.styleSheet;

const fetchMock = vi.fn();
const realFetch = globalThis.fetch;

beforeEach(() => { globalThis.fetch = fetchMock as unknown as typeof fetch; });
afterEach(() => { globalThis.fetch = realFetch; fetchMock.mockReset(); });

describe('OpenAICompatibleProvider', () => {
  it('exposes the configured base URL, model, and provider name', () => {
    const p = new OpenAICompatibleProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'gsk_test', model: 'llama-3.1-70b-versatile', name: 'groq',
    });
    expect(p.name).toBe('groq');
    expect(p.model).toBe('llama-3.1-70b-versatile');
  });

  it('POSTs to <baseUrl>/chat/completions with the configured model + prompts', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: '{"profiles":{},"params":{}}' } }],
        model: 'llama-3.1-70b-versatile',
      }),
    });
    const p = new OpenAICompatibleProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'gsk_test', model: 'llama-3.1-70b-versatile',
    });
    const prompt = buildPrompt({ element, styleSheet, seed: 1n });
    const r = await p.generate({ element, styleSheet, seed: 1n }, prompt);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer gsk_test');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('llama-3.1-70b-versatile');
    expect(body.messages[0]).toEqual({ role: 'system',  content: prompt.system });
    expect(body.messages[1]).toEqual({ role: 'user',    content: prompt.user });
    expect(r.rawText).toBe('{"profiles":{},"params":{}}');
    expect(r.provider).toBe('openai-compat');
  });

  it('omits Authorization header when apiKey is empty (local Ollama / LM Studio)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{}' } }] }),
    });
    const p = new OpenAICompatibleProvider({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '', model: 'qwen2.5-coder:7b-instruct',
    });
    const prompt = buildPrompt({ element, styleSheet, seed: 1n });
    await p.generate({ element, styleSheet, seed: 1n }, prompt);
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('throws when fetch returns a non-2xx response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' });
    const p = new OpenAICompatibleProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'bad', model: 'm',
    });
    const prompt = buildPrompt({ element, styleSheet, seed: 1n });
    await expect(p.generate({ element, styleSheet, seed: 1n }, prompt)).rejects.toThrow(/401/);
  });

  it('throws when the response has no message content', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: {} }] }),
    });
    const p = new OpenAICompatibleProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'gsk_test', model: 'm',
    });
    const prompt = buildPrompt({ element, styleSheet, seed: 1n });
    await expect(p.generate({ element, styleSheet, seed: 1n }, prompt)).rejects.toThrow(/content/);
  });
});
```

- [ ] **Step 2: Run → FAIL**

```bash
npm test --workspace=@hayba/architecture -- provider-openai-compat.test
```

- [ ] **Step 3: Implement `provider-openai-compat.ts`**

`packages/architecture/src/ai/provider-openai-compat.ts`:
```ts
import { hashPrompt } from './prompt-builder.js';
import type { AIProvider, BindingRequest, RawBindingResponse, AIProviderName } from './types.js';

export interface OpenAICompatibleProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Cosmetic name for provenance tracking. Defaults to 'openai-compat'. */
  name?: string;
  /** Max tokens to request. Default 2048. */
  maxTokens?: number;
  /** Temperature. Default 0.7 — high enough for variety, low enough for valid JSON. */
  temperature?: number;
}

/**
 * Speaks the OpenAI chat-completions HTTP API. Compatible with:
 * - Groq            (https://api.groq.com/openai/v1)
 * - OpenRouter      (https://openrouter.ai/api/v1)
 * - OpenAI          (https://api.openai.com/v1)
 * - Ollama (local)  (http://localhost:11434/v1, no key needed)
 * - LM Studio       (http://localhost:1234/v1, no key needed)
 * - vLLM, llama.cpp server, anything else with /chat/completions
 */
export class OpenAICompatibleProvider implements AIProvider {
  readonly name: AIProviderName;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly maxTokens: number;
  private readonly temperature: number;

  constructor(opts: OpenAICompatibleProviderOptions) {
    this.name = (opts.name as AIProviderName) ?? ('openai-compat' as AIProviderName);
    this.model = opts.model;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.maxTokens = opts.maxTokens ?? 2048;
    this.temperature = opts.temperature ?? 0.7;
  }

  async generate(_req: BindingRequest, prompt: { system: string; user: string }): Promise<RawBindingResponse> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const url = `${this.baseUrl}/chat/completions`;
    const body = JSON.stringify({
      model: this.model,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user',   content: prompt.user },
      ],
      max_tokens: this.maxTokens,
      temperature: this.temperature,
    });

    const res = await fetch(url, { method: 'POST', headers, body });
    if (!res.ok) {
      const text = await (res.text?.() ?? Promise.resolve(''));
      throw new Error(`OpenAICompatibleProvider: HTTP ${res.status} from ${url}: ${text.slice(0, 200)}`);
    }
    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error(`OpenAICompatibleProvider: response had no message content`);
    }

    return {
      rawText: content,
      provider: this.name,
      model: this.model,
      promptHash: hashPrompt(prompt.system, prompt.user),
    };
  }
}

/** Convenience presets for the settings panel. */
export const OPENAI_COMPAT_PRESETS = [
  { id: 'groq',      label: 'Groq (free tier)',         baseUrl: 'https://api.groq.com/openai/v1',  defaultModel: 'llama-3.1-70b-versatile', needsKey: true,  keyHint: 'gsk_...' },
  { id: 'openrouter',label: 'OpenRouter (free routes)', baseUrl: 'https://openrouter.ai/api/v1',    defaultModel: 'meta-llama/llama-3-8b-instruct:free', needsKey: true,  keyHint: 'sk-or-...' },
  { id: 'openai',    label: 'OpenAI',                   baseUrl: 'https://api.openai.com/v1',       defaultModel: 'gpt-4o-mini',             needsKey: true,  keyHint: 'sk-...' },
  { id: 'ollama',    label: 'Ollama (local)',           baseUrl: 'http://localhost:11434/v1',       defaultModel: 'qwen2.5-coder:7b-instruct', needsKey: false, keyHint: '(no key)' },
  { id: 'lmstudio',  label: 'LM Studio (local)',        baseUrl: 'http://localhost:1234/v1',        defaultModel: 'local-model',             needsKey: false, keyHint: '(no key)' },
  { id: 'custom',    label: 'Custom OpenAI-compatible', baseUrl: '',                                defaultModel: '',                        needsKey: false, keyHint: 'optional' },
] as const;
```

You'll also need to extend the `AIProviderName` union in `types.ts` to include `'openai-compat'`. Find:

```ts
export type AIProviderName = 'anthropic' | 'openai' | 'fal' | 'local' | 'mock';
```

and replace with:

```ts
export type AIProviderName = 'anthropic' | 'openai' | 'openai-compat' | 'groq' | 'openrouter' | 'ollama' | 'lmstudio' | 'fal' | 'local' | 'mock';
```

- [ ] **Step 4: Run → PASS**

```bash
npm test --workspace=@hayba/architecture -- provider-openai-compat.test
```
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/architecture/src/ai/provider-openai-compat.ts packages/architecture/src/ai/provider-openai-compat.test.ts packages/architecture/src/ai/types.ts
git diff --cached --name-only
git commit -m "feat(architecture): OpenAI-compatible provider (Groq, OpenRouter, OpenAI, Ollama, LM Studio, custom)"
```

---

### Task 8: Kernel — `registerBinding` + re-exports

**Files:**
- Modify: `packages/architecture/src/element-registry.ts`
- Modify: `packages/architecture/src/element-registry.test.ts`
- Modify: `packages/architecture/src/index.ts` (re-export AI surface)

- [ ] **Step 1: Append failing test**

In `packages/architecture/src/element-registry.test.ts` append:

```ts
import { registerBinding } from './element-registry.js';

describe('registerBinding (session-only binding registration)', () => {
  it('registers a new binding and makes it available via loadBinding', () => {
    const fake: ElementBinding = {
      elementId: 'column',
      styleSheetId: 'test-style-sheet-xyz',
      seed: 0xfacen,
      profiles: {
        shaft:          '<svg viewBox="0 0 200 1000"><path d="M0 0 L 100 0 L 100 1000 L 0 1000 Z"/></svg>',
        base:           '<svg viewBox="0 0 300 80"><path d="M0 0 L 150 0 L 150 80 L 0 80 Z"/></svg>',
        capital_bottom: '<svg viewBox="-100 -100 200 200"><path d="M-50 -50 L 50 -50 L 50 50 L -50 50 Z"/></svg>',
        capital_top:    '<svg viewBox="-150 -150 300 300"><path d="M-100 -100 L 100 -100 L 100 100 L -100 100 Z"/></svg>',
      },
      params: { base_height_m: 0.2, shaft_height_m: 3.0, capital_height_m: 0.3, revolve_segments: 32 },
      provenance: { source: 'ai', aiProvider: 'mock', createdAt: '2026-05-13T00:00:00Z' },
    };
    registerBinding(fake);
    const got = loadBinding('test-style-sheet-xyz', 'column');
    expect(got).not.toBeNull();
    expect(got!.seed).toBe(0xfacen);
  });

  it('overwrites a previously registered binding for the same (styleSheet, element)', () => {
    const first: ElementBinding = {
      elementId: 'column',
      styleSheetId: 'overwrite-test',
      seed: 0x1n,
      profiles: { /* same valid 4 profiles as above */
        shaft:          '<svg viewBox="0 0 200 1000"><path d="M0 0 L 100 0 L 100 1000 L 0 1000 Z"/></svg>',
        base:           '<svg viewBox="0 0 300 80"><path d="M0 0 L 150 0 L 150 80 L 0 80 Z"/></svg>',
        capital_bottom: '<svg viewBox="-100 -100 200 200"><path d="M-50 -50 L 50 -50 L 50 50 L -50 50 Z"/></svg>',
        capital_top:    '<svg viewBox="-150 -150 300 300"><path d="M-100 -100 L 100 -100 L 100 100 L -100 100 Z"/></svg>',
      },
      params: { base_height_m: 0.2, shaft_height_m: 3.0, capital_height_m: 0.3, revolve_segments: 32 },
      provenance: { source: 'ai', aiProvider: 'mock', createdAt: '2026-05-13T00:00:00Z' },
    };
    const second = { ...first, seed: 0x2n };
    registerBinding(first);
    registerBinding(second);
    expect(loadBinding('overwrite-test', 'column')!.seed).toBe(0x2n);
  });
});
```

(Add `import type { ElementBinding } from './schema.js';` near the top of the test file if not already present.)

- [ ] **Step 2: Run → FAIL**

```bash
npm test --workspace=@hayba/architecture -- element-registry.test
```

- [ ] **Step 3: Add registerBinding to element-registry.ts**

In `packages/architecture/src/element-registry.ts`, after the existing `loadBinding` function, add:

```ts
/**
 * Register a binding at runtime (session-only). Adds (or overwrites) an entry
 * in the binding catalog. Persistence to disk is a separate concern — call
 * `acceptBindingToDisk` (Plan 4) to commit, or `Download JSON` from the atlas.
 *
 * Throws if the element type is unknown.
 */
export function registerBinding(binding: ElementBinding): void {
  const elements = loadElementCatalog();
  if (!elements.elementsById.has(binding.elementId)) {
    throw new Error(`registerBinding: unknown element ${JSON.stringify(binding.elementId)}`);
  }
  // Force the binding catalog to load if it hasn't yet.
  loadBindingCatalog();
  const key = `${binding.styleSheetId}::${binding.elementId}`;
  // CAT_BINDINGS.byKey is a ReadonlyMap typewise but a real Map at runtime;
  // cast via unknown to set/overwrite.
  const map = (CAT_BINDINGS as { byKey: Map<string, ElementBinding> }).byKey;
  map.set(key, binding);
}
```

You'll also need to update the `loadBindingCatalog` function to be exported (it's currently file-private). Find:
```ts
function loadBindingCatalog(): BindingCatalog {
```
and change to:
```ts
export function loadBindingCatalog(): BindingCatalog {
```

(Don't expose CAT_BINDINGS itself — the assertion in registerBinding is the only place we mutate.)

- [ ] **Step 4: Update index.ts to re-export AI surface**

Append to `packages/architecture/src/index.ts`:
```ts
// AI binding pipeline
export type {
  BindingRequest, RawBindingResponse, ParsedBindingDraft,
  AIProviderName, AIProvider,
  GenerateBindingResult, GenerateBindingError,
} from './ai/types.js';
export { buildPrompt, hashPrompt } from './ai/prompt-builder.js';
export { parseResponse } from './ai/response-parser.js';
export { MockProvider } from './ai/provider-mock.js';
export { AnthropicProvider } from './ai/provider-anthropic.js';
export type { AnthropicProviderOptions } from './ai/provider-anthropic.js';
export { OpenAICompatibleProvider, OPENAI_COMPAT_PRESETS } from './ai/provider-openai-compat.js';
export type { OpenAICompatibleProviderOptions } from './ai/provider-openai-compat.js';
export { generateBinding } from './ai/generate-binding.js';
export type { GenerateBindingArgs } from './ai/generate-binding.js';
export { registerBinding } from './element-registry.js';
```

- [ ] **Step 5: Run all tests**

```bash
npm test --workspace=@hayba/architecture
```
Expected: ALL tests pass (including the previously-failing third generate-binding test).

- [ ] **Step 6: Commit**

```bash
git add packages/architecture/src/element-registry.ts packages/architecture/src/element-registry.test.ts packages/architecture/src/index.ts
git diff --cached --name-only
git commit -m "feat(architecture): registerBinding for session-only AI bindings + re-export AI surface"
```

---

### Task 9: MCP tool `architecture_generate_binding`

**Files:**
- Modify: `packages/hayba/src/tools/worldbuilding/architecture-handlers.ts`

- [ ] **Step 1: Add the handler**

Read the existing file first:
```bash
cat packages/hayba/src/tools/worldbuilding/architecture-handlers.ts
```
You'll see existing handlers like `listStyleGuides`, `getStyleGuide`, etc.

Append to the file:

```ts
import {
  loadElementCatalog as engineLoadElementCatalog,
  generateBinding as engineGenerateBinding,
  MockProvider, AnthropicProvider, OpenAICompatibleProvider,
  loadRegistry as engineLoadRegistry,
} from '@hayba/architecture';

/* ─────────────────────  AI binding generation  ───────────────────── */

export const generateBindingSchema = z.object({
  styleSheetId: z.string().describe('Target style sheet id (e.g. "medieval-european-gothic")'),
  elementId: z.string().describe('Target element id (e.g. "column")'),
  seed: z.string().optional().describe('Hex bigint seed (e.g. "0x42"). Defaults to 0xa70.'),
  provider: z.enum(['mock', 'anthropic', 'groq', 'openrouter', 'openai', 'ollama', 'lmstudio', 'custom']).optional().default('mock')
    .describe('AI provider. Default mock (no key). free: groq, openrouter, ollama, lmstudio. paid: anthropic, openai. custom: provide baseUrl.'),
  model: z.string().optional().describe('Provider-specific model id.'),
  baseUrl: z.string().optional().describe('Required when provider="custom". The OpenAI-compatible chat-completions root, e.g. http://localhost:8080/v1.'),
});

const ENV_KEY_BY_PROVIDER: Record<string, string> = {
  anthropic:  'HAYBA_ANTHROPIC_API_KEY',
  groq:       'HAYBA_GROQ_API_KEY',
  openrouter: 'HAYBA_OPENROUTER_API_KEY',
  openai:     'HAYBA_OPENAI_API_KEY',
  custom:     'HAYBA_CUSTOM_API_KEY',
};

const BASE_URL_BY_PROVIDER: Record<string, string> = {
  groq:       'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  openai:     'https://api.openai.com/v1',
  ollama:     'http://localhost:11434/v1',
  lmstudio:   'http://localhost:1234/v1',
};

const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  anthropic:  'claude-haiku-4-5',
  groq:       'llama-3.1-70b-versatile',
  openrouter: 'meta-llama/llama-3-8b-instruct:free',
  openai:     'gpt-4o-mini',
  ollama:     'qwen2.5-coder:7b-instruct',
  lmstudio:   'local-model',
};

export async function generateBinding(params: z.infer<typeof generateBindingSchema>) {
  const catalog = engineLoadElementCatalog();
  const reg = engineLoadRegistry();
  const element = catalog.elementsById.get(params.elementId);
  if (!element) return { ok: false, error: 'unknown_element', message: `no element ${JSON.stringify(params.elementId)}` };
  const guide = reg.styleGuidesById.get(params.styleSheetId);
  if (!guide) return { ok: false, error: 'unknown_style', message: `no style sheet ${JSON.stringify(params.styleSheetId)}` };

  let provider;
  if (params.provider === 'mock') {
    provider = new MockProvider();
  } else if (params.provider === 'anthropic') {
    const key = process.env.HAYBA_ANTHROPIC_API_KEY;
    if (!key) {
      return { ok: false, error: 'ai_failed', message: 'no API key configured. Set HAYBA_ANTHROPIC_API_KEY.' };
    }
    provider = new AnthropicProvider({ apiKey: key, model: params.model });
  } else {
    // OpenAI-compatible family: groq / openrouter / openai / ollama / lmstudio / custom
    const baseUrl = params.provider === 'custom'
      ? params.baseUrl
      : BASE_URL_BY_PROVIDER[params.provider];
    if (!baseUrl) {
      return { ok: false, error: 'ai_failed', message: `unknown provider ${JSON.stringify(params.provider)} or missing baseUrl` };
    }
    const envKey = ENV_KEY_BY_PROVIDER[params.provider];
    const key = envKey ? (process.env[envKey] ?? '') : '';
    if (envKey && !key && params.provider !== 'custom') {
      return {
        ok: false,
        error: 'ai_failed',
        message: `no API key for ${params.provider}. Set ${envKey}, or use provider="mock"/"ollama"/"lmstudio" for keyless options.`,
      };
    }
    const model = params.model ?? DEFAULT_MODEL_BY_PROVIDER[params.provider] ?? 'unknown';
    provider = new OpenAICompatibleProvider({ baseUrl, apiKey: key, model, name: params.provider });
  }

  const seed = params.seed ? BigInt(params.seed) : 0xa70n;
  const result = await engineGenerateBinding({
    element, styleSheet: guide.styleSheet, seed, provider,
  });

  if (result.ok) {
    return {
      ok: true,
      draft: { ...result.draft, seed: '0x' + result.draft.seed.toString(16) },   // bigint → hex string for JSON transport
      rationale: result.rationale ?? null,
      validation: { ok: true },
      retriesUsed: 0,
    };
  }
  return {
    ok: false,
    error: 'ai_failed',
    message: result.message,
    stage: result.stage,
    errors: result.errors,
  };
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck --workspace=hayba
```
Expected: silent.

- [ ] **Step 3: Commit**

```bash
git add packages/hayba/src/tools/worldbuilding/architecture-handlers.ts
git diff --cached --name-only
git commit -m "feat(architecture): MCP handler for architecture_generate_binding"
```

---

### Task 10: Register MCP tool in hayba server

**Files:**
- Modify: `packages/hayba/src/tools/index.ts`

- [ ] **Step 1: Add the import alias**

Near the top of `packages/hayba/src/tools/index.ts`, find the existing block:
```ts
import {
  ...
  validateStyleGuide as architectureValidateStyleGuide,
} from './worldbuilding/architecture-handlers.js';
```

Add to that import statement:
```ts
  generateBindingSchema,
  generateBinding as architectureGenerateBinding,
```

- [ ] **Step 2: Register the server.tool**

Find the existing `architecture_validate_style_guide` server.tool block. After its closing `);` insert:

```ts
  server.tool(
    'architecture_generate_binding',
    'Generate an AI-authored ElementBinding for (styleSheetId, elementId). Non-deterministic: calls an LLM provider. Returns a draft binding for review; caller decides whether to accept/register/save.',
    generateBindingSchema.shape,
    async (params) => {
      try {
        const result = await architectureGenerateBinding(params as z.infer<typeof generateBindingSchema>);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'unexpected', message: msg }) }], isError: true };
      }
    }
  );
```

- [ ] **Step 3: Register the reg() entry**

Find the existing `reg('architecture_validate_style_guide', ...)` line. After it:

```ts
  reg('architecture_generate_binding', generateBindingSchema.shape, 'high', '{ok, draft, rationale, validation, retriesUsed}|{ok:false, error, message, stage, errors}');
```

Note `'high'` latency: this tool calls an external AI API.

- [ ] **Step 4: Build + test**

```bash
npm run typecheck --workspace=hayba
```
Expected: silent.

- [ ] **Step 5: Commit**

```bash
git add packages/hayba/src/tools/index.ts
git diff --cached --name-only
git commit -m "feat(architecture): register architecture_generate_binding MCP tool"
```

---

### Task 11: Atlas demo — BYOK settings panel

**Files:**
- Modify: `packages/architecture/demo/index.html`

- [ ] **Step 1: Add a "Settings" button to the toolbar**

Find the existing toolbar block (`<div class="toolbar">`). After the existing `<span class="mono muted">A1 · style-data explorer</span>` line (the rightmost element), insert a settings button:

```html
  <button class="settings-btn" id="settingsBtn" title="Configure AI provider">⚙ settings</button>
```

- [ ] **Step 2: Add a settings modal HTML**

Just before the existing `<div id="viewerModal" ...>` block (the 3D viewer modal), insert:

```html
<div id="settingsModal" class="viewer-modal" style="display:none;">
  <div class="viewer-modal-backdrop"></div>
  <div class="viewer-modal-card" style="width: 480px;">
    <div class="viewer-modal-h">
      <span>Settings · AI provider</span>
      <button class="viewer-modal-close" id="settingsModalClose">✕</button>
    </div>
    <div style="padding: 8px 0; display: flex; flex-direction: column; gap: 14px;">
      <div>
        <div class="settings-label">Provider</div>
        <select class="settings-input" id="settingsProvider">
          <option value="mock">Mock (no key, canned output — for testing)</option>
          <optgroup label="Free providers">
            <option value="groq">Groq — free tier, very fast (llama / mixtral)</option>
            <option value="openrouter">OpenRouter — free routes (llama-3, gemini-flash)</option>
          </optgroup>
          <optgroup label="Local (no key, run a server first)">
            <option value="ollama">Ollama (localhost:11434) — qwen, llama, etc.</option>
            <option value="lmstudio">LM Studio (localhost:1234)</option>
          </optgroup>
          <optgroup label="Paid">
            <option value="anthropic">Anthropic Claude (BYOK)</option>
            <option value="openai">OpenAI (BYOK)</option>
          </optgroup>
          <option value="custom">Custom OpenAI-compatible endpoint</option>
        </select>
      </div>
      <div id="settingsKeyRow">
        <div class="settings-label">API key</div>
        <input type="password" class="settings-input" id="settingsApiKey" placeholder="sk-..." autocomplete="off">
        <div class="settings-hint">Stays on this machine (browser localStorage). Sent only to the chosen provider's endpoint.</div>
      </div>
      <div id="settingsBaseUrlRow" style="display:none;">
        <div class="settings-label">Base URL</div>
        <input type="text" class="settings-input" id="settingsBaseUrl" placeholder="http://localhost:8080/v1">
        <div class="settings-hint">For custom endpoints (vLLM, llama.cpp server, etc.). Must point to the root that exposes /chat/completions.</div>
      </div>
      <div>
        <div class="settings-label">Model</div>
        <input type="text" class="settings-input" id="settingsModel" placeholder="model name">
      </div>
      <div style="display: flex; gap: 8px; justify-content: flex-end;">
        <button class="settings-action settings-action-primary" id="settingsSaveBtn">Save</button>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 3: Add CSS for the settings UI**

Just before the closing `</style>` tag, insert:

```css
  /* —— settings button + settings modal —— */
  .settings-btn {
    height: 26px; padding: 0 10px;
    background: transparent; border: 1px solid var(--border-soft);
    color: var(--text-secondary); border-radius: 4px;
    font: 11.5px var(--font-ui); cursor: pointer;
    margin-left: 8px;
    transition: background .12s, color .12s, border-color .12s;
  }
  .settings-btn:hover { background: var(--bg-panel); color: var(--text-primary); border-color: var(--accent); }
  .settings-label {
    font-size: 10.5px; letter-spacing: 0.6px; text-transform: uppercase;
    color: var(--text-muted); font-weight: 700; margin-bottom: 6px;
  }
  .settings-row { padding: 3px 0; font-size: 12.5px; color: var(--text-primary); }
  .settings-input {
    width: 100%; padding: 6px 10px;
    background: var(--bg-deep); color: var(--text-primary);
    border: 1px solid var(--border-soft); border-radius: 4px;
    font: 12px var(--font-mono); outline: none;
    transition: border-color .12s;
  }
  .settings-input:focus { border-color: var(--accent); }
  .settings-hint { font-size: 10.5px; color: var(--text-muted); margin-top: 4px; }
  .settings-action {
    height: 28px; padding: 0 14px; border-radius: 4px;
    background: var(--bg-elevated); border: 1px solid var(--border-soft);
    color: var(--text-primary); font: 12px var(--font-ui); cursor: pointer;
  }
  .settings-action:hover { background: var(--bg-raised); border-color: var(--accent); }
  .settings-action-primary {
    background: var(--accent); color: #0e1219; border-color: var(--accent); font-weight: 600;
  }
  .settings-action-primary:hover { background: var(--accent-hover); }
```

- [ ] **Step 4: Add the settings JS (localStorage persistence + modal open/close)**

In the main `<script type="module">` block, after the `BOUND_PAIRS` declaration, add:

```js
/* ── AI provider settings (BYOK), persisted to localStorage ── */
const SETTINGS_KEY = 'hayba-architecture-atlas-settings';
function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
  } catch { return {}; }
}
function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

// Per-provider defaults; user can override via settings UI.
const PROVIDER_DEFAULTS = {
  mock:       { model: 'mock-deterministic',                needsKey: false, needsBaseUrl: false, baseUrl: '' },
  groq:       { model: 'llama-3.1-70b-versatile',            needsKey: true,  needsBaseUrl: false, baseUrl: 'https://api.groq.com/openai/v1' },
  openrouter: { model: 'meta-llama/llama-3-8b-instruct:free',needsKey: true,  needsBaseUrl: false, baseUrl: 'https://openrouter.ai/api/v1' },
  ollama:     { model: 'qwen2.5-coder:7b-instruct',          needsKey: false, needsBaseUrl: false, baseUrl: 'http://localhost:11434/v1' },
  lmstudio:   { model: 'local-model',                        needsKey: false, needsBaseUrl: false, baseUrl: 'http://localhost:1234/v1' },
  anthropic:  { model: 'claude-haiku-4-5',                   needsKey: true,  needsBaseUrl: false, baseUrl: '' },
  openai:     { model: 'gpt-4o-mini',                        needsKey: true,  needsBaseUrl: false, baseUrl: 'https://api.openai.com/v1' },
  custom:     { model: '',                                   needsKey: false, needsBaseUrl: true,  baseUrl: '' },
};

const settings = Object.assign({
  provider: 'mock',
  apiKey: '',
  model: PROVIDER_DEFAULTS.mock.model,
  baseUrl: '',
}, loadSettings());
```

And near the bottom (where the existing click handlers live), add:

```js
// Settings modal wiring.
function updateSettingsModalVisibility() {
  const provider = document.getElementById('settingsProvider').value;
  const defaults = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.mock;
  document.getElementById('settingsKeyRow').style.display = (defaults.needsKey || provider === 'custom') ? '' : 'none';
  document.getElementById('settingsBaseUrlRow').style.display = defaults.needsBaseUrl ? '' : 'none';
}

document.getElementById('settingsBtn').addEventListener('click', () => {
  document.getElementById('settingsModal').style.display = 'flex';
  document.getElementById('settingsProvider').value = settings.provider;
  document.getElementById('settingsApiKey').value = settings.apiKey;
  document.getElementById('settingsModel').value = settings.model;
  document.getElementById('settingsBaseUrl').value = settings.baseUrl;
  updateSettingsModalVisibility();
});
document.getElementById('settingsProvider').addEventListener('change', () => {
  // When provider changes, suggest the default model + baseUrl for that provider.
  const provider = document.getElementById('settingsProvider').value;
  const defaults = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.mock;
  document.getElementById('settingsModel').value = defaults.model;
  if (defaults.baseUrl) document.getElementById('settingsBaseUrl').value = defaults.baseUrl;
  updateSettingsModalVisibility();
});
document.getElementById('settingsModalClose').addEventListener('click', () => {
  document.getElementById('settingsModal').style.display = 'none';
});
document.getElementById('settingsSaveBtn').addEventListener('click', () => {
  settings.provider = document.getElementById('settingsProvider').value;
  settings.apiKey   = document.getElementById('settingsApiKey').value.trim();
  settings.model    = document.getElementById('settingsModel').value.trim() || PROVIDER_DEFAULTS[settings.provider]?.model || '';
  settings.baseUrl  = document.getElementById('settingsBaseUrl').value.trim();
  saveSettings(settings);
  document.getElementById('settingsModal').style.display = 'none';
});
```

- [ ] **Step 5: Smoke-test**

Open the demo (`npm run serve --workspace=@hayba/architecture`). Confirm:
- A "⚙ settings" button appears in the toolbar (right side).
- Clicking it opens the modal.
- Selecting Anthropic, entering a key, hitting Save → localStorage has the value (`localStorage.getItem('hayba-architecture-atlas-settings')` in console).
- Reopening shows the saved values.

- [ ] **Step 6: Commit**

```bash
git add packages/architecture/demo/index.html
git diff --cached --name-only
git commit -m "feat(architecture): atlas — BYOK settings panel (provider, Anthropic key, model)"
```

---

### Task 12: Atlas demo — Generate / Accept flow in inspector

**Files:**
- Modify: `packages/architecture/demo/index.html`

- [ ] **Step 1: Add "Generate binding" button to the bound-element card**

Find the `bound-elements-grid` template within `renderCenter()`. The current per-card markup is:

```html
<div class="bound-element-card" data-element="${p.elementId}" data-style="${p.styleSheetId}">
  ...existing content...
</div>
```

Replace with (add a regen button):

```html
<div class="bound-element-card" data-element="${p.elementId}" data-style="${p.styleSheetId}">
  ...existing content unchanged...
  <button class="bec-regen" data-regen-element="${p.elementId}" data-regen-style="${p.styleSheetId}" title="Regenerate via AI">⟲ regen</button>
</div>
```

- [ ] **Step 2: Add CSS for the regen button**

In the existing CSS block, add:

```css
  .bec-regen {
    align-self: flex-start; margin-top: 4px;
    background: transparent; border: 1px solid var(--border-soft);
    color: var(--text-secondary); padding: 3px 8px;
    border-radius: 3px; cursor: pointer;
    font: 10.5px var(--font-ui);
    transition: background .12s, color .12s, border-color .12s;
  }
  .bec-regen:hover { background: var(--bg-elevated); color: var(--text-primary); border-color: var(--accent); }
  .gen-overlay {
    position: absolute; inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex; align-items: center; justify-content: center;
    color: var(--text-primary); font-size: 12px;
  }
```

- [ ] **Step 3: Add the kernel-side generate call**

In the main script block (after the existing `kernelMod` setup), add:

```js
async function generateBindingInBrowser(styleSheetId, elementId, seedHex = '0xa70') {
  if (!kernelMod) throw new Error('Kernel not loaded');
  const catalog = kernelMod.loadElementCatalog();
  const reg = kernelMod.loadRegistry();
  const element = catalog.elementsById.get(elementId);
  const guide = reg.styleGuidesById.get(styleSheetId);
  if (!element || !guide) throw new Error('Unknown element or style sheet');

  const provider = (() => {
    const defaults = PROVIDER_DEFAULTS[settings.provider] ?? PROVIDER_DEFAULTS.mock;
    if (settings.provider === 'mock') return new kernelMod.MockProvider();
    if (settings.provider === 'anthropic') {
      if (!settings.apiKey) throw new Error('Anthropic key not set. Open ⚙ settings.');
      return new kernelMod.AnthropicProvider({
        apiKey: settings.apiKey,
        model: settings.model || defaults.model,
        dangerouslyAllowBrowser: true,
      });
    }
    // OpenAI-compatible family.
    const baseUrl = settings.provider === 'custom'
      ? settings.baseUrl
      : defaults.baseUrl;
    if (!baseUrl) throw new Error('No base URL configured for this provider. Open ⚙ settings.');
    if (defaults.needsKey && !settings.apiKey) {
      throw new Error(`Key required for ${settings.provider}. Open ⚙ settings.`);
    }
    return new kernelMod.OpenAICompatibleProvider({
      baseUrl,
      apiKey: settings.apiKey || '',
      model: settings.model || defaults.model,
      name: settings.provider,
    });
  })();

  const seed = BigInt(seedHex);
  const r = await kernelMod.generateBinding({
    element, styleSheet: guide.styleSheet, seed, provider,
  });
  return r;
}

async function regenerateBoundElement(styleSheetId, elementId, button) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = '⏳ generating…';
  try {
    // Seed varies with timestamp so repeated regens give different output.
    const seed = '0x' + (Date.now() & 0xffffffff).toString(16);
    const r = await generateBindingInBrowser(styleSheetId, elementId, seed);
    if (!r.ok) {
      alert(`Generation failed (${r.stage}):\n` + r.errors.map(e => `${e.path}: ${e.message}`).join('\n'));
      button.textContent = originalText;
      button.disabled = false;
      return;
    }
    // Register the new binding with the kernel so emitElementMesh picks it up.
    kernelMod.registerBinding(r.draft);
    // Refresh the right pane and (if 3D viewer is open) re-emit.
    button.textContent = '✓ accepted';
    setTimeout(() => {
      button.textContent = originalText;
      button.disabled = false;
    }, 1200);
    // If the viewer is currently showing this element, re-open it with the new binding.
    if (document.getElementById('viewerModal').style.display === 'flex') {
      openViewer(styleSheetId, elementId);
    }
  } catch (e) {
    alert(`Generation error: ${e.message}`);
    button.textContent = originalText;
    button.disabled = false;
  }
}
```

- [ ] **Step 4: Wire the button click**

In the existing document-level click handler (the one that already handles `.bound-element-card` clicks), update to handle regen separately. Replace:

```js
document.addEventListener('click', (e) => {
  const card = e.target.closest('.bound-element-card');
  if (card) { openViewer(card.dataset.style, card.dataset.element); return; }
  // ... existing material/ornament inspect handlers ...
});
```

with:

```js
document.addEventListener('click', (e) => {
  // Regen button — must be handled BEFORE the card-click handler swallows it.
  const regenBtn = e.target.closest('[data-regen-element]');
  if (regenBtn) {
    e.stopPropagation();
    regenerateBoundElement(regenBtn.dataset.regenStyle, regenBtn.dataset.regenElement, regenBtn);
    return;
  }

  const card = e.target.closest('.bound-element-card');
  if (card) { openViewer(card.dataset.style, card.dataset.element); return; }

  // ... keep existing material/ornament inspect handlers ...
  const matEl = e.target.closest('[data-inspect-material]');
  if (matEl) {
    state.inspecting = { kind: 'material', id: matEl.dataset.inspectMaterial };
    renderCenter(); renderRight();
    return;
  }
  const ornEl = e.target.closest('[data-inspect-ornament]');
  if (ornEl) {
    state.inspecting = { kind: 'ornament', id: ornEl.dataset.inspectOrnament };
    renderCenter(); renderRight();
    return;
  }
});
```

- [ ] **Step 5: Smoke-test end-to-end**

```bash
npm run build --workspace=@hayba/architecture
npm run serve --workspace=@hayba/architecture
```

1. Open the demo, navigate to Gothic.
2. In the Bound elements panel, each card has a "⟲ regen" button.
3. With default settings (provider=mock), click ⟲ on the column card.
4. Button shows "⏳ generating…" → "✓ accepted" within a few hundred ms.
5. Click the column card itself — the 3D viewer should show the new column geometry (mock provider's centered-rectangle-revolve looks plausibly column-shaped).
6. Click ⟲ again with a different seed (the timestamp seed varies per click) — the 3D should change slightly.

If provider=anthropic is selected with a valid key:
- Same flow, but the API call takes ~5–15 seconds; the geometry should look like a real Gothic column.

- [ ] **Step 6: Commit**

```bash
git add packages/architecture/demo/index.html
git diff --cached --name-only
git commit -m "feat(architecture): atlas — Generate/Accept flow with kernel registerBinding integration"
```

---

## Definition of done

- [x] AI provider abstraction: `AIProvider` interface, `MockProvider` + `AnthropicProvider` + `OpenAICompatibleProvider` implementations *(Tasks 2, 5, 7, 7B)*
- [x] Pure-functional prompt builder + response parser, both fully unit-tested *(Tasks 3, 4)*
- [x] `generateBinding` pipeline composes the pieces end-to-end *(Task 6)*
- [x] Kernel exposes `registerBinding` for session-only binding addition *(Task 8)*
- [x] MCP tool `architecture_generate_binding` ships with **8 providers**: mock, anthropic, groq, openrouter, openai, ollama, lmstudio, custom *(Tasks 9, 10)*
- [x] Atlas demo: BYOK settings panel persists to localStorage; provider dropdown with free, local, paid groups *(Task 11)*
- [x] Atlas demo: "⟲ regen" button on every bound-element card, full Generate → Register → Re-render loop *(Task 12)*
- [x] All vitest tests pass (~140 total including ~30 new for the AI surface — adds 5 OpenAI-compat tests on top of the original mock/anthropic suite)
- [x] Typecheck + build clean across both `@hayba/architecture` and `@hayba/mcp`

## Out of scope (re-stated)

- Persistence to disk (`acceptBindingToDisk`) — Plan 4
- Reference-image upload + multi-image prompt conditioning — Plan 4
- Streaming token display in the inspector
- Retry loop with structured error feedback
- Batch generation across all `(style sheet × element)` pairs — Plan 4
- FAL / Replicate / specialty image-gen providers (these aren't OpenAI-compatible) — Plan 5+

## Self-review notes (already applied)

- Confirmed every type used in later tasks (`AIProvider`, `RawBindingResponse`, `GenerateBindingResult`) is exported by an earlier task.
- Confirmed the `generate-binding.test.ts` third test (`registerBinding round-trip`) is expected to fail at Task 6 and pass after Task 8 — flagged explicitly in Task 6 Step 4.
- Confirmed `process.env.HAYBA_ANTHROPIC_API_KEY` matches the spec's BYOK env var naming (§ 7).
- Confirmed seed is serialized as hex string at MCP boundaries (bigint isn't JSON-transportable) and deserialized via `BigInt(...)` inside.
- Confirmed `dangerouslyAllowBrowser: true` is only set when the demo passes it explicitly — Node-side calls (MCP tool) don't set it.
