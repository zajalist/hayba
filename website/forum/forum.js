import { auth, topics, isOffline } from '/lib/hayba-client.js';

const composer = document.getElementById('composer');
const signedOut = document.getElementById('signed-out');
const topicsList = document.getElementById('topics-list');
const topicsCount = document.getElementById('topics-count');
const composerStatus = document.getElementById('composer-status');
const form = document.getElementById('topic-form');

if (isOffline) {
  topicsList.innerHTML = '<p class="muted">Forum is offline — Supabase config not loaded.</p>';
} else {
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
    const { data, error } = await topics.list({ limit: 50 });
    if (error) {
      topicsList.innerHTML = '<p class="muted">Could not load topics.</p>';
      return;
    }
    if (!data.length) {
      topicsList.innerHTML = '<p class="muted">No topics yet. Be the first to post.</p>';
      topicsCount.textContent = '0';
      return;
    }
    topicsCount.textContent = `${data.length} topic${data.length === 1 ? '' : 's'}`;
    topicsList.innerHTML = data.map(renderTopic).join('');
  }

  function renderTopic(t) {
    const when = new Date(t.created_at);
    const ageDays = (Date.now() - when.getTime()) / 86400000;
    const ago = ageDays < 1
      ? `${Math.max(1, Math.round(ageDays * 24))}h ago`
      : ageDays < 30
        ? `${Math.round(ageDays)}d ago`
        : when.toLocaleDateString();
    const snippet = (t.body || '').slice(0, 180).replace(/\n+/g, ' ');
    const more = (t.body || '').length > 180 ? '…' : '';
    const author = (t.author_email || '').split('@')[0] || 'anon';
    return `
      <article class="forum-topic">
        <h3 class="forum-topic-title">${esc(t.title)}</h3>
        <p class="forum-topic-body">${esc(snippet)}${more}</p>
        <div class="forum-topic-meta">
          <span class="forum-topic-author">${esc(author)}</span>
          <span class="forum-topic-dot">·</span>
          <span class="forum-topic-when">${ago}</span>
        </div>
      </article>
    `;
  }

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({
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
    const { error } = await topics.create({ title, body });
    if (error) {
      composerStatus.textContent = error.message || 'Could not post.';
      return;
    }
    form.reset();
    composerStatus.textContent = 'Posted.';
    setTimeout(() => { composerStatus.textContent = ''; }, 1500);
    loadTopics();
  });

  (async () => {
    showComposer(await auth.getSession());
    auth.subscribe((session) => showComposer(session));
    loadTopics();
  })();
}
