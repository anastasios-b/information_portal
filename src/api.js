const PORTAL_CACHE_PREFIX = 'information-portal:public-cache:v1:';
const PORTAL_CACHE_TTL_MS = 5 * 60 * 1000;

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    cache: 'no-store',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
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

export async function cachedPortalApi(path) {
  const key = `${PORTAL_CACHE_PREFIX}${path}`;
  try {
    const raw = sessionStorage.getItem(key);
    if (raw) {
      const cached = JSON.parse(raw);
      if (cached?.expiresAt > Date.now()) return cached.payload;
      sessionStorage.removeItem(key);
    }
  } catch {
    // Cache failures must never prevent portal access.
  }

  const payload = await request(path, { method: 'GET' });
  try {
    sessionStorage.setItem(key, JSON.stringify({
      payload,
      expiresAt: Date.now() + PORTAL_CACHE_TTL_MS,
    }));
  } catch {
    // Storage may be unavailable or full; network data remains valid.
  }
  return payload;
}

export function clearPortalCache() {
  try {
    const keys = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(PORTAL_CACHE_PREFIX)) keys.push(key);
    }
    for (const key of keys) sessionStorage.removeItem(key);
  } catch {
    // Ignore cache cleanup errors.
  }
}
