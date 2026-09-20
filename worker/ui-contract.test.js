import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('UI preserves required portal features', () => {
  assert.match(app, /path\.startsWith\('\/admin'\)/);
  assert.match(app, /Create first administrator/);
  assert.ok((app.match(/Repeat password/g) || []).length >= 2);
  for (const role of ['administrator', 'editor', 'reader']) assert.match(app, new RegExp(role));
  assert.match(app, /Private/);
  assert.match(app, /Public/);
  assert.match(app, /Create article/);
  assert.match(app, /Edit article/);
  assert.match(app, /Delete/);
  assert.match(app, /accept="\.txt,\.md,text\/plain,text\/markdown"/);
});
