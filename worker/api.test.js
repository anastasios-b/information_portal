import test from 'node:test';
import assert from 'node:assert/strict';
import { handleApiRequest } from './api.js';

const ORIGIN = 'https://portal.example';
const SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef';
const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class MockR2Object {
  constructor(entry) { this.entry = entry; this.etag = entry.etag; }
  async json() { return JSON.parse(this.entry.value); }
}

class MockR2 {
  constructor() { this.items = new Map(); this.version = 0; this.failWrites = false; }
  async get(key) {
    const entry = this.items.get(key);
    return entry ? new MockR2Object(entry) : null;
  }
  async put(key, value, options = {}) {
    if (this.failWrites) throw new Error('simulated R2 write failure');
    const current = this.items.get(key);
    const condition = options.onlyIf;
    if (condition instanceof Headers) {
      if (condition.get('If-None-Match') === '*' && current) return null;
    } else if (condition?.etagMatches && current?.etag !== condition.etagMatches) return null;
    else if (condition?.etagMatches && !current) return null;

    const etag = `etag-${++this.version}`;
    this.items.set(key, { value: String(value), etag });
    return { etag };
  }
  db() {
    const entry = this.items.get('db/information-portal.json');
    return entry ? JSON.parse(entry.value) : null;
  }
  seed(db) {
    this.items.set('db/information-portal.json', { value: JSON.stringify(db), etag: `etag-${++this.version}` });
  }
}

function env(overrides = {}) {
  return { PORTAL_DATA: new MockR2(), SESSION_SECRET: SECRET, ...overrides };
}

async function call(environment, path, { method = 'GET', body, cookie } = {}) {
  const headers = new Headers();
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (method !== 'GET') headers.set('Origin', ORIGIN);
  if (cookie) headers.set('Cookie', cookie);

  const response = await handleApiRequest(new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }), environment);

  return { response, payload: response.status === 204 ? null : await response.json() };
}

function cookieFrom(response) {
  return response.headers.get('set-cookie')?.split(';')[0] || '';
}

async function setupAdmin(environment, email = 'admin@example.com') {
  const result = await call(environment, '/api/setup', {
    method: 'POST',
    body: { email, password: ADMIN_PASSWORD },
  });
  assert.equal(result.response.status, 201);
  return { ...result, cookie: cookieFrom(result.response) };
}

async function createUser(environment, cookie, data) {
  return call(environment, '/api/admin/users', { method: 'POST', cookie, body: data });
}

async function createCategory(environment, cookie, name = 'General') {
  const result = await call(environment, '/api/categories', {
    method: 'POST',
    cookie,
    body: { name },
  });
  assert.equal(result.response.status, 201);
  return result.payload.category;
}

async function createArticle(environment, cookie, categoryId, overrides = {}) {
  return call(environment, '/api/articles', {
    method: 'POST',
    cookie,
    body: {
      title: 'Article',
      summary: '',
      content: 'body',
      status: 'published',
      categoryId,
      ...overrides,
    },
  });
}

function toStandardBase64(value) {
  let normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  normalized += '='.repeat((4 - (normalized.length % 4)) % 4);
  return normalized;
}

test('bootstrap, setup and UUID schema v2', async () => {
  const e = env();
  let result = await call(e, '/api/bootstrap');
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.setupRequired, true);
  assert.equal(result.payload.mode, 'private');

  const admin = await setupAdmin(e);
  const db = e.PORTAL_DATA.db();
  assert.equal(db.schemaVersion, 2);
  assert.match(db.id, UUID_RE);
  assert.match(db.settings.id, UUID_RE);
  assert.ok(Array.isArray(db.categories));
  assert.match(admin.payload.user.id, UUID_RE);
  assert.match(db.users[0].sessionNonce, UUID_RE);

  result = await call(e, '/api/setup', {
    method: 'POST',
    body: { email: 'other@example.com', password: ADMIN_PASSWORD },
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.payload.code, 'SETUP_COMPLETE');
});

test('schema v1 data migrates without deleting users or articles', async () => {
  const e = env();
  const admin = await setupAdmin(e);
  const original = e.PORTAL_DATA.db();

  original.schemaVersion = 1;
  delete original.categories;
  original.articles = [{
    id: crypto.randomUUID(),
    title: 'Legacy',
    summary: '',
    content: 'legacy',
    status: 'published',
    authorId: original.users[0].id,
    updatedById: original.users[0].id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }];
  e.PORTAL_DATA.seed(original);

  let result = await call(e, '/api/bootstrap', { cookie: admin.cookie });
  assert.equal(result.response.status, 200);

  const category = await createCategory(e, admin.cookie, 'Migrated');
  assert.match(category.id, UUID_RE);

  const migrated = e.PORTAL_DATA.db();
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.users.length, 1);
  assert.equal(migrated.articles.length, 1);
  assert.equal(migrated.articles[0].categoryId, null);
});

test('password hashing verifies login and legacy base64 encoding', async () => {
  const e = env();
  await setupAdmin(e);

  let result = await call(e, '/api/login', {
    method: 'POST',
    body: { email: 'admin@example.com', password: ADMIN_PASSWORD },
  });
  assert.equal(result.response.status, 200);
  assert.ok(cookieFrom(result.response));

  const db = e.PORTAL_DATA.db();
  db.users[0].password.salt = toStandardBase64(db.users[0].password.salt);
  db.users[0].password.hash = toStandardBase64(db.users[0].password.hash);
  e.PORTAL_DATA.seed(db);

  result = await call(e, '/api/login', {
    method: 'POST',
    body: { email: 'ADMIN@example.com', password: ADMIN_PASSWORD },
  });
  assert.equal(result.response.status, 200);

  result = await call(e, '/api/login', {
    method: 'POST',
    body: { email: 'admin@example.com', password: 'wrong-password' },
  });
  assert.equal(result.response.status, 401);
});

test('mode change requires current administrator password and cannot reselect current mode', async () => {
  const e = env();
  const admin = await setupAdmin(e);

  let result = await call(e, '/api/admin/settings', {
    method: 'PATCH',
    cookie: admin.cookie,
    body: { mode: 'public', password: 'wrong-password' },
  });
  assert.equal(result.response.status, 401);
  assert.equal(e.PORTAL_DATA.db().settings.mode, 'private');

  result = await call(e, '/api/admin/settings', {
    method: 'PATCH',
    cookie: admin.cookie,
    body: { mode: 'public', password: ADMIN_PASSWORD },
  });
  assert.equal(result.response.status, 200);
  assert.equal(e.PORTAL_DATA.db().settings.mode, 'public');

  result = await call(e, '/api/admin/settings', {
    method: 'PATCH',
    cookie: admin.cookie,
    body: { mode: 'public', password: ADMIN_PASSWORD },
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.payload.code, 'MODE_UNCHANGED');

  result = await call(e, '/api/admin/settings', {
    method: 'PATCH',
    cookie: admin.cookie,
    body: { mode: 'private', password: ADMIN_PASSWORD },
  });
  assert.equal(result.response.status, 200);
  assert.equal(e.PORTAL_DATA.db().users.length, 1);
});

test('categories CRUD and article category requirement', async () => {
  const e = env();
  const admin = await setupAdmin(e);

  let result = await createArticle(e, admin.cookie, crypto.randomUUID());
  assert.equal(result.response.status, 400);
  assert.equal(result.payload.code, 'INVALID_CATEGORY');

  const category = await createCategory(e, admin.cookie, 'Operations');
  assert.match(category.id, UUID_RE);

  result = await call(e, `/api/categories/${category.id}`, {
    method: 'PUT',
    cookie: admin.cookie,
    body: { name: 'Procedures' },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.category.name, 'Procedures');

  result = await createArticle(e, admin.cookie, category.id);
  assert.equal(result.response.status, 201);
  assert.equal(result.payload.article.categoryId, category.id);

  const articleId = result.payload.article.id;
  result = await call(e, `/api/categories/${category.id}`, {
    method: 'DELETE',
    cookie: admin.cookie,
    body: {},
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.payload.code, 'CATEGORY_IN_USE');

  await call(e, `/api/articles/${articleId}`, { method: 'DELETE', cookie: admin.cookie, body: {} });
  result = await call(e, `/api/categories/${category.id}`, {
    method: 'DELETE',
    cookie: admin.cookie,
    body: {},
  });
  assert.equal(result.response.status, 200);
});

test('private/public published article access includes public categories', async () => {
  const e = env();
  const admin = await setupAdmin(e);
  const category = await createCategory(e, admin.cookie);
  await createArticle(e, admin.cookie, category.id, { title: 'Published' });
  await createArticle(e, admin.cookie, category.id, { title: 'Draft', status: 'draft' });

  let result = await call(e, '/api/articles');
  assert.equal(result.response.status, 401);
  result = await call(e, '/api/categories');
  assert.equal(result.response.status, 401);

  await call(e, '/api/admin/settings', {
    method: 'PATCH',
    cookie: admin.cookie,
    body: { mode: 'public', password: ADMIN_PASSWORD },
  });

  result = await call(e, '/api/articles');
  assert.deepEqual(result.payload.articles.map((article) => article.title), ['Published']);

  result = await call(e, '/api/categories');
  assert.deepEqual(result.payload.categories.map((item) => item.name), ['General']);
});

test('last administrator cannot be deleted or demoted', async () => {
  const e = env();
  const admin = await setupAdmin(e);
  const id = admin.payload.user.id;

  let result = await call(e, `/api/admin/users/${id}`, { method: 'DELETE', cookie: admin.cookie, body: {} });
  assert.equal(result.response.status, 409);

  result = await call(e, `/api/admin/users/${id}`, {
    method: 'PUT',
    cookie: admin.cookie,
    body: { email: 'admin@example.com', role: 'reader' },
  });
  assert.equal(result.response.status, 409);

  result = await createUser(e, admin.cookie, {
    email: 'admin2@example.com',
    password: 'another-secure-password',
    role: 'administrator',
  });
  assert.equal(result.response.status, 201);

  result = await call(e, `/api/admin/users/${id}`, {
    method: 'PUT',
    cookie: admin.cookie,
    body: { email: 'admin@example.com', role: 'reader' },
  });
  assert.equal(result.response.status, 200);
});

test('editors manage categories/articles but not users/settings', async () => {
  const e = env();
  const admin = await setupAdmin(e);
  await createUser(e, admin.cookie, {
    email: 'editor@example.com',
    password: 'editor-secure-password',
    role: 'editor',
  });

  let result = await call(e, '/api/login', {
    method: 'POST',
    body: { email: 'editor@example.com', password: 'editor-secure-password' },
  });
  const editorCookie = cookieFrom(result.response);
  const category = await createCategory(e, editorCookie, 'Editor category');
  result = await createArticle(e, editorCookie, category.id);
  assert.equal(result.response.status, 201);

  result = await call(e, '/api/admin/users', { cookie: editorCookie });
  assert.equal(result.response.status, 403);

  result = await call(e, '/api/admin/settings', {
    method: 'PATCH',
    cookie: editorCookie,
    body: { mode: 'public', password: 'editor-secure-password' },
  });
  assert.equal(result.response.status, 403);
});

test('readers read published content but cannot manage', async () => {
  const e = env();
  const admin = await setupAdmin(e);
  const category = await createCategory(e, admin.cookie);
  await createArticle(e, admin.cookie, category.id);

  await createUser(e, admin.cookie, {
    email: 'reader@example.com',
    password: 'reader-secure-password',
    role: 'reader',
  });

  let result = await call(e, '/api/login', {
    method: 'POST',
    body: { email: 'reader@example.com', password: 'reader-secure-password' },
  });
  const readerCookie = cookieFrom(result.response);

  result = await call(e, '/api/articles', { cookie: readerCookie });
  assert.equal(result.response.status, 200);

  result = await call(e, '/api/categories?manage=1', { cookie: readerCookie });
  assert.equal(result.response.status, 403);
});

test('password changes invalidate old sessions and new password authenticates', async () => {
  const e = env();
  const admin = await setupAdmin(e);

  let result = await createUser(e, admin.cookie, {
    email: 'user@example.com',
    password: 'original-secure-password',
    role: 'reader',
  });
  const userId = result.payload.user.id;

  result = await call(e, '/api/login', {
    method: 'POST',
    body: { email: 'user@example.com', password: 'original-secure-password' },
  });
  const oldCookie = cookieFrom(result.response);

  result = await call(e, `/api/admin/users/${userId}`, {
    method: 'PUT',
    cookie: admin.cookie,
    body: { email: 'user@example.com', password: 'replacement-secure-password', role: 'reader' },
  });
  assert.equal(result.response.status, 200);

  result = await call(e, '/api/articles', { cookie: oldCookie });
  assert.equal(result.response.status, 401);

  result = await call(e, '/api/login', {
    method: 'POST',
    body: { email: 'user@example.com', password: 'replacement-secure-password' },
  });
  assert.equal(result.response.status, 200);
});

test('storage/configuration failures return structured JSON', async () => {
  const e = env();
  e.PORTAL_DATA.failWrites = true;
  let result = await call(e, '/api/setup', {
    method: 'POST',
    body: { email: 'admin@example.com', password: ADMIN_PASSWORD },
  });
  assert.equal(result.response.status, 500);
  assert.equal(result.payload.code, 'STORAGE_WRITE_FAILED');
  assert.match(result.payload.requestId, UUID_RE);

  result = await call({ PORTAL_DATA: new MockR2(), SESSION_SECRET: 'short' }, '/api/bootstrap');
  assert.equal(result.response.status, 500);
  assert.equal(result.payload.code, 'SESSION_SECRET_INVALID');
});
