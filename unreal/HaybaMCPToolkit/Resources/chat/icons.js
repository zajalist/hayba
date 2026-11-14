/* Hayba's compact, shared 24px action icons. No network assets or icon font. */
(() => {
  const paths = {
    history: 'M3 5h18v14H3z M8 5v14 M12 9h5 M12 13h4',
    agents: 'M12 3v6 M5 9h14 M5 9v5 M19 9v5 M2 14h6v6H2z M16 14h6v6h-6z M9 2h6v5H9z',
    video: 'M3 5h13v14H3z m13 5 5-4v12l-5-4',
    splat:
      'M12 3h.01 M5 7h.01 M19 7h.01 M3 14h.01 M21 14h.01 M7 20h.01 M17 20h.01 M12 12h.01 M9 8h.01 M15 8h.01 M8 15h.01 M16 15h.01 M12 18h.01',
    fal: 'M5 21V8a5 5 0 0 1 10 0v3 M3 12h13 M11 21V8a5 5 0 0 1 10 0',
    worldlabs: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c6 5 6 13 0 18-6-5-6-13 0-18 M5 7h14 M5 17h14',
    new: 'M13 5H5v14h14v-8 M15 4l5 5 M10 14l1-4 7-7 4 4-7 7z',
    cube: 'm12 3 9 5v9l-9 5-9-5V8z M3 8l9 5 9-5 M12 13v9 M8 5l9 5',
    sparkle: 'm12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3z',
    attach: 'm8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8 M7 13l7-7',
    selection: 'M4 9V4h5 M15 4h5v5 M20 15v5h-5 M9 20H4v-5 M9 8l8 4-4 1-1 4z',
    settings: 'M4 6h7 M15 6h5 M4 12h3 M11 12h9 M4 18h11 M19 18h1 M11 3v6 M7 9v6 M15 15v6',
    send: 'M12 20V4 M5 11l7-7 7 7',
    stop: 'M6 6h12v12H6z',
    check: 'm5 12 4 4 10-10',
    chevron: 'm8 10 4 4 4-4',
    right: 'm9 5 7 7-7 7',
    folder: 'M3 7V5h6l2 2h10v13H3z',
    file: 'M5 3h9l5 5v13H5z M14 3v6h5 M8 13h8 M8 17h5',
    plug: 'M8 3v5 M16 3v5 M6 8h12v4a6 6 0 0 1-12 0z M12 18v4',
    search: 'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0 M15 15l6 6',
    more: 'M5 12h.01 M12 12h.01 M19 12h.01',
    close: 'm6 6 12 12 M18 6 6 18',
    refresh: 'M20 10a8 8 0 0 0-14-5L3 8 M3 3v5h5 M4 14a8 8 0 0 0 14 5l3-3 M21 21v-5h-5',
    clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 7v5l3 2',
    download: 'M12 3v12 m-5-5 5 5 5-5 M4 16v5h16v-5',
    image: 'M3 4h18v16H3z m1 12 5-5 4 4 3-3 5 5 M16 8h.01',
    shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z m-4 9 3 3 5-5',
    bolt: 'm13 2-9 12h7l-1 8 10-13h-7z',
    brain:
      'M12 5c-4-5-9 0-7 4-5 2-2 8 1 8 0 5 6 5 6 1V5 M12 5c4-5 9 0 7 4 5 2 2 8-1 8 0 5-6 5-6 1 M8 8l4 3 M16 8l-4 3 M7 14l5 2 M17 14l-5 2',
    activity: 'M3 12h4l3-8 4 16 3-8h4',
    warning: 'm12 3 10 18H2z M12 9v5 M12 17h.01',
    info: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 11v6 M12 7h.01',
    meshy: 'm12 3 9 5v9l-9 5-9-5V8z M3 8l18 9 M21 8 3 17 M12 3v19',
    tripo: 'm12 3 10 18H2z M12 3v12 M2 21l10-6 10 6',
    aholo: 'M4 8c0-5 16-5 16 0s-16 5-16 0 M4 8v8c0 5 16 5 16 0V8 M12 4v16',
  };
  function create(name, size = 18) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.65,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
    }))
      svg.setAttribute(key, value);
    svg.classList.add('icon');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', paths[name] || paths.file);
    if (name === 'more') svg.setAttribute('stroke-width', '3.5');
    svg.append(path);
    return svg;
  }
  window.HaybaIcons = { create };
})();
