import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cfg = window.HAYBA_CONFIG || {};
if (!cfg.url || cfg.url.includes('__VERCEL')) {
  document.getElementById('topics-list').innerHTML =
    '<p class="muted">Forum is offline — Supabase config not loaded.</p>';
} else {
  const sb = createClient(cfg.url, cfg.anonKey);

  const composer = document.getElementById('composer');
  const signedOut = document.getElementById('signed-out');
  const topicsList = document.getElementById('topics-list');
  const topicsCount = document.getElementById('topics-count');
  const composerStatus = document.getElementById('composer-status');
  const form = document.getElementById('topic-form');

  function showComposer(session) {
    if (session && session.user) {
      composer.hidden = false;
      signedOut.hidden = true;
    } else {
      composer.hidden = true;
      signedOut.hidden = false;
    }
  }

  async function loadTopics() {
    const { data, error } = await sb
      .from('forum_topics')
      .select('id, title, body, author_email, created_at')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) {
      topicsList.innerHTML = '<p class="muted">Could not load topics.</p>';
      return;
    }
    if (!data || data.length === 0) {
      topicsList.innerHTML = '<p class="muted">No topics yet. Be the first to post.</p>';
      topicsCount.textContent = '0';
      return;
    }
    topicsCount.textContent = `${data.length} topic${data.length === 1 ? '' : 's'}`;
    topicsList.innerHTML = data.map(t => renderTopic(t)).join('');
  }

  function renderTopic(t) {
    const when = new Date(t.created_at);
    const dayMs = 24 * 60 * 60 * 1000;
    const ageDays = (Date.now() - when.getTime()) / dayMs;
    let ago;
    if (ageDays < 1) ago = `${Math.max(1, Math.round(ageDays * 24))}h ago`;
    else if (ageDays < 30) ago = `${Math.round(ageDays)}d ago`;
    else ago = when.toLocaleDateString();
    const snippet = (t.body || '').slice(0, 180).replace(/\n+/g, ' ');
    const more = (t.body || '').length > 180 ? '…' : '';
    const author = (t.author_email || '').split('@')[0] || 'anon';
    return `
      <article class="forum-topic">
        <h3 class="forum-topic-title">${escapeHtml(t.title)}</h3>
        <p class="forum-topic-body">${escapeHtml(snippet)}${more}</p>
        <div class="forum-topic-meta">
          <span class="forum-topic-author">${escapeHtml(author)}</span>
          <span class="forum-topic-dot">·</span>
          <span class="forum-topic-when">${ago}</span>
        </div>
      </article>
    `;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const title = String(fd.get('title') || '').trim();
    const body = String(fd.get('body') || '').trim();
    if (title.length < 3 || body.length < 1) return;
    composerStatus.textContent = 'Posting…';
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
      composerStatus.textContent = 'Session expired. Sign in again.';
      return;
    }
    const { error } = await sb.from('forum_topics').insert({
      author_id: session.user.id,
      author_email: session.user.email,
      title,
      body,
    });
    if (error) {
      composerStatus.textContent = error.message || 'Could not post.';
      return;
    }
    form.reset();
    composerStatus.textContent = 'Posted.';
    setTimeout(() => { composerStatus.textContent = ''; }, 1500);
    loadTopics();
  });

  // Boot
  (async () => {
    const { data: { session } } = await sb.auth.getSession();
    showComposer(session);
    sb.auth.onAuthStateChange((_evt, sess) => showComposer(sess));
    loadTopics();
  })();
}
