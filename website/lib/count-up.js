// Counts [data-count-to] numbers up from 0 the first time they scroll into view.
// The markup holds the final value, so without this script (or with reduced
// motion) the number is simply there. Pair the element with an .sr-only copy
// and aria-hidden, so screen readers never hear the intermediate values.

const DURATION_MS = 1400;

export function mountCountUp(root = document) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!('IntersectionObserver' in window)) return;

  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      io.unobserve(entry.target);
      countUp(entry.target);
    }
  }, { threshold: 0.6 });

  for (const el of root.querySelectorAll('[data-count-to]')) {
    // A number already on screen has been read; leave it.
    if (el.getBoundingClientRect().top < window.innerHeight) continue;
    el.textContent = '0';
    io.observe(el);
  }
}

function countUp(el) {
  const to = Number(el.dataset.countTo);
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / DURATION_MS);
    const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t); // exponential ease-out
    el.textContent = String(Math.round(to * eased));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
