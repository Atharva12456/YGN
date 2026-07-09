const fetchMock = async (url) => {
  if (url === '/officials?limit=250&offset=0') {
    return {
      status: 404,
      ok: false,
      json: async () => ({})
    };
  }
  if (url === 'data/officials.json') {
    return {
      status: 200,
      ok: true,
      json: async () => ([{ name: "Mock Member" }])
    };
  }
};

async function fetchJsonWithStaticFallback(apiPath, staticPath, options = {}) {
  const API_BASE_URL = '';
  try {
    const res = await fetchMock(API_BASE_URL + apiPath, { cache: options.cache || 'default' });
    if (res.status === 404) return { notFound: true, source: 'api' };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { data: await res.json(), source: 'api' };
  } catch (apiError) {
    if (!staticPath) throw apiError;
    const res = await fetchMock(`data/${staticPath}`, { cache: 'no-store' });
    if (res.status === 404) return { notFound: true, source: 'static' };
    if (!res.ok) throw apiError;
    return { data: await res.json(), source: 'static' };
  }
}

(async () => {
  const result = await fetchJsonWithStaticFallback('/officials?limit=250&offset=0', 'officials.json');
  console.log('Result from fetchJsonWithStaticFallback:', result);
  
  const data = result.data;
  let items;
  if (Array.isArray(data)) {
    items = data;
  } else if (data && Array.isArray(data.items)) {
    items = data.items;
  } else if (data && Array.isArray(data.members)) {
    items = data.members;
  } else {
    items = [];
  }
  console.log('Items parsed:', items);
})();
