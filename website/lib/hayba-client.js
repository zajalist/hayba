// Hayba browser SDK — single seam between the website and Supabase.
// Pages must NOT touch the underlying supabase client directly; reach for
// the namespaced operations on the default export instead.
//
// One construction; one config-validity check; one place to swap transports.

import { createHaybaSupabaseClient } from '/dist/supabase-client.js';

function readConfig() {
  const cfg = (typeof window !== 'undefined' && window.HAYBA_CONFIG) || null;
  if (!cfg) return null;
  // Detect the un-substituted Vercel build placeholders.
  if (typeof cfg.url !== 'string' || cfg.url.includes('__VERCEL') || cfg.url === '') {
    return null;
  }
  if (typeof cfg.anonKey !== 'string' || cfg.anonKey.includes('__VERCEL') || cfg.anonKey === '') {
    return null;
  }
  return cfg;
}

const config = readConfig();
const client = config ? createHaybaSupabaseClient(config) : null;

export const isOffline = !client;

function requireClient() {
  if (!client) throw new Error('Hayba SDK: runtime config missing — set VERCEL_PUBLIC_HAYBA_API_URL and VERCEL_PUBLIC_HAYBA_ANON_KEY in Vercel.');
  return client;
}

// ─────────────── auth ───────────────
export const auth = {
  async signIn(email, { redirectTo } = {}) {
    const sb = requireClient();
    const target = redirectTo || `${window.location.origin}/app`;
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: target },
    });
    return { error };
  },
  async signOut() {
    return requireClient().auth.signOut();
  },
  async getSession() {
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data.session;
  },
  async getUser() {
    if (!client) return null;
    const { data } = await client.auth.getUser();
    return data.user;
  },
  subscribe(cb) {
    if (!client) return () => {};
    const { data: { subscription } } = client.auth.onAuthStateChange((_evt, session) => cb(session));
    return () => subscription.unsubscribe();
  },
};

// ─────────────── profile ───────────────
export const profile = {
  async isAdmin(userId) {
    const sb = requireClient();
    const { data } = await sb.from('profiles').select('is_admin').eq('user_id', userId).single();
    return !!data?.is_admin;
  },
};

// ─────────────── forum ───────────────
export const topics = {
  async list({ limit = 50 } = {}) {
    const sb = requireClient();
    const { data, error } = await sb
      .from('forum_topics')
      .select('id, title, body, author_email, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    return { data: data || [], error };
  },
  async create({ title, body }) {
    const sb = requireClient();
    const session = await auth.getSession();
    if (!session) return { error: new Error('not signed in') };
    return sb.from('forum_topics').insert({
      author_id: session.user.id,
      author_email: session.user.email,
      title,
      body,
    });
  },
};

// ─────────────── waitlist ───────────────
export const waitlist = {
  async submit(payload) {
    const sb = requireClient();
    return sb.from('waitlist_entries').insert(payload);
  },
};

// ─────────────── admin: waitlist entries ───────────────
export const entries = {
  async countByStatus(status) {
    const sb = requireClient();
    const { count } = await sb
      .from('waitlist_entries')
      .select('*', { count: 'exact', head: true })
      .eq('status', status);
    return count || 0;
  },
  async list({ status = null } = {}) {
    const sb = requireClient();
    let q = sb.from('waitlist_entries').select('*').order('created_at', { ascending: false });
    if (status && status !== 'all') q = q.eq('status', status);
    return q;
  },
  async approve(id) {
    const sb = requireClient();
    return sb.functions.invoke('approve-entry', { body: { id } });
  },
  async reject(id) {
    const sb = requireClient();
    return sb.from('waitlist_entries').update({ status: 'rejected' }).eq('id', id);
  },
};

export default { isOffline, auth, profile, topics, waitlist, entries };
