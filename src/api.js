const contentRequests = new Map();

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    cache: 'no-store',
    headers: {
      ...(typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });

  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const payload = isJson
    ? await response.json()
    : { message: `Server request failed (HTTP ${response.status})` };

  if (!response.ok) {
    let message = payload.error || payload.message || `Request failed (HTTP ${response.status})`;
    if (response.status >= 500 && payload.code) message += ` [${payload.code}]`;
    const error = new Error(message);
    error.status = response.status;
    error.code = payload.code;
    error.requestId = payload.requestId;
    throw error;
  }

  return payload;
}

export function api(path, options = {}) {
  return request(path, options);
}

export function loadContentOnce(cacheKey, { manage = false, initial = false } = {}) {
  const variant = manage ? 'manage' : initial ? 'initial' : 'portal';
  const key = `${cacheKey}:${variant}`;
  if (!contentRequests.has(key)) {
    const params = new URLSearchParams();
    if (manage) params.set('manage', '1');
    else if (initial) params.set('initial', '1');
    const query = params.size ? `?${params.toString()}` : '';
    const requestPromise = request(`/api/content${query}`, { method: 'GET' })
      .catch((error) => {
        contentRequests.delete(key);
        throw error;
      });
    contentRequests.set(key, requestPromise);
  }
  return contentRequests.get(key);
}

export function resetContentRequests() {
  contentRequests.clear();
}

export async function uploadArticleImage(file) {
  return request('/api/article-images', {
    method: 'POST',
    body: file,
    headers: {
      'Content-Type': file.type,
      'X-Article-Image-Filename': encodeURIComponent(file.name),
    },
  });
}

export function articleImageUrl(filename) {
  return `/api/article-images/${encodeURIComponent(filename)}`;
}

export function listArticleImages() {
  return request('/api/article-images', { method: 'GET' });
}
