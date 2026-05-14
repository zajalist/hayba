import { createHaybaSupabaseClient } from '/dist/supabase-client.js';

const CONFIG = window.HAYBA_CONFIG ?? { url: 'http://localhost:54321', anonKey: '...' };
const supabase = createHaybaSupabaseClient(CONFIG);
const SLOTS = 50;

const TOOL_LABELS = {
  'planet-physics': 'Planet physics', tectonics: 'Tectonics', terrain: 'Terrain',
  hydrology: 'Hydrology', atmosphere: 'Atmosphere', cartography: 'Cartography',
  biomes: 'Biomes', 'flora-fauna': 'Flora & fauna', linguistics: 'Linguistics',
  cultures: 'Cultures', history: 'History', religion: 'Religion', naming: 'Naming',
  architecture: 'Architecture', economy: 'Economy', politics: 'Politics',
  magic: 'Magic systems', 'ue5-plugin': 'UE5 plugin · MCP', gaea: 'Gaea',
  'houdini-blender': 'Houdini / Blender', 'ai-agents': 'AI agents · MCP', other: 'Other',
};
const MAKING_LABELS = {
  game: 'Game', novel: 'Novel / fiction / comics', ttrpg: 'TTRPG',
  animation: 'Animation', hobby: 'Hobby', academic: 'Academic', curious: 'Curious',
};

async function requireAdmin() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { window.location.href = '/login?next=/admin'; return false; }
  const { data: prof } = await supabase
    .from('profiles').select('is_admin').eq('user_id', user.id).single();
  if (!prof?.is_admin) {
    document.body.innerHTML = '<div class="readonly-404">Not authorised.</div>';
    return false;
  }
  return true;
}

async function loadCounts() {
  const { count: pending } = await supabase
    .from('waitlist_entries').select('*', { count: 'exact', head: true })
    .eq('status', 'pending');
  const { count: approved } = await supabase
    .from('waitlist_entries').select('*', { count: 'exact', head: true })
    .eq('status', 'approved');
  document.getElementById('count-pending').textContent  = pending  ?? 0;
  document.getElementById('count-approved').textContent = approved ?? 0;
  document.getElementById('count-slots').textContent    = SLOTS - (approved ?? 0);
}

async function loadEntries(filter) {
  let q = supabase.from('waitlist_entries').select('*').order('created_at', { ascending: false });
  if (filter !== 'all') q = q.eq('status', filter);
  const { data, error } = await q;
  const host = document.getElementById('admin-list');
  if (error) { host.textContent = 'Error: ' + error.message; return; }
  if (!data.length) { host.textContent = 'No entries.'; return; }
  host.innerHTML = data.map(e => renderEntry(e)).join('');
  host.querySelectorAll('[data-approve]').forEach(b => b.addEventListener('click', () => approve(+b.dataset.approve)));
  host.querySelectorAll('[data-reject]').forEach(b => b.addEventListener('click', () => reject(+b.dataset.reject)));
}

function renderEntry(e) {
  const tools = (e.questionnaire?.tools ?? []).map(t => `<span class="chip-tag">${TOOL_LABELS[t] ?? t}</span>`).join('');
  const making = MAKING_LABELS[e.questionnaire?.making] ?? '—';
  return `
    <article class="entry status-${e.status}">
      <header>
        <span class="email">${escapeText(e.email)}</span>
        <span class="status-pill ${e.status}">${e.status}</span>
        <span class="time">${new Date(e.created_at).toLocaleDateString()}</span>
        <span class="actions">
          ${e.status === 'pending' ? `
            <button class="btn approve" data-approve="${e.id}">Approve</button>
            <button class="btn ghost" data-reject="${e.id}">Reject</button>
          ` : ''}
        </span>
      </header>
      <div class="row"><span class="field-label">Making</span><span>${making}</span></div>
      <div class="row"><span class="field-label">Tools</span><span class="chips">${tools || '<em>none picked</em>'}</span></div>
      ${e.questionnaire?.notes ? `<div class="row"><span class="field-label">Notes</span><span>${escapeText(e.questionnaire.notes)}</span></div>` : ''}
    </article>`;
}

async function approve(id) {
  const { error } = await supabase.functions.invoke('approve-entry', { body: { id } });
  if (error) { alert('Failed: ' + error.message); return; }
  await Promise.all([loadCounts(), loadEntries(document.getElementById('filter').value)]);
}
async function reject(id) {
  const { error } = await supabase.from('waitlist_entries').update({ status: 'rejected' }).eq('id', id);
  if (error) { alert('Failed: ' + error.message); return; }
  await Promise.all([loadCounts(), loadEntries(document.getElementById('filter').value)]);
}

function escapeText(s) { return String(s).replace(/[<>&]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;' }[c])); }

(async () => {
  if (!(await requireAdmin())) return;
  document.getElementById('admin-signout').onclick = async () => {
    await supabase.auth.signOut();
    window.location.href = '/login';
  };
  document.getElementById('filter').addEventListener('change', e => loadEntries(e.target.value));
  await Promise.all([loadCounts(), loadEntries('pending')]);
})();
