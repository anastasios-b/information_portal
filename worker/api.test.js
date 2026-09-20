import test from 'node:test';
import assert from 'node:assert/strict';
import { handleApiRequest } from './api.js';

const ORIGIN = 'https://portal.example';
const SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class MockR2Object {
  constructor(entry) { this.entry = entry; this.etag = entry.etag; }
  async json() { return JSON.parse(this.entry.value); }
}
class MockR2 {
  constructor() { this.items = new Map(); this.version = 0; this.failWrites = false; }
  async get(key) { const entry = this.items.get(key); return entry ? new MockR2Object(entry) : null; }
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
}

function env(overrides = {}) { return { PORTAL_DATA: new MockR2(), SESSION_SECRET: SECRET, ...overrides }; }

async function call(environment, path, { method = 'GET', body, cookie } = {}) {
  const headers = new Headers();
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (method !== 'GET') headers.set('Origin', ORIGIN);
  if (cookie) headers.set('Cookie', cookie);
  const response = await handleApiRequest(new Request(`${ORIGIN}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), environment);
  return { response, payload: response.status === 204 ? null : await response.json() };
}
function cookieFrom(response) { return response.headers.get('set-cookie')?.split(';')[0] || ''; }

async function setupAdmin(environment, email = 'admin@example.com') {
  const result = await call(environment, '/api/setup', {
    method: 'POST', body: { email, password: 'correct-horse-battery-staple' },
  });
  assert.equal(result.response.status, 201);
  return { ...result, cookie: cookieFrom(result.response) };
}
async function createUser(environment, cookie, data) {
  return call(environment, '/api/admin/users', { method: 'POST', cookie, body: data });
}

test('bootstrap and setup lifecycle', async () => {
  const e = env();
  let r = await call(e, '/api/bootstrap');
  assert.equal(r.response.status, 200);
  assert.equal(r.payload.setupRequired, true);
  assert.equal(r.payload.mode, 'private');

  const setup = await setupAdmin(e);
  r = await call(e, '/api/bootstrap', { cookie: setup.cookie });
  assert.equal(r.payload.setupRequired, false);
  assert.equal(r.payload.user.role, 'administrator');

  r = await call(e, '/api/setup', {
    method: 'POST', body: { email: 'other@example.com', password: 'correct-horse-battery-staple' },
  });
  assert.equal(r.response.status, 409);
  assert.equal(r.payload.code, 'SETUP_COMPLETE');
});

test('all persisted records use UUIDs', async () => {
  const e = env();
  const setup = await setupAdmin(e);
  assert.match(setup.payload.user.id, UUID_RE);
  const db = e.PORTAL_DATA.db();
  assert.match(db.id, UUID_RE);
  assert.match(db.settings.id, UUID_RE);
  assert.match(db.users[0].id, UUID_RE);
  assert.match(db.users[0].sessionNonce, UUID_RE);
});

test('login validates credentials', async () => {
  const e = env();
  await setupAdmin(e);
  let r = await call(e, '/api/login', { method: 'POST', body: { email: 'admin@example.com', password: 'wrong-password' } });
  assert.equal(r.response.status, 401);
  r = await call(e, '/api/login', { method: 'POST', body: { email: 'ADMIN@example.com', password: 'correct-horse-battery-staple' } });
  assert.equal(r.response.status, 200);
  assert.ok(cookieFrom(r.response));
});

test('private/public mode and published visibility', async () => {
  const e = env();
  const admin = await setupAdmin(e);
  let r = await call(e, '/api/articles');
  assert.equal(r.response.status, 401);

  await call(e, '/api/articles', { method: 'POST', cookie: admin.cookie, body: { title: 'Draft', summary: '', content: 'draft body', status: 'draft' } });
  r = await call(e, '/api/articles', { method: 'POST', cookie: admin.cookie, body: { title: 'Published', summary: 'summary', content: 'published body', status: 'published' } });
  assert.match(r.payload.article.id, UUID_RE);

  r = await call(e, '/api/admin/settings', { method: 'PATCH', cookie: admin.cookie, body: { mode: 'public' } });
  assert.equal(r.response.status, 200);
  r = await call(e, '/api/articles');
  assert.deepEqual(r.payload.articles.map((a) => a.title), ['Published']);
  assert.equal(e.PORTAL_DATA.db().users.length, 1);

  r = await call(e, '/api/admin/settings', { method: 'PATCH', cookie: admin.cookie, body: { mode: 'private' } });
  assert.equal(r.response.status, 200);
  r = await call(e, '/api/articles');
  assert.equal(r.response.status, 401);
});

test('last administrator cannot be deleted or demoted', async () => {
  const e = env();
  const admin = await setupAdmin(e);
  const id = admin.payload.user.id;

  let r = await call(e, `/api/admin/users/${id}`, { method: 'DELETE', cookie: admin.cookie, body: {} });
  assert.equal(r.response.status, 409);
  assert.equal(r.payload.code, 'LAST_ADMIN_REQUIRED');

  r = await call(e, `/api/admin/users/${id}`, {
    method: 'PUT', cookie: admin.cookie, body: { email: 'admin@example.com', role: 'reader' },
  });
  assert.equal(r.response.status, 409);

  r = await createUser(e, admin.cookie, { email: 'admin2@example.com', password: 'another-secure-password', role: 'administrator' });
  assert.equal(r.response.status, 201);
  r = await call(e, `/api/admin/users/${id}`, {
    method: 'PUT', cookie: admin.cookie, body: { email: 'admin@example.com', role: 'reader' },
  });
  assert.equal(r.response.status, 200);
});

test('editors manage articles but cannot manage users/settings', async () => {
  const e = env();
  const admin = await setupAdmin(e);
  await createUser(e, admin.cookie, { email: 'editor@example.com', password: 'editor-secure-password', role: 'editor' });
  let r = await call(e, '/api/login', { method: 'POST', body: { email: 'editor@example.com', password: 'editor-secure-password' } });
  const editorCookie = cookieFrom(r.response);

  r = await call(e, '/api/articles', { method: 'POST', cookie: editorCookie, body: { title: 'Editor article', summary: '', content: 'body', status: 'published' } });
  assert.equal(r.response.status, 201);
  const id = r.payload.article.id;

  r = await call(e, `/api/articles/${id}`, { method: 'PUT', cookie: editorCookie, body: { title: 'Edited', summary: '', content: 'changed', status: 'draft' } });
  assert.equal(r.response.status, 200);
  r = await call(e, '/api/admin/users', { cookie: editorCookie });
  assert.equal(r.response.status, 403);
  r = await call(e, '/api/admin/settings', { method: 'PATCH', cookie: editorCookie, body: { mode: 'public' } });
  assert.equal(r.response.status, 403);
  r = await call(e, `/api/articles/${id}`, { method: 'DELETE', cookie: editorCookie, body: {} });
  assert.equal(r.response.status, 200);
});

test('readers can read but cannot manage', async () => {
  const e = env();
  const admin = await setupAdmin(e);
  await createUser(e, admin.cookie, { email: 'reader@example.com', password: 'reader-secure-password', role: 'reader' });
  await call(e, '/api/articles', { method: 'POST', cookie: admin.cookie, body: { title: 'Visible', summary: '', content: 'body', status: 'published' } });
  let r = await call(e, '/api/login', { method: 'POST', body: { email: 'reader@example.com', password: 'reader-secure-password' } });
  const readerCookie = cookieFrom(r.response);
  r = await call(e, '/api/articles', { cookie: readerCookie });
  assert.equal(r.response.status, 200);
  r = await call(e, '/api/articles?manage=1', { cookie: readerCookie });
  assert.equal(r.response.status, 403);
});

test('password changes invalidate old sessions', async () => {
  const e = env();
  const admin = await setupAdmin(e);
  let r = await createUser(e, admin.cookie, { email: 'user@example.com', password: 'original-secure-password', role: 'reader' });
  const userId = r.payload.user.id;
  r = await call(e, '/api/login', { method: 'POST', body: { email: 'user@example.com', password: 'original-secure-password' } });
  const oldCookie = cookieFrom(r.response);

  await call(e, `/api/admin/users/${userId}`, {
    method: 'PUT', cookie: admin.cookie,
    body: { email: 'user@example.com', password: 'replacement-secure-password', role: 'reader' },
  });

  r = await call(e, '/api/articles', { cookie: oldCookie });
  assert.equal(r.response.status, 401);
  r = await call(e, '/api/login', { method: 'POST', body: { email: 'user@example.com', password: 'replacement-secure-password' } });
  assert.equal(r.response.status, 200);
});

test('storage/configuration failures return JSON errors', async () => {
  const e = env();
  e.PORTAL_DATA.failWrites = true;
  let r = await call(e, '/api/setup', { method: 'POST', body: { email: 'admin@example.com', password: 'correct-horse-battery-staple' } });
  assert.equal(r.response.status, 500);
  assert.equal(r.payload.code, 'STORAGE_WRITE_FAILED');
  assert.match(r.payload.requestId, UUID_RE);

  r = await call({ PORTAL_DATA: new MockR2(), SESSION_SECRET: 'short' }, '/api/bootstrap');
  assert.equal(r.response.status, 500);
  assert.equal(r.payload.code, 'SESSION_SECRET_INVALID');
});
