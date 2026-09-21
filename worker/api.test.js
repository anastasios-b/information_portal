import test from 'node:test';
import assert from 'node:assert/strict';
import { handleApiRequest } from './api.js';

const ORIGIN = 'https://portal.example';
const SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef';
const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEYS = {
  users: 'db/users.json',
  articles: 'db/articles.json',
  categories: 'db/article-categories.json',
  settings: 'db/settings.json',
  logbook: 'db/logbook.json',
  legacy: 'db/information-portal.json',
};

class MockR2Object {
  constructor(entry) {
    this.entry = entry;
    this.etag = entry.etag;
    this.httpMetadata = entry.httpMetadata;
    this.customMetadata = entry.customMetadata;
    this.body = entry.value instanceof ArrayBuffer ? entry.value : new TextEncoder().encode(String(entry.value));
  }
  async json() { return JSON.parse(this.entry.value); }
}
class MockR2 {
  constructor() { this.items = new Map(); this.version = 0; this.reads = []; this.writes = []; this.failWrites = false; }
  async get(key) {
    this.reads.push(key);
    const entry = this.items.get(key);
    return entry ? new MockR2Object(entry) : null;
  }
  async put(key, value, options = {}) {
    this.writes.push(key);
    if (this.failWrites) throw new Error('simulated R2 write failure');
    const current = this.items.get(key);
    const condition = options.onlyIf;
    if (condition instanceof Headers) {
      if (condition.get('If-None-Match') === '*' && current) return null;
    } else if (condition?.etagMatches && current?.etag !== condition.etagMatches) return null;
    else if (condition?.etagMatches && !current) return null;
    const etag = `etag-${++this.version}`;
    this.items.set(key, {
      value: typeof value === 'string' ? value : value,
      etag,
      httpMetadata: options.httpMetadata,
      customMetadata: options.customMetadata,
    });
    return { etag };
  }
  async list(options = {}) {
    const prefix = options.prefix || '';
    const objects = [...this.items.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, entry]) => ({
        key,
        size: typeof entry.value === 'string' ? new TextEncoder().encode(entry.value).byteLength : entry.value.byteLength,
        etag: entry.etag,
        uploaded: new Date(),
        httpMetadata: entry.httpMetadata,
        customMetadata: entry.customMetadata,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
    return { objects, truncated: false };
  }
  data(key) {
    const entry = this.items.get(key);
    return entry && typeof entry.value === 'string' ? JSON.parse(entry.value) : null;
  }
  seed(key, value) { this.items.set(key, { value: JSON.stringify(value), etag: `etag-${++this.version}` }); }
  resetTrace() { this.reads = []; this.writes = []; }
}

function env(overrides = {}) { return { PORTAL_DATA: new MockR2(), SESSION_SECRET: SECRET, ...overrides }; }
function createTestContext() {
  const pending = [];
  return {
    pending,
    waitUntil(promise) { pending.push(Promise.resolve(promise)); },
  };
}

async function call(environment, path, { method = 'GET', body, cookie, drainWaitUntil = true } = {}) {
  const headers = new Headers();
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (method !== 'GET') headers.set('Origin', ORIGIN);
  if (cookie) headers.set('Cookie', cookie);
  const ctx = createTestContext();
  const response = await handleApiRequest(new Request(`${ORIGIN}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), environment, ctx);
  if (drainWaitUntil) await Promise.all(ctx.pending);
  return { response, payload: response.status === 204 ? null : await response.json(), ctx };
}
async function rawCall(environment, path, { method = 'GET', body, cookie, contentType, filename } = {}) {
  const headers = new Headers();
  if (contentType) headers.set('Content-Type', contentType);
  if (filename) headers.set('X-Article-Image-Filename', encodeURIComponent(filename));
  if (method !== 'GET') headers.set('Origin', ORIGIN);
  if (cookie) headers.set('Cookie', cookie);
  const ctx = createTestContext();
  const response = await handleApiRequest(new Request(`${ORIGIN}${path}`, { method, headers, body }), environment, ctx);
  await Promise.all(ctx.pending);
  const type = response.headers.get('content-type') || '';
  return {
    response,
    payload: type.includes('application/json') ? await response.json() : await response.arrayBuffer(),
    ctx,
  };
}

function cookieFrom(response) { return response.headers.get('set-cookie')?.split(';')[0] || ''; }
async function setupAdmin(environment) {
  const result = await call(environment, '/api/setup', { method: 'POST', body: { email: 'admin@example.com', password: ADMIN_PASSWORD } });
  assert.equal(result.response.status, 201);
  return { ...result, cookie: cookieFrom(result.response) };
}
async function createCategory(environment, cookie, name = 'General') {
  const result = await call(environment, '/api/categories', { method: 'POST', cookie, body: { name } });
  assert.equal(result.response.status, 201);
  return result.payload.category;
}

test('setup creates split users store and login verifies password', async () => {
  const e = env();
  const admin = await setupAdmin(e);
  assert.match(admin.payload.user.id, UUID_RE);
  assert.ok(e.PORTAL_DATA.data(KEYS.users));
  assert.equal(e.PORTAL_DATA.data(KEYS.articles), null);
  assert.equal(e.PORTAL_DATA.data(KEYS.categories), null);

  e.PORTAL_DATA.resetTrace();
  let result = await call(e, '/api/login', { method: 'POST', body: { email: 'admin@example.com', password: ADMIN_PASSWORD } });
  assert.equal(result.response.status, 200);
  assert.deepEqual([...new Set(e.PORTAL_DATA.reads)], [KEYS.users]);

  result = await call(e, '/api/login', { method: 'POST', body: { email: 'admin@example.com', password: 'wrong-password' } });
  assert.equal(result.response.status, 401);
});

test('bootstrap reads only users and settings after split stores exist', async () => {
  const e = env();
  const admin = await setupAdmin(e);
  await call(e, '/api/bootstrap', { cookie: admin.cookie });
  e.PORTAL_DATA.resetTrace();
  const result = await call(e, '/api/bootstrap', { cookie: admin.cookie });
  assert.equal(result.response.status, 200);
  assert.deepEqual(new Set(e.PORTAL_DATA.reads), new Set([KEYS.users, KEYS.settings]));
});

test('legacy monolith migrates lazily into four split files without data loss', async () => {
  const e = env();
  const userId = crypto.randomUUID();
  const categoryId = crypto.randomUUID();
  const now = new Date().toISOString();
  e.PORTAL_DATA.seed(KEYS.legacy, {
    id: crypto.randomUUID(), schemaVersion: 2,
    settings: { id: crypto.randomUUID(), mode: 'public', updatedAt: now, updatedById: null },
    users: [{ id: userId, email: 'legacy@example.com', role: 'reader', password: { algorithm: 'PBKDF2-SHA-256', iterations: 1, salt: 'AA', hash: 'AA' }, sessionNonce: crypto.randomUUID(), createdAt: now, updatedAt: now }],
    categories: [{ id: categoryId, name: 'Legacy category', createdById: userId, updatedById: userId, createdAt: now, updatedAt: now }],
    articles: [{ id: crypto.randomUUID(), title: 'Legacy article', summary: '', content: 'body', status: 'published', categoryId, authorId: userId, updatedById: userId, createdAt: now, updatedAt: now }],
    createdAt: now, updatedAt: now,
  });

  let result = await call(e, '/api/articles');
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.articles[0].title, 'Legacy article');
  result = await call(e, '/api/categories');
  assert.equal(result.response.status, 200);
  result = await call(e, '/api/bootstrap');
  assert.equal(result.response.status, 200);

  for (const key of [KEYS.users, KEYS.articles, KEYS.categories, KEYS.settings]) assert.ok(e.PORTAL_DATA.data(key), key);
  assert.equal(e.PORTAL_DATA.data(KEYS.users).users[0].email, 'legacy@example.com');
  assert.equal(e.PORTAL_DATA.data(KEYS.categories).categories[0].name, 'Legacy category');
});

test('public article endpoint reads only settings and articles once stores exist', async () => {
  const e = env();
  const admin = await setupAdmin(e);
  const category = await createCategory(e, admin.cookie);
  await call(e, '/api/articles', { method: 'POST', cookie: admin.cookie, body: { title: 'Published', summary: '', content: 'body', status: 'published', categoryId: category.id } });
  await call(e, '/api/admin/settings', { method: 'PATCH', cookie: admin.cookie, body: { mode: 'public', password: ADMIN_PASSWORD } });

  e.PORTAL_DATA.resetTrace();
  const result = await call(e, '/api/articles');
  assert.equal(result.response.status, 200);
  assert.deepEqual(new Set(e.PORTAL_DATA.reads), new Set([KEYS.settings, KEYS.articles]));
});

test('public categories endpoint reads only settings and categories', async () => {
  const e = env();
  const admin = await setupAdmin(e);
  await createCategory(e, admin.cookie);
  await call(e, '/api/admin/settings', { method: 'PATCH', cookie: admin.cookie, body: { mode: 'public', password: ADMIN_PASSWORD } });

  e.PORTAL_DATA.resetTrace();
  const result = await call(e, '/api/categories');
  assert.equal(result.response.status, 200);
  assert.deepEqual(new Set(e.PORTAL_DATA.reads), new Set([KEYS.settings, KEYS.categories]));
});

test('mode changes require administrator password and write settings plus audit log after authentication read', async () => {
  const e = env();
  const admin = await setupAdmin(e);
  await call(e, '/api/bootstrap', { cookie: admin.cookie });

  let result = await call(e, '/api/admin/settings', { method: 'PATCH', cookie: admin.cookie, body: { mode: 'public', password: 'wrong-password' } });
  assert.equal(result.response.status, 401);

  e.PORTAL_DATA.resetTrace();
  result = await call(e, '/api/admin/settings', { method: 'PATCH', cookie: admin.cookie, body: { mode: 'public', password: ADMIN_PASSWORD } });
  assert.equal(result.response.status, 200);
  assert.deepEqual(new Set(e.PORTAL_DATA.reads), new Set([KEYS.users, KEYS.settings, KEYS.logbook]));
  assert.equal(e.PORTAL_DATA.data(KEYS.settings).mode, 'public');
  const logbook = e.PORTAL_DATA.data(KEYS.logbook);
  assert.equal(logbook.entries.at(-1).action, 'Portal State Update to Public');
  assert.equal(logbook.entries.at(-1).entityLabel, 'Portal');
  assert.equal(logbook.entries.at(-1).previousEntityId, null);
  assert.equal(logbook.entries.at(-1).previousEntityLabel, 'Private');
  assert.equal(logbook.entries.at(-1).userEmail, 'admin@example.com');
});

test('category CRUD and article integrity use only required split stores', async () => {
  const e = env();
  const admin = await setupAdmin(e);
  const category = await createCategory(e, admin.cookie, 'Operations');
  let result = await call(e, '/api/articles', { method: 'POST', cookie: admin.cookie, body: { title: 'Article', summary: '', content: 'body', status: 'published', categoryId: category.id } });
  assert.equal(result.response.status, 201);
  const articleId = result.payload.article.id;

  result = await call(e, `/api/categories/${category.id}`, { method: 'DELETE', cookie: admin.cookie, body: {} });
  assert.equal(result.response.status, 409);
  assert.equal(result.payload.code, 'CATEGORY_IN_USE');

  await call(e, `/api/articles/${articleId}`, { method: 'DELETE', cookie: admin.cookie, body: {} });
  result = await call(e, `/api/categories/${category.id}`, { method: 'DELETE', cookie: admin.cookie, body: {} });
  assert.equal(result.response.status, 200);
});

test('last administrator invariant remains enforced in users store', async () => {
  const e = env();
  const admin = await setupAdmin(e);
  const id = admin.payload.user.id;
  let result = await call(e, `/api/admin/users/${id}`, { method: 'DELETE', cookie: admin.cookie, body: {} });
  assert.equal(result.response.status, 409);
  result = await call(e, `/api/admin/users/${id}`, { method: 'PUT', cookie: admin.cookie, body: { email: 'admin@example.com', role: 'reader' } });
  assert.equal(result.response.status, 409);
});


test('inline article images use filenames, appear in media library and respect portal privacy', async () => {
  const e = env();
  const admin = await setupAdmin(e);
  const category = await createCategory(e, admin.cookie);
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const filename = 'hotel-map.png';

  let result = await rawCall(e, '/api/article-images', {
    method: 'POST',
    cookie: admin.cookie,
    contentType: 'image/png',
    filename,
    body: bytes,
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.payload.image.filename, filename);
  assert.ok(e.PORTAL_DATA.items.has(`article-images/${filename}`));

  result = await call(e, '/api/article-images', { cookie: admin.cookie });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.payload.images.map((image) => image.filename), [filename]);

  result = await call(e, '/api/articles', {
    method: 'POST',
    cookie: admin.cookie,
    body: {
      title: 'With image',
      summary: '',
      content: `Before\n[[image:${filename}|50]]\nAfter`,
      status: 'published',
      categoryId: category.id,
    },
  });
  assert.equal(result.response.status, 201);

  result = await rawCall(e, `/api/article-images/${encodeURIComponent(filename)}`, { cookie: admin.cookie });
  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers.get('content-type'), 'image/png');
  assert.deepEqual([...new Uint8Array(result.payload)], [...bytes]);

  result = await rawCall(e, `/api/article-images/${encodeURIComponent(filename)}`);
  assert.equal(result.response.status, 401);

  result = await rawCall(e, '/api/article-images', {
    method: 'POST',
    cookie: admin.cookie,
    contentType: 'image/png',
    filename,
    body: bytes,
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.payload.code, 'IMAGE_FILENAME_IN_USE');

  await call(e, '/api/admin/settings', {
    method: 'PATCH',
    cookie: admin.cookie,
    body: { mode: 'public', password: ADMIN_PASSWORD },
  });
  result = await rawCall(e, `/api/article-images/${encodeURIComponent(filename)}`);
  assert.equal(result.response.status, 200);
});

test('legacy UUID-backed article images remain readable but are omitted from filename media library', async () => {
  const e = env();
  const admin = await setupAdmin(e);
  const legacyId = crypto.randomUUID();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  await e.PORTAL_DATA.put(`article-images/${legacyId}`, bytes, { httpMetadata: { contentType: 'image/png' } });

  let result = await rawCall(e, `/api/article-images/${legacyId}`, { cookie: admin.cookie });
  assert.equal(result.response.status, 200);

  result = await call(e, '/api/article-images', { cookie: admin.cookie });
  assert.deepEqual(result.payload.images, []);
});

test('invalid inline image tokens are rejected', async () => {
  const e = env();
  const admin = await setupAdmin(e);
  const category = await createCategory(e, admin.cookie);

  const result = await call(e, '/api/articles', {
    method: 'POST',
    cookie: admin.cookie,
    body: {
      title: 'Bad image token',
      summary: '',
      content: 'Text [[image:bad/name.png|50]]',
      status: 'published',
      categoryId: category.id,
    },
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.payload.code, 'INVALID_IMAGE_TOKEN');
});

test('storage failures stay structured', async () => {
  const e = env();
  e.PORTAL_DATA.failWrites = true;
  const result = await call(e, '/api/setup', { method: 'POST', body: { email: 'admin@example.com', password: ADMIN_PASSWORD } });
  assert.equal(result.response.status, 500);
  assert.equal(result.payload.code, 'STORAGE_READ_FAILED');
  assert.match(result.payload.requestId, UUID_RE);
});


test('new password hashes use the Worker-safe PBKDF2 cost and remain verifiable', async () => {
  const e = env();
  const admin = await setupAdmin(e);

  let result = await call(e, '/api/admin/users', {
    method: 'POST',
    cookie: admin.cookie,
    body: {
      email: 'hash-check@example.com',
      password: 'worker-safe-password',
      role: 'reader',
    },
  });
  assert.equal(result.response.status, 201);

  const usersStore = e.PORTAL_DATA.data(KEYS.users);
  const created = usersStore.users.find((user) => user.email === 'hash-check@example.com');
  assert.equal(created.password.algorithm, 'PBKDF2-SHA-256');
  assert.equal(created.password.iterations, 60000);

  result = await call(e, '/api/login', {
    method: 'POST',
    body: {
      email: 'hash-check@example.com',
      password: 'worker-safe-password',
    },
  });
  assert.equal(result.response.status, 200);
});


test('logbook is visible only to administrators', async () => {
  const e = env();
  const admin = await setupAdmin(e);

  let result = await call(e, '/api/admin/users', {
    method: 'POST',
    cookie: admin.cookie,
    body: {
      email: 'editor@example.com',
      password: 'editor-secure-password',
      role: 'editor',
    },
  });
  assert.equal(result.response.status, 201);

  result = await call(e, '/api/login', {
    method: 'POST',
    body: {
      email: 'editor@example.com',
      password: 'editor-secure-password',
    },
  });
  assert.equal(result.response.status, 200);
  const editorCookie = cookieFrom(result.response);

  result = await call(e, '/api/admin/logbook', { cookie: admin.cookie });
  assert.equal(result.response.status, 200);
  assert.ok(Array.isArray(result.payload.entries));

  result = await call(e, '/api/admin/logbook', { cookie: editorCookie });
  assert.equal(result.response.status, 403);
});


test('logbook update entries preserve previous entity labels and UUIDs', async () => {
  const e = env();
  const admin = await setupAdmin(e);
  const category = await createCategory(e, admin.cookie, 'Original category');

  let result = await call(e, `/api/categories/${category.id}`, {
    method: 'PUT',
    cookie: admin.cookie,
    body: { name: 'Renamed category' },
  });
  assert.equal(result.response.status, 200);

  result = await call(e, '/api/admin/logbook', { cookie: admin.cookie });
  const entry = result.payload.entries.find((item) => item.action === 'Category Update');
  assert.equal(entry.entityId, category.id);
  assert.equal(entry.entityLabel, 'Renamed category');
  assert.equal(entry.previousEntityId, category.id);
  assert.equal(entry.previousEntityLabel, 'Original category');
});

test('audit writes are scheduled with waitUntil without blocking the response path', async () => {
  const e = env();
  const admin = await setupAdmin(e);

  const result = await call(e, '/api/admin/settings', {
    method: 'PATCH',
    cookie: admin.cookie,
    drainWaitUntil: false,
    body: { mode: 'public', password: ADMIN_PASSWORD },
  });

  assert.equal(result.response.status, 200);
  assert.equal(result.ctx.pending.length, 1);
  await Promise.all(result.ctx.pending);
  assert.equal(e.PORTAL_DATA.data(KEYS.logbook).entries.at(-1).action, 'Portal State Update to Public');
});


test('article update logbook captures every changed previous field', async () => {
  const e = env();
  const admin = await setupAdmin(e);
  const firstCategory = await createCategory(e, admin.cookie, 'First category');
  const secondCategory = await createCategory(e, admin.cookie, 'Second category');

  let result = await call(e, '/api/articles', {
    method: 'POST',
    cookie: admin.cookie,
    body: {
      title: 'Original title',
      summary: 'Original summary',
      content: 'Original content',
      status: 'draft',
      categoryId: firstCategory.id,
    },
  });
  assert.equal(result.response.status, 201);
  const article = result.payload.article;

  result = await call(e, `/api/articles/${article.id}`, {
    method: 'PUT',
    cookie: admin.cookie,
    body: {
      title: 'Updated title',
      summary: 'Updated summary',
      content: 'Updated content',
      status: 'published',
      categoryId: secondCategory.id,
    },
  });
  assert.equal(result.response.status, 200);

  result = await call(e, '/api/admin/logbook', { cookie: admin.cookie });
  const entry = result.payload.entries.find((item) => item.action === 'Article Update' && item.entityId === article.id);
  assert.deepEqual(entry.previousFields, [
    { field: 'Title', value: 'Original title' },
    { field: 'Summary', value: 'Original summary' },
    { field: 'Content', value: 'Original content' },
    { field: 'Status', value: 'draft' },
    { field: 'Category', value: 'First category', referenceId: firstCategory.id },
  ]);
});
