const contentRequests = new Map();
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


export function loadContentOnce(cacheKey, { manage = false } = {}) {
  const key = `${cacheKey}:${manage ? 'manage' : 'portal'}`;
  if (!contentRequests.has(key)) {
    const requestPromise = request(`/api/content${manage ? '?manage=1' : ''}`, { method: 'GET' })
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
