import { useEffect, useMemo, useRef, useState } from 'react';
import { api, articleImageUrl, cachedPortalApi, clearPortalCache, listArticleImages, uploadArticleImage } from './api.js';

const ADMIN_ROUTES = ['/admin/articles', '/admin/categories', '/admin/users', '/admin/settings'];

function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  dispatchEvent(new Event('portal-nav'));
}

function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const sync = () => setPath(location.pathname);
    addEventListener('popstate', sync);
    addEventListener('portal-nav', sync);
    return () => {
      removeEventListener('popstate', sync);
      removeEventListener('portal-nav', sync);
    };
  }, []);
  return path;
}

export default function App() {
  const path = usePath();
  const [boot, setBoot] = useState();
  const [error, setError] = useState('');

  const refresh = async () => {
    try {
      setBoot(await api('/api/bootstrap'));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => { refresh(); }, []);

  if (error) return <Center><Card title="Portal unavailable" text={error} /></Center>;
  if (!boot) return <AppSkeleton />;
  if (boot.setupRequired) return <Setup boot={boot} refresh={refresh} />;

  if (path.startsWith('/admin')) {
    if (!boot.user) return <Login mode={boot.mode} refresh={refresh} />;
    if (!['administrator', 'editor'].includes(boot.user.role)) {
      return <Center><Card title="Access denied" text="Administrators and editors only." action={() => navigate('/')} /></Center>;
    }
    return <Admin path={path} boot={boot} refresh={refresh} />;
  }

  if (boot.mode === 'private' && !boot.user) return <Login mode={boot.mode} refresh={refresh} />;
  if (path.startsWith('/articles/')) return <ArticlePage path={path} boot={boot} refresh={refresh} />;
  return <Home boot={boot} refresh={refresh} />;
}

function Login({ mode, refresh }) {
  const [form, setForm] = useState({ email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/login', { method: 'POST', body: JSON.stringify(form) });
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return <Center><div className="card auth">
    <small>Information Portal</small><h1>Sign in</h1>
    <p>{mode === 'private' ? 'This portal is private. Sign in to continue.' : 'Staff access.'}</p>
    <form onSubmit={submit}>
      <Field label="Email"><input type="email" autoComplete="username" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
      <Field label="Password"><input type="password" autoComplete="current-password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
      {error && <ErrorBox text={error} />}
      <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      {mode === 'public' && <button type="button" className="secondary" onClick={() => navigate('/')}>Back to portal</button>}
    </form>
  </div></Center>;
}

function Setup({ boot, refresh }) {
  const [form, setForm] = useState({ email: '', password: '', repeat: '', bootstrapToken: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    if (form.password !== form.repeat) return setError('Passwords do not match');
    setBusy(true);
    setError('');
    try {
      await api('/api/setup', {
        method: 'POST',
        body: JSON.stringify({ email: form.email, password: form.password, bootstrapToken: form.bootstrapToken }),
      });
      await refresh();
      navigate('/admin/articles', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return <Center><div className="card auth">
    <small>Initial setup</small><h1>Create first administrator</h1>
    <p>Registration closes after this account is created.</p>
    <form onSubmit={submit}>
      <Field label="Email"><input type="email" autoComplete="username" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
      <Field label="Password"><input type="password" autoComplete="new-password" minLength="10" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
      <Field label="Repeat password"><input type="password" autoComplete="new-password" minLength="10" required value={form.repeat} onChange={(e) => setForm({ ...form, repeat: e.target.value })} /></Field>
      {boot.setupTokenRequired && <Field label="Setup token"><input type="password" required value={form.bootstrapToken} onChange={(e) => setForm({ ...form, bootstrapToken: e.target.value })} /></Field>}
      {error && <ErrorBox text={error} />}
      <button disabled={busy}>{busy ? 'Creating…' : 'Complete setup'}</button>
    </form>
  </div></Center>;
}

function Home({ boot, refresh }) {
  const [articles, setArticles] = useState([]);
  const [categories, setCategories] = useState([]);
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const load = boot.mode === 'public' ? cachedPortalApi : api;
    Promise.all([load('/api/articles'), load('/api/categories')])
      .then(([articleData, categoryData]) => {
        if (!active) return;
        setArticles(articleData.articles);
        setCategories(categoryData.categories);
        setError('');
      })
      .catch((err) => { if (active) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [boot.mode, boot.user?.id]);

  const categoryMap = useMemo(() => new Map(categories.map((category) => [category.id, category.name])), [categories]);
  const filteredArticles = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return articles.filter((article) => {
      if (categoryFilter && article.categoryId !== categoryFilter) return false;
      if (!needle) return true;
      const category = categoryMap.get(article.categoryId) || 'Uncategorized';
      return [article.title, article.summary, articlePlainText(article.content), category]
        .some((value) => String(value || '').toLocaleLowerCase().includes(needle));
    });
  }, [articles, categoryFilter, categoryMap, query]);

  const logout = async () => {
    await api('/api/logout', { method: 'POST', body: '{}' });
    await refresh();
    navigate('/');
  };

  return <>
    <header className="top">
      <b>Information Portal</b>
      <div>
        <span className="pill">{boot.mode}</span>
        {boot.user ? <>
          <span className="who">{boot.user.email}</span>
          {['administrator', 'editor'].includes(boot.user.role) && <button className="secondary" onClick={() => navigate('/admin/articles')}>Admin</button>}
          <button className="secondary" onClick={logout}>Log out</button>
        </> : <button className="secondary" onClick={() => navigate('/admin/articles')}>Staff login</button>}
      </div>
    </header>

    <main className="main">
      <section className="hero"><small>Team knowledge</small><h1>Information that stays easy to find.</h1><p>Published procedures, references, notes and updates in one lean portal.</p></section>
      {error && <ErrorBox text={error} />}
      {loading ? <PortalSkeleton /> : <>
        <section className="portal-tools" aria-label="Filter articles">
          <label className="search-field"><span>Search</span><input type="search" placeholder="Search articles…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <label className="category-filter"><span>Category</span><select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="">All categories</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
        </section>
        <p className="results-count">{filteredArticles.length} {filteredArticles.length === 1 ? 'article' : 'articles'}</p>
        <section className="grid">
          {filteredArticles.map((article) => <article className="card article" key={article.id}>
          <div>
            <div className="article-meta"><span className="tag">{categoryMap.get(article.categoryId) || 'Uncategorized'}</span><small>{new Date(article.updatedAt).toLocaleString()}</small></div>
            <h2>{article.title}</h2><p>{article.summary || articlePlainText(article.content).slice(0, 160)}</p>
          </div>
          <button className="article-read" onClick={() => navigate(`/articles/${article.id}`)}>Read article →</button>
          </article>)}
        </section>
        {!articles.length && !error && <div className="empty">No published articles yet.</div>}
        {Boolean(articles.length) && !filteredArticles.length && !error && <div className="empty">No matching articles.</div>}
      </>}
    </main>

  </>;
}

function ArticlePage({ path, boot, refresh }) {
  const articleId = path.split('/').filter(Boolean)[1] || '';
  const [article, setArticle] = useState();
  const [categories, setCategories] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const categoryLoader = boot.mode === 'public' ? cachedPortalApi : api;

    Promise.all([
      api(`/api/articles/${articleId}`),
      categoryLoader('/api/categories'),
    ])
      .then(([articleData, categoryData]) => {
        if (!active) return;
        setArticle(articleData.article);
        setCategories(categoryData.categories);
        setError('');
      })
      .catch((err) => {
        if (active) setError(err.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => { active = false; };
  }, [articleId, boot.mode, boot.user?.id]);

  const categoryName = categories.find((category) => category.id === article?.categoryId)?.name || 'Uncategorized';

  const logout = async () => {
    await api('/api/logout', { method: 'POST', body: '{}' });
    await refresh();
    navigate('/');
  };

  return <>
    <header className="top">
      <button className="brand-link" onClick={() => navigate('/')}>Information Portal</button>
      <div>
        <span className="pill">{boot.mode}</span>
        {boot.user ? <>
          <span className="who">{boot.user.email}</span>
          {['administrator', 'editor'].includes(boot.user.role) && <button className="secondary" onClick={() => navigate('/admin/articles')}>Admin</button>}
          <button className="secondary" onClick={logout}>Log out</button>
        </> : <button className="secondary" onClick={() => navigate('/admin/articles')}>Staff login</button>}
      </div>
    </header>

    <main className="article-page">
      {loading ? <ArticlePageSkeleton /> : error ? <ErrorBox text={error} /> : article ? <>
        <button className="article-back" onClick={() => navigate('/')}>← Back to portal</button>
        <article className="article-document">
          <div className="article-meta">
            <span className="tag">{categoryName}</span>
            <small>Updated {new Date(article.updatedAt).toLocaleString()}</small>
          </div>
          <h1>{article.title}</h1>
          {article.summary && <p className="article-summary">{article.summary}</p>}
          <div className="article-body">{renderArticleContent(article.content)}</div>
        </article>
      </> : null}
    </main>
  </>;
}

function Admin({ path, boot, refresh }) {
  const isAdmin = boot.user.role === 'administrator';
  const isArticleRoute = path === '/admin/articles' || /^\/admin\/articles\/[0-9a-f-]{36}$/i.test(path);
  const isAllowedRoute =
    isArticleRoute ||
    path === '/admin/categories' ||
    (isAdmin && (path === '/admin/users' || path === '/admin/settings'));

  useEffect(() => {
    if (path === '/admin') navigate('/admin/articles', { replace: true });
    else if (!isAllowedRoute) navigate('/admin/articles', { replace: true });
  }, [path, isAllowedRoute]);

  const logout = async () => {
    await api('/api/logout', { method: 'POST', body: '{}' });
    await refresh();
    navigate('/');
  };

  const activePath = isArticleRoute ? '/admin/articles' : isAllowedRoute ? path : '/admin/articles';

  return <div className="layout">
    <aside>
      <b>Information Portal</b><small>Admin panel</small>
      <nav>
        <NavButton path="/admin/articles" current={activePath}>Articles</NavButton>
        <NavButton path="/admin/categories" current={activePath}>Article Categories</NavButton>
        {isAdmin && <NavButton path="/admin/users" current={activePath}>Users</NavButton>}
        {isAdmin && <NavButton path="/admin/settings" current={activePath}>Settings</NavButton>}
      </nav>
      <footer>
        <span>{boot.user.email}</span><span>{boot.user.role}</span>
        <a className="secondary button-link" href="/" target="_blank" rel="noopener noreferrer">View portal <NewTabIcon /></a>
        <button className="secondary" onClick={logout}>Log out</button>
      </footer>
    </aside>

    <main className="admin">
      {activePath === '/admin/articles' && <Articles path={path} />}
      {activePath === '/admin/categories' && <Categories />}
      {activePath === '/admin/users' && isAdmin && <Users boot={boot} refresh={refresh} />}
      {activePath === '/admin/settings' && isAdmin && <Settings boot={boot} refresh={refresh} />}
    </main>
  </div>;
}

function NavButton({ path, current, children }) {
  const selected = current === path;
  return <button className={selected ? 'active' : ''} disabled={selected} onClick={() => navigate(path)}>{children}</button>;
}

function Articles({ path }) {
  const empty = { title: '', summary: '', content: '', status: 'draft', categoryId: '' };
  const routeEditId = /^\/admin\/articles\/([0-9a-f-]{36})$/i.exec(path)?.[1];
  const [items, setItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [form, setForm] = useState(empty);
  const [id, setId] = useState();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [imageBusy, setImageBusy] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [mediaItems, setMediaItems] = useState([]);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaError, setMediaError] = useState('');
  const contentRef = useRef(null);
  const insertRangeRef = useRef({ start: 0, end: 0 });

  const load = async () => {
    setLoading(true);
    try {
      const [articleData, categoryData] = await Promise.all([api('/api/articles?manage=1'), api('/api/categories?manage=1')]);
      setItems(articleData.articles); setCategories(categoryData.categories); setError('');
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (loading) return;

    if (!routeEditId) {
      if (id) {
        setId(undefined);
        setForm(empty);
        setError('');
      }
      return;
    }

    const article = items.find((item) => item.id === routeEditId);
    if (!article) {
      setId(undefined);
      setForm(empty);
      setError('Article not found');
      return;
    }

    if (id !== article.id) {
      setId(article.id);
      setForm({
        title: article.title,
        summary: article.summary,
        content: article.content,
        status: article.status,
        categoryId: article.categoryId || '',
      });
      setError('');
    }
  }, [routeEditId, loading, items, id]);

  const categoryMap = useMemo(() => new Map(categories.map((category) => [category.id, category.name])), [categories]);
  const inlineImages = useMemo(() => extractInlineImages(form.content), [form.content]);
  const previewCategory = categoryMap.get(form.categoryId) || 'Uncategorized';

  const edit = (article) => {
    navigate(`/admin/articles/${article.id}`);
  };

  const reset = () => {
    setId(undefined);
    setForm(empty);
    setError('');
    navigate('/admin/articles');
  };

  const save = async (event) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await api(id ? `/api/articles/${id}` : '/api/articles', {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify(form),
      });
      clearPortalCache();
      await load();
      if (!id) navigate(`/admin/articles/${result.article.id}`);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const remove = async (article) => {
    if (!confirm(`Delete "${article.title}"?`)) return;
    try {
      await api(`/api/articles/${article.id}`, { method: 'DELETE', body: '{}' });
      clearPortalCache();
      if (routeEditId === article.id) navigate('/admin/articles');
      await load();
    } catch (err) { setError(err.message); }
  };

  const rememberInsertionRange = () => {
    const textarea = contentRef.current;
    insertRangeRef.current = {
      start: textarea?.selectionStart ?? form.content.length,
      end: textarea?.selectionEnd ?? textarea?.selectionStart ?? form.content.length,
    };
  };

  const insertImageReference = (reference, width = 100) => {
    const { start, end } = insertRangeRef.current;
    const token = `[[image:${reference}|${width}]]`;
    setForm((current) => {
      const safeStart = Math.min(start, current.content.length);
      const safeEnd = Math.min(Math.max(end, safeStart), current.content.length);
      const before = current.content.slice(0, safeStart);
      const after = current.content.slice(safeEnd);
      const prefix = before && !before.endsWith('\n') ? '\n' : '';
      const suffix = after && !after.startsWith('\n') ? '\n' : '';
      return { ...current, content: `${before}${prefix}${token}${suffix}${after}` };
    });
  };

  const openMediaLibrary = async () => {
    rememberInsertionRange();
    setMediaOpen(true);
    setMediaLoading(true);
    setMediaError('');
    try {
      const data = await listArticleImages();
      setMediaItems(data.images || []);
    } catch (err) {
      setMediaError(err.message);
    } finally {
      setMediaLoading(false);
    }
  };

  const selectMediaImage = (image) => {
    insertImageReference(image.filename, 100);
    setMediaOpen(false);
  };

  const uploadImage = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
    if (!allowedTypes.has(file.type)) {
      setError('Supported image types are JPEG, PNG, WebP, GIF and AVIF');
      event.target.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Article image must be at most 5 MB');
      event.target.value = '';
      return;
    }

    rememberInsertionRange();
    setImageBusy(true);
    setError('');

    try {
      const result = await uploadArticleImage(file);
      insertImageReference(result.image.filename, 100);
    } catch (err) {
      setError(err.message);
    } finally {
      setImageBusy(false);
      event.target.value = '';
    }
  };

  const resizeImage = (start, width) => {
    setForm((current) => {
      const target = extractInlineImages(current.content).find((image) => image.start === start);
      if (!target) return current;
      const replacement = `[[image:${target.reference}|${width}]]`;
      return {
        ...current,
        content: current.content.slice(0, target.start) + replacement + current.content.slice(target.end),
      };
    });
  };

  const removeImage = (start) => {
    setForm((current) => {
      const target = extractInlineImages(current.content).find((image) => image.start === start);
      if (!target) return current;
      return {
        ...current,
        content: (current.content.slice(0, target.start) + current.content.slice(target.end))
          .replace(/\n{3,}/g, '\n\n'),
      };
    });
  };

  const upload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 1_000_000) return setError('Article file must be at most 1 MB');
    const text = await file.text();
    setForm((current) => ({ ...current, title: current.title || file.name.replace(/\.(txt|md)$/i, ''), content: text }));
    event.target.value = '';
  };

  return <section>
    <Head title="Articles" text="Administrators and editors can create, import, edit and delete articles." />
    {!loading && !categories.length && <div className="notice">Create at least one category before creating an article.<button className="secondary" onClick={() => navigate('/admin/categories')}>Manage categories</button></div>}
    <div className="cols">
      <form className="card form" onSubmit={save}>
        <h2>{id ? 'Edit article' : 'New article'}</h2>
        <Field label="Title"><input required maxLength="200" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
        <Field label="Category">{loading ? <Skeleton height="41px" /> : <select required value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}><option value="">Select category</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select>}</Field>
        <Field label="Summary"><textarea rows="3" maxLength="600" value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} /></Field>
        <Field label="Content"><textarea ref={contentRef} rows="14" required value={form.content} onSelect={rememberInsertionRange} onKeyUp={rememberInsertionRange} onClick={rememberInsertionRange} onChange={(e) => setForm({ ...form, content: e.target.value })} /></Field>
        <div className="image-field">
          <span className="field-label">Add inline image</span>
          <div className="image-source-actions">
            <label className="image-upload-button">
              <span>Upload image</span>
              <input type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" disabled={imageBusy} onClick={rememberInsertionRange} onChange={uploadImage} />
            </label>
            <button type="button" className="secondary" onClick={openMediaLibrary}>Media library</button>
          </div>
        </div>
        {imageBusy && <div className="image-upload-placeholder"><Skeleton width="100%" height="72px" /></div>}
        {inlineImages.length > 0 && <div className="inline-image-controls">
          {inlineImages.map((image) => <div className="inline-image-control" key={`${image.reference}-${image.start}`}>
            <img src={articleImageUrl(image.reference)} alt="" />
            <div className="inline-image-name">
              <b title={image.reference}>{image.reference}</b>
            </div>
            <label><span>Width</span><select value={image.width} onChange={(event) => resizeImage(image.start, Number(event.target.value))}>
              {[25, 50, 75, 100].map((width) => <option key={width} value={width}>{width}%</option>)}
            </select></label>
            <button type="button" className="secondary" onClick={() => removeImage(image.start)}>Remove</button>
          </div>)}
        </div>}
        <Field label="Status"><select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}><option value="draft">Draft</option><option value="published">Published</option></select></Field>
        <Field label="Import .txt or .md"><input type="file" accept=".txt,.md,text/plain,text/markdown" onChange={upload} /></Field>
        {error && <ErrorBox text={error} />}
        <button disabled={busy || !categories.length}>{busy ? 'Saving…' : id ? 'Save changes' : 'Create article'}</button>
        {id && <button type="button" className="secondary" onClick={reset}>Cancel</button>}
      </form>

      {id ? <div className="card article-live-preview">
        <div className="live-preview-head">
          <div><small>Live rendering</small><h2>Article preview</h2></div>
          <span className="pill">{form.status}</span>
        </div>
        <article className="article-document preview-document">
          <div className="article-meta"><span className="tag">{previewCategory}</span></div>
          <h1>{form.title || 'Untitled article'}</h1>
          {form.summary && <p className="article-summary">{form.summary}</p>}
          <div className="article-body">
            {form.content ? renderArticleContent(form.content) : <p className="preview-empty">Article content will appear here.</p>}
          </div>
        </article>
      </div> : <div className="card"><h2>Existing articles</h2><div className="records" aria-busy={loading}>
        {loading ? <RecordSkeleton count={4} /> : items.map((article) => <div className="record" key={article.id}>
          <div><b>{article.title}</b><small>{categoryMap.get(article.categoryId) || 'Uncategorized'} · {article.status} · {article.id}</small></div>
          <div><button className="article-edit" onClick={() => edit(article)}>Edit</button><button className="article-delete" onClick={() => remove(article)}>Delete</button></div>
        </div>)}
      </div></div>}
    </div>

    {mediaOpen && <div className="media-library-overlay" onMouseDown={() => setMediaOpen(false)}>
      <section className="media-library-modal" role="dialog" aria-modal="true" aria-label="Media library" onMouseDown={(event) => event.stopPropagation()}>
        <header className="media-library-header">
          <div><small>Article images</small><h2>Media library</h2></div>
          <button type="button" className="secondary" onClick={() => setMediaOpen(false)}>Close</button>
        </header>
        {mediaError && <ErrorBox text={mediaError} />}
        {mediaLoading ? <MediaLibrarySkeleton /> : mediaItems.length ? <div className="media-library-grid">
          {mediaItems.map((image) => <button type="button" className="media-library-item" key={image.filename} onClick={() => selectMediaImage(image)}>
            <img src={articleImageUrl(image.filename)} alt={image.filename} loading="lazy" />
            <span title={image.filename}>{image.filename}</span>
          </button>)}
        </div> : !mediaError && <div className="empty">No images in the media library yet.</div>}
      </section>
    </div>}
  </section>;
}

function Categories() {
  const [items, setItems] = useState([]);
  const [name, setName] = useState('');
  const [id, setId] = useState();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try { const data = await api('/api/categories?manage=1'); setItems(data.categories); setError(''); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const reset = () => { setId(undefined); setName(''); setError(''); };
  const save = async (event) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await api(id ? `/api/categories/${id}` : '/api/categories', { method: id ? 'PUT' : 'POST', body: JSON.stringify({ name }) });
      clearPortalCache(); reset(); await load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const edit = (category) => { setId(category.id); setName(category.name); setError(''); };
  const remove = async (category) => {
    if (!confirm(`Delete category "${category.name}"?`)) return;
    try {
      await api(`/api/categories/${category.id}`, { method: 'DELETE', body: '{}' });
      clearPortalCache(); if (id === category.id) reset();
      await load();
    } catch (err) { setError(err.message); }
  };

  return <section>
    <Head title="Article Categories" text="Categories organize articles and are available to administrators and editors." />
    <div className="cols">
      <form className="card form" onSubmit={save}>
        <h2>{id ? 'Edit category' : 'New category'}</h2>
        <Field label="Name"><input required maxLength="80" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        {error && <ErrorBox text={error} />}
        <button disabled={busy}>{busy ? 'Saving…' : id ? 'Save category' : 'Create category'}</button>
        {id && <button type="button" className="secondary" onClick={reset}>Cancel</button>}
      </form>
      <div className="card"><h2>Article categories</h2><div className="records" aria-busy={loading}>
        {loading ? <RecordSkeleton count={4} /> : items.map((category) => <div className="record" key={category.id}>
          <div><b>{category.name}</b><small>{category.id}</small></div>
          <div><button className="secondary" onClick={() => edit(category)}>Edit</button><button className="danger" onClick={() => remove(category)}>Delete</button></div>
        </div>)}
      </div>{!loading && !items.length && <p className="hint">No categories yet.</p>}</div>
    </div>
  </section>;
}

function Users({ boot, refresh }) {
  const empty = { email: '', password: '', repeat: '', role: 'reader' };
  const [items, setItems] = useState([]);
  const [form, setForm] = useState(empty);
  const [id, setId] = useState();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try { const data = await api('/api/admin/users'); setItems(data.users); setError(''); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const edit = (user) => { setId(user.id); setForm({ email: user.email, password: '', repeat: '', role: user.role }); setError(''); };
  const reset = () => { setId(undefined); setForm(empty); setError(''); };
  const save = async (event) => {
    event.preventDefault();
    if (form.password !== form.repeat) return setError('Passwords do not match');
    if (!id && !form.password) return setError('Password is required');
    setBusy(true); setError('');
    try {
      await api(id ? `/api/admin/users/${id}` : '/api/admin/users', {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify({ email: form.email, password: form.password || undefined, role: form.role }),
      });
      reset(); await Promise.all([load(), refresh()]);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const remove = async (user) => {
    if (!confirm(`Delete ${user.email}?`)) return;
    try {
      await api(`/api/admin/users/${user.id}`, { method: 'DELETE', body: '{}' });
      await Promise.all([load(), refresh()]);
      if (user.id === boot.user.id) navigate('/');
    } catch (err) { setError(err.message); }
  };
  const adminCount = items.filter((item) => item.role === 'administrator').length;

  return <section>
    <Head title="Users" text="No public registration. Administrators create and maintain all accounts." />
    <div className="cols">
      <form className="card form" onSubmit={save}>
        <h2>{id ? 'Edit user' : 'Create user'}</h2>
        <Field label="Email"><input type="email" autoComplete="username" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label={id ? 'New password (optional)' : 'Password'}><input type="password" autoComplete="new-password" minLength={form.password ? 10 : undefined} required={!id} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
        <Field label="Repeat password"><input type="password" autoComplete="new-password" required={!id || Boolean(form.password)} value={form.repeat} onChange={(e) => setForm({ ...form, repeat: e.target.value })} /></Field>
        <Field label="Role"><select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{['administrator', 'editor', 'reader'].map((role) => <option key={role}>{role}</option>)}</select></Field>
        {error && <ErrorBox text={error} />}
        <button disabled={busy}>{busy ? 'Saving…' : id ? 'Save user' : 'Create user'}</button>
        {id && <button type="button" className="secondary" onClick={reset}>Cancel</button>}
      </form>

      <div className="card"><h2>Accounts</h2><div className="records" aria-busy={loading}>
        {loading ? <RecordSkeleton count={4} /> : items.map((user) => {
          const protectedAdmin = user.id === boot.user.id && user.role === 'administrator' && adminCount === 1;
          return <div className="record" key={user.id}>
            <div><b>{user.email}</b><small>{user.role} · {user.id}</small></div>
            <div><button className="secondary" onClick={() => edit(user)}>Edit</button><button className="danger" disabled={protectedAdmin} onClick={() => remove(user)}>Delete</button></div>
          </div>;
        })}
      </div><p className="hint">The API also blocks deletion or demotion of the final administrator.</p></div>
    </div>
  </section>;
}

function Settings({ boot, refresh }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const change = async (mode) => {
    if (mode === boot.mode || busy) return;
    setBusy(true); setError('');
    try {
      await api('/api/admin/settings', { method: 'PATCH', body: JSON.stringify({ mode, password }) });
      clearPortalCache(); setPassword('');
      await refresh();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return <section>
    <Head title="Settings" text="Changing visibility preserves all users, categories and articles." />
    <div className="card settings">
      <h2>Portal visibility</h2>
      <p>Private requires login. Public exposes published articles only; drafts and administration remain protected.</p>
      <Field label="Confirm with your administrator password"><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter password before switching" /></Field>
      <div className="modes">
        <button disabled={busy || boot.mode === 'private' || !password} className={boot.mode === 'private' ? 'chosen' : ''} onClick={() => change('private')}>Private<br /><small>Login required</small></button>
        <button disabled={busy || boot.mode === 'public' || !password} className={boot.mode === 'public' ? 'chosen' : ''} onClick={() => change('public')}>Public<br /><small>Published articles visible</small></button>
      </div>
      {error && <ErrorBox text={error} />}
    </div>
  </section>;
}

function extractInlineImages(content) {
  const images = [];
  const pattern = /\[\[image:([^|\]\r\n]+)\|(25|50|75|100)\]\]/gi;
  let match;
  while ((match = pattern.exec(String(content || '')))) {
    images.push({
      reference: match[1],
      width: Number(match[2]),
      start: match.index,
      end: pattern.lastIndex,
    });
  }
  return images;
}

function articlePlainText(content) {
  return String(content || '')
    .replace(/\[\[image:[^|\]\r\n]+\|(25|50|75|100)\]\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderArticleContent(content) {
  const lines = String(content || '').split('\n');
  const nodes = [];
  let keyIndex = 0;

  lines.forEach((line, lineIndex) => {
    const images = extractInlineImages(line);
    const onlyImages = images.length > 1 &&
      images.every((image) => image.width <= 50) &&
      articlePlainText(line) === '';

    if (onlyImages) {
      nodes.push(
        <div className="inline-article-image-row" key={`row-${lineIndex}`}>
          {images.map((image) => <figure
            className="inline-article-image"
            style={{ gridColumn: `span ${image.width / 25}` }}
            key={`row-image-${image.reference}-${keyIndex++}`}
          >
            <img src={articleImageUrl(image.reference)} alt={image.reference} loading="lazy" />
          </figure>)}
        </div>,
      );
    } else {
      const pattern = /\[\[image:([^|\]\r\n]+)\|(25|50|75|100)\]\]/gi;
      let cursor = 0;
      let match;

      while ((match = pattern.exec(line))) {
        if (match.index > cursor) {
          nodes.push(<span className="article-text" key={`text-${keyIndex++}`}>{line.slice(cursor, match.index)}</span>);
        }

        const reference = match[1];
        const width = Number(match[2]);
        nodes.push(
          <figure className="inline-article-image" style={{ width: `${width}%` }} key={`image-${reference}-${keyIndex++}`}>
            <img src={articleImageUrl(reference)} alt={reference} loading="lazy" />
          </figure>,
        );
        cursor = pattern.lastIndex;
      }

      if (cursor < line.length) {
        nodes.push(<span className="article-text" key={`text-${keyIndex++}`}>{line.slice(cursor)}</span>);
      }
    }

    if (lineIndex < lines.length - 1) {
      nodes.push(<span className="article-line-break" aria-hidden="true" key={`break-${lineIndex}`}>{'\n'}</span>);
    }
  });

  return nodes;
}

function MediaLibrarySkeleton() {
  return <div className="media-library-grid" aria-hidden="true">
    {Array.from({ length: 8 }, (_, index) => <div className="media-library-item skeleton-media-item" key={index}>
      <Skeleton width="100%" height="120px" />
      <Skeleton width="76%" height="12px" />
    </div>)}
  </div>;
}

function AppSkeleton() {
  return <div className="app-skeleton" aria-hidden="true">
    <header className="top"><Skeleton width="150px" height="18px" /><div><Skeleton width="78px" height="30px" /><Skeleton width="92px" height="38px" /></div></header>
    <main className="main">
      <section className="hero"><Skeleton width="95px" height="12px" /><Skeleton width="min(560px, 90%)" height="54px" /><Skeleton width="min(650px, 95%)" height="18px" /></section>
      <PortalSkeleton />
    </main>
  </div>;
}

function PortalSkeleton() {
  return <div className="skeleton-section" aria-hidden="true">
    <div className="portal-tools">
      <div><Skeleton width="55px" height="12px" /><Skeleton width="100%" height="44px" /></div>
      <div><Skeleton width="65px" height="12px" /><Skeleton width="100%" height="44px" /></div>
    </div>
    <Skeleton width="72px" height="12px" />
    <div className="grid skeleton-grid">
      {Array.from({ length: 6 }, (_, index) => <article className="card article skeleton-card" key={index}>
        <div><Skeleton width="90px" height="20px" /><Skeleton width="72%" height="25px" /><Skeleton width="100%" height="14px" /><Skeleton width="86%" height="14px" /></div>
        <Skeleton width="105px" height="14px" />
      </article>)}
    </div>
  </div>;
}

function ArticlePageSkeleton() {
  return <div className="article-page-skeleton" aria-hidden="true">
    <Skeleton width="120px" height="38px" />
    <div className="article-document">
      <div className="article-meta"><Skeleton width="90px" height="22px" /><Skeleton width="180px" height="12px" /></div>
      <Skeleton width="72%" height="48px" />
      <Skeleton width="88%" height="20px" />
      <div className="article-body-skeleton">
        <Skeleton width="100%" height="14px" />
        <Skeleton width="96%" height="14px" />
        <Skeleton width="91%" height="14px" />
        <Skeleton width="98%" height="14px" />
        <Skeleton width="76%" height="14px" />
      </div>
    </div>
  </div>;
}

function RecordSkeleton({ count = 4 }) {
  return <>{Array.from({ length: count }, (_, index) => <div className="record skeleton-record" key={index} aria-hidden="true">
    <div><Skeleton width={index % 2 ? '58%' : '72%'} height="16px" /><Skeleton width="88%" height="11px" /></div>
    <div><Skeleton width="62px" height="34px" /><Skeleton width="68px" height="34px" /></div>
  </div>)}</>;
}

function Skeleton({ width = '100%', height = '16px' }) {
  return <span className="skeleton" style={{ width, height }} />;
}

function NewTabIcon() {
  return <svg className="new-tab-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M13 11l6-6M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></svg>;
}

const Field = ({ label, children }) => <label><span>{label}</span>{children}</label>;
const ErrorBox = ({ text }) => <div className="error">{text}</div>;
const Head = ({ title, text }) => <header className="head"><h1>{title}</h1><p>{text}</p></header>;
const Center = ({ children }) => <main className="center">{children}</main>;
const Card = ({ title, text, action }) => <div className="card auth"><h1>{title}</h1><p>{text}</p>{action && <button onClick={action}>Back to portal</button>}</div>;
