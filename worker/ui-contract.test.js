import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
const clientApi = await readFile(new URL('../src/api.js', import.meta.url), 'utf8');

test('UI preserves required routes, search and controls', () => {
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

  assert.match(app, /type="search"/);
  assert.match(app, /Search articles…/);
  assert.match(app, /All categories/);
  assert.match(app, /filteredArticles/);
  assert.match(app, /No matching articles/);

  assert.match(app, /boot\.mode === 'public' \? cachedPortalApi : api/);
  assert.match(clientApi, /sessionStorage\.getItem/);
  assert.match(clientApi, /sessionStorage\.setItem/);
  assert.match(clientApi, /cache: 'no-store'/);

  assert.match(app, /Confirm with your administrator password/);
  assert.match(app, /disabled=\{selected\}/);
  assert.match(app, /target="_blank"/);
  assert.match(app, /rel="noopener noreferrer"/);
});
