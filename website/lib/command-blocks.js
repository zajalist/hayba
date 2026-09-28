// Command blocks (.docs-cmd): adds a "Copy" button to each block's header bar
// and makes blocks that scroll sideways reachable from the keyboard.
//
// Markup:
//   <div class="docs-cmd" data-copy-name="build commands">
//     <div class="docs-cmd-bar"><span class="docs-cmd-label">Terminal</span></div>
//     <pre><code>…</code></pre>
//   </div>
// The button is added here rather than in the HTML so it only appears when it works.

const RESET_MS = 1800;

export function mountCommandBlocks(root = document) {
  const blocks = Array.from(root.querySelectorAll('.docs-cmd'));
  if (!blocks.length) return null;

  const announcer = document.createElement('div');
  announcer.className = 'sr-only';
  announcer.setAttribute('role', 'status');
  document.body.append(announcer);

  const observer = 'ResizeObserver' in window
    ? new ResizeObserver((entries) => entries.forEach((e) => syncScrollFocus(e.target)))
    : null;

  for (const block of blocks) {
    const pre = block.querySelector('pre');
    const bar = block.querySelector('.docs-cmd-bar');
    if (!pre || !bar) continue;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'docs-cmd-copy';
    btn.textContent = 'Copy';
    btn.setAttribute('aria-label', `Copy ${block.dataset.copyName || 'code'}`);
    let resetTimer = 0;

    btn.addEventListener('click', async () => {
      const ok = await copyText(pre.textContent.replace(/\n+$/, ''));
      btn.classList.toggle('is-copied', ok);
      btn.classList.toggle('is-failed', !ok);
      btn.textContent = ok ? 'Copied' : 'Press Ctrl+C';
      announcer.textContent = ok
        ? 'Copied to clipboard.'
        : 'Copy failed. The text is selected; press Ctrl+C to copy it.';
      if (!ok) selectContents(pre);
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('is-copied', 'is-failed');
        announcer.textContent = '';
      }, RESET_MS);
    });

    bar.append(btn);
    syncScrollFocus(pre);
    observer?.observe(pre);
  }

  return { stop() { observer?.disconnect(); announcer.remove(); } };
}

// A block that overflows sideways needs a tab stop so keyboard users can scroll it.
function syncScrollFocus(pre) {
  if (pre.scrollWidth > pre.clientWidth + 1) pre.tabIndex = 0;
  else pre.removeAttribute('tabindex');
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  // Plain-http previews have no async clipboard; execCommand still works there.
  const previousFocus = document.activeElement;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  previousFocus?.focus?.();
  return ok;
}

function selectContents(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}
