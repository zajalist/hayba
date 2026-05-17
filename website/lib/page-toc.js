// Fixed left-side page TOC that fades in after the hero and highlights the
// section closest to viewport-center as you scroll.

export function mountPageToc(tocEl, { heroEl, threshold = 0.45, probeFraction = 0.4 } = {}) {
  if (!tocEl) return null;
  const hero = heroEl || document.getElementById('hero');
  const links = Array.from(tocEl.querySelectorAll('.toc-link[data-target]'));
  const targets = links
    .map((l) => ({
      link: l,
      el: document.getElementById(l.dataset.target)
        || (l.dataset.target === 'top' ? hero : null),
    }))
    .filter((t) => t.el);

  function onScroll() {
    const y = window.scrollY;
    const heroH = hero ? hero.offsetHeight : 0;
    tocEl.classList.toggle('is-visible', y > heroH * threshold);

    const probe = y + window.innerHeight * probeFraction;
    let active = targets[0];
    for (const t of targets) {
      if (t.el.offsetTop <= probe) active = t;
    }
    links.forEach((l) => l.classList.toggle('is-active', l === active.link));
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  onScroll();

  return {
    stop() {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    },
  };
}
