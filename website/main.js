// Nav scroll behaviour: hide on scroll-down, show on scroll-up,
// add .scrolled past the hero so the slate background re-acquires.
(function navScroll() {
  const nav = document.getElementById('mainNav');
  if (!nav) return;
  let lastY = 0;
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    if (y > lastY && y > 100) nav.classList.add('hide');
    else nav.classList.remove('hide');
    if (y > 80) nav.classList.add('scrolled');
    else nav.classList.remove('scrolled');
    lastY = y;
  }, { passive: true });
})();
