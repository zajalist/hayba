// auth.js — Supabase session bootstrap for the workbench.
// Reads config from window.HAYBA_CONFIG (injected by index.html at deploy time);
// in dev, falls back to a local Supabase pointed at http://localhost:54321.

import { createHaybaSupabaseClient } from '../dist/supabase-client.js';

const CONFIG = window.HAYBA_CONFIG ?? {
  url:     'http://localhost:54321',
  anonKey: 'eyJ...local-anon-key...',
};

export const supabase = createHaybaSupabaseClient(CONFIG);

/** Resolves to the current session or null. */
export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

/** Returns the authenticated user or null. */
export async function getUser() {
  const { data } = await supabase.auth.getUser();
  return data.user;
}

/** Sends a magic-link email. Returns { error } when the request fails. */
export async function sendMagicLink(email, redirectTo) {
  return supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo ?? `${window.location.origin}/app` },
  });
}

/** Signs out, clears local session, returns void. */
export async function signOut() {
  await supabase.auth.signOut();
}

/** Resolves true if the current user has profiles.is_admin = true. */
export async function isAdmin() {
  const user = await getUser();
  if (!user) return false;
  const { data, error } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('user_id', user.id)
    .single();
  if (error) return false;
  return !!data?.is_admin;
}

/** Resolves a Promise to true if signed in, redirects otherwise. */
export async function requireAuth(redirectTo = '/login') {
  const session = await getSession();
  if (!session) { window.location.href = redirectTo; return false; }
  return true;
}
