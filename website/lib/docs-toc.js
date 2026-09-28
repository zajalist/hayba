// Docs sidebar: highlights the TOC link for the section being read.
//
// The active section is the last heading above a probe line near the top of
// the viewport. Short final sections can never scroll up to that line, so over
// the last stretch of the page the probe sweeps down to the bottom edge: each
// remaining section lights up in turn, and the last one wins at the very end.
// A clicked link (or a #hash on load) stays highlighted until the jump
// finishes and the reader scrolls again.

const QUIET_MS = 200;

export function mountDocsToc(tocEl, { probeOffset = 120 } = {}) {
  if (!tocEl) return null;
  const targets = Array.from(tocEl.querySelectorAll('a.docs-toc-link[href^="#"]'))
    .map((link) => ({ link, el: document.getElementById(decodeURIComponent(link.hash.slice(1))) }))
    .filter((t) => t.el);
  if (!targets.length) return null;

  let current = null;
  let pinned = null;
  let lastScrollAt = 0;
  let frame = 0;

  function setActive(target) {
    if (target === current) return;
    current = target;
    for (const { link } of targets) {
      const on = link === target.link;
      link.classList.toggle('is-active', on);
      if (on) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  }

  function fromScroll() {
    const viewH = window.innerHeight;
    const maxScroll = document.documentElement.scrollHeight - viewH;
    const remaining = Math.max(0, maxScroll - window.scrollY);
    const sweep = Math.min(viewH / 2, maxScroll / 2);
    const progress = sweep > 0 && remaining < sweep ? 1 - remaining / sweep : 0;
    const probe = probeOffset + (viewH - probeOffset) * progress;
    let active = targets[0];
    for (const t of targets) if (t.el.getBoundingClientRect().top <= probe) active = t;
    return active;
  }

  function pin(target) {
    pinned = target;
    lastScrollAt = performance.now();
    setActive(target);
  }

  function onScroll() {
    const now = performance.now();
    if (pinned) {
      // Scroll events arriving back to back belong to the jump itself; a scroll
      // after a pause is the reader moving on.
      const quiet = now - lastScrollAt > QUIET_MS;
      lastScrollAt = now;
      if (!quiet) return;
      pinned = null;
    }
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; setActive(fromScroll()); });
  }

  function onClick(e) {
    const link = e.target.closest('a');
    const target = targets.find((t) => t.link === link);
    if (target) pin(target);
  }

  function onHash() {
    const target = targets.find((t) => t.link.hash === window.location.hash);
    if (target) pin(target);
  }

  tocEl.addEventListener('click', onClick);
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  window.addEventListener('hashchange', onHash);

  const initial = targets.find((t) => window.location.hash && t.link.hash === window.location.hash);
  if (initial) pin(initial);
  else setActive(fromScroll());

  return {
    stop() {
      tocEl.removeEventListener('click', onClick);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('hashchange', onHash);
      cancelAnimationFrame(frame);
    },
  };
}
