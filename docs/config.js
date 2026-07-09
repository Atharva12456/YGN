// YGN API configuration.
// Keep DEFAULT_API_BASE_URL blank for GitHub Pages static mode.
const DEFAULT_API_BASE_URL = '';
const LOCAL_API_BASE_URL = 'http://127.0.0.1:8000';

function resolveApiBaseUrl() {
  const params = new URLSearchParams(window.location.search);
  const override = (params.get('api') || '').trim();

  if (override === 'local') return LOCAL_API_BASE_URL;
  if (override === 'static') return '';
  if (override === 'origin') return window.location.origin;
  if (/^https?:\/\//i.test(override)) {
    // Only allow same-origin or localhost overrides — never point the app at an
    // arbitrary external host supplied via the URL.
    try {
      const u = new URL(override);
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.origin === window.location.origin) {
        return override.replace(/\/+$/, '');
      }
    } catch (_) { /* fall through to default */ }
  }

  return DEFAULT_API_BASE_URL.replace(/\/+$/, '');
}

const API_BASE_URL = resolveApiBaseUrl();
