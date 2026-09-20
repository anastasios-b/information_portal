import { handleApiRequest } from './api.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    return handleApiRequest(request, env);
  },
};
