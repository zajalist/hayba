// Shared behaviour for every docs page: section highlighting in the sidebar,
// copy buttons on command blocks, and the folding menu on narrow screens.
import { mountDocsToc } from '/lib/docs-toc.js';
import { mountCommandBlocks } from '/lib/command-blocks.js';

mountDocsToc(document.querySelector('.docs-nav'));
mountCommandBlocks(document.querySelector('.docs-main'));

// The menu ships open so it works without JavaScript. On narrow screens it
// folds away above the content; on wide screens it is the sidebar.
const menu = document.querySelector('.docs-menu');
const narrow = window.matchMedia('(max-width: 900px)');
const syncMenu = () => { if (menu) menu.open = !narrow.matches; };
syncMenu();
narrow.addEventListener('change', syncMenu);
