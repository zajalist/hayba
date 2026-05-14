/**
 * Thin typed wrapper around @supabase/supabase-js so callers don't have to
 * know which version of the SDK is pinned. Validates required config up front
 * with clear errors — early misconfiguration is the most common production
 * failure on a self-hosted Supabase.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface HaybaSupabaseConfig {
  url: string;        // e.g. https://api.hayba.app
  anonKey: string;    // anon JWT — safe to embed in the browser
}

export function createHaybaSupabaseClient(config: HaybaSupabaseConfig): SupabaseClient {
  if (!config.url) throw new Error('hayba: supabase url is required');
  if (!config.anonKey) throw new Error('hayba: supabase anonKey is required');
  return createClient(config.url, config.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
}

export type { SupabaseClient };
