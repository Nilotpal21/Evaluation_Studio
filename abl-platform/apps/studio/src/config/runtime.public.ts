/**
 * Browser-safe runtime URL helpers.
 *
 * This module intentionally contains no process.env reads or server-only APIs.
 * Server code should resolve env vars in `runtime.server.ts` and pass the
 * resulting values into these helpers.
 */

/** Default fallback when no env var is set on the server. */
export const DEFAULT_RUNTIME_URL = 'http://localhost:3112';

export const INVALID_RUNTIME_URL_ERROR =
  'Runtime URL must be an absolute http:// or https:// URL without a trailing slash.';

export interface RuntimeConfig {
  /** HTTP API base URL (e.g., https://agents.example.com). Empty = same-origin routing. */
  apiUrl: string;
  /** WebSocket base URL (e.g., wss://agents.example.com/ws). */
  wsUrl: string;
  /** SDK WebSocket endpoint (e.g., wss://agents.example.com/ws/sdk). */
  sdkWsUrl: string;
  /** Whether we're in development mode. */
  isDev: boolean;
}

export interface ConfigValidationError {
  field: string;
  message: string;
  value?: string;
}

export function normalizeRuntimeUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '');
  const parsed = new URL(normalized);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(INVALID_RUNTIME_URL_ERROR);
  }
  return normalized;
}

function createEmptyRuntimeConfig(isDev: boolean): RuntimeConfig {
  return {
    apiUrl: '',
    wsUrl: '',
    sdkWsUrl: '',
    isDev,
  };
}

function deriveWsUrls(baseUrl: string): Pick<RuntimeConfig, 'wsUrl' | 'sdkWsUrl'> {
  const wsProtocol = baseUrl.startsWith('https') ? 'wss' : 'ws';
  const wsHost = baseUrl.replace(/^https?:\/\//, '');

  return {
    wsUrl: `${wsProtocol}://${wsHost}/ws`,
    sdkWsUrl: `${wsProtocol}://${wsHost}/ws/sdk`,
  };
}

/**
 * Convert an explicit public Runtime base URL into browser-facing HTTP/WS URLs.
 * Empty input intentionally means "use same-origin routing in the browser".
 */
export function createPublicRuntimeConfig(
  configuredBaseUrl: string | null | undefined,
  isDev: boolean,
): RuntimeConfig {
  if (typeof configuredBaseUrl !== 'string' || configuredBaseUrl.trim().length === 0) {
    return createEmptyRuntimeConfig(isDev);
  }

  const apiUrl = normalizeRuntimeUrl(configuredBaseUrl);
  const { wsUrl, sdkWsUrl } = deriveWsUrls(apiUrl);

  return {
    apiUrl,
    wsUrl,
    sdkWsUrl,
    isDev,
  };
}

/**
 * Browser-side fallback when no explicit public Runtime URL was injected.
 */
export function resolveBrowserWsUrl(
  configuredWsUrl: string | null | undefined,
  pathname: '/ws' | '/ws/sdk',
): string {
  if (typeof configuredWsUrl === 'string' && configuredWsUrl.trim().length > 0) {
    return configuredWsUrl;
  }

  if (typeof window === 'undefined') {
    return '';
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${pathname}`;
}

/**
 * Validate a resolved public runtime config object.
 */
export function validateRuntimeConfig(config: RuntimeConfig): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];

  if (!config.apiUrl) {
    return errors;
  }

  try {
    new URL(config.apiUrl);
  } catch {
    errors.push({
      field: 'NEXT_PUBLIC_RUNTIME_URL',
      message: 'Invalid URL format',
      value: config.apiUrl,
    });
  }

  if (config.apiUrl.endsWith('/')) {
    errors.push({
      field: 'NEXT_PUBLIC_RUNTIME_URL',
      message: 'URL should not end with trailing slash',
      value: config.apiUrl,
    });
  }

  if (config.apiUrl.includes('/ws')) {
    errors.push({
      field: 'NEXT_PUBLIC_RUNTIME_URL',
      message: 'URL should be base URL without /ws path',
      value: config.apiUrl,
    });
  }

  return errors;
}
