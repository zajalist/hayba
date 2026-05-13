/* Anchor-scoped popover. Replaces the legacy singleton.
   - One popover may be open at a time (per `_active` slot) but each Popover
     instance owns its own DOM element and click-away handler.
   - If the anchor element is removed from the DOM (e.g. its parent re-renders)
     the popover auto-closes — no orphan floaters. */

let _active = null;

export function attachPopover(anchor, contentBuilder, opts = {}) {
  // Close any existing popover first.
  if (_active) _active.close();

  const pop = document.createElement('div');
  pop.className = 'gr-popover' + (opts.extraClass ? ' ' + opts.extraClass : '');
  document.body.appendChild(pop);
  contentBuilder(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = (window.scrollX + r.left) + 'px';
  pop.style.top = (window.scrollY + r.bottom + 4) + 'px';

  let closed = false;
  const observer = new MutationObserver(() => {
    if (!document.body.contains(anchor)) close();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  const onMouseDown = e => {
    if (closed) return;
    if (!pop.contains(e.target)) close();
  };

  function close() {
    if (closed) return;
    closed = true;
    observer.disconnect();
    document.removeEventListener('mousedown', onMouseDown, true);
    if (pop.parentNode) pop.parentNode.removeChild(pop);
    if (_active === api) _active = null;
  }

  const api = { el: pop, close };
  _active = api;
  // setTimeout dodges the same mousedown that triggered the open.
  setTimeout(() => document.addEventListener('mousedown', onMouseDown, true), 0);
  return api;
}

export function closeActivePopover() {
  if (_active) _active.close();
}
