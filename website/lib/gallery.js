// Showcase gallery: each button.shot opens its screenshot in a <dialog> viewer
// (arrow keys page, Escape or the backdrop closes, focus returns to the shot).
// On fine pointers each shot drifts a few pixels against the cursor; style.css
// applies the drift only there and only without reduced motion.

import { watchImage } from './media.js';

export function mountGallery(gallery, dialog) {
  if (!gallery || !dialog || typeof dialog.showModal !== 'function') return;
  const shots = Array.from(gallery.querySelectorAll('button.shot'));
  if (!shots.length) return;

  const slot = document.createElement('span');
  slot.className = 'lightbox-slot media-slot';
  const img = document.createElement('img');
  img.width = 1920;
  img.height = 1080;
  slot.append(img);
  dialog.querySelector('.lightbox-figure').prepend(slot);
  watchImage(img);

  const text = dialog.querySelector('.lightbox-text');
  const count = dialog.querySelector('.lightbox-count');
  let index = 0;
  let opener = null;

  const show = (i) => {
    index = (i + shots.length) % shots.length;
    const thumb = shots[index].querySelector('img');
    img.classList.remove('is-missing');
    img.src = thumb.currentSrc || thumb.src;
    img.alt = thumb.alt;
    text.textContent = shots[index].dataset.caption || thumb.alt;
    count.textContent = `${index + 1} / ${shots.length}`;
  };

  shots.forEach((shot, i) => shot.addEventListener('click', () => {
    opener = shot;
    show(i);
    dialog.showModal();
  }));
  dialog.querySelector('.lightbox-prev').addEventListener('click', () => show(index - 1));
  dialog.querySelector('.lightbox-next').addEventListener('click', () => show(index + 1));
  dialog.querySelector('.lightbox-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(index - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); show(index + 1); }
  });
  // The dialog box fills the viewport; a click that lands on it, not on its content, is a backdrop click.
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => opener?.focus({ preventScroll: true }));

  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  for (const shot of shots) {
    let frame = 0;
    shot.addEventListener('pointermove', (e) => {
      const r = shot.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        shot.style.setProperty('--mx', x.toFixed(3));
        shot.style.setProperty('--my', y.toFixed(3));
      });
    });
    shot.addEventListener('pointerleave', () => {
      cancelAnimationFrame(frame);
      shot.style.setProperty('--mx', '0');
      shot.style.setProperty('--my', '0');
    });
  }
}
