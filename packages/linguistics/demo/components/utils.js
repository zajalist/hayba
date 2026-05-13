/* Small DOM + string helpers shared across views. */

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function $(id) { return document.getElementById(id); }

export function $$(sel, root = document) { return root.querySelectorAll(sel); }

/** Replace children of `host` with a single HTML string. */
export function setHTML(host, html) {
  if (host) host.innerHTML = html;
}
