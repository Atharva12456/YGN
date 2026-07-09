const fs = require('fs');

const code = fs.readFileSync('docs/app.js', 'utf8');

let fetchCalls = [];

global.fetch = async (url) => {
  fetchCalls.push(url);
  // Mock API 404
  if (url.startsWith('http://127.0.0.1:8000')) {
    return {
      status: 404,
      ok: false,
      json: async () => ({ detail: "Not found" })
    };
  }
  
  // Mock static fallback
  if (url.startsWith('data/')) {
    if (url.includes('missing')) {
      return { status: 404, ok: false };
    }
    return {
      status: 200,
      ok: true,
      json: async () => ({ dim1: -0.5, success: true })
    };
  }
  
  return { status: 500, ok: false };
};

const API_BASE_URL = 'http://127.0.0.1:8000';

// Extract the fetchJsonWithStaticFallback function
const fetchFuncRegex = /async function fetchJsonWithStaticFallback[^}]*\}[\s\S]*?\n\}/;
const fetchMatch = code.match(fetchFuncRegex);
eval(fetchMatch[0]);

// Also extract nominateCache, applyNominateTint, fetchNominate
const nominateCache = new Map();
const applyNominateTintRegex = /function applyNominateTint[^}]*\}[\s\S]*?\n\}/;
const applyNominateMatch = code.match(applyNominateTintRegex);
eval(applyNominateMatch[0]);

const fetchNominateRegex = /async function fetchNominate[^}]*\}[\s\S]*?\n\}/;
const fetchNominateMatch = code.match(fetchNominateRegex);
eval(fetchNominateMatch[0]);

(async () => {
  console.log("--- TEST 1: Fallback logic on API 404 ---");
  fetchCalls = [];
  try {
    const res = await fetchJsonWithStaticFallback('/test', 'test.json');
    console.log("Result:", res);
    console.log("Fetches:", fetchCalls);
    if (res.source === 'static' && res.data.success) {
      console.log("PASS: Fallback to static data worked.");
    } else {
      console.log("FAIL: Fallback did not return expected static data.");
    }
  } catch (e) {
    console.log("FAIL: Exception thrown:", e.message);
  }

  console.log("\n--- TEST 2: Fallback logic on API 404 + Static 404 ---");
  fetchCalls = [];
  try {
    const res = await fetchJsonWithStaticFallback('/test-missing', 'missing.json');
    console.log("Result:", res);
    console.log("Fetches:", fetchCalls);
    if (res.notFound) {
      console.log("PASS: Handled static 404 properly.");
    } else {
      console.log("FAIL: Did not return notFound.");
    }
  } catch (e) {
    console.log("FAIL: Exception thrown:", e.message);
  }

  console.log("\n--- TEST 3: Dynamic background color logic (fetchNominate) ---");
  fetchCalls = [];
  const dummyTile = { style: {} };
  await fetchNominate('member123', dummyTile);
  console.log("Tile Style after fetchNominate (-0.5):", dummyTile.style);
  if (dummyTile.style.backgroundColor && dummyTile.style.backgroundColor.startsWith('rgb(')) {
    console.log("PASS: Applied RGB tint for dim1=-0.5");
  } else {
    console.log("FAIL: Did not apply RGB tint correctly.");
  }
})();
