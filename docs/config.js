// YGN API configuration.
// Keep DEFAULT_API_BASE_URL blank for GitHub Pages static mode.
const DEFAULT_API_BASE_URL = '';
const LOCAL_API_BASE_URL = 'http://127.0.0.1:8000';

function resolveApiBaseUrl() {
  const params = new URLSearchParams(window.location.search);
  const override = (params.get('api') || '').trim();

  if (override === 'local') return LOCAL_API_BASE_URL;
  if (override === 'static') return '';
  if (/^https?:\/\//i.test(override)) return override.replace(/\/+$/, '');

  return DEFAULT_API_BASE_URL.replace(/\/+$/, '');
}

const API_BASE_URL = resolveApiBaseUrl();
