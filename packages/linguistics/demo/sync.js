// sync.js — bidirectional sync between localStorage state.languages and
// Supabase Postgres. Last-write-wins per language, debounced 2s on writes.

import { supabase } from './auth.js';

const DEBOUNCE_MS = 2000;
const pending = new Map();         // langId -> timeoutHandle

/** Fetch every language owned by the current user. */
export async function fetchUserLanguages() {
  const { data, error } = await supabase
    .from('languages')
    .select('id, name, is_public, snapshot, updated_at')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/** Merge fetched languages into state.languages, last-write-wins by updated_at. */
export function mergeRemoteIntoState(state, remote) {
  if (!state.languages) state.languages = {};
  for (const r of remote) {
    const local = state.languages[r.id];
    const remoteIsNewer = !local?._meta?.updated_at
      || new Date(r.updated_at) > new Date(local._meta.updated_at);
    if (remoteIsNewer) {
      state.languages[r.id] = {
        ...(r.snapshot ?? {}),
        _meta: {
          id: r.id,
          owner_id: r.owner_id,
          is_public: !!r.is_public,
          updated_at: r.updated_at,
          local_dirty: false,
        },
      };
    }
  }
}

/** Push a language snapshot to Postgres. Debounced — call freely. */
export function queueLanguageSave(state, langId) {
  if (pending.has(langId)) clearTimeout(pending.get(langId));
  const lang = state.languages?.[langId];
  if (lang) {
    lang._meta = { ...(lang._meta ?? {}), local_dirty: true };
  }
  pending.set(langId, setTimeout(() => flushLanguageSave(state, langId), DEBOUNCE_MS));
}

async function flushLanguageSave(state, langId) {
  pending.delete(langId);
  const lang = state.languages?.[langId];
  if (!lang) return;
  const { _meta, ...snapshot } = lang;
  const { data, error } = await supabase.from('languages').upsert({
    id: langId,
    name: snapshot.name ?? langId,
    is_public: _meta?.is_public ?? false,
    snapshot,
  }).select('updated_at').single();
  if (error) {
    console.error('[sync] save failed', error);
    return;
  }
  lang._meta = { ..._meta, updated_at: data.updated_at, local_dirty: false };
}

/** Flush every dirty language right now (used before navigation). */
export async function flushAll(state) {
  for (const [id, handle] of pending) {
    clearTimeout(handle);
    pending.delete(id);
    await flushLanguageSave(state, id);
  }
}

/** Migrate every language already in state.languages that lacks _meta. */
export async function migrateLocalToRemote(state) {
  for (const [id, lang] of Object.entries(state.languages ?? {})) {
    if (!lang._meta) {
      lang._meta = { id, is_public: false, local_dirty: true };
      queueLanguageSave(state, id);
    }
  }
  await flushAll(state);
}
