// POST /api/waitlist {"email": "..."}: the Hayba Pro early-access waitlist.
//
// 200 {ok:true}                         stored (or already on the list)
// 400 {error:"invalid_email"}
// 405 {error:"method_not_allowed"}
// 503 {error:"waitlist_not_configured"} no storage env vars; the site shows a fallback
// 502 {error:"storage_failed"}
//
// The address is never logged. Vercel serves this from the repo root's /api,
// next to the static site in website/ (vercel.json outputDirectory).

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readEmail(body) {
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = Object.fromEntries(new URLSearchParams(body));
    }
  }
  const email = body && typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

module.exports = async function waitlist(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const email = readEmail(req.body);
  if (!email) return res.status(400).json({ error: 'invalid_email' });

  // shortcut: no storage yet, wire to Supabase or Vercel Blob when Pro launches
  // Setting SUPABASE_URL and SUPABASE_ANON_KEY turns on the insert below, into the
  // waitlist_entries table from supabase/migrations/20260514034747_waitlist.sql.
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return res.status(503).json({ error: 'waitlist_not_configured' });

  try {
    const stored = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/waitlist_entries`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ email }),
    });
    // 409 is the unique-email constraint: answer as success, so the form never reveals who signed up.
    if (stored.ok || stored.status === 409) return res.status(200).json({ ok: true });
    console.error('waitlist: storage answered', stored.status);
  } catch (err) {
    console.error('waitlist: storage unreachable', err && err.name);
  }
  return res.status(502).json({ error: 'storage_failed' });
};
