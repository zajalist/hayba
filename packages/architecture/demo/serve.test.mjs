import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleRequest, __setDataDir } from './serve.mjs';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'serve-')); __setDataDir(root); });

test('GET /api/cultures empty → []', async () => {
  const res = await handleRequest({ method: 'GET', url: '/api/cultures' });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), []);
});

test('POST /api/cultures creates + GET /api/cultures/:id returns', async () => {
  const create = await handleRequest({
    method: 'POST', url: '/api/cultures',
    body: JSON.stringify({ id: 'temp', name: 'Temp', region: 'X', climate: 'temperate' }),
  });
  assert.equal(create.status, 201);
  const get = await handleRequest({ method: 'GET', url: '/api/cultures/temp' });
  assert.equal(get.status, 200);
  assert.equal(JSON.parse(get.body).id, 'temp');
});

test('POST duplicate id → 409', async () => {
  await handleRequest({ method: 'POST', url: '/api/cultures', body: JSON.stringify({ id: 'dup', name: 'D', region: 'X', climate: 'temperate' }) });
  const res = await handleRequest({ method: 'POST', url: '/api/cultures', body: JSON.stringify({ id: 'dup', name: 'D', region: 'X', climate: 'temperate' }) });
  assert.equal(res.status, 409);
});

test('GET nonexistent → 404', async () => {
  const res = await handleRequest({ method: 'GET', url: '/api/cultures/ghost' });
  assert.equal(res.status, 404);
});

test('PATCH updates a field', async () => {
  await handleRequest({ method: 'POST', url: '/api/cultures', body: JSON.stringify({ id: 'p', name: 'P', region: 'X', climate: 'temperate' }) });
  const res = await handleRequest({ method: 'PATCH', url: '/api/cultures/p', body: JSON.stringify({ region: 'New' }) });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).region, 'New');
});

test('DELETE removes', async () => {
  await handleRequest({ method: 'POST', url: '/api/cultures', body: JSON.stringify({ id: 'd', name: 'D', region: 'X', climate: 'temperate' }) });
  const res = await handleRequest({ method: 'DELETE', url: '/api/cultures/d' });
  assert.equal(res.status, 204);
  const after = await handleRequest({ method: 'GET', url: '/api/cultures/d' });
  assert.equal(after.status, 404);
});

// ─── /resolve endpoint ────────────────────────────────────────────────────

async function makeResolveFixture() {
  // Create a culture with one era and one rule
  const culture = {
    id: 'rc',
    name: 'Resolve Culture',
    region: 'Test',
    climate: 'temperate',
    rules: [
      {
        id: 'r-1',
        priority: 1,
        conditions: { scenario: 'temple', tagMatches: { climate: 'cold' } },
        assigns: { materialId: 'limestone' },
      },
    ],
    eras: [
      {
        id: 'era-1',
        name: 'Era One',
        dateRange: [100, 200],
        defaults: { roofType: 'gabled', proportions: {}, palette: [], ornamentDensity: 'moderate', technique: '' },
        typologyMix: {},
        rules: [],
      },
    ],
    materials: [],
    ornaments: [],
    tagAxes: [],
  };
  await handleRequest({ method: 'POST', url: '/api/cultures', body: JSON.stringify({ id: 'rc', name: 'RC', region: 'X', climate: 'temperate' }) });
  await handleRequest({ method: 'PATCH', url: '/api/cultures/rc', body: JSON.stringify(culture) });
}

test('GET /resolve returns assigns for a matching rule', async () => {
  await makeResolveFixture();
  const res = await handleRequest({ method: 'GET', url: '/api/cultures/rc/resolve?eraId=era-1&scenario=temple&tags=climate:cold' });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.assigns.materialId, 'limestone');
  assert.equal(body.ruleId, 'r-1');
});

test('GET /resolve returns empty assigns when no rule matches', async () => {
  await makeResolveFixture();
  const res = await handleRequest({ method: 'GET', url: '/api/cultures/rc/resolve?eraId=era-1&scenario=temple&tags=climate:warm' });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.assigns, {});
  assert.equal(body.ruleId, null);
});

test('GET /resolve returns 404 for unknown culture', async () => {
  const res = await handleRequest({ method: 'GET', url: '/api/cultures/ghost/resolve?eraId=era-1&scenario=x' });
  assert.equal(res.status, 404);
});

test('GET /resolve returns 404 for unknown era', async () => {
  await makeResolveFixture();
  const res = await handleRequest({ method: 'GET', url: '/api/cultures/rc/resolve?eraId=no-era&scenario=x' });
  assert.equal(res.status, 404);
});

test('GET /resolve returns 400 when eraId missing', async () => {
  await makeResolveFixture();
  const res = await handleRequest({ method: 'GET', url: '/api/cultures/rc/resolve?scenario=temple' });
  assert.equal(res.status, 400);
});
