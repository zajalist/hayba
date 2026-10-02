/* global require */
/* eslint-disable @typescript-eslint/no-require-imports -- Node runs this browser-script test as CommonJS. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildIndex, folderContains, actorsInFolder, selectionUrl } = require('./scene-map-model.js');

test('folder boundaries include descendants but exclude similarly prefixed siblings', () => {
  assert.equal(folderContains('Buildings', 'Buildings/Interior'), true);
  assert.equal(folderContains('Buildings', 'Buildings2'), false);
  assert.equal(folderContains('Buildings', 'Other/Buildings'), false);
  assert.equal(folderContains('Buildings', 'Buildings\\Interior'), true);
  assert.equal(folderContains('', 'Anything/Nested'), true);
});

test('selection URL accepts only current scan integer coordinates', () => {
  assert.equal(selectionUrl(12, { selectionIndex: 3 }), 'hayba-scene-map://select/12/3');
  assert.equal(selectionUrl(0, { selectionIndex: 3 }), null);
  assert.equal(selectionUrl(12, { selectionIndex: -1 }), null);
  assert.equal(selectionUrl(12, { selectionIndex: '3' }), null);
});

test('folder counts distinguish direct actors from all loaded descendants', () => {
  const index = buildIndex([
    { label: 'cell 1', actors: [
      { id: '/Level/A', label: 'A', folder: 'Buildings' },
      { id: '/Level/B', label: 'B', folder: 'Buildings/Interior' },
    ] },
    { label: 'cell 2', actors: [
      { id: '/Level/C', label: 'C', folder: 'Buildings2' },
      { id: '/Level/D', label: 'D', folder: '' },
    ] },
  ]);
  const folder = path => index.folders.find(f => f.path === path);
  assert.deepEqual(folder('Buildings'), { path: 'Buildings', direct: 1, descendants: 2 });
  assert.deepEqual(folder('Buildings/Interior'), { path: 'Buildings/Interior', direct: 1, descendants: 1 });
  assert.deepEqual(folder(''), { path: '', direct: 1, descendants: 4 });
  assert.deepEqual(actorsInFolder(index, 'Buildings').map(a => a.id), ['/Level/A', '/Level/B']);
});
