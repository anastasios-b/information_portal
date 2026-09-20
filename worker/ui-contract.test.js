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

  assert.match(app, /function AppSkeleton/);
  assert.match(app, /function PortalSkeleton/);
  assert.match(app, /function RecordSkeleton/);
  assert.match(app, /className="skeleton"/);
  assert.match(app, /aria-busy=\{loading\}/);
  assert.doesNotMatch(app, />Loading…</);

  assert.match(app, /path\.startsWith\('\/articles\/'\)/);
  assert.match(app, /function ArticlePage/);
  assert.match(app, /\/articles\/\$\{article\.id\}/);
  assert.match(app, /className="article-read"/);
  assert.match(app, /className="article-edit"/);
  assert.match(app, /className="article-delete"/);
  assert.match(app, /<Articles path=\{path\} \/>/);
  assert.match(app, /\/admin\/articles\/\$\{article\.id\}/);
  assert.match(app, /Live rendering/);
  assert.match(app, /Article preview/);
  assert.match(app, /renderArticleContent\(form\.content\)/);
  assert.doesNotMatch(app, /className="modal"/);

  assert.match(app, /Add inline image/);
  assert.match(app, /uploadArticleImage/);
  assert.match(app, /articleImageUrl/);
  assert.match(app, /extractInlineImages/);
  assert.match(app, /renderArticleContent/);
  assert.match(app, /\[25, 50, 75, 100\]/);
  assert.match(app, /className="inline-image-control"/);
  assert.match(app, /className="inline-article-image"/);
  assert.match(app, /className="inline-article-image-row"/);
  assert.match(app, /image\.width <= 50/);
  assert.match(app, /gridColumn: `span \$\{image\.width \/ 25\}`/);
  assert.match(app, /Media library/);
  assert.match(app, /listArticleImages/);
  assert.match(app, /className="media-library-overlay"/);
  assert.match(app, /className="media-library-grid"/);
  assert.match(app, /result\.image\.filename/);
  assert.match(clientApi, /X-Article-Image-Filename/);
  assert.match(clientApi, /encodeURIComponent\(filename\)/);
});
