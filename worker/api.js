const LEGACY_DB_KEY = 'db/information-portal.json';
const STORE_KEYS = {
  users: 'db/users.json',
  articles: 'db/articles.json',
  initialArticles: 'db/articles-initial.json',
  categories: 'db/article-categories.json',
  settings: 'db/settings.json',
  logbook: 'db/logbook.json',
  announcements: 'db/announcements.json',
  comments: 'db/comments.json',
};
const ARTICLE_IMAGE_PREFIX = 'article-images/';
const MAX_ARTICLE_IMAGE_BYTES = 5 * 1024 * 1024;
const ARTICLE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const SESSION_COOKIE = 'portal_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const PBKDF2_ITERATIONS = 60000;
const STORE_SCHEMA_VERSION = 1;
const DEFAULT_PORTAL_NAME = 'Information Portal';
const DEFAULT_INITIAL_ARTICLES = 12;
const DEFAULT_HERO_EYEBROW = 'Team knowledge';
const DEFAULT_HERO_TITLE = 'Information that stays easy to find.';
const DEFAULT_HERO_DESCRIPTION = 'Published procedures, references, notes and updates in one lean portal.';
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

export async function handleApiRequest(request, env, ctx) {
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

    if (method === 'GET' && parts[0] === 'content' && parts.length === 1) {
      return await getContent(
        request,
        env,
        url.searchParams.get('manage') === '1',
        url.searchParams.get('initial') === '1',
      );
    }

    if (parts[0] === 'article-images') {
      if (method === 'GET' && parts.length === 1) return await listArticleImages(request, env);
      if (method === 'POST' && parts.length === 1) return await uploadArticleImage(request, env);
      if (method === 'GET' && parts.length === 2) return await getArticleImage(request, env, decodePathComponent(parts[1]));
    }

    if (parts[0] === 'articles') {
      if (method === 'GET' && parts.length === 1) return await listArticles(request, env, url.searchParams.get('manage') === '1');
      if (method === 'POST' && parts.length === 3 && parts[2] === 'comments') return await addArticleComment(request, env, parts[1]);
      if (method === 'PUT' && parts.length === 4 && parts[2] === 'comments') return await updateArticleComment(request, env, parts[1], parts[3]);
      if (method === 'DELETE' && parts.length === 4 && parts[2] === 'comments') return await deleteArticleComment(request, env, parts[1], parts[3]);
      if (method === 'GET' && parts.length === 2) return await getArticle(request, env, parts[1]);
      if (method === 'POST' && parts.length === 1) return await saveArticle(request, env, ctx);
      if (method === 'PUT' && parts.length === 2) return await saveArticle(request, env, ctx, parts[1]);
      if (method === 'DELETE' && parts.length === 2) return await deleteArticle(request, env, ctx, parts[1]);
    }

    if (parts[0] === 'categories') {
      if (method === 'GET' && parts.length === 1) return await listCategories(request, env, url.searchParams.get('manage') === '1');
      if (method === 'POST' && parts.length === 1) return await saveCategory(request, env, ctx);
      if (method === 'PUT' && parts.length === 2) return await saveCategory(request, env, ctx, parts[1]);
      if (method === 'DELETE' && parts.length === 2) return await deleteCategory(request, env, ctx, parts[1]);
    }

    if (parts[0] === 'announcements') {
      if (method === 'GET' && parts.length === 1) return await listAnnouncements(request, env, url.searchParams.get('manage') === '1');
      if (method === 'POST' && parts.length === 1) return await saveAnnouncement(request, env);
      if (method === 'PUT' && parts.length === 2) return await saveAnnouncement(request, env, parts[1]);
      if (method === 'DELETE' && parts.length === 2) return await deleteAnnouncement(request, env, parts[1]);
    }

    if (method === 'GET' && parts[0] === 'admin' && parts[1] === 'logbook' && parts.length === 2) {
      return await listLogbook(request, env);
    }

    if (parts[0] === 'admin' && parts[1] === 'users') {
      if (method === 'GET' && parts.length === 2) return await listUsers(request, env);
      if (method === 'POST' && parts.length === 2) return await saveUser(request, env, ctx);
      if (method === 'PUT' && parts.length === 3) return await saveUser(request, env, ctx, parts[2]);
      if (method === 'DELETE' && parts.length === 3) return await deleteUser(request, env, ctx, parts[2]);
    }

    if (method === 'PATCH' && parts[0] === 'admin' && parts[1] === 'settings' && parts.length === 2) {
      return await updateSettings(request, env, ctx);
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
    portalName: portalName(settings),
    initialArticles: initialArticlesCount(settings),
    heroEyebrow: heroEyebrow(settings),
    heroTitle: heroTitle(settings),
    heroDescription: heroDescription(settings),
    user: user ? publicUser(user) : null,
    adminCount: adminCount(usersStore.users),
  });
}

async function setup(request, env) {
  const input = await jsonBody(request);
  const email = normalizeEmail(input.email);
  const fullName = input.fullName == null ? email : validateFullName(input.fullName);
  const password = validatePassword(input.password);
  if (env.BOOTSTRAP_TOKEN && input.bootstrapToken !== env.BOOTSTRAP_TOKEN) {
    throw new ApiError(403, 'Invalid setup token', 'INVALID_SETUP_TOKEN');
  }

  const user = await mutateStore(env, 'users', async (store) => {
    if (adminCount(store.users) !== 0) throw new ApiError(409, 'Initial setup has already been completed', 'SETUP_COMPLETE');
    const now = new Date().toISOString();
    const created = {
      id: crypto.randomUUID(),
      fullName,
      email,
      role: 'administrator',
      canComment: true,
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

async function listArticleImages(request, env) {
  await authenticate(request, env, ['administrator', 'editor']);
  if (typeof env.PORTAL_DATA.list !== 'function') {
    throw new ApiError(500, 'Portal media storage cannot be listed', 'STORAGE_NOT_CONFIGURED');
  }

  try {
    const objects = [];
    let cursor;

    do {
      const page = await env.PORTAL_DATA.list({
        prefix: ARTICLE_IMAGE_PREFIX,
        include: ['httpMetadata', 'customMetadata'],
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      objects.push(...(page.objects || []));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);

    const images = objects
      .map((object) => {
        const filename = object.key.slice(ARTICLE_IMAGE_PREFIX.length);
        if (!filename || isUuid(filename)) return null;
        try {
          validateArticleImageReference(filename);
        } catch {
          return null;
        }
        return {
          filename,
          url: `/api/article-images/${encodeURIComponent(filename)}`,
          size: object.size ?? null,
          uploadedAt: object.customMetadata?.uploadedAt || object.uploaded?.toISOString?.() || null,
          contentType: object.httpMetadata?.contentType || null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.filename.localeCompare(b.filename));

    return json({ images });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    console.error('R2 article image list failed', error?.stack || error);
    throw new ApiError(500, 'Article media library could not be loaded', 'IMAGE_STORAGE_FAILED');
  }
}

async function uploadArticleImage(request, env) {
  await authenticate(request, env, ['administrator', 'editor']);
  const contentType = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!ARTICLE_IMAGE_TYPES.has(contentType)) {
    throw new ApiError(415, 'Supported image types are JPEG, PNG, WebP, GIF and AVIF', 'INVALID_IMAGE_TYPE');
  }

  const filename = validateArticleImageFilename(request.headers.get('X-Article-Image-Filename'), contentType);
  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (declaredLength > MAX_ARTICLE_IMAGE_BYTES) {
    throw new ApiError(413, 'Article image must be at most 5 MB', 'IMAGE_TOO_LARGE');
  }

  const body = await request.arrayBuffer();
  if (!body.byteLength || body.byteLength > MAX_ARTICLE_IMAGE_BYTES) {
    throw new ApiError(413, 'Article image must be between 1 byte and 5 MB', 'IMAGE_TOO_LARGE');
  }

  try {
    const written = await env.PORTAL_DATA.put(`${ARTICLE_IMAGE_PREFIX}${filename}`, body, {
      onlyIf: new Headers({ 'If-None-Match': '*' }),
      httpMetadata: { contentType },
      customMetadata: { uploadedAt: new Date().toISOString(), filename },
    });
    if (!written) {
      throw new ApiError(409, 'An article image with this filename already exists', 'IMAGE_FILENAME_IN_USE');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    console.error('R2 article image write failed', error?.stack || error);
    throw new ApiError(500, 'Article image could not be saved', 'IMAGE_STORAGE_FAILED');
  }

  return json({
    image: {
      filename,
      url: `/api/article-images/${encodeURIComponent(filename)}`,
    },
  }, 201);
}

async function getArticleImage(request, env, reference) {
  const filename = validateArticleImageReference(reference);
  const { data: settings } = await readStore(env, 'settings');
  if (settings.mode === 'private') await authenticate(request, env, ['administrator', 'editor', 'reader']);

  let object;
  try {
    object = await env.PORTAL_DATA.get(`${ARTICLE_IMAGE_PREFIX}${filename}`);
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

async function getContent(request, env, manage, initial = false) {
  const { data: settings } = await readStore(env, 'settings');
  let user = null;

  if (manage) {
    ({ user } = await authenticate(request, env, ['administrator', 'editor']));
  } else if (settings.mode === 'private') {
    ({ user } = await authenticate(request, env, ['administrator', 'editor', 'reader']));
  }

  const articleRead = manage || !initial
    ? readStore(env, 'articles')
    : readInitialArticlesStore(env);

  const storeReads = [
    articleRead,
    readStore(env, 'categories'),
    readStore(env, 'announcements'),
  ];
  if (!manage && settings.mode === 'private') storeReads.push(readStore(env, 'comments'));

  const stores = await Promise.all(storeReads);
  const articleStore = stores[0].data;
  const categoryStore = stores[1].data;
  const announcementStore = stores[2].data;
  const commentStore = stores[3]?.data;

  const visibleCategories = categoryStore.categories.filter((category) => !category.hidden);
  const eligibleArticles = manage
    ? articleStore.articles
    : articleStore.articles.filter((article) =>
        article.status === 'published' && articleHasVisibleCategory(article, categoryStore.categories));
  const articles = (manage ? sortArticles(eligibleArticles) : sortArticlesByCreatedAt(eligibleArticles))
    .map((article) => manage ? publicArticle(article) : portalArticle(article, categoryStore.categories));

  const now = Date.now();
  const announcements = sortAnnouncements(
    manage
      ? announcementStore.announcements
      : announcementStore.announcements.filter((announcement) => isAnnouncementActive(announcement, now)),
  );

  const visibleArticleIds = new Set(articles.map((article) => article.id));
  const comments = settings.mode === 'private' && !manage
    ? sortComments((commentStore?.comments || []).filter((comment) => visibleArticleIds.has(comment.articleId)))
    : [];

  return json({
    mode: settings.mode,
    portalName: portalName(settings),
    initialArticles: initialArticlesCount(settings),
    heroEyebrow: heroEyebrow(settings),
    heroTitle: heroTitle(settings),
    heroDescription: heroDescription(settings),
    articlesComplete: manage || !initial,
    user: user ? publicUser(user) : null,
    articles,
    categories: sortCategories(manage ? categoryStore.categories : visibleCategories),
    announcements,
    comments,
  });
}

async function listAnnouncements(request, env, manage) {
  if (manage) {
    await authenticate(request, env, ['administrator', 'editor']);
    const { data: store } = await readStore(env, 'announcements');
    return json({ announcements: sortAnnouncements(store.announcements) });
  }

  const { data: settings } = await readStore(env, 'settings');
  if (settings.mode === 'private') await authenticate(request, env, ['administrator', 'editor', 'reader']);
  const { data: store } = await readStore(env, 'announcements');
  const now = Date.now();
  return json({ announcements: sortAnnouncements(store.announcements.filter((announcement) => isAnnouncementActive(announcement, now))) });
}

async function saveAnnouncement(request, env, id = null) {
  if (id) assertUuid(id);
  const { user } = await authenticate(request, env, ['administrator', 'editor']);
  const input = validateAnnouncement(await jsonBody(request));

  const announcement = await mutateStore(env, 'announcements', (store) => {
    const now = new Date().toISOString();
    if (id) {
      const existing = store.announcements.find((item) => item.id === id);
      if (!existing) throw new ApiError(404, 'Announcement not found', 'ANNOUNCEMENT_NOT_FOUND');
      Object.assign(existing, input, { updatedAt: now, updatedById: user.id });
      return existing;
    }
    const created = {
      id: crypto.randomUUID(),
      ...input,
      createdById: user.id,
      updatedById: user.id,
      createdAt: now,
      updatedAt: now,
    };
    store.announcements.push(created);
    return created;
  });

  return json({ announcement }, id ? 200 : 201);
}

async function deleteAnnouncement(request, env, id) {
  assertUuid(id);
  await authenticate(request, env, ['administrator', 'editor']);
  await mutateStore(env, 'announcements', (store) => {
    const index = store.announcements.findIndex((item) => item.id === id);
    if (index < 0) throw new ApiError(404, 'Announcement not found', 'ANNOUNCEMENT_NOT_FOUND');
    store.announcements.splice(index, 1);
  });
  return json({ ok: true });
}

async function requireArticleCommentAccess(env, articleId, user) {
  const [{ data: articleStore }, { data: categoryStore }] = await Promise.all([
    readStore(env, 'articles'),
    readStore(env, 'categories'),
  ]);
  const article = articleStore.articles.find((item) => item.id === articleId);
  if (!article) throw new ApiError(404, 'Article not found', 'ARTICLE_NOT_FOUND');

  const manager = ['administrator', 'editor'].includes(user.role);
  if (!manager && (article.status !== 'published' || !articleHasVisibleCategory(article, categoryStore.categories))) {
    throw new ApiError(403, 'Article is not available to this account', 'FORBIDDEN');
  }
  return article;
}

async function addArticleComment(request, env, articleId) {
  assertUuid(articleId);
  const { data: settings } = await readStore(env, 'settings');
  if (settings.mode !== 'private') {
    throw new ApiError(403, 'Comments are available only while the portal is private', 'COMMENTS_PRIVATE_ONLY');
  }

  const { user } = await authenticate(request, env, ['administrator', 'editor', 'reader']);
  requireCommentWrite(user);
  await requireArticleCommentAccess(env, articleId, user);

  const input = await jsonBody(request);
  const content = validateCommentContent(input.content);

  const comment = await mutateStore(env, 'comments', (store) => {
    const created = {
      id: crypto.randomUUID(),
      articleId,
      userId: user.id,
      userFullName: String(user.fullName || '').trim() || user.email,
      userEmail: user.email,
      content,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.comments.push(created);
    return created;
  });

  return json({ comment }, 201);
}

async function updateArticleComment(request, env, articleId, commentId) {
  assertUuid(articleId);
  assertUuid(commentId);
  const { data: settings } = await readStore(env, 'settings');
  if (settings.mode !== 'private') {
    throw new ApiError(403, 'Comments are available only while the portal is private', 'COMMENTS_PRIVATE_ONLY');
  }

  const { user } = await authenticate(request, env, ['administrator', 'editor', 'reader']);
  requireCommentWrite(user);
  await requireArticleCommentAccess(env, articleId, user);
  const input = await jsonBody(request);
  const content = validateCommentContent(input.content);

  const comment = await mutateStore(env, 'comments', (store) => {
    const existing = store.comments.find((item) => item.id === commentId && item.articleId === articleId);
    if (!existing) throw new ApiError(404, 'Comment not found', 'COMMENT_NOT_FOUND');
    if (existing.userId !== user.id) {
      throw new ApiError(403, 'You can edit only your own comments', 'COMMENT_NOT_OWNED');
    }
    existing.content = content;
    existing.updatedAt = new Date().toISOString();
    return existing;
  });

  return json({ comment });
}

async function deleteArticleComment(request, env, articleId, commentId) {
  assertUuid(articleId);
  assertUuid(commentId);
  const { data: settings } = await readStore(env, 'settings');
  if (settings.mode !== 'private') {
    throw new ApiError(403, 'Comments are available only while the portal is private', 'COMMENTS_PRIVATE_ONLY');
  }

  const { user } = await authenticate(request, env, ['administrator', 'editor', 'reader']);
  requireCommentWrite(user);
  await requireArticleCommentAccess(env, articleId, user);
  await mutateStore(env, 'comments', (store) => {
    const index = store.comments.findIndex((item) => item.id === commentId && item.articleId === articleId);
    if (index < 0) throw new ApiError(404, 'Comment not found', 'COMMENT_NOT_FOUND');
    if (store.comments[index].userId !== user.id) {
      throw new ApiError(403, 'You can delete only your own comments', 'COMMENT_NOT_OWNED');
    }
    store.comments.splice(index, 1);
  });

  return json({ ok: true });
}

async function listArticles(request, env, manage) {
  if (manage) {
    await authenticate(request, env, ['administrator', 'editor']);
    const { data: articleStore } = await readStore(env, 'articles');
    return json({ articles: sortArticles(articleStore.articles).map(publicArticle) });
  }

  const { data: settings } = await readStore(env, 'settings');
  if (settings.mode === 'private') await authenticate(request, env, ['administrator', 'editor', 'reader']);
  const [{ data: articleStore }, { data: categoryStore }] = await Promise.all([
    readStore(env, 'articles'),
    readStore(env, 'categories'),
  ]);
  return json({
    articles: sortArticlesByCreatedAt(articleStore.articles.filter((article) =>
      article.status === 'published' && articleHasVisibleCategory(article, categoryStore.categories),
    )).map((article) => portalArticle(article, categoryStore.categories)),
  });
}

async function getArticle(request, env, id) {
  assertUuid(id);
  const [{ data: articleStore }, { data: categoryStore }] = await Promise.all([
    readStore(env, 'articles'),
    readStore(env, 'categories'),
  ]);
  const article = articleStore.articles.find((item) => item.id === id);
  if (!article) throw new ApiError(404, 'Article not found', 'ARTICLE_NOT_FOUND');

  let managementAccess = false;
  if (article.status === 'draft' || !articleHasVisibleCategory(article, categoryStore.categories)) {
    await authenticate(request, env, ['administrator', 'editor']);
    managementAccess = true;
  } else {
    const { data: settings } = await readStore(env, 'settings');
    if (settings.mode === 'private') {
      const { user } = await authenticate(request, env, ['administrator', 'editor', 'reader']);
      managementAccess = ['administrator', 'editor'].includes(user.role);
    }
  }

  return json({
    article: managementAccess ? publicArticle(article) : portalArticle(article, categoryStore.categories),
  });
}

async function saveArticle(request, env, ctx, id = null) {
  if (id) assertUuid(id);
  const { user } = await authenticate(request, env, ['administrator', 'editor']);
  const body = await jsonBody(request);
  const { data: categoryStore } = await readStore(env, 'categories');
  const input = validateArticle(body, categoryStore.categories);

  let previousArticle = null;
  const article = await mutateStore(env, 'articles', (store) => {
    const now = new Date().toISOString();
    if (id) {
      const existing = store.articles.find((item) => item.id === id);
      if (!existing) throw new ApiError(404, 'Article not found', 'ARTICLE_NOT_FOUND');
      previousArticle = {
        id: existing.id,
        label: existing.title,
        fields: [
          existing.title !== input.title ? { field: 'Title', value: existing.title } : null,
          existing.summary !== input.summary ? { field: 'Summary', value: existing.summary } : null,
          existing.content !== input.content ? { field: 'Content', value: existing.content } : null,
          existing.status !== input.status ? { field: 'Status', value: existing.status } : null,
          !sameStringArray(articleCategoryIds(existing), input.categoryIds) ? {
            field: 'Categories',
            value: articleCategoryIds(existing)
              .map((categoryId) => categoryStore.categories.find((category) => category.id === categoryId)?.name || 'Unknown category')
              .join(', ') || 'Uncategorized',
            referenceIds: articleCategoryIds(existing),
          } : null,
        ].filter(Boolean),
      };
      Object.assign(existing, input, { updatedAt: now, updatedById: user.id });
      delete existing.categoryId;
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

  await refreshInitialArticlesSafely(env);

  scheduleLogEntry(ctx, env, {
    action: id ? 'Article Update' : 'Article Create',
    entityId: article.id,
    entityLabel: article.title,
    previousEntityId: previousArticle?.id ?? null,
    previousEntityLabel: previousArticle?.label ?? null,
    previousFields: previousArticle?.fields ?? null,
    userEmail: user.email,
  });

  return json({ article: publicArticle(article) }, id ? 200 : 201);
}

async function deleteArticle(request, env, ctx, id) {
  assertUuid(id);
  const { user } = await authenticate(request, env, ['administrator', 'editor']);
  const deleted = await mutateStore(env, 'articles', (store) => {
    const index = store.articles.findIndex((item) => item.id === id);
    if (index < 0) throw new ApiError(404, 'Article not found', 'ARTICLE_NOT_FOUND');
    const [article] = store.articles.splice(index, 1);
    return article;
  });

  await refreshInitialArticlesSafely(env);

  scheduleLogEntry(ctx, env, {
    action: 'Article Delete',
    entityId: deleted.id,
    entityLabel: deleted.title,
    previousEntityId: deleted.id,
    previousEntityLabel: deleted.title,
    userEmail: user.email,
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
  return json({ categories: sortCategories(categoryStore.categories.filter((category) => !category.hidden)) });
}

async function saveCategory(request, env, ctx, id = null) {
  if (id) assertUuid(id);
  const { user } = await authenticate(request, env, ['administrator', 'editor']);
  const input = validateCategory(await jsonBody(request));

  let previousCategory = null;
  const category = await mutateStore(env, 'categories', (store) => {
    if (store.categories.some((item) => item.name.toLocaleLowerCase() === input.name.toLocaleLowerCase() && item.id !== id)) {
      throw new ApiError(409, 'Category name is already in use', 'CATEGORY_NAME_IN_USE');
    }
    const now = new Date().toISOString();
    if (id) {
      const existing = store.categories.find((item) => item.id === id);
      if (!existing) throw new ApiError(404, 'Category not found', 'CATEGORY_NOT_FOUND');
      previousCategory = {
        id: existing.id,
        label: existing.name,
        fields: [
          existing.name !== input.name ? { field: 'Name', value: existing.name } : null,
          Boolean(existing.hidden) !== input.hidden ? { field: 'Hidden', value: Boolean(existing.hidden) ? 'Yes' : 'No' } : null,
        ].filter(Boolean),
      };
      existing.name = input.name;
      existing.hidden = input.hidden;
      existing.updatedAt = now;
      existing.updatedById = user.id;
      return existing;
    }
    const created = {
      id: crypto.randomUUID(),
      name: input.name,
      hidden: input.hidden,
      createdById: user.id,
      updatedById: user.id,
      createdAt: now,
      updatedAt: now,
    };
    store.categories.push(created);
    return created;
  });

  await refreshInitialArticlesSafely(env);

  scheduleLogEntry(ctx, env, {
    action: id ? 'Category Update' : 'Category Create',
    entityId: category.id,
    entityLabel: category.name,
    previousEntityId: previousCategory?.id ?? null,
    previousEntityLabel: previousCategory?.label ?? null,
    previousFields: previousCategory?.fields ?? null,
    userEmail: user.email,
  });

  return json({ category }, id ? 200 : 201);
}

async function deleteCategory(request, env, ctx, id) {
  assertUuid(id);
  const { user } = await authenticate(request, env, ['administrator', 'editor']);
  const { data: articleStore } = await readStore(env, 'articles');
  if (articleStore.articles.some((article) => articleCategoryIds(article).includes(id))) {
    throw new ApiError(409, 'Category is used by one or more articles', 'CATEGORY_IN_USE');
  }

  const deleted = await mutateStore(env, 'categories', (store) => {
    const index = store.categories.findIndex((item) => item.id === id);
    if (index < 0) throw new ApiError(404, 'Category not found', 'CATEGORY_NOT_FOUND');
    const [category] = store.categories.splice(index, 1);
    return category;
  });

  await refreshInitialArticlesSafely(env);

  scheduleLogEntry(ctx, env, {
    action: 'Category Delete',
    entityId: deleted.id,
    entityLabel: deleted.name,
    previousEntityId: deleted.id,
    previousEntityLabel: deleted.name,
    userEmail: user.email,
  });
  return json({ ok: true });
}

async function listLogbook(request, env) {
  await authenticate(request, env, ['administrator']);
  const { data: logbookStore } = await readStore(env, 'logbook');
  const entries = [...logbookStore.entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return json({ entries });
}

async function listUsers(request, env) {
  const { usersStore } = await authenticate(request, env, ['administrator']);
  return json({ users: usersStore.users.map(publicUser).sort((a, b) => a.email.localeCompare(b.email)) });
}

async function saveUser(request, env, ctx, id = null) {
  if (id) assertUuid(id);
  const { session, user: actingUser } = await authenticate(request, env, ['administrator']);
  const input = await jsonBody(request);
  const email = normalizeEmail(input.email);
  const requestedFullName = input.fullName == null ? null : validateFullName(input.fullName);
  const role = validateRole(input.role);
  const canComment = role === 'reader' ? input.canComment === true : true;
  const password = input.password ? validatePassword(input.password) : null;
  if (!id && !password) throw new ApiError(400, 'Password is required', 'PASSWORD_REQUIRED');

  let previousUser = null;
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
      previousUser = { id: existing.id, label: existing.email };
      if (existing.role === 'administrator' && role !== 'administrator' && adminCount(store.users) <= 1) {
        throw new ApiError(409, 'The system must always have at least one administrator', 'LAST_ADMIN_REQUIRED');
      }
      existing.fullName = requestedFullName ?? (String(existing.fullName || '').trim() || existing.email);
      existing.email = email;
      existing.role = role;
      existing.canComment = canComment;
      existing.updatedAt = now;
      if (password) {
        existing.password = await hashPassword(password);
        existing.sessionNonce = crypto.randomUUID();
      }
      return existing;
    }

    const created = {
      id: crypto.randomUUID(),
      fullName: requestedFullName ?? email,
      email,
      role,
      canComment,
      password: await hashPassword(password),
      sessionNonce: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    store.users.push(created);
    return created;
  });

  scheduleLogEntry(ctx, env, {
    action: id ? 'User Update' : 'User Create',
    entityId: user.id,
    entityLabel: user.email,
    previousEntityId: previousUser?.id ?? null,
    previousEntityLabel: previousUser?.label ?? null,
    userEmail: actingUser.email,
  });

  return json({ user: publicUser(user) }, id ? 200 : 201);
}

async function deleteUser(request, env, ctx, id) {
  assertUuid(id);
  const { session, user: actingUser } = await authenticate(request, env, ['administrator']);
  const deleted = await mutateStore(env, 'users', (store) => {
    const actor = userFromSession(store.users, session);
    requireRole(actor, ['administrator']);
    const index = store.users.findIndex((item) => item.id === id);
    if (index < 0) throw new ApiError(404, 'User not found', 'USER_NOT_FOUND');
    if (store.users[index].role === 'administrator' && adminCount(store.users) <= 1) {
      throw new ApiError(409, 'The system must always have at least one administrator', 'LAST_ADMIN_REQUIRED');
    }
    const [user] = store.users.splice(index, 1);
    return user;
  });

  scheduleLogEntry(ctx, env, {
    action: 'User Delete',
    entityId: deleted.id,
    entityLabel: deleted.email,
    previousEntityId: deleted.id,
    previousEntityLabel: deleted.email,
    userEmail: actingUser.email,
  });
  return json({ ok: true }, 200, session.uid === id ? { 'Set-Cookie': expiredSessionCookie(request) } : {});
}

async function updateSettings(request, env, ctx) {
  const { user } = await authenticate(request, env, ['administrator']);
  const input = await jsonBody(request);
  const hasMode = input.mode !== undefined;
  const hasPortalName = input.portalName !== undefined;
  const hasInitialArticles = input.initialArticles !== undefined;
  const hasHeroEyebrow = input.heroEyebrow !== undefined;
  const hasHeroTitle = input.heroTitle !== undefined;
  const hasHeroDescription = input.heroDescription !== undefined;

  if (!hasMode && !hasPortalName && !hasInitialArticles && !hasHeroEyebrow && !hasHeroTitle && !hasHeroDescription) {
    throw new ApiError(400, 'No settings change was provided', 'INVALID_SETTINGS');
  }

  if (hasMode && !['private', 'public'].includes(input.mode)) {
    throw new ApiError(400, 'Mode must be private or public', 'INVALID_MODE');
  }

  if (hasMode) {
    const password = String(input.password ?? '');
    if (!password) throw new ApiError(400, 'Administrator password is required', 'PASSWORD_REQUIRED');
    if (!(await verifyPassword(password, user.password))) {
      throw new ApiError(401, 'Incorrect administrator password', 'INVALID_CREDENTIALS');
    }
  }

  const nextPortalName = hasPortalName ? validatePortalName(input.portalName) : null;
  const nextInitialArticles = hasInitialArticles ? validateInitialArticles(input.initialArticles) : null;
  const nextHeroEyebrow = hasHeroEyebrow ? validateHeroEyebrow(input.heroEyebrow) : null;
  const nextHeroTitle = hasHeroTitle ? validateHeroTitle(input.heroTitle) : null;
  const nextHeroDescription = hasHeroDescription ? validateHeroDescription(input.heroDescription) : null;

  let previousMode = null;
  let previousPortalName = null;
  let previousInitialArticles = null;
  let portalNameChanged = false;
  let initialArticlesChanged = false;
  let homepageChanged = false;
  let previousHomepageFields = [];

  const updated = await mutateStore(env, 'settings', (settings) => {
    if (hasMode) {
      if (settings.mode === input.mode) throw new ApiError(409, `Portal is already ${input.mode}`, 'MODE_UNCHANGED');
      previousMode = settings.mode;
      settings.mode = input.mode;
    }

    if (hasPortalName) {
      previousPortalName = portalName(settings);
      portalNameChanged = previousPortalName !== nextPortalName;
      settings.portalName = nextPortalName;
    }

    if (hasInitialArticles) {
      previousInitialArticles = initialArticlesCount(settings);
      initialArticlesChanged = previousInitialArticles !== nextInitialArticles;
      settings.initialArticles = nextInitialArticles;
    }

    if (hasHeroEyebrow) {
      const previous = heroEyebrow(settings);
      if (previous !== nextHeroEyebrow) previousHomepageFields.push({ field: 'Hero label', value: previous });
      settings.heroEyebrow = nextHeroEyebrow;
    }
    if (hasHeroTitle) {
      const previous = heroTitle(settings);
      if (previous !== nextHeroTitle) previousHomepageFields.push({ field: 'Hero title', value: previous });
      settings.heroTitle = nextHeroTitle;
    }
    if (hasHeroDescription) {
      const previous = heroDescription(settings);
      if (previous !== nextHeroDescription) previousHomepageFields.push({ field: 'Hero description', value: previous });
      settings.heroDescription = nextHeroDescription;
    }
    homepageChanged = previousHomepageFields.length > 0;

    settings.updatedAt = new Date().toISOString();
    settings.updatedById = user.id;
    return settings;
  });

  if (hasMode) {
    scheduleLogEntry(ctx, env, {
      action: `Portal State Update to ${input.mode === 'public' ? 'Public' : 'Private'}`,
      entityId: null,
      entityLabel: 'Portal',
      previousEntityId: null,
      previousEntityLabel: previousMode === 'public' ? 'Public' : 'Private',
      userEmail: user.email,
    });
  }

  if (portalNameChanged) {
    scheduleLogEntry(ctx, env, {
      action: 'Portal Name Update',
      entityId: null,
      entityLabel: 'Portal',
      previousEntityId: null,
      previousEntityLabel: previousPortalName,
      userEmail: user.email,
    });
  }

  if (initialArticlesChanged) {
    await refreshInitialArticlesSafely(env);
    scheduleLogEntry(ctx, env, {
      action: 'Initial Articles Update',
      entityId: null,
      entityLabel: 'Portal',
      previousEntityId: null,
      previousEntityLabel: String(previousInitialArticles),
      userEmail: user.email,
    });
  }

  if (homepageChanged) {
    scheduleLogEntry(ctx, env, {
      action: 'Homepage Content Update',
      entityId: null,
      entityLabel: 'Portal',
      previousEntityId: null,
      previousEntityLabel: null,
      previousFields: previousHomepageFields,
      userEmail: user.email,
    });
  }

  return json({
    ok: true,
    mode: updated.mode,
    portalName: portalName(updated),
    initialArticles: initialArticlesCount(updated),
    heroEyebrow: heroEyebrow(updated),
    heroTitle: heroTitle(updated),
    heroDescription: heroDescription(updated),
  });
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
  if (name === 'settings') return {
    id: crypto.randomUUID(),
    schemaVersion: STORE_SCHEMA_VERSION,
    mode: 'private',
    portalName: DEFAULT_PORTAL_NAME,
    initialArticles: DEFAULT_INITIAL_ARTICLES,
    heroEyebrow: DEFAULT_HERO_EYEBROW,
    heroTitle: DEFAULT_HERO_TITLE,
    heroDescription: DEFAULT_HERO_DESCRIPTION,
    updatedAt: now,
    updatedById: null,
  };
  if (name === 'logbook') return { id: crypto.randomUUID(), schemaVersion: STORE_SCHEMA_VERSION, entries: [], createdAt: now, updatedAt: now };
  if (name === 'announcements') return { id: crypto.randomUUID(), schemaVersion: STORE_SCHEMA_VERSION, announcements: [], createdAt: now, updatedAt: now };
  if (name === 'comments') return { id: crypto.randomUUID(), schemaVersion: STORE_SCHEMA_VERSION, comments: [], createdAt: now, updatedAt: now };
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
      categories: Array.isArray(legacy.categories)
        ? legacy.categories.map((category) => ({ ...structuredClone(category), hidden: Boolean(category.hidden) }))
        : [],
      createdAt,
      updatedAt: legacy.updatedAt || now,
    };
  }

  if (name === 'logbook' || name === 'announcements' || name === 'comments') return createStore(name);

  if (name === 'settings') {
    return {
      id: isUuid(legacy.settings?.id) ? legacy.settings.id : crypto.randomUUID(),
      schemaVersion: 1,
      mode: ['private', 'public'].includes(legacy.settings?.mode) ? legacy.settings.mode : 'private',
      portalName: validPortalNameOrDefault(legacy.settings?.portalName),
      initialArticles: validInitialArticlesOrDefault(legacy.settings?.initialArticles),
      heroEyebrow: validHeroTextOrDefault(legacy.settings?.heroEyebrow, DEFAULT_HERO_EYEBROW, 80),
      heroTitle: validHeroTextOrDefault(legacy.settings?.heroTitle, DEFAULT_HERO_TITLE, 200),
      heroDescription: validHeroTextOrDefault(legacy.settings?.heroDescription, DEFAULT_HERO_DESCRIPTION, 500),
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

    const data = ['logbook', 'announcements', 'comments'].includes(name)
      ? createStore(name)
      : (() => null)();

    let migrated = data;
    if (!migrated) {
      const legacyObject = await env.PORTAL_DATA.get(LEGACY_DB_KEY);
      migrated = legacyObject ? storeFromLegacy(name, await legacyObject.json()) : createStore(name);
    }
    validateStore(name, migrated);

    const created = await env.PORTAL_DATA.put(key, JSON.stringify(migrated), {
      onlyIf: new Headers({ 'If-None-Match': '*' }),
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });

    if (created) return { data: migrated, etag: created.etag };

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

async function readInitialArticlesStore(env) {
  try {
    const object = await env.PORTAL_DATA.get(STORE_KEYS.initialArticles);
    if (object) {
      const data = await object.json();
      validateStore('initialArticles', data);
      return { data, etag: object.etag };
    }
    const data = await refreshInitialArticles(env);
    return { data, etag: null };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    console.error('R2 initial articles store read failed', error?.stack || error);
    throw new ApiError(500, 'Portal initial articles data could not be read', 'STORAGE_READ_FAILED');
  }
}

async function refreshInitialArticles(env) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const [{ data: articleStore }, { data: categoryStore }, { data: settings }] = await Promise.all([
      readStore(env, 'articles'),
      readStore(env, 'categories'),
      readStore(env, 'settings'),
    ]);

    let currentObject;
    try {
      currentObject = await env.PORTAL_DATA.get(STORE_KEYS.initialArticles);
    } catch (error) {
      console.error('R2 initial articles store read failed', error?.stack || error);
      throw new ApiError(500, 'Portal initial articles data could not be read', 'STORAGE_READ_FAILED');
    }

    let current = null;
    if (currentObject) {
      current = await currentObject.json();
      validateStore('initialArticles', current);
    }

    const now = new Date().toISOString();
    const articles = sortArticlesByCreatedAt(
      articleStore.articles.filter((article) =>
        article.status === 'published' && articleHasVisibleCategory(article, categoryStore.categories)),
    ).slice(0, initialArticlesCount(settings));

    const next = {
      id: current?.id || crypto.randomUUID(),
      schemaVersion: STORE_SCHEMA_VERSION,
      articles: structuredClone(articles),
      createdAt: current?.createdAt || now,
      updatedAt: now,
    };

    try {
      const condition = currentObject
        ? { etagMatches: currentObject.etag }
        : new Headers({ 'If-None-Match': '*' });
      const written = await env.PORTAL_DATA.put(STORE_KEYS.initialArticles, JSON.stringify(next), {
        onlyIf: condition,
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
      });
      if (written) return next;
    } catch (error) {
      console.error('R2 initial articles store write failed', error?.stack || error);
      throw new ApiError(500, 'Portal initial articles data could not be saved', 'STORAGE_WRITE_FAILED');
    }
  }

  throw new ApiError(409, 'Initial article index changed concurrently. Retry the operation.', 'WRITE_CONFLICT');
}

async function refreshInitialArticlesSafely(env) {
  try {
    await refreshInitialArticles(env);
  } catch (error) {
    console.error('Initial article index refresh failed', error?.stack || error);
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
      const fullNameValid = user.fullName === undefined || typeof user.fullName === 'string';
      const commentPrivilegeValid = user.canComment === undefined || typeof user.canComment === 'boolean';
      if (!isUuid(user.id) || !isUuid(user.sessionNonce) || !ROLES.has(user.role) || typeof user.email !== 'string' || !fullNameValid || !commentPrivilegeValid) {
        throw new ApiError(500, 'Portal users data is invalid', 'INVALID_DATABASE');
      }
    }
  } else if (name === 'articles') {
    if (!Array.isArray(data.articles)) throw new ApiError(500, 'Portal articles data is invalid', 'INVALID_DATABASE');
    for (const article of data.articles) {
      const legacyCategoryValid = article.categoryId == null || isUuid(article.categoryId);
      const categoriesValid = article.categoryIds === undefined ||
        (Array.isArray(article.categoryIds) && article.categoryIds.length > 0 && article.categoryIds.every(isUuid));
      if (!isUuid(article.id) || !isUuid(article.authorId) || !isUuid(article.updatedById) ||
          !ARTICLE_STATUSES.has(article.status) || !legacyCategoryValid || !categoriesValid) {
        throw new ApiError(500, 'Portal articles data is invalid', 'INVALID_DATABASE');
      }
    }
  } else if (name === 'initialArticles') {
    if (!Array.isArray(data.articles)) throw new ApiError(500, 'Portal initial articles data is invalid', 'INVALID_DATABASE');
    for (const article of data.articles) {
      const legacyCategoryValid = article.categoryId == null || isUuid(article.categoryId);
      const categoriesValid = article.categoryIds === undefined ||
        (Array.isArray(article.categoryIds) && article.categoryIds.length > 0 && article.categoryIds.every(isUuid));
      if (!isUuid(article.id) || !isUuid(article.authorId) || !isUuid(article.updatedById) ||
          !ARTICLE_STATUSES.has(article.status) || !legacyCategoryValid || !categoriesValid) {
        throw new ApiError(500, 'Portal initial articles data is invalid', 'INVALID_DATABASE');
      }
    }
  } else if (name === 'categories') {
    if (!Array.isArray(data.categories)) throw new ApiError(500, 'Portal categories data is invalid', 'INVALID_DATABASE');
    for (const category of data.categories) {
      const hiddenValid = category.hidden === undefined || typeof category.hidden === 'boolean';
      if (!isUuid(category.id) || typeof category.name !== 'string' || !hiddenValid || !isUuid(category.createdById) || !isUuid(category.updatedById)) {
        throw new ApiError(500, 'Portal categories data is invalid', 'INVALID_DATABASE');
      }
    }
  } else if (name === 'settings') {
    if (!['private', 'public'].includes(data.mode)) throw new ApiError(500, 'Portal settings data is invalid', 'INVALID_DATABASE');
    if (data.portalName !== undefined && (typeof data.portalName !== 'string' || !data.portalName.trim() || data.portalName.trim().length > 120)) {
      throw new ApiError(500, 'Portal settings data is invalid', 'INVALID_DATABASE');
    }
    if (data.initialArticles !== undefined && (!Number.isInteger(data.initialArticles) || data.initialArticles < 1 || data.initialArticles > 1000)) {
      throw new ApiError(500, 'Portal settings data is invalid', 'INVALID_DATABASE');
    }
    if (data.heroEyebrow !== undefined && (typeof data.heroEyebrow !== 'string' || data.heroEyebrow.length > 80)) {
      throw new ApiError(500, 'Portal settings data is invalid', 'INVALID_DATABASE');
    }
    if (data.heroTitle !== undefined && (typeof data.heroTitle !== 'string' || !data.heroTitle.trim() || data.heroTitle.trim().length > 200)) {
      throw new ApiError(500, 'Portal settings data is invalid', 'INVALID_DATABASE');
    }
    if (data.heroDescription !== undefined && (typeof data.heroDescription !== 'string' || !data.heroDescription.trim() || data.heroDescription.trim().length > 500)) {
      throw new ApiError(500, 'Portal settings data is invalid', 'INVALID_DATABASE');
    }
    if (data.updatedById !== null && data.updatedById !== undefined && !isUuid(data.updatedById)) {
      throw new ApiError(500, 'Portal settings data is invalid', 'INVALID_DATABASE');
    }
  } else if (name === 'announcements') {
    if (!Array.isArray(data.announcements)) throw new ApiError(500, 'Portal announcements data is invalid', 'INVALID_DATABASE');
    for (const announcement of data.announcements) {
      if (!isUuid(announcement.id) || typeof announcement.title !== 'string' || typeof announcement.content !== 'string' ||
          typeof announcement.startAt !== 'string' || (announcement.endAt !== null && typeof announcement.endAt !== 'string') ||
          !isUuid(announcement.createdById) || !isUuid(announcement.updatedById)) {
        throw new ApiError(500, 'Portal announcements data is invalid', 'INVALID_DATABASE');
      }
    }
  } else if (name === 'comments') {
    if (!Array.isArray(data.comments)) throw new ApiError(500, 'Portal comments data is invalid', 'INVALID_DATABASE');
    for (const comment of data.comments) {
      if (!isUuid(comment.id) || !isUuid(comment.articleId) || !isUuid(comment.userId) ||
          typeof comment.userFullName !== 'string' || typeof comment.userEmail !== 'string' ||
          typeof comment.content !== 'string' || typeof comment.createdAt !== 'string' ||
          (comment.updatedAt !== undefined && typeof comment.updatedAt !== 'string')) {
        throw new ApiError(500, 'Portal comments data is invalid', 'INVALID_DATABASE');
      }
    }
  } else if (name === 'logbook') {
    if (!Array.isArray(data.entries)) throw new ApiError(500, 'Portal logbook data is invalid', 'INVALID_DATABASE');
    for (const entry of data.entries) {
      const previousIdValid = entry.previousEntityId === undefined || entry.previousEntityId === null || isUuid(entry.previousEntityId);
      const previousLabelValid = entry.previousEntityLabel === undefined || entry.previousEntityLabel === null || typeof entry.previousEntityLabel === 'string';
      const previousFieldsValid = entry.previousFields === undefined || entry.previousFields === null ||
        (Array.isArray(entry.previousFields) && entry.previousFields.every((field) =>
          field && typeof field.field === 'string' && typeof field.value === 'string' &&
          (field.referenceId === undefined || field.referenceId === null || isUuid(field.referenceId)) &&
          (field.referenceIds === undefined || (Array.isArray(field.referenceIds) && field.referenceIds.every(isUuid)))
        ));
      if (!isUuid(entry.id) || typeof entry.action !== 'string' || typeof entry.entityLabel !== 'string' ||
          (entry.entityId !== null && !isUuid(entry.entityId)) || !previousIdValid || !previousLabelValid || !previousFieldsValid ||
          typeof entry.userEmail !== 'string' || typeof entry.createdAt !== 'string') {
        throw new ApiError(500, 'Portal logbook data is invalid', 'INVALID_DATABASE');
      }
    }
  }
}

function scheduleLogEntry(ctx, env, {
  action,
  entityId,
  entityLabel,
  previousEntityId = null,
  previousEntityLabel = null,
  previousFields = null,
  userEmail,
}) {
  const entry = {
    id: crypto.randomUUID(),
    action,
    entityId,
    entityLabel,
    previousEntityId,
    previousEntityLabel,
    previousFields,
    userEmail,
    createdAt: new Date().toISOString(),
  };

  const task = mutateStore(env, 'logbook', (store) => {
    store.entries.push(entry);
    return entry;
  }).catch((error) => {
    console.error('Asynchronous logbook write failed', error?.stack || error);
  });

  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(task);
  } else {
    void task;
  }
}

function sortArticles(articles) { return [...articles].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
function sortArticlesByCreatedAt(articles) { return [...articles].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
function sortCategories(categories) { return [...categories].sort((a, b) => a.name.localeCompare(b.name)); }
function sortAnnouncements(announcements) { return [...announcements].sort((a, b) => b.startAt.localeCompare(a.startAt)); }
function sortComments(comments) { return [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
function isAnnouncementActive(announcement, now = Date.now()) {
  const start = Date.parse(announcement.startAt);
  const end = announcement.endAt ? Date.parse(announcement.endAt) : Infinity;
  return Number.isFinite(start) && start <= now && now <= end;
}
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
function canWriteComments(user) {
  return Boolean(user && (user.role === 'administrator' || user.role === 'editor' || (user.role === 'reader' && user.canComment === true)));
}

function requireCommentWrite(user) {
  if (!canWriteComments(user)) {
    throw new ApiError(403, 'Comment writing is not enabled for this account', 'COMMENT_WRITE_DISABLED');
  }
  return user;
}

function publicUser(user) {
  return {
    id: user.id,
    fullName: String(user.fullName || '').trim() || user.email,
    email: user.email,
    role: user.role,
    canComment: canWriteComments(user),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function articleCategoryIds(article) {
  if (Array.isArray(article.categoryIds)) return [...new Set(article.categoryIds.filter(isUuid))];
  return isUuid(article.categoryId) ? [article.categoryId] : [];
}

function articleHasVisibleCategory(article, categories) {
  const visibleCategoryIds = new Set(
    categories.filter((category) => !category.hidden).map((category) => category.id),
  );
  return articleCategoryIds(article).some((categoryId) => visibleCategoryIds.has(categoryId));
}

function publicArticle(article) {
  const { categoryId, ...rest } = article;
  return { ...rest, categoryIds: articleCategoryIds(article) };
}

function portalArticle(article, categories) {
  const visibleCategoryIds = new Set(
    categories.filter((category) => !category.hidden).map((category) => category.id),
  );
  const result = publicArticle(article);
  return {
    ...result,
    categoryIds: result.categoryIds.filter((categoryId) => visibleCategoryIds.has(categoryId)),
  };
}

function sameStringArray(left, right) {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
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

function validatePortalName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 120) {
    throw new ApiError(400, 'Portal name is required and must be at most 120 characters', 'INVALID_PORTAL_NAME');
  }
  return name;
}

function validPortalNameOrDefault(value) {
  const name = String(value || '').trim();
  return name && name.length <= 120 ? name : DEFAULT_PORTAL_NAME;
}

function portalName(settings) {
  return validPortalNameOrDefault(settings?.portalName);
}

function validateInitialArticles(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 1000) {
    throw new ApiError(400, 'Initial Articles must be an integer between 1 and 1000', 'INVALID_INITIAL_ARTICLES');
  }
  return count;
}

function validInitialArticlesOrDefault(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 1 && count <= 1000 ? count : DEFAULT_INITIAL_ARTICLES;
}

function initialArticlesCount(settings) {
  return validInitialArticlesOrDefault(settings?.initialArticles);
}

function validHeroTextOrDefault(value, fallback, maxLength) {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  return text.length <= maxLength && (text || fallback === DEFAULT_HERO_EYEBROW) ? text : fallback;
}

function validateHeroEyebrow(value) {
  const text = String(value ?? '').trim();
  if (text.length > 80) throw new ApiError(400, 'Hero label must be at most 80 characters', 'INVALID_HERO_EYEBROW');
  return text;
}

function validateHeroTitle(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 200) throw new ApiError(400, 'Hero title is required and must be at most 200 characters', 'INVALID_HERO_TITLE');
  return text;
}

function validateHeroDescription(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 500) throw new ApiError(400, 'Hero description is required and must be at most 500 characters', 'INVALID_HERO_DESCRIPTION');
  return text;
}

function heroEyebrow(settings) {
  return validHeroTextOrDefault(settings?.heroEyebrow, DEFAULT_HERO_EYEBROW, 80);
}

function heroTitle(settings) {
  return validHeroTextOrDefault(settings?.heroTitle, DEFAULT_HERO_TITLE, 200);
}

function heroDescription(settings) {
  return validHeroTextOrDefault(settings?.heroDescription, DEFAULT_HERO_DESCRIPTION, 500);
}

function validateCommentContent(value) {
  const content = String(value || '').trim();
  if (!content || content.length > 4000) {
    throw new ApiError(400, 'Comment is required and must be at most 4000 characters', 'INVALID_COMMENT');
  }
  return content;
}

function validateFullName(value) {
  const fullName = String(value || '').trim();
  if (!fullName || fullName.length > 120) {
    throw new ApiError(400, 'Full name is required and must be at most 120 characters', 'INVALID_FULL_NAME');
  }
  return fullName;
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
function validateAnnouncement(input) {
  const title = String(input.title || '').trim();
  const content = String(input.content || '').trim();
  const start = new Date(input.startAt);
  const end = input.endAt ? new Date(input.endAt) : null;
  if (!title || title.length > 160) throw new ApiError(400, 'Announcement title is required and must be at most 160 characters', 'INVALID_ANNOUNCEMENT_TITLE');
  if (!content || content.length > 4000) throw new ApiError(400, 'Announcement content is required and must be at most 4000 characters', 'INVALID_ANNOUNCEMENT_CONTENT');
  if (!Number.isFinite(start.getTime())) throw new ApiError(400, 'Valid announcement start date is required', 'INVALID_ANNOUNCEMENT_START');
  if (end && !Number.isFinite(end.getTime())) throw new ApiError(400, 'Announcement end date is invalid', 'INVALID_ANNOUNCEMENT_END');
  if (end && end.getTime() < start.getTime()) throw new ApiError(400, 'Announcement end date must be after its start date', 'INVALID_ANNOUNCEMENT_END');
  return { title, content, startAt: start.toISOString(), endAt: end ? end.toISOString() : null };
}

function validateCategory(input) {
  const name = String(input.name || '').trim();
  if (!name || name.length > 80) {
    throw new ApiError(400, 'Category name is required and must be at most 80 characters', 'INVALID_CATEGORY_NAME');
  }
  return { name, hidden: input.hidden === true };
}
function validateArticle(input, categories) {
  const title = String(input.title || '').trim();
  const summary = String(input.summary || '').trim();
  const content = String(input.content || '').trim();
  const status = String(input.status || 'draft');
  const rawCategoryIds = Array.isArray(input.categoryIds)
    ? input.categoryIds
    : input.categoryId ? [input.categoryId] : [];
  const categoryIds = [...new Set(rawCategoryIds.map((value) => String(value || '')))];
  if (!title || title.length > 200) throw new ApiError(400, 'Title is required and must be at most 200 characters', 'INVALID_TITLE');
  if (summary.length > 600) throw new ApiError(400, 'Summary must be at most 600 characters', 'INVALID_SUMMARY');
  if (!content || content.length > 1_000_000) throw new ApiError(400, 'Article content is required and must be at most 1 MB', 'INVALID_CONTENT');
  validateInlineImageTokens(content);
  if (!ARTICLE_STATUSES.has(status)) throw new ApiError(400, 'Invalid article status', 'INVALID_ARTICLE_STATUS');
  if (!categoryIds.length || categoryIds.some((categoryId) => !isUuid(categoryId) || !categories.some((category) => category.id === categoryId))) {
    throw new ApiError(400, 'At least one valid article category is required', 'INVALID_CATEGORY');
  }
  return { title, summary, content, status, categoryIds };
}

function validateInlineImageTokens(content) {
  const tokenStart = '[[image:';
  if (!content.toLowerCase().includes(tokenStart)) return;

  const validToken = /\[\[image:([^|\]\r\n]+)\|(25|50|75|100)\]\]/gi;
  let match;
  try {
    while ((match = validToken.exec(content))) validateArticleImageReference(match[1]);
  } catch {
    throw new ApiError(400, 'Article contains an invalid inline image token', 'INVALID_IMAGE_TOKEN');
  }

  const remaining = content.replace(validToken, '');
  if (remaining.toLowerCase().includes(tokenStart)) {
    throw new ApiError(400, 'Article contains an invalid inline image token', 'INVALID_IMAGE_TOKEN');
  }
}

function validateArticleImageFilename(encodedFilename, contentType) {
  if (!encodedFilename) throw new ApiError(400, 'Image filename is required', 'IMAGE_FILENAME_REQUIRED');

  let filename;
  try { filename = decodeURIComponent(encodedFilename); }
  catch { throw new ApiError(400, 'Image filename is invalid', 'INVALID_IMAGE_FILENAME'); }

  filename = validateArticleImageReference(filename);
  if (isUuid(filename)) {
    throw new ApiError(400, 'Image filename must include its file extension', 'INVALID_IMAGE_FILENAME');
  }

  const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase() : '';
  const allowedExtensions = {
    'image/jpeg': new Set(['jpg', 'jpeg']),
    'image/png': new Set(['png']),
    'image/webp': new Set(['webp']),
    'image/gif': new Set(['gif']),
    'image/avif': new Set(['avif']),
  };
  if (!allowedExtensions[contentType]?.has(extension)) {
    throw new ApiError(400, 'Image filename extension does not match its file type', 'INVALID_IMAGE_FILENAME');
  }

  return filename;
}

function validateArticleImageReference(value) {
  const reference = String(value || '').trim();
  if (isUuid(reference)) return reference; // Legacy UUID-backed image references remain readable.
  if (!reference || reference.length > 160 || /[\\/\0-\x1f\x7f|\[\]]/.test(reference) || reference === '.' || reference === '..') {
    throw new ApiError(400, 'Article image filename is invalid', 'INVALID_IMAGE_FILENAME');
  }
  if (!/\.[A-Za-z0-9]{2,5}$/.test(reference)) {
    throw new ApiError(400, 'Article image filename must include a file extension', 'INVALID_IMAGE_FILENAME');
  }
  return reference;
}

function decodePathComponent(value) {
  try { return decodeURIComponent(value); }
  catch { throw new ApiError(400, 'Article image filename is invalid', 'INVALID_IMAGE_FILENAME'); }
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
