import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
const clientApi = await readFile(new URL('../src/api.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

test('UI preserves required routes, content controls and single-load behavior', () => {
  for (const route of [
    '/admin/articles',
    '/admin/categories',
    '/admin/announcements',
    '/admin/logbook',
    '/admin/users',
    '/admin/settings',
  ]) {
    assert.match(app, new RegExp(route.replace(/\//g, '\\/')));
  }

  assert.match(app, /Create first administrator/);
  assert.ok((app.match(/Full Name/g) || []).length >= 2);
  assert.ok((app.match(/Repeat password/g) || []).length >= 2);
  for (const role of ['administrator', 'editor', 'reader']) assert.match(app, new RegExp(role));

  assert.match(app, /Article Categories/);
  assert.match(app, /className="category-checklist"/);
  assert.match(app, /categoryIds/);
  assert.match(app, /Create category/);
  assert.match(app, /Hide category and its exclusive articles/);
  assert.match(app, /Articles assigned to another visible category remain visible/);
  assert.match(app, /category-hidden-badge/);
  assert.match(app, /accept="\.txt,\.md,text\/plain,text\/markdown"/);

  assert.match(app, /type="search"/);
  assert.match(app, /Search articles…/);
  assert.match(app, /All categories/);
  assert.match(app, /filteredArticles/);
  assert.match(app, /No matching articles/);

  assert.match(app, /loadContentOnce\(contentKey, \{ manage \}\)/);
  assert.match(clientApi, /const contentRequests = new Map\(\)/);
  assert.match(clientApi, /\/api\/content/);
  assert.match(clientApi, /contentRequests\.has\(key\)/);
  assert.doesNotMatch(app, /cachedPortalApi/);
  assert.doesNotMatch(clientApi, /sessionStorage/);
  assert.match(clientApi, /cache: 'no-store'/);

  assert.match(app, /Confirm with your administrator password/);
  assert.match(app, /disabled=\{selected\}/);
  assert.match(app, /target="_blank"/);
  assert.match(app, /rel="noopener noreferrer"/);
  assert.match(app, /isAdmin && <NavButton path="\/admin\/logbook"/);
  assert.match(app, /Previous Value/);
  assert.match(app, /Filter logbook by action/);
  assert.match(app, /All actions/);
  assert.match(app, /filteredEntries/);
  assert.match(styles, /\.logbook-action-header\{/);

  assert.match(app, /function PortalSidebar/);
  assert.match(app, /Announcements/);
  assert.match(app, /Recent Articles/);
  assert.match(app, />Show all</);
  assert.match(app, /className="announcement-drawer"/);
  assert.match(app, /function Announcements/);
  assert.match(app, /Start date/);
  assert.match(app, /End date \(optional\)/);
  assert.match(app, /announcement-status/);
  assert.match(app, /Stopped/);
  assert.match(app, /Active/);
  assert.match(styles, /\.announcement-status\.active\{/);
  assert.match(styles, /\.announcement-status\.stopped\{/);

  assert.match(app, /function ArticlePage/);
  assert.match(app, /Comments/);
  assert.match(app, /Post comment/);
  assert.match(app, /comment\.userFullName/);
  assert.match(app, /comment\.userEmail/);
  assert.match(app, /boot\.mode === 'private'/);
  assert.match(app, /Allow comment writing/);
  assert.match(app, /canComment/);
  assert.match(app, /comment\.userId === boot\.user\?\.id/);
  assert.match(app, /saveCommentEdit/);
  assert.match(app, /removeComment/);
  assert.match(app, /Portal Name/);
  assert.match(app, /boot\.portalName/);

  assert.match(app, /function AppSkeleton/);
  assert.match(app, /function PortalSkeleton/);
  assert.match(app, /function RecordSkeleton/);
  assert.match(app, /className="skeleton"/);
  assert.doesNotMatch(app, />Loading…</);

  assert.match(app, /path\.startsWith\('\/articles\/'\)/);
  assert.match(app, /\/articles\/\$\{article\.id\}/);
  assert.match(app, /className="article-read"/);
  assert.match(app, /className="article-edit"/);
  assert.match(app, /className="article-delete"/);
  assert.match(app, /<Articles path=\{path\} content=\{content\} patchContent=\{patchContent\} \/>/);
  assert.match(app, /\/admin\/articles\/\$\{article\.id\}/);
  assert.match(app, /Live rendering/);
  assert.match(app, /Article preview/);
  assert.match(app, /View article/);
  assert.match(app, /href=\{\`\/articles\/\$\{id\}\`\}/);
  assert.match(app, /className="live-preview-actions"/);
  assert.match(app, /renderArticleContent\(form\.content\)/);
  assert.match(app, /className="markdown-toolbar"/);
  assert.match(app, /\['h1', 'h2', 'h3'\]/);
  assert.match(app, /type\.toUpperCase\(\)/);
  assert.match(app, /Insert code block/);
  assert.match(app, /insertMarkdown\('code'\)/);
  assert.match(app, /article-markdown-heading/);
  assert.match(app, /article-code-block/);
  assert.match(app, /article-code-disclosure/);
  assert.match(app, /article-code-summary/);
  assert.match(app, /article-code-chevron/);
  assert.match(app, /CODE_LANGUAGES/);
  for (const language of ['javascript', 'bash', 'docker', 'dockerfile', 'kubernetes', 'k8s', 'yaml', 'php', 'sql', 'python']) assert.match(app, new RegExp(language));
  assert.match(app, /Prism\.tokenize/);
  assert.match(app, /renderSyntaxTokens/);
  assert.match(app, /syntax-highlighted/);
  assert.match(styles, /\.markdown-toolbar\{/);
  assert.match(styles, /\.article-code-block\{/);
  assert.match(styles, /\.article-code-disclosure\{/);
  assert.match(styles, /\.article-code-block \.token\.keyword/);
  assert.match(styles, /\.article-code-block \.token\.string/);

  assert.match(app, /Add inline image/);
  assert.match(app, /uploadArticleImage/);
  assert.match(app, /articleImageUrl/);
  assert.match(app, /extractInlineImages/);
  assert.match(app, /renderArticleContent/);
  assert.match(app, /\[25, 50, 75, 100\]/);
  assert.match(app, /className="inline-image-control"/);
  assert.match(app, /className="inline-article-image-row"/);
  assert.match(app, /Media library/);
  assert.match(clientApi, /X-Article-Image-Filename/);

  assert.match(styles, /--accent:#e74e24/);
  assert.match(styles, /\.portal-layout\{/);
  assert.match(styles, /\.announcement-drawer\{/);
  assert.match(styles, /\.comments-section\{/);
  assert.match(styles, /\.category-checklist\{/);
  assert.match(styles, /\.category-hidden-badge\{/);
});
