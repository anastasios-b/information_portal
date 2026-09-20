const DB_KEY = 'db/information-portal.json';
const SESSION_COOKIE = 'portal_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const PBKDF2_ITERATIONS = 210000;
const SCHEMA_VERSION = 2;
const ROLES = new Set(['administrator', 'editor', 'reader']);
const ARTICLE_STATUSES = new Set(['draft', 'published']);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class ApiError extends Error {
  constructor(status, message, code = 'REQUEST_FAILED') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export async function handleApiRequest(request, env) {
  const requestId = crypto.randomUUID();

  try {
    validateEnvironment(env);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) assertSameOrigin(request, url);

    if (method === 'OPTIONS') return new Response(null, { status: 204 });
    if (method === 'GET' && parts[0] === 'bootstrap' && parts.length === 1) return await bootstrap(request, env);
    if (method === 'POST' && parts[0] === 'setup' && parts.length === 1) return await setup(request, env);
    if (method === 'POST' && parts[0] === 'login' && parts.length === 1) return await login(request, env);
    if (method === 'POST' && parts[0] === 'logout' && parts.length === 1) {
      return json({ ok: true }, 200, { 'Set-Cookie': expiredSessionCookie(request) });
    }

    if (parts[0] === 'articles') {
      if (method === 'GET' && parts.length === 1) return await listArticles(request, env, url.searchParams.get('manage') === '1');
      if (method === 'GET' && parts.length === 2) return await getArticle(request, env, parts[1]);
      if (method === 'POST' && parts.length === 1) return await saveArticle(request, env);
      if (method === 'PUT' && parts.length === 2) return await saveArticle(request, env, parts[1]);
      if (method === 'DELETE' && parts.length === 2) return await deleteArticle(request, env, parts[1]);
    }

    if (parts[0] === 'categories') {
      if (method === 'GET' && parts.length === 1) return await listCategories(request, env, url.searchParams.get('manage') === '1');
      if (method === 'POST' && parts.length === 1) return await saveCategory(request, env);
      if (method === 'PUT' && parts.length === 2) return await saveCategory(request, env, parts[1]);
      if (method === 'DELETE' && parts.length === 2) return await deleteCategory(request, env, parts[1]);
    }

    if (parts[0] === 'admin' && parts[1] === 'users') {
      if (method === 'GET' && parts.length === 2) return await listUsers(request, env);
      if (method === 'POST' && parts.length === 2) return await saveUser(request, env);
      if (method === 'PUT' && parts.length === 3) return await saveUser(request, env, parts[2]);
      if (method === 'DELETE' && parts.length === 3) return await deleteUser(request, env, parts[2]);
    }

    if (method === 'PATCH' && parts[0] === 'admin' && parts[1] === 'settings' && parts.length === 2) {
      return await updateSettings(request, env);
    }

    throw new ApiError(404, 'Endpoint not found', 'NOT_FOUND');
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status >= 500) console.error(`[${requestId}] ${error.code}: ${error.message}`);
      return json({ error: error.message, code: error.code, requestId }, error.status);
    }
    console.error(`[${requestId}] Unhandled API error`, error?.stack || error);
    return json({ error: 'Internal server error', code: 'INTERNAL_ERROR', requestId }, 500);
  }
}

function validateEnvironment(env) {
  if (!env?.PORTAL_DATA || typeof env.PORTAL_DATA.get !== 'function' || typeof env.PORTAL_DATA.put !== 'function') {
    throw new ApiError(500, 'Portal storage is not configured', 'STORAGE_NOT_CONFIGURED');
  }
  if (typeof env.SESSION_SECRET !== 'string' || env.SESSION_SECRET.length < 32) {
    throw new ApiError(500, 'Session secret is not configured correctly', 'SESSION_SECRET_INVALID');
  }
}

function assertSameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) throw new ApiError(403, 'Cross-origin request rejected', 'CROSS_ORIGIN_REJECTED');
}

async function bootstrap(request, env) {
  const { db } = await readDatabase(env);
  const session = await readSession(request, env).catch(() => null);
  const user = session ? userFromSession(db, session) : null;
  return json({
    setupRequired: adminCount(db) === 0,
    setupTokenRequired: Boolean(env.BOOTSTRAP_TOKEN),
    mode: db.settings.mode,
    user: user ? publicUser(user) : null,
    adminCount: adminCount(db),
  });
}

async function setup(request, env) {
  const input = await jsonBody(request);
  const email = normalizeEmail(input.email);
  const password = validatePassword(input.password);
  if (env.BOOTSTRAP_TOKEN && input.bootstrapToken !== env.BOOTSTRAP_TOKEN) {
    throw new ApiError(403, 'Invalid setup token', 'INVALID_SETUP_TOKEN');
  }

  const user = await mutateDatabase(env, async (db) => {
    if (adminCount(db) !== 0) throw new ApiError(409, 'Initial setup has already been completed', 'SETUP_COMPLETE');
    const now = new Date().toISOString();
    const newUser = {
      id: crypto.randomUUID(),
      email,
      role: 'administrator',
      password: await hashPassword(password),
      sessionNonce: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    db.users.push(newUser);
    return newUser;
  });

  const sessionToken = await createSessionToken(user, env);
  return json({ user: publicUser(user) }, 201, { 'Set-Cookie': sessionCookie(request, sessionToken) });
}

async function login(request, env) {
  const input = await jsonBody(request);
  const email = normalizeEmail(input.email);
  const password = String(input.password ?? '');
  const { db } = await readDatabase(env);
  const user = db.users.find((item) => item.email === email);

  if (!user || !(await verifyPassword(password, user.password))) {
    throw new ApiError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');
  }

  const sessionToken = await createSessionToken(user, env);
  return json({ user: publicUser(user) }, 200, { 'Set-Cookie': sessionCookie(request, sessionToken) });
}

async function listArticles(request, env, manage) {
  const { db } = await readDatabase(env);
  const session = await readSession(request, env).catch(() => null);
  const user = session ? userFromSession(db, session) : null;
  if (manage) requireRole(user, ['administrator', 'editor']);
  else if (db.settings.mode === 'private' && !user) throw new ApiError(401, 'Authentication required', 'AUTH_REQUIRED');
  const articles = manage ? db.articles : db.articles.filter((article) => article.status === 'published');
  return json({ articles: [...articles].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) });
}

async function getArticle(request, env, id) {
  assertUuid(id);
  const { db } = await readDatabase(env);
  const session = await readSession(request, env).catch(() => null);
  const user = session ? userFromSession(db, session) : null;
  const article = db.articles.find((item) => item.id === id);
  if (!article) throw new ApiError(404, 'Article not found', 'ARTICLE_NOT_FOUND');
  if (article.status === 'draft') requireRole(user, ['administrator', 'editor']);
  else if (db.settings.mode === 'private' && !user) throw new ApiError(401, 'Authentication required', 'AUTH_REQUIRED');
  return json({ article });
}

async function saveArticle(request, env, id = null) {
  if (id) assertUuid(id);
  const session = await requireSession(request, env);
  const body = await jsonBody(request);

  const article = await mutateDatabase(env, (db) => {
    const user = userFromSession(db, session);
    requireRole(user, ['administrator', 'editor']);
    const input = validateArticle(body, db);
    const now = new Date().toISOString();

    if (id) {
      const existing = db.articles.find((item) => item.id === id);
      if (!existing) throw new ApiError(404, 'Article not found', 'ARTICLE_NOT_FOUND');
      Object.assign(existing, input, { updatedAt: now, updatedById: user.id });
      return existing;
    }

    const created = {
      id: crypto.randomUUID(),
      ...input,
      authorId: user.id,
      updatedById: user.id,
      createdAt: now,
      updatedAt: now,
    };
    db.articles.push(created);
    return created;
  });

  return json({ article }, id ? 200 : 201);
}

async function deleteArticle(request, env, id) {
  assertUuid(id);
  const session = await requireSession(request, env);
  await mutateDatabase(env, (db) => {
    requireRole(userFromSession(db, session), ['administrator', 'editor']);
    const index = db.articles.findIndex((item) => item.id === id);
    if (index < 0) throw new ApiError(404, 'Article not found', 'ARTICLE_NOT_FOUND');
    db.articles.splice(index, 1);
  });
  return json({ ok: true });
}

async function listCategories(request, env, manage) {
  const { db } = await readDatabase(env);
  const session = await readSession(request, env).catch(() => null);
  const user = session ? userFromSession(db, session) : null;
  if (manage) requireRole(user, ['administrator', 'editor']);
  else if (db.settings.mode === 'private' && !user) throw new ApiError(401, 'Authentication required', 'AUTH_REQUIRED');
  return json({ categories: [...db.categories].sort((a, b) => a.name.localeCompare(b.name)) });
}

async function saveCategory(request, env, id = null) {
  if (id) assertUuid(id);
  const session = await requireSession(request, env);
  const input = validateCategory(await jsonBody(request));

  const category = await mutateDatabase(env, (db) => {
    const user = userFromSession(db, session);
    requireRole(user, ['administrator', 'editor']);
    if (db.categories.some((item) => item.name.toLocaleLowerCase() === input.name.toLocaleLowerCase() && item.id !== id)) {
      throw new ApiError(409, 'Category name is already in use', 'CATEGORY_NAME_IN_USE');
    }
    const now = new Date().toISOString();

    if (id) {
      const existing = db.categories.find((item) => item.id === id);
      if (!existing) throw new ApiError(404, 'Category not found', 'CATEGORY_NOT_FOUND');
      existing.name = input.name;
      existing.updatedAt = now;
      existing.updatedById = user.id;
      return existing;
    }

    const created = {
      id: crypto.randomUUID(),
      name: input.name,
      createdById: user.id,
      updatedById: user.id,
      createdAt: now,
      updatedAt: now,
    };
    db.categories.push(created);
    return created;
  });

  return json({ category }, id ? 200 : 201);
}

async function deleteCategory(request, env, id) {
  assertUuid(id);
  const session = await requireSession(request, env);
  await mutateDatabase(env, (db) => {
    requireRole(userFromSession(db, session), ['administrator', 'editor']);
    const index = db.categories.findIndex((item) => item.id === id);
    if (index < 0) throw new ApiError(404, 'Category not found', 'CATEGORY_NOT_FOUND');
    if (db.articles.some((article) => article.categoryId === id)) {
      throw new ApiError(409, 'Category is used by one or more articles', 'CATEGORY_IN_USE');
    }
    db.categories.splice(index, 1);
  });
  return json({ ok: true });
}

async function listUsers(request, env) {
  const session = await requireSession(request, env);
  const { db } = await readDatabase(env);
  requireRole(userFromSession(db, session), ['administrator']);
  return json({ users: db.users.map(publicUser).sort((a, b) => a.email.localeCompare(b.email)) });
}

async function saveUser(request, env, id = null) {
  if (id) assertUuid(id);
  const session = await requireSession(request, env);
  const input = await jsonBody(request);
  const email = normalizeEmail(input.email);
  const role = validateRole(input.role);
  const password = input.password ? validatePassword(input.password) : null;
  if (!id && !password) throw new ApiError(400, 'Password is required', 'PASSWORD_REQUIRED');

  const user = await mutateDatabase(env, async (db) => {
    requireRole(userFromSession(db, session), ['administrator']);
    if (db.users.some((item) => item.email === email && item.id !== id)) {
      throw new ApiError(409, 'Email is already in use', 'EMAIL_IN_USE');
    }
    const now = new Date().toISOString();

    if (id) {
      const existing = db.users.find((item) => item.id === id);
      if (!existing) throw new ApiError(404, 'User not found', 'USER_NOT_FOUND');
      if (existing.role === 'administrator' && role !== 'administrator' && adminCount(db) <= 1) {
        throw new ApiError(409, 'The system must always have at least one administrator', 'LAST_ADMIN_REQUIRED');
      }
      existing.email = email;
      existing.role = role;
      existing.updatedAt = now;
      if (password) {
        existing.password = await hashPassword(password);
        existing.sessionNonce = crypto.randomUUID();
      }
      return existing;
    }

    const created = {
      id: crypto.randomUUID(),
      email,
      role,
      password: await hashPassword(password),
      sessionNonce: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    db.users.push(created);
    return created;
  });

  return json({ user: publicUser(user) }, id ? 200 : 201);
}

async function deleteUser(request, env, id) {
  assertUuid(id);
  const session = await requireSession(request, env);
  await mutateDatabase(env, (db) => {
    requireRole(userFromSession(db, session), ['administrator']);
    const index = db.users.findIndex((item) => item.id === id);
    if (index < 0) throw new ApiError(404, 'User not found', 'USER_NOT_FOUND');
    if (db.users[index].role === 'administrator' && adminCount(db) <= 1) {
      throw new ApiError(409, 'The system must always have at least one administrator', 'LAST_ADMIN_REQUIRED');
    }
    db.users.splice(index, 1);
  });
  return json({ ok: true }, 200, session.uid === id ? { 'Set-Cookie': expiredSessionCookie(request) } : {});
}

async function updateSettings(request, env) {
  const session = await requireSession(request, env);
  const input = await jsonBody(request);
  if (!['private', 'public'].includes(input.mode)) throw new ApiError(400, 'Mode must be private or public', 'INVALID_MODE');
  const password = String(input.password ?? '');
  if (!password) throw new ApiError(400, 'Administrator password is required', 'PASSWORD_REQUIRED');

  await mutateDatabase(env, async (db) => {
    const user = userFromSession(db, session);
    requireRole(user, ['administrator']);
    if (!(await verifyPassword(password, user.password))) {
      throw new ApiError(401, 'Incorrect administrator password', 'INVALID_CREDENTIALS');
    }
    if (db.settings.mode === input.mode) throw new ApiError(409, `Portal is already ${input.mode}`, 'MODE_UNCHANGED');
    db.settings.mode = input.mode;
    db.settings.updatedAt = new Date().toISOString();
    db.settings.updatedById = user.id;
  });

  return json({ ok: true, mode: input.mode });
}

function createDatabase() {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    schemaVersion: SCHEMA_VERSION,
    settings: { id: crypto.randomUUID(), mode: 'private', updatedAt: now, updatedById: null },
    users: [],
    categories: [],
    articles: [],
    createdAt: now,
    updatedAt: now,
  };
}

function migrateDatabase(raw) {
  if (!raw || typeof raw !== 'object') throw new ApiError(500, 'Portal data is invalid', 'INVALID_DATABASE');
  const db = structuredClone(raw);
  if (db.schemaVersion === 1) {
    db.categories = [];
    db.articles = Array.isArray(db.articles)
      ? db.articles.map((article) => ({ ...article, categoryId: article.categoryId ?? null }))
      : db.articles;
    db.schemaVersion = 2;
  }
  return db;
}

async function readDatabase(env) {
  try {
    const object = await env.PORTAL_DATA.get(DB_KEY);
    if (!object) return { db: createDatabase(), etag: null };
    const db = migrateDatabase(await object.json());
    validateDatabase(db);
    return { db, etag: object.etag };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    console.error('R2 database read failed', error?.stack || error);
    throw new ApiError(500, 'Portal data could not be read', 'STORAGE_READ_FAILED');
  }
}

async function mutateDatabase(env, mutator) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let object;
    let db;
    try {
      object = await env.PORTAL_DATA.get(DB_KEY);
      db = object ? migrateDatabase(await object.json()) : createDatabase();
      validateDatabase(db);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      console.error('R2 database read failed during mutation', error?.stack || error);
      throw new ApiError(500, 'Portal data could not be read', 'STORAGE_READ_FAILED');
    }

    const result = await mutator(db);
    db.updatedAt = new Date().toISOString();
    const onlyIf = object ? { etagMatches: object.etag } : new Headers({ 'If-None-Match': '*' });

    try {
      const written = await env.PORTAL_DATA.put(DB_KEY, JSON.stringify(db), {
        onlyIf,
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
      });
      if (written) return result;
    } catch (error) {
      console.error('R2 database write failed', error?.stack || error);
      throw new ApiError(500, 'Portal data could not be saved', 'STORAGE_WRITE_FAILED');
    }
  }
  throw new ApiError(409, 'Data changed concurrently. Retry the operation.', 'WRITE_CONFLICT');
}

function validateDatabase(db) {
  if (!db || db.schemaVersion !== SCHEMA_VERSION || !isUuid(db.id)) throw new ApiError(500, 'Portal data is invalid', 'INVALID_DATABASE');
  if (!db.settings || !isUuid(db.settings.id) || !['private', 'public'].includes(db.settings.mode)) {
    throw new ApiError(500, 'Portal settings data is invalid', 'INVALID_DATABASE');
  }
  if (!Array.isArray(db.users) || !Array.isArray(db.categories) || !Array.isArray(db.articles)) {
    throw new ApiError(500, 'Portal collection data is invalid', 'INVALID_DATABASE');
  }

  const categoryIds = new Set();
  for (const user of db.users) {
    if (!isUuid(user.id) || !isUuid(user.sessionNonce) || !ROLES.has(user.role) || typeof user.email !== 'string') {
      throw new ApiError(500, 'Portal user data is invalid', 'INVALID_DATABASE');
    }
  }
  for (const category of db.categories) {
    if (!isUuid(category.id) || typeof category.name !== 'string' || !isUuid(category.createdById) || !isUuid(category.updatedById)) {
      throw new ApiError(500, 'Portal category data is invalid', 'INVALID_DATABASE');
    }
    categoryIds.add(category.id);
  }
  for (const article of db.articles) {
    const categoryValid = article.categoryId === null || article.categoryId === undefined ||
      (isUuid(article.categoryId) && categoryIds.has(article.categoryId));
    if (!isUuid(article.id) || !isUuid(article.authorId) || !isUuid(article.updatedById) ||
        !ARTICLE_STATUSES.has(article.status) || !categoryValid) {
      throw new ApiError(500, 'Portal article data is invalid', 'INVALID_DATABASE');
    }
  }
}

function adminCount(db) { return db.users.filter((user) => user.role === 'administrator').length; }
function userFromSession(db, session) {
  const user = db.users.find((item) => item.id === session.uid);
  return user && user.sessionNonce === session.nonce ? user : null;
}
function requireRole(user, allowedRoles) {
  if (!user) throw new ApiError(401, 'Authentication required', 'AUTH_REQUIRED');
  if (!allowedRoles.includes(user.role)) throw new ApiError(403, 'Insufficient permissions', 'FORBIDDEN');
  return user;
}
function publicUser(user) {
  return { id: user.id, email: user.email, role: user.role, createdAt: user.createdAt, updatedAt: user.updatedAt };
}

async function createSessionToken(user, env) {
  const payload = base64UrlEncode(encoder.encode(JSON.stringify({
    uid: user.id,
    nonce: user.sessionNonce,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  })));
  return `${payload}.${await signHmac(payload, env.SESSION_SECRET)}`;
}

async function readSession(request, env) {
  const raw = readCookie(request.headers.get('Cookie') || '', SESSION_COOKIE);
  if (!raw) throw new ApiError(401, 'Authentication required', 'AUTH_REQUIRED');
  const segments = raw.split('.');
  if (segments.length !== 2) throw new ApiError(401, 'Invalid session', 'INVALID_SESSION');
  const [payload, signature] = segments;
  if (!(await verifyHmac(payload, signature, env.SESSION_SECRET))) throw new ApiError(401, 'Invalid session', 'INVALID_SESSION');

  let session;
  try { session = JSON.parse(decoder.decode(base64UrlDecode(payload))); }
  catch { throw new ApiError(401, 'Invalid session', 'INVALID_SESSION'); }

  if (!isUuid(session.uid) || !isUuid(session.nonce) || !Number.isFinite(session.exp) || session.exp <= Date.now() / 1000) {
    throw new ApiError(401, 'Session expired', 'INVALID_SESSION');
  }
  return session;
}

async function requireSession(request, env) { return readSession(request, env); }

async function signHmac(value, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64UrlEncode(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}

async function verifyHmac(value, signature, secret) {
  let decodedSignature;
  try { decodedSignature = base64UrlDecode(signature); } catch { return false; }
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, decodedSignature, encoder.encode(value));
}

async function derivePasswordHash(password, salt, iterations, lengthBits = 256) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    lengthBits,
  ));
}

async function hashPassword(password) {
  try {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await derivePasswordHash(password, salt, PBKDF2_ITERATIONS, 256);
    return {
      algorithm: 'PBKDF2-SHA-256',
      iterations: PBKDF2_ITERATIONS,
      salt: base64UrlEncode(salt),
      hash: base64UrlEncode(hash),
    };
  } catch (error) {
    console.error('Password hashing failed', error?.stack || error);
    throw new ApiError(500, 'Authentication service failed', 'PASSWORD_HASH_FAILED');
  }
}

async function verifyPassword(password, record) {
  if (!record || record.algorithm !== 'PBKDF2-SHA-256' || !Number.isInteger(record.iterations) ||
      record.iterations < 1 || typeof record.salt !== 'string' || typeof record.hash !== 'string') return false;
  try {
    const salt = base64DecodeFlexible(record.salt);
    const expected = base64DecodeFlexible(record.hash);
    if (!salt.length || !expected.length) return false;
    const actual = await derivePasswordHash(password, salt, record.iterations, expected.length * 8);
    if (actual.length !== expected.length) return false;
    let difference = 0;
    for (let i = 0; i < actual.length; i += 1) difference |= actual[i] ^ expected[i];
    return difference === 0;
  } catch (error) {
    console.error('Password verification failed', error?.stack || error);
    return false;
  }
}

async function jsonBody(request) {
  if (!(request.headers.get('Content-Type') || '').toLowerCase().includes('application/json')) {
    throw new ApiError(415, 'Content-Type must be application/json', 'UNSUPPORTED_MEDIA_TYPE');
  }
  try { return await request.json(); }
  catch { throw new ApiError(400, 'Invalid JSON body', 'INVALID_JSON'); }
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new ApiError(400, 'Valid email is required', 'INVALID_EMAIL');
  }
  return email;
}
function validatePassword(value) {
  const password = String(value ?? '');
  if (password.length < 10 || password.length > 200) {
    throw new ApiError(400, 'Password must be between 10 and 200 characters', 'INVALID_PASSWORD');
  }
  return password;
}
function validateRole(value) {
  if (!ROLES.has(value)) throw new ApiError(400, 'Invalid role', 'INVALID_ROLE');
  return value;
}
function validateCategory(input) {
  const name = String(input.name || '').trim();
  if (!name || name.length > 80) {
    throw new ApiError(400, 'Category name is required and must be at most 80 characters', 'INVALID_CATEGORY_NAME');
  }
  return { name };
}
function validateArticle(input, db) {
  const title = String(input.title || '').trim();
  const summary = String(input.summary || '').trim();
  const content = String(input.content || '').trim();
  const status = String(input.status || 'draft');
  const categoryId = String(input.categoryId || '');
  if (!title || title.length > 200) throw new ApiError(400, 'Title is required and must be at most 200 characters', 'INVALID_TITLE');
  if (summary.length > 600) throw new ApiError(400, 'Summary must be at most 600 characters', 'INVALID_SUMMARY');
  if (!content || content.length > 1_000_000) throw new ApiError(400, 'Article content is required and must be at most 1 MB', 'INVALID_CONTENT');
  if (!ARTICLE_STATUSES.has(status)) throw new ApiError(400, 'Invalid article status', 'INVALID_ARTICLE_STATUS');
  if (!isUuid(categoryId) || !db.categories.some((category) => category.id === categoryId)) {
    throw new ApiError(400, 'A valid article category is required', 'INVALID_CATEGORY');
  }
  return { title, summary, content, status, categoryId };
}

function assertUuid(value) {
  if (!isUuid(value)) throw new ApiError(400, 'Invalid UUID', 'INVALID_UUID');
}
function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function readCookie(header, name) {
  for (const item of header.split(';')) {
    const [key, ...parts] = item.trim().split('=');
    if (key === name) return parts.join('=');
  }
  return null;
}
function sessionCookie(request, value) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
}
function expiredSessionCookie(request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function base64DecodeFlexible(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/_=-]*$/.test(value)) throw new Error('Invalid base64');
  let normalized = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/g, '');
  normalized += '='.repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
}
function base64UrlDecode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('Invalid base64url');
  let normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  normalized += '='.repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
}
function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}
