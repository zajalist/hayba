// Media on the landing page.
//
// mountMedia: an image whose file is missing (a capture not shipped yet) leaves
// its .media-slot's dark panel showing instead of a broken-image box.
//
// mountDemoVideo / mountLoops: muted videos that play only while on screen. With reduced motion, or without this script, each shows its poster
// (and native controls where it has them) and nothing autoplays.

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function mountMedia(root = document) {
  for (const img of root.querySelectorAll('.media-slot img')) watchImage(img);
}

function watchImage(img) {
  const missing = () => img.classList.add('is-missing');
  img.addEventListener('error', missing);
  img.addEventListener('load', () => img.classList.remove('is-missing'));
  // The error may have fired before this module ran.
  if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) missing();
}

// Plays the video while at least `threshold` of it is visible and pauses it
// otherwise. A pause the reader made sticks; one this observer made does not.
function playInView(video, threshold = 0.25) {
  if (!('IntersectionObserver' in window)) return;
  let pausedByUs = false;
  let pausedByReader = false;
  video.addEventListener('pause', () => {
    if (!pausedByUs) pausedByReader = true;
    pausedByUs = false;
  });
  video.addEventListener('play', () => { pausedByReader = false; });

  new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting) {
      if (!pausedByReader) video.play().catch(() => {});
    } else if (!video.paused) {
      pausedByUs = true;
      video.pause();
    }
  }, { threshold }).observe(video);
}

export function mountDemoVideo(video) {
  const frame = video && video.closest('.demo-frame');
  if (!frame || frame.closest('[hidden]')) return; // the capture hasn't shipped yet
  if (video.dataset.poster) video.poster = video.dataset.poster;
  if (reducedMotion()) return;
  const canHover = window.matchMedia('(hover: hover)').matches;

  // Touch screens have no hover, so they keep the controls.
  const setControls = (on) => { video.controls = on || !canHover; };
  setControls(false);
  video.tabIndex = 0; // reachable by keyboard while its controls are hidden
  frame.addEventListener('pointerenter', () => setControls(true));
  frame.addEventListener('pointerleave', () => {
    if (!frame.contains(document.activeElement)) setControls(false);
  });
  frame.addEventListener('focusin', () => setControls(true));
  frame.addEventListener('focusout', (e) => {
    if (!frame.contains(e.relatedTarget)) setControls(false);
  });
  playInView(video);
}

// GIF-style clips (video.loop-clip): muted, looping, no controls, playing only
// while on screen. A clip inside a hidden slot (capture not shipped) is skipped,
// so its files are never requested; data-poster becomes its poster once shown.
export function mountLoops(root = document) {
  for (const video of root.querySelectorAll('video.loop-clip')) {
    if (video.closest('[hidden]')) continue;
    if (video.dataset.poster) video.poster = video.dataset.poster;
    if (!reducedMotion()) playInView(video, 0.1);
  }
}
