# Architecture — Binding Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans.

**Goal:** AI-generated (and manually-edited) bindings survive page reload by being written to disk via two new endpoints on `serve.mjs`.

**Architecture:** `POST /api/bindings/:styleSheetId/:elementId` writes the body to `packages/architecture/src/bindings/<style>/<element>.json` after server-side validation. `GET /api/bindings/list` enumerates `src/bindings/`. Atlas replaces its hardcoded `BOUND_PAIRS` with a dynamic fetch; after AI-accept, atlas POSTs the binding + calls `kernelMod.registerBinding()` for instant reflection.

**Tech Stack:** Node 24+ (no new deps). Existing `serve.mjs` is a tiny `node:http` server; we extend it.

**Spec:** none (small, designed inline)
**Branch:** `feat/architecture-pillar`

**Out of scope:** authentication, conflict resolution, history versioning, cross-machine sync.

---

### Task 1: serve.mjs — `GET /api/bindings/list`

**Files:**
- Modify: `packages/architecture/demo/serve.mjs`

- [ ] **Step 1: Verify branch**

```bash
cd D:/Hackathons/hayba && git branch --show-current
```
Expected: `feat/architecture-pillar`. STOP with BLOCKED if uncommitted changes prevent switching.

- [ ] **Step 2: Add the route**

Read the existing `serve.mjs` first. It's a small node:http server that serves static files from the package root. Add the API route handling INSIDE the existing request handler, BEFORE the static-file fallback.

Add at the top of the file, after the existing imports:

```js
import { readdir } from 'node:fs/promises';
```

Find the existing request-handler function. Locate the line that starts with:
```js
const server = createServer(async (req, res) => {
```

Add the API branch as the FIRST thing inside the try block (right after `let url = decodeURIComponent(...)`):

```js
    // ─── API: list bindings on disk ─────────────────────────────────────
    if (url === '/api/bindings/list' && req.method === 'GET') {
      const bindingsRoot = join(ROOT, 'src', 'bindings');
      const out = [];
      try {
        const styleSheets = await readdir(bindingsRoot, { withFileTypes: true });
        for (const sheetEntry of styleSheets) {
          if (!sheetEntry.isDirectory()) continue;
          const sheetDir = join(bindingsRoot, sheetEntry.name);
          const files = await readdir(sheetDir, { withFileTypes: true });
          for (const fileEntry of files) {
            if (!fileEntry.isFile() || !fileEntry.name.endsWith('.json')) continue;
            out.push({
              styleSheetId: sheetEntry.name,
              elementId: fileEntry.name.replace(/\.json$/, ''),
            });
          }
        }
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        // bindings dir doesn't exist yet — empty list is fine
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out));
      return;
    }
```

- [ ] **Step 3: Smoke test**

Start the server: `npm run serve --workspace=@hayba/architecture`
Open another shell:
```bash
curl http://localhost:5184/api/bindings/list
```
(Use whatever port the server printed.) Expected output: a JSON array containing at least the three Gothic bindings, e.g.:
```json
[{"styleSheetId":"medieval-european-gothic","elementId":"column"},{"styleSheetId":"medieval-european-gothic","elementId":"cornice"},{"styleSheetId":"medieval-european-gothic","elementId":"finial"}]
```

Stop the server (Ctrl+C in its terminal).

- [ ] **Step 4: Commit**

```bash
git add packages/architecture/demo/serve.mjs
git diff --cached --name-only   # ONLY this file
git commit -m "feat(architecture): serve.mjs — GET /api/bindings/list (scan src/bindings/)"
```

---

### Task 2: serve.mjs — `POST /api/bindings/:styleSheetId/:elementId`

**Files:**
- Modify: `packages/architecture/demo/serve.mjs`

- [ ] **Step 1: Add imports**

At the top of `serve.mjs`, add to the existing fs imports:
```js
import { mkdir, writeFile } from 'node:fs/promises';
```

- [ ] **Step 2: Add helper for reading the request body**

Add just after the API list-route block (or near the top of the request handler):

```js
async function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error(`request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
```

(Put this at module scope, not inside the handler, so it's defined once.)

- [ ] **Step 3: Add the POST route**

Inside the request handler, after the list route, add:

```js
    // ─── API: write binding to disk ─────────────────────────────────────
    const writeMatch = url.match(/^\/api\/bindings\/([^/]+)\/([^/]+)$/);
    if (writeMatch && req.method === 'POST') {
      const [, styleSheetId, elementId] = writeMatch;
      // Sanitize: no path traversal, no slashes, must look like an id.
      const idPat = /^[a-z0-9_-]+$/i;
      if (!idPat.test(styleSheetId) || !idPat.test(elementId)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid id (only [A-Za-z0-9_-] allowed)' }));
        return;
      }
      let bodyText;
      try {
        bodyText = await readBody(req);
      } catch (err) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
        return;
      }
      let body;
      try {
        body = JSON.parse(bodyText);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'request body must be valid JSON' }));
        return;
      }
      // Minimal shape check (full validation happens client-side via the kernel).
      if (typeof body !== 'object' || body === null ||
          body.elementId !== elementId || body.styleSheetId !== styleSheetId ||
          typeof body.profiles !== 'object' || typeof body.params !== 'object') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: 'binding JSON malformed: elementId/styleSheetId/profiles/params required and ids must match the URL',
        }));
        return;
      }
      const targetDir = join(ROOT, 'src', 'bindings', styleSheetId);
      const targetFile = join(targetDir, `${elementId}.json`);
      // Final guard: resolved path must stay under bindings/.
      const bindingsRoot = join(ROOT, 'src', 'bindings');
      if (!targetFile.startsWith(bindingsRoot)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'path traversal refused' }));
        return;
      }
      await mkdir(targetDir, { recursive: true });
      await writeFile(targetFile, JSON.stringify(body, null, 2) + '\n', 'utf-8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: `src/bindings/${styleSheetId}/${elementId}.json` }));
      return;
    }
```

- [ ] **Step 4: Smoke test**

Start the server. In another shell:
```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"elementId":"column","styleSheetId":"test-write","seed":"0x1","profiles":{"a":"x"},"params":{},"provenance":{"source":"human","createdAt":"2026-05-13T00:00:00Z"}}' \
  http://localhost:5184/api/bindings/test-write/column
```
Expected response: `{"ok":true,"path":"src/bindings/test-write/column.json"}`. Check that the file exists at `packages/architecture/src/bindings/test-write/column.json` and contains the JSON. Then delete that test file:
```bash
rm packages/architecture/src/bindings/test-write/column.json
rmdir packages/architecture/src/bindings/test-write
```

Test invalid IDs:
```bash
curl -X POST -H "Content-Type: application/json" -d '{}' http://localhost:5184/api/bindings/../foo/bar
```
Expected: 400 with `invalid id`.

- [ ] **Step 5: Commit**

```bash
git add packages/architecture/demo/serve.mjs
git diff --cached --name-only
git commit -m "feat(architecture): serve.mjs — POST /api/bindings/:style/:element with path-safe validation"
```

---

### Task 3: Atlas — dynamic binding load on startup

**Files:**
- Modify: `packages/architecture/demo/index.html`

- [ ] **Step 1: Locate the current BOUND_PAIRS + bindings fetch**

Find this block in `demo/index.html` (inside the `<script type="module">` block):

```js
const BOUND_PAIRS = [
  { styleSheetId: 'medieval-european-gothic', elementId: 'column' },
  { styleSheetId: 'medieval-european-gothic', elementId: 'cornice' },
  { styleSheetId: 'medieval-european-gothic', elementId: 'finial' },
];

const [typologyFile, ...guides] = await Promise.all([
  fetch('../src/data/typologies.json').then(r => r.json()),
  ...GUIDE_FILES.map(n => fetch(`../src/data/style-guides/${n}.json`).then(r => r.json())),
]);

const bindings = {};
for (const { styleSheetId, elementId } of BOUND_PAIRS) {
  bindings[`${styleSheetId}::${elementId}`] =
    await fetch(`../src/bindings/${styleSheetId}/${elementId}.json`).then(r => r.json());
}
```

- [ ] **Step 2: Replace the static list with a dynamic fetch**

REPLACE the entire block above with:

```js
// Start with a dynamic listing from the server. If the listing endpoint is
// unavailable (e.g. the user is serving static files from a non-Hayba server),
// fall back to a hardcoded set so the page still works.
const FALLBACK_BOUND_PAIRS = [
  { styleSheetId: 'medieval-european-gothic', elementId: 'column' },
  { styleSheetId: 'medieval-european-gothic', elementId: 'cornice' },
  { styleSheetId: 'medieval-european-gothic', elementId: 'finial' },
];

let BOUND_PAIRS;
try {
  const list = await fetch('/api/bindings/list').then(r => r.json());
  BOUND_PAIRS = Array.isArray(list) && list.length > 0 ? list : FALLBACK_BOUND_PAIRS;
} catch {
  BOUND_PAIRS = FALLBACK_BOUND_PAIRS;
}

const [typologyFile, ...guides] = await Promise.all([
  fetch('../src/data/typologies.json').then(r => r.json()),
  ...GUIDE_FILES.map(n => fetch(`../src/data/style-guides/${n}.json`).then(r => r.json())),
]);

const bindings = {};
await Promise.all(BOUND_PAIRS.map(async ({ styleSheetId, elementId }) => {
  try {
    bindings[`${styleSheetId}::${elementId}`] =
      await fetch(`../src/bindings/${styleSheetId}/${elementId}.json`).then(r => r.json());
  } catch (err) {
    console.warn(`Failed to load binding ${styleSheetId}/${elementId}:`, err);
  }
}));
```

- [ ] **Step 3: Smoke test**

```bash
npm run build --workspace=@hayba/architecture
npm run serve --workspace=@hayba/architecture
```

Open `http://localhost:5184/demo/` (or whichever port). Open browser devtools network tab. Confirm `/api/bindings/list` is called and returns the three Gothic bindings. The atlas should look identical to before — same three bound elements visible on the Gothic detail page.

- [ ] **Step 4: Commit**

```bash
git add packages/architecture/demo/index.html
git diff --cached --name-only
git commit -m "feat(architecture): atlas — dynamic binding load from /api/bindings/list (with hardcoded fallback)"
```

---

### Task 4: Atlas — POST after AI-accept + register

**Files:**
- Modify: `packages/architecture/demo/index.html`

- [ ] **Step 1: Locate the AI accept flow**

Find the `regenerateBoundElement` function in the script block. Currently it:
1. Calls `generateBindingInBrowser(...)` to get a draft.
2. On success, calls `kernelMod.registerBinding(r.draft)` (session-only).
3. Updates the button text + reopens the viewer if it's showing.

We're adding a POST step after the kernel register and before the UI feedback.

- [ ] **Step 2: Add the POST helper**

After the existing `generateBindingInBrowser` function definition, add:

```js
async function persistBindingToServer(binding) {
  // Serialize bigint seed as hex string for JSON transport.
  const transported = { ...binding, seed: '0x' + binding.seed.toString(16) };
  const url = `/api/bindings/${encodeURIComponent(binding.styleSheetId)}/${encodeURIComponent(binding.elementId)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(transported),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Persist failed (HTTP ${r.status}): ${txt}`);
  }
  return await r.json();
}
```

- [ ] **Step 3: Wire the POST into the accept flow**

Find the existing `regenerateBoundElement` function. Locate the block:

```js
    // Register the new binding with the kernel so emitElementMesh picks it up.
    kernelMod.registerBinding(r.draft);
    button.textContent = '✓ accepted';
    setTimeout(() => {
      button.textContent = originalText;
      button.disabled = false;
    }, 1200);
    // If the viewer is currently showing this element, re-open it with the new binding.
    if (document.getElementById('viewerModal').style.display === 'flex') {
      openViewer(styleSheetId, elementId);
    }
```

REPLACE it with:

```js
    // Register the new binding with the kernel so emitElementMesh picks it up.
    kernelMod.registerBinding(r.draft);

    // Persist to disk so the binding survives page reload.
    button.textContent = '💾 saving…';
    try {
      await persistBindingToServer(r.draft);
    } catch (persistErr) {
      console.warn('Persist failed (kept in session only):', persistErr);
      alert(`Saved to session but failed to persist to disk:\n${persistErr.message}`);
    }

    // Update local cache so re-renders see the new binding.
    bindings[`${styleSheetId}::${elementId}`] = { ...r.draft, seed: '0x' + r.draft.seed.toString(16) };

    button.textContent = '✓ accepted';
    setTimeout(() => {
      button.textContent = originalText;
      button.disabled = false;
    }, 1200);
    // If the viewer is currently showing this element, re-open it with the new binding.
    if (document.getElementById('viewerModal').style.display === 'flex') {
      openViewer(styleSheetId, elementId);
    }
    // Refresh the bound-elements panel so meta info reflects new params.
    renderCenter();
```

- [ ] **Step 4: Smoke test**

```bash
npm run build --workspace=@hayba/architecture
npm run serve --workspace=@hayba/architecture
```

In the browser:
1. Navigate to Gothic style sheet.
2. Click ⟲ regen on the column card.
3. Button cycles `⏳ generating…` → `💾 saving…` → `✓ accepted`.
4. Verify the file at `packages/architecture/src/bindings/medieval-european-gothic/column.json` has been overwritten (different `seed` in `provenance.aiProvider` field). You can check `git diff packages/architecture/src/bindings/medieval-european-gothic/column.json`.
5. Hard-refresh the page. The newly-regenerated geometry should still be there (click the column to verify in the 3D viewer).

- [ ] **Step 5: Revert the test binding before committing**

If you ran a regen in step 4, you'll have modified the Gothic column binding. Restore the original:
```bash
git checkout packages/architecture/src/bindings/medieval-european-gothic/column.json
```

- [ ] **Step 6: Commit**

```bash
git add packages/architecture/demo/index.html
git diff --cached --name-only
git commit -m "feat(architecture): atlas — POST regenerated bindings to /api/bindings + refresh local cache"
```

---

### Task 5: Smoke-test the round-trip + commit notes

**Files:** none modified — verification only.

- [ ] **Step 1: Restart the dev server with a clean build**

```bash
npm run build --workspace=@hayba/architecture
npm run serve --workspace=@hayba/architecture
```

- [ ] **Step 2: End-to-end check**

In the browser:
1. Open the demo. Navigate to Gothic.
2. Open ⚙ settings; select provider `mock` (no key needed). Save.
3. Click ⟲ regen on the column card. Wait for `✓ accepted`.
4. Click the column card → 3D viewer should render the new geometry.
5. Close the viewer.
6. Hard-refresh (Ctrl+Shift+R).
7. Click the column card again → the regenerated geometry should still be there (it loaded from disk, not from session memory).

- [ ] **Step 3: Verify the disk state**

```bash
git diff packages/architecture/src/bindings/medieval-european-gothic/column.json
```
You should see the binding has changed compared to git HEAD — that's the persisted regeneration. Restore the original:
```bash
git checkout packages/architecture/src/bindings/medieval-european-gothic/column.json
```

- [ ] **Step 4: No commit needed** (verification only). If anything broke and you fixed it, commit the fix as `fix(architecture): ...`.

---

## Definition of done

- [x] `GET /api/bindings/list` returns all bindings on disk *(Task 1)*
- [x] `POST /api/bindings/:style/:element` writes JSON to disk after id-sanity validation *(Task 2)*
- [x] Atlas startup uses the dynamic listing; falls back to hardcoded set if endpoint absent *(Task 3)*
- [x] AI-accept flow persists to disk + refreshes local cache *(Task 4)*
- [x] End-to-end round-trip verified: regen → page reload → regenerated geometry survives *(Task 5)*

## Out of scope (re-stated)

- Authentication on the write endpoint (local dev only)
- Conflict resolution / version history (overwrite is fine)
- A separate "Accept" UX distinct from "Regen" (currently regen auto-accepts; a draft-review workflow comes with the SVG editor in Phase 2)
- Cross-machine sync
