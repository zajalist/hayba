// Nav scroll behaviour: hide on scroll-down, show on scroll-up,
// add .scrolled past the hero so the slate background re-acquires.
(function navScroll() {
  const nav = document.getElementById('mainNav');
  if (!nav) return;
  let lastY = 0;
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    // An open phone menu keeps the bar in place, or the panel would slide away with it.
    if (y > lastY && y > 100 && !nav.classList.contains('menu-open')) nav.classList.add('hide');
    else nav.classList.remove('hide');
    if (y > 80) nav.classList.add('scrolled');
    else nav.classList.remove('scrolled');
    lastY = y;
  }, { passive: true });
})();

// Phone header (720px and below): the links collapse behind a Menu disclosure
// button and open as a panel under the bar. Without this script the button stays
// hidden and style.css wraps the links onto extra rows of the bar.
(function navMenu() {
  const nav = document.getElementById('mainNav');
  const btn = nav && nav.querySelector('.nav-menu-btn');
  const panel = btn && document.getElementById(btn.getAttribute('aria-controls'));
  if (!panel) return;

  const isOpen = () => btn.getAttribute('aria-expanded') === 'true';
  const setOpen = (open, returnFocus) => {
    btn.setAttribute('aria-expanded', String(open));
    nav.classList.toggle('menu-open', open);
    if (open) nav.classList.remove('hide');
    if (!open && returnFocus) btn.focus({ preventScroll: true });
  };

  btn.hidden = false;
  nav.classList.add('has-menu');
  btn.addEventListener('click', () => setOpen(!isOpen(), false));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) setOpen(false, true);
  });
  document.addEventListener('click', (e) => {
    if (isOpen() && !nav.contains(e.target)) setOpen(false, false);
  });
  // A link on this page moves the reading position to its target, so focus is left
  // to the browser there; links that leave the page open in a new tab or unload it.
  panel.addEventListener('click', (e) => {
    const link = e.target.closest('a');
    if (!link || !isOpen()) return;
    setOpen(false, !(link.getAttribute('href') || '').startsWith('#'));
  });
  // Tabbing out of the header closes the panel so it can't cover the focused element.
  nav.addEventListener('focusout', (e) => {
    if (isOpen() && e.relatedTarget && !nav.contains(e.relatedTarget)) setOpen(false, false);
  });
  const phone = window.matchMedia('(max-width: 720px)');
  const onPhoneChange = (e) => { if (!e.matches && isOpen()) setOpen(false, false); };
  // Safari 13 and older only have the deprecated addListener.
  if (phone.addEventListener) phone.addEventListener('change', onPhoneChange);
  else phone.addListener(onPhoneChange);
})();
