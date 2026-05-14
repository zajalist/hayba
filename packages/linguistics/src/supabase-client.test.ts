import { describe, expect, it, vi } from 'vitest';
import { createHaybaSupabaseClient } from './supabase-client.js';

describe('createHaybaSupabaseClient', () => {
  it('throws when url is missing', () => {
    expect(() => createHaybaSupabaseClient({ url: '', anonKey: 'x' })).toThrow(/url/);
  });

  it('throws when anonKey is missing', () => {
    expect(() => createHaybaSupabaseClient({ url: 'http://x', anonKey: '' })).toThrow(/anonKey/);
  });

  it('returns a client with auth and from helpers', () => {
    const c = createHaybaSupabaseClient({ url: 'http://localhost', anonKey: 'demo' });
    expect(typeof c.auth.signInWithOtp).toBe('function');
    expect(typeof c.from).toBe('function');
  });
});
