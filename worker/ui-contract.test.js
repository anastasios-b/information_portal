import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('UI preserves required routes and controls', () => {
  for (const route of ['/admin/articles', '/admin/categories', '/admin/users', '/admin/settings']) {
    assert.match(app, new RegExp(route.replace(/\//g, '\\\/')));
  }

  assert.match(app, /Create first administrator/);
  assert.ok((app.match(/Repeat password/g) || []).length >= 2);
  for (const role of ['administrator', 'editor', 'reader']) assert.match(app, new RegExp(role));

  assert.match(app, /Article Categories/);
  assert.match(app, /Select category/);
  assert.match(app, /Create category/);
  assert.match(app, /accept="\.txt,\.md,text\/plain,text\/markdown"/);

  assert.match(app, /Confirm with your administrator password/);
  assert.match(app, /boot\.mode === 'private'/);
  assert.match(app, /boot\.mode === 'public'/);
  assert.match(app, /disabled=\{selected\}/);

  assert.match(app, /target="_blank"/);
  assert.match(app, /rel="noopener noreferrer"/);
  assert.match(app, /NewTabIcon/);
});
