// Media on the landing page.
//
// mountMedia: an image whose file is missing (a capture not shipped yet) leaves
// its .media-slot's dark editor grid showing instead of a broken-image box.
//
// mountDemoVideo: the demo capture plays muted and looped only while on screen,
// and shows its controls on hover or keyboard focus. Reduced-motion readers get
// the poster and a play button instead. Without this script the native controls
// stay on and nothing autoplays.

export function mountMedia(root = document) {
  for (const img of root.querySelectorAll('.media-slot img')) watchImage(img);
}

export function watchImage(img) {
  const missing = () => img.classList.add('is-missing');
  img.addEventListener('error', missing);
  img.addEventListener('load', () => img.classList.remove('is-missing'));
  // The error may have fired before this module ran.
  if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) missing();
}

export function mountDemoVideo(video) {
  const frame = video && video.closest('.demo-frame');
  if (!frame) return;
  const playBtn = frame.querySelector('.demo-play');
  const canHover = window.matchMedia('(hover: hover)').matches;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Reduced motion: no controls over the poster until the reader presses play.
  let started = !reduceMotion;

  // Touch screens have no hover, so they keep the controls.
  const setControls = (on) => { video.controls = started && (on || !canHover); };
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

  if (reduceMotion) {
    playBtn.hidden = false;
    video.addEventListener('play', () => { playBtn.hidden = true; });
    playBtn.addEventListener('click', () => {
      started = true;
      video.controls = true;
      video.focus();
      video.play().catch(() => { playBtn.hidden = false; });
    });
    return;
  }

  if (!('IntersectionObserver' in window)) return;
  // A pause the reader made sticks; one this observer made does not.
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
  }, { threshold: 0.25 }).observe(video);
}
