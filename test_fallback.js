const fs = require('fs');

const code = fs.readFileSync('docs/app.js', 'utf8');
const config = fs.readFileSync('docs/config.js', 'utf8');

// Mock fetch
global.fetch = async (url) => {
  console.log('Fetching:', url);
  if (url === '/officials?limit=250&offset=0' || url === '/health' || url.includes('/officials/')) {
    return {
      status: 404,
      ok: false,
      json: async () => ({})
    };
  }
  if (url.startsWith('data/')) {
    return {
      status: 200,
      ok: true,
      json: async () => ([{ name: "Static Mock", bioguideId: "123", party: "D" }])
    };
  }
  return { status: 500, ok: false };
};

eval(config);

// Extract just the fetchJsonWithStaticFallback function to avoid DOM dependencies
const funcRegex = /async function fetchJsonWithStaticFallback[^}]*\}[\s\S]*?\n\}/;
const match = code.match(funcRegex);

if (match) {
  eval(match[0]);
  (async () => {
    console.log("Testing fetchJsonWithStaticFallback directly...");
    const res = await fetchJsonWithStaticFallback('/officials?limit=250&offset=0', 'officials.json');
    console.log("Result:", res);
  })();
} else {
  console.log("Could not find function");
}
