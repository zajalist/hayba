// Tool reference filter. Hides tools (and empty domains) that do not contain
// every word typed into the filter box. Plain script, no dependencies.
(() => {
  const input = document.getElementById('tool-filter');
  if (!input) return;
  const count = document.getElementById('tool-count');
  const empty = document.getElementById('tools-empty');

  const sections = Array.from(document.querySelectorAll('.tool-domain')).map((el) => ({
    el,
    link: document.querySelector(`.tools-domains a[href="#${el.id}"]`)?.closest('li'),
    items: Array.from(el.querySelectorAll('article.tool, .tools-unavailable li')).map((item) => ({
      el: item,
      callable: item.tagName === 'ARTICLE',
      text: item.textContent.toLowerCase().replace(/\s+/g, ' '),
    })),
  }));
  const total = sections.reduce((n, s) => n + s.items.filter((i) => i.callable).length, 0);

  function apply() {
    const terms = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    let anyVisible = false;
    for (const s of sections) {
      let visible = 0;
      for (const item of s.items) {
        const hit = terms.every((t) => item.text.includes(t));
        item.el.hidden = !hit;
        if (hit) {
          visible += 1;
          if (item.callable) shown += 1;
        }
      }
      s.el.hidden = visible === 0;
      if (s.link) s.link.hidden = visible === 0;
      anyVisible = anyVisible || visible > 0;
    }
    count.textContent = terms.length ? `Showing ${shown} of ${total} tools` : `${total} tools`;
    empty.hidden = anyVisible;
  }

  input.addEventListener('input', apply);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      input.value = '';
      apply();
    }
  });

  // Following a link to a tool the filter has hidden clears the filter first.
  function revealHash() {
    const id = decodeURIComponent(window.location.hash.slice(1));
    const target = id && document.getElementById(id);
    if (target && target.closest('[hidden]')) {
      input.value = '';
      apply();
      target.scrollIntoView();
    }
  }
  window.addEventListener('hashchange', revealHash);
  apply();
})();
