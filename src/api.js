export async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
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
    if (response.status >= 500 && payload.code) {
      message += ` [${payload.code}]`;
    }
    const error = new Error(message);
    error.status = response.status;
    error.code = payload.code;
    error.requestId = payload.requestId;
    throw error;
  }

  return payload;
}
