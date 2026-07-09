global.fetch = async (url) => {
  console.log('Fetching', url);
  if (url === '/health') return { status: 404, ok: false };
  if (url === 'data/health.json') return { status: 200, ok: true, json: async () => ({ status: 'ok' }) };
  throw new Error('Unknown URL');
};

const API_BASE_URL = '';

async function fetchJsonWithStaticFallback(apiPath, staticPath, options = {}) {
  try {
    const res = await fetch(API_BASE_URL + apiPath, { cache: options.cache || 'default' });
    if (res.status === 404) return { notFound: true, source: 'api' };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { data: await res.json(), source: 'api' };
  } catch (apiError) {
    if (!staticPath) throw apiError;
    const res = await fetch(`data/${staticPath}`, { cache: 'no-store' });
    if (res.status === 404) return { notFound: true, source: 'static' };
    if (!res.ok) throw apiError;
    return { data: await res.json(), source: 'static' };
  }
}

fetchJsonWithStaticFallback('/health', 'health.json').then(console.log).catch(console.error);
