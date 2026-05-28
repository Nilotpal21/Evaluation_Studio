const DEFAULT_STUDIO_URL = 'http://localhost:5173';
const DEFAULT_RUNTIME_URL = 'http://localhost:3112';
const ISOLATED_STUDIO_URL = 'http://127.0.0.1:45173';
const ISOLATED_RUNTIME_URL = 'http://127.0.0.1:43112';

export const SDK_BROWSER_STUDIO_READY_PATH = '/api/health/e2e-ready';

function resolveUrl(configured, fallback) {
  return configured && configured.trim().length > 0 ? configured : fallback;
}

function isIsolatedSdkBrowserE2E() {
  return process.env.SDK_BROWSER_E2E_ISOLATED === 'true';
}

export function resolveStudioBaseUrl() {
  return isIsolatedSdkBrowserE2E()
    ? resolveUrl(process.env.SDK_BROWSER_E2E_STUDIO_URL, ISOLATED_STUDIO_URL)
    : resolveUrl(process.env.STUDIO_URL, DEFAULT_STUDIO_URL);
}

export function resolveRuntimeBaseUrl() {
  return isIsolatedSdkBrowserE2E()
    ? resolveUrl(process.env.SDK_BROWSER_E2E_RUNTIME_URL, ISOLATED_RUNTIME_URL)
    : resolveUrl(
        process.env.RUNTIME_URL ?? process.env.NEXT_PUBLIC_RUNTIME_URL,
        DEFAULT_RUNTIME_URL,
      );
}
