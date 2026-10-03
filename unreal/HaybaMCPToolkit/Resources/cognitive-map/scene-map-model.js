/* global module */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.HaybaSceneMapModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function normalizeFolder(value) {
    return String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
  }

  function folderContains(parent, child) {
    const p = normalizeFolder(parent);
    const c = normalizeFolder(child);
    return p === '' || c === p || c.startsWith(p + '/');
  }

  function buildIndex(cells) {
    const folders = new Map();
    const actors = [];
    const ensure = (path) => {
      if (!folders.has(path)) folders.set(path, { path, direct: 0, descendants: 0 });
      return folders.get(path);
    };
    ensure('');
    for (const cell of cells || []) {
      for (const source of cell.actors || []) {
        if (!source || !source.id) continue;
        const folder = normalizeFolder(source.folder);
        actors.push({ ...source, folder, cell });
        ensure(folder).direct++;
        const parts = folder ? folder.split('/') : [];
        for (let i = 0; i <= parts.length; i++) {
          ensure(parts.slice(0, i).join('/')).descendants++;
        }
      }
    }
    return { folders: [...folders.values()].sort((a, b) => a.path.localeCompare(b.path)), actors };
  }

  function actorsInFolder(index, path) {
    return index.actors.filter(actor => folderContains(path, actor.folder));
  }

  function selectionUrl(generation, actor) {
    if (!Number.isSafeInteger(generation) || generation <= 0 ||
        !actor || !Number.isSafeInteger(actor.selectionIndex) || actor.selectionIndex < 0) return null;
    return `hayba-scene-map://select/${generation}/${actor.selectionIndex}`;
  }

  return { normalizeFolder, folderContains, buildIndex, actorsInFolder, selectionUrl };
});
