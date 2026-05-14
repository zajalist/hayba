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
