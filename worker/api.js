const LEGACY_DB_KEY = 'db/information-portal.json';
const STORE_KEYS = {
  users: 'db/users.json',
  articles: 'db/articles.json',
  categories: 'db/article-categories.json',
  settings: 'db/settings.json',
};
const ARTICLE_IMAGE_PREFIX = 'article-images/';
const MAX_ARTICLE_IMAGE_BYTES = 5 * 1024 * 1024;
const ARTICLE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const SESSION_COOKIE = 'portal_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const PBKDF2_ITERATIONS = 210000;
const STORE_SCHEMA_VERSION = 1;
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

    if (parts[0] === 'article-images') {
      if (method === 'POST' && parts.length === 1) return await uploadArticleImage(request, env);
      if (method === 'GET' && parts.length === 2) return await getArticleImage(request, env, parts[1]);
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
  const [{ data: usersStore }, { data: settings }] = await Promise.all([
    readStore(env, 'users'),
    readStore(env, 'settings'),
  ]);
  const session = await readSession(request, env).catch(() => null);
  const user = session ? userFromSession(usersStore.users, session) : null;
  return json({
    setupRequired: adminCount(usersStore.users) === 0,
    setupTokenRequired: Boolean(env.BOOTSTRAP_TOKEN),
    mode: settings.mode,
    user: user ? publicUser(user) : null,
    adminCount: adminCount(usersStore.users),
  });
}

async function setup(request, env) {
  const input = await jsonBody(request);
  const email = normalizeEmail(input.email);
  const password = validatePassword(input.password);
  if (env.BOOTSTRAP_TOKEN && input.bootstrapToken !== env.BOOTSTRAP_TOKEN) {
    throw new ApiError(403, 'Invalid setup token', 'INVALID_SETUP_TOKEN');
  }

  const user = await mutateStore(env, 'users', async (store) => {
    if (adminCount(store.users) !== 0) throw new ApiError(409, 'Initial setup has already been completed', 'SETUP_COMPLETE');
    const now = new Date().toISOString();
    const created = {
      id: crypto.randomUUID(),
      email,
      role: 'administrator',
      password: await hashPassword(password),
      sessionNonce: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    store.users.push(created);
    return created;
  });

  const sessionToken = await createSessionToken(user, env);
  return json({ user: publicUser(user) }, 201, { 'Set-Cookie': sessionCookie(request, sessionToken) });
}

async function login(request, env) {
  const input = await jsonBody(request);
  const email = normalizeEmail(input.email);
  const password = String(input.password ?? '');
  const { data: usersStore } = await readStore(env, 'users');
  const user = usersStore.users.find((item) => item.email === email);
  if (!user || !(await verifyPassword(password, user.password))) {
    throw new ApiError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');
  }
  const sessionToken = await createSessionToken(user, env);
  return json({ user: publicUser(user) }, 200, { 'Set-Cookie': sessionCookie(request, sessionToken) });
}

async function uploadArticleImage(request, env) {
  await authenticate(request, env, ['administrator', 'editor']);
  const contentType = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!ARTICLE_IMAGE_TYPES.has(contentType)) {
    throw new ApiError(415, 'Supported image types are JPEG, PNG, WebP, GIF and AVIF', 'INVALID_IMAGE_TYPE');
  }

  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (declaredLength > MAX_ARTICLE_IMAGE_BYTES) {
    throw new ApiError(413, 'Article image must be at most 5 MB', 'IMAGE_TOO_LARGE');
  }

  const body = await request.arrayBuffer();
  if (!body.byteLength || body.byteLength > MAX_ARTICLE_IMAGE_BYTES) {
    throw new ApiError(413, 'Article image must be between 1 byte and 5 MB', 'IMAGE_TOO_LARGE');
  }

  const id = crypto.randomUUID();
  try {
    await env.PORTAL_DATA.put(`${ARTICLE_IMAGE_PREFIX}${id}`, body, {
      httpMetadata: { contentType },
      customMetadata: { uploadedAt: new Date().toISOString() },
    });
  } catch (error) {
    console.error('R2 article image write failed', error?.stack || error);
    throw new ApiError(500, 'Article image could not be saved', 'IMAGE_STORAGE_FAILED');
  }

  return json({ image: { id, url: `/api/article-images/${id}` } }, 201);
}

async function getArticleImage(request, env, id) {
  assertUuid(id);
  const { data: settings } = await readStore(env, 'settings');
  if (settings.mode === 'private') await authenticate(request, env, ['administrator', 'editor', 'reader']);

  let object;
  try {
    object = await env.PORTAL_DATA.get(`${ARTICLE_IMAGE_PREFIX}${id}`);
  } catch (error) {
    console.error('R2 article image read failed', error?.stack || error);
    throw new ApiError(500, 'Article image could not be read', 'IMAGE_STORAGE_FAILED');
  }
  if (!object) throw new ApiError(404, 'Article image not found', 'IMAGE_NOT_FOUND');

  const headers = new Headers({
    'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
    'Cache-Control': settings.mode === 'public' ? 'public, max-age=3600' : 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (object.etag) headers.set('ETag', object.etag);
  return new Response(object.body, { status: 200, headers });
}

async function listArticles(request, env, manage) {
  if (manage) {
    await authenticate(request, env, ['administrator', 'editor']);
    const { data: articleStore } = await readStore(env, 'articles');
    return json({ articles: sortArticles(articleStore.articles) });
  }

  const { data: settings } = await readStore(env, 'settings');
  if (settings.mode === 'private') await authenticate(request, env, ['administrator', 'editor', 'reader']);
  const { data: articleStore } = await readStore(env, 'articles');
  return json({ articles: sortArticles(articleStore.articles.filter((article) => article.status === 'published')) });
}

async function getArticle(request, env, id) {
  assertUuid(id);
  const { data: articleStore } = await readStore(env, 'articles');
  const article = articleStore.articles.find((item) => item.id === id);
  if (!article) throw new ApiError(404, 'Article not found', 'ARTICLE_NOT_FOUND');

  if (article.status === 'draft') {
    await authenticate(request, env, ['administrator', 'editor']);
  } else {
    const { data: settings } = await readStore(env, 'settings');
    if (settings.mode === 'private') await authenticate(request, env, ['administrator', 'editor', 'reader']);
  }
  return json({ article });
}

async function saveArticle(request, env, id = null) {
  if (id) assertUuid(id);
  const { user } = await authenticate(request, env, ['administrator', 'editor']);
  const body = await jsonBody(request);
  const { data: categoryStore } = await readStore(env, 'categories');
  const input = validateArticle(body, categoryStore.categories);

  const article = await mutateStore(env, 'articles', (store) => {
    const now = new Date().toISOString();
    if (id) {
      const existing = store.articles.find((item) => item.id === id);
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
    store.articles.push(created);
    return created;
  });

  return json({ article }, id ? 200 : 201);
}

async function deleteArticle(request, env, id) {
  assertUuid(id);
  await authenticate(request, env, ['administrator', 'editor']);
  await mutateStore(env, 'articles', (store) => {
    const index = store.articles.findIndex((item) => item.id === id);
    if (index < 0) throw new ApiError(404, 'Article not found', 'ARTICLE_NOT_FOUND');
    store.articles.splice(index, 1);
  });
  return json({ ok: true });
}

async function listCategories(request, env, manage) {
  if (manage) {
    await authenticate(request, env, ['administrator', 'editor']);
    const { data: categoryStore } = await readStore(env, 'categories');
    return json({ categories: sortCategories(categoryStore.categories) });
  }

  const { data: settings } = await readStore(env, 'settings');
  if (settings.mode === 'private') await authenticate(request, env, ['administrator', 'editor', 'reader']);
  const { data: categoryStore } = await readStore(env, 'categories');
  return json({ categories: sortCategories(categoryStore.categories) });
}

async function saveCategory(request, env, id = null) {
  if (id) assertUuid(id);
  const { user } = await authenticate(request, env, ['administrator', 'editor']);
  const input = validateCategory(await jsonBody(request));

  const category = await mutateStore(env, 'categories', (store) => {
    if (store.categories.some((item) => item.name.toLocaleLowerCase() === input.name.toLocaleLowerCase() && item.id !== id)) {
      throw new ApiError(409, 'Category name is already in use', 'CATEGORY_NAME_IN_USE');
    }
    const now = new Date().toISOString();
    if (id) {
      const existing = store.categories.find((item) => item.id === id);
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
    store.categories.push(created);
    return created;
  });

  return json({ category }, id ? 200 : 201);
}

async function deleteCategory(request, env, id) {
  assertUuid(id);
  await authenticate(request, env, ['administrator', 'editor']);
  const { data: articleStore } = await readStore(env, 'articles');
  if (articleStore.articles.some((article) => article.categoryId === id)) {
    throw new ApiError(409, 'Category is used by one or more articles', 'CATEGORY_IN_USE');
  }
  await mutateStore(env, 'categories', (store) => {
    const index = store.categories.findIndex((item) => item.id === id);
    if (index < 0) throw new ApiError(404, 'Category not found', 'CATEGORY_NOT_FOUND');
    store.categories.splice(index, 1);
  });
  return json({ ok: true });
}

async function listUsers(request, env) {
  const { usersStore } = await authenticate(request, env, ['administrator']);
  return json({ users: usersStore.users.map(publicUser).sort((a, b) => a.email.localeCompare(b.email)) });
}

async function saveUser(request, env, id = null) {
  if (id) assertUuid(id);
  const { session } = await authenticate(request, env, ['administrator']);
  const input = await jsonBody(request);
  const email = normalizeEmail(input.email);
  const role = validateRole(input.role);
  const password = input.password ? validatePassword(input.password) : null;
  if (!id && !password) throw new ApiError(400, 'Password is required', 'PASSWORD_REQUIRED');

  const user = await mutateStore(env, 'users', async (store) => {
    const actor = userFromSession(store.users, session);
    requireRole(actor, ['administrator']);
    if (store.users.some((item) => item.email === email && item.id !== id)) {
      throw new ApiError(409, 'Email is already in use', 'EMAIL_IN_USE');
    }
    const now = new Date().toISOString();

    if (id) {
      const existing = store.users.find((item) => item.id === id);
      if (!existing) throw new ApiError(404, 'User not found', 'USER_NOT_FOUND');
      if (existing.role === 'administrator' && role !== 'administrator' && adminCount(store.users) <= 1) {
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
    store.users.push(created);
    return created;
  });

  return json({ user: publicUser(user) }, id ? 200 : 201);
}

async function deleteUser(request, env, id) {
  assertUuid(id);
  const { session } = await authenticate(request, env, ['administrator']);
  await mutateStore(env, 'users', (store) => {
    const actor = userFromSession(store.users, session);
    requireRole(actor, ['administrator']);
    const index = store.users.findIndex((item) => item.id === id);
    if (index < 0) throw new ApiError(404, 'User not found', 'USER_NOT_FOUND');
    if (store.users[index].role === 'administrator' && adminCount(store.users) <= 1) {
      throw new ApiError(409, 'The system must always have at least one administrator', 'LAST_ADMIN_REQUIRED');
    }
    store.users.splice(index, 1);
  });
  return json({ ok: true }, 200, session.uid === id ? { 'Set-Cookie': expiredSessionCookie(request) } : {});
}

async function updateSettings(request, env) {
  const { user } = await authenticate(request, env, ['administrator']);
  const input = await jsonBody(request);
  if (!['private', 'public'].includes(input.mode)) throw new ApiError(400, 'Mode must be private or public', 'INVALID_MODE');
  const password = String(input.password ?? '');
  if (!password) throw new ApiError(400, 'Administrator password is required', 'PASSWORD_REQUIRED');
  if (!(await verifyPassword(password, user.password))) {
    throw new ApiError(401, 'Incorrect administrator password', 'INVALID_CREDENTIALS');
  }

  await mutateStore(env, 'settings', (settings) => {
    if (settings.mode === input.mode) throw new ApiError(409, `Portal is already ${input.mode}`, 'MODE_UNCHANGED');
    settings.mode = input.mode;
    settings.updatedAt = new Date().toISOString();
    settings.updatedById = user.id;
  });
  return json({ ok: true, mode: input.mode });
}

async function authenticate(request, env, allowedRoles) {
  const session = await requireSession(request, env);
  const { data: usersStore } = await readStore(env, 'users');
  const user = userFromSession(usersStore.users, session);
  requireRole(user, allowedRoles);
  return { session, user, usersStore };
}

function createStore(name) {
  const now = new Date().toISOString();
  if (name === 'users') return { id: crypto.randomUUID(), schemaVersion: STORE_SCHEMA_VERSION, users: [], createdAt: now, updatedAt: now };
  if (name === 'articles') return { id: crypto.randomUUID(), schemaVersion: STORE_SCHEMA_VERSION, articles: [], createdAt: now, updatedAt: now };
  if (name === 'categories') return { id: crypto.randomUUID(), schemaVersion: STORE_SCHEMA_VERSION, categories: [], createdAt: now, updatedAt: now };
  if (name === 'settings') return { id: crypto.randomUUID(), schemaVersion: STORE_SCHEMA_VERSION, mode: 'private', updatedAt: now, updatedById: null };
  throw new Error('Unknown store');
}

function storeFromLegacy(name, legacy) {
  if (!legacy || typeof legacy !== 'object') return createStore(name);
  const now = new Date().toISOString();
  const createdAt = legacy.createdAt || now;

  if (name === 'users') {
    return {
      id: crypto.randomUUID(),
      schemaVersion: 1,
      users: Array.isArray(legacy.users) ? structuredClone(legacy.users) : [],
      createdAt,
      updatedAt: legacy.updatedAt || now,
    };
  }

  if (name === 'articles') {
    const articles = Array.isArray(legacy.articles)
      ? legacy.articles.map((article) => ({ ...structuredClone(article), categoryId: article.categoryId ?? null }))
      : [];
    return { id: crypto.randomUUID(), schemaVersion: 1, articles, createdAt, updatedAt: legacy.updatedAt || now };
  }

  if (name === 'categories') {
    return {
      id: crypto.randomUUID(),
      schemaVersion: 1,
      categories: Array.isArray(legacy.categories) ? structuredClone(legacy.categories) : [],
      createdAt,
      updatedAt: legacy.updatedAt || now,
    };
  }

  if (name === 'settings') {
    return {
      id: isUuid(legacy.settings?.id) ? legacy.settings.id : crypto.randomUUID(),
      schemaVersion: 1,
      mode: ['private', 'public'].includes(legacy.settings?.mode) ? legacy.settings.mode : 'private',
      updatedAt: legacy.settings?.updatedAt || legacy.updatedAt || now,
      updatedById: legacy.settings?.updatedById ?? null,
    };
  }

  throw new Error('Unknown store');
}

async function readStore(env, name) {
  const key = STORE_KEYS[name];
  try {
    let object = await env.PORTAL_DATA.get(key);
    if (object) {
      const data = await object.json();
      validateStore(name, data);
      return { data, etag: object.etag };
    }

    const legacyObject = await env.PORTAL_DATA.get(LEGACY_DB_KEY);
    const data = legacyObject ? storeFromLegacy(name, await legacyObject.json()) : createStore(name);
    validateStore(name, data);

    const created = await env.PORTAL_DATA.put(key, JSON.stringify(data), {
      onlyIf: new Headers({ 'If-None-Match': '*' }),
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });

    if (created) return { data, etag: created.etag };

    object = await env.PORTAL_DATA.get(key);
    if (!object) throw new Error('Store creation race could not be resolved');
    const winner = await object.json();
    validateStore(name, winner);
    return { data: winner, etag: object.etag };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    console.error(`R2 ${name} store read failed`, error?.stack || error);
    throw new ApiError(500, `Portal ${name} data could not be read`, 'STORAGE_READ_FAILED');
  }
}

async function mutateStore(env, name, mutator) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { data, etag } = await readStore(env, name);
    const result = await mutator(data);
    if ('updatedAt' in data) data.updatedAt = new Date().toISOString();

    try {
      const written = await env.PORTAL_DATA.put(STORE_KEYS[name], JSON.stringify(data), {
        onlyIf: { etagMatches: etag },
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
      });
      if (written) return result;
    } catch (error) {
      console.error(`R2 ${name} store write failed`, error?.stack || error);
      throw new ApiError(500, `Portal ${name} data could not be saved`, 'STORAGE_WRITE_FAILED');
    }
  }
  throw new ApiError(409, 'Data changed concurrently. Retry the operation.', 'WRITE_CONFLICT');
}

function validateStore(name, data) {
  if (!data || data.schemaVersion !== STORE_SCHEMA_VERSION || !isUuid(data.id)) {
    throw new ApiError(500, `Portal ${name} data is invalid`, 'INVALID_DATABASE');
  }

  if (name === 'users') {
    if (!Array.isArray(data.users)) throw new ApiError(500, 'Portal users data is invalid', 'INVALID_DATABASE');
    for (const user of data.users) {
      if (!isUuid(user.id) || !isUuid(user.sessionNonce) || !ROLES.has(user.role) || typeof user.email !== 'string') {
        throw new ApiError(500, 'Portal users data is invalid', 'INVALID_DATABASE');
      }
    }
  } else if (name === 'articles') {
    if (!Array.isArray(data.articles)) throw new ApiError(500, 'Portal articles data is invalid', 'INVALID_DATABASE');
    for (const article of data.articles) {
      const categoryValid = article.categoryId == null || isUuid(article.categoryId);
      if (!isUuid(article.id) || !isUuid(article.authorId) || !isUuid(article.updatedById) ||
          !ARTICLE_STATUSES.has(article.status) || !categoryValid) {
        throw new ApiError(500, 'Portal articles data is invalid', 'INVALID_DATABASE');
      }
    }
  } else if (name === 'categories') {
    if (!Array.isArray(data.categories)) throw new ApiError(500, 'Portal categories data is invalid', 'INVALID_DATABASE');
    for (const category of data.categories) {
      if (!isUuid(category.id) || typeof category.name !== 'string' || !isUuid(category.createdById) || !isUuid(category.updatedById)) {
        throw new ApiError(500, 'Portal categories data is invalid', 'INVALID_DATABASE');
      }
    }
  } else if (name === 'settings') {
    if (!['private', 'public'].includes(data.mode)) throw new ApiError(500, 'Portal settings data is invalid', 'INVALID_DATABASE');
    if (data.updatedById !== null && data.updatedById !== undefined && !isUuid(data.updatedById)) {
      throw new ApiError(500, 'Portal settings data is invalid', 'INVALID_DATABASE');
    }
  }
}

function sortArticles(articles) { return [...articles].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
function sortCategories(categories) { return [...categories].sort((a, b) => a.name.localeCompare(b.name)); }
function adminCount(users) { return users.filter((user) => user.role === 'administrator').length; }
function userFromSession(users, session) {
  const user = users.find((item) => item.id === session.uid);
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
function validateArticle(input, categories) {
  const title = String(input.title || '').trim();
  const summary = String(input.summary || '').trim();
  const content = String(input.content || '').trim();
  const status = String(input.status || 'draft');
  const categoryId = String(input.categoryId || '');
  if (!title || title.length > 200) throw new ApiError(400, 'Title is required and must be at most 200 characters', 'INVALID_TITLE');
  if (summary.length > 600) throw new ApiError(400, 'Summary must be at most 600 characters', 'INVALID_SUMMARY');
  if (!content || content.length > 1_000_000) throw new ApiError(400, 'Article content is required and must be at most 1 MB', 'INVALID_CONTENT');
  validateInlineImageTokens(content);
  if (!ARTICLE_STATUSES.has(status)) throw new ApiError(400, 'Invalid article status', 'INVALID_ARTICLE_STATUS');
  if (!isUuid(categoryId) || !categories.some((category) => category.id === categoryId)) {
    throw new ApiError(400, 'A valid article category is required', 'INVALID_CATEGORY');
  }
  return { title, summary, content, status, categoryId };
}

function validateInlineImageTokens(content) {
  const tokenStart = '[[image:';
  if (!content.includes(tokenStart)) return;
  const validToken = /\[\[image:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\|(25|50|75|100)\]\]/gi;
  const remaining = content.replace(validToken, '');
  if (remaining.includes(tokenStart)) {
    throw new ApiError(400, 'Article contains an invalid inline image token', 'INVALID_IMAGE_TOKEN');
  }
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
