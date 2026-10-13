// node --test api/_waitlist.test.mjs   (the leading underscore keeps Vercel from serving this file)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const waitlist = createRequire(import.meta.url)('./waitlist.js');

function call(req) {
  return new Promise((resolve) => {
    const res = {
      code: 0,
      setHeader() {},
      status(code) { this.code = code; return this; },
      json(body) { resolve({ status: this.code, body }); return this; },
    };
    waitlist(req, res);
  });
}

test('only POST is allowed', async () => {
  assert.equal((await call({ method: 'GET' })).status, 405);
});

test('rejects missing or malformed addresses', async () => {
  for (const body of [undefined, {}, { email: 'nope' }, { email: 'a@b' }, 'email=x', { email: `${'a'.repeat(250)}@b.co` }]) {
    assert.equal((await call({ method: 'POST', body })).status, 400, JSON.stringify(body));
  }
});

test('answers 503 waitlist_not_configured without storage env vars', async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  assert.deepEqual(await call({ method: 'POST', body: { email: 'dev@example.com' } }),
    { status: 503, body: { error: 'waitlist_not_configured' } });
});

test('stores a normalised address when configured; a duplicate still answers ok', async () => {
  process.env.SUPABASE_URL = 'https://db.example.co/';
  process.env.SUPABASE_ANON_KEY = 'anon';
  const realFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return { ok: false, status: 409 }; };
  try {
    const r = await call({ method: 'POST', body: '{"email":" Dev@Example.com "}' });
    assert.deepEqual(r, { status: 200, body: { ok: true } });
    assert.deepEqual(sent, { url: 'https://db.example.co/rest/v1/waitlist_entries', body: { email: 'dev@example.com' } });
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
  }
});
