// Approves a waitlist entry: updates status, invites the user by email.
// Requires the caller to have profiles.is_admin = true.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL    = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PUBLIC_SITE_URL = Deno.env.get('PUBLIC_SITE_URL') ?? 'https://hayba.app';

Deno.serve(async (req) => {
  const auth = req.headers.get('Authorization') ?? '';
  if (!auth) return new Response('unauthorised', { status: 401 });

  // Get the calling user from their bearer token.
  const userClient = createClient(SUPABASE_URL, SERVICE_ROLE);
  const { data: { user: caller }, error: userErr } = await userClient.auth.getUser(
    auth.replace('Bearer ', ''),
  );
  if (userErr || !caller) return new Response('unauthorised', { status: 401 });

  // Admin guard via profiles.is_admin.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const { data: prof } = await admin
    .from('profiles').select('is_admin').eq('user_id', caller.id).single();
  if (!prof?.is_admin) return new Response('forbidden', { status: 403 });

  const { id } = await req.json();
  if (!id) return new Response('id required', { status: 400 });

  // Fetch the entry.
  const { data: entry, error: fetchErr } = await admin
    .from('waitlist_entries').select('*').eq('id', id).single();
  if (fetchErr || !entry) return new Response('entry not found', { status: 404 });
  if (entry.status === 'approved') {
    return new Response(JSON.stringify({ ok: true, already: true }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  // Update status first.
  const { error: upErr } = await admin.from('waitlist_entries')
    .update({
      status: 'approved',
      approved_by: caller.id,
      approved_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (upErr) return new Response(upErr.message, { status: 500 });

  // Send the invite email.
  const { error: invErr } = await admin.auth.admin.inviteUserByEmail(entry.email, {
    redirectTo: `${PUBLIC_SITE_URL}/app`,
  });
  if (invErr) {
    // Roll back status so the admin can retry cleanly.
    await admin.from('waitlist_entries')
      .update({ status: 'pending', approved_by: null, approved_at: null })
      .eq('id', id);
    return new Response('invite failed: ' + invErr.message, { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'content-type': 'application/json' },
  });
});
