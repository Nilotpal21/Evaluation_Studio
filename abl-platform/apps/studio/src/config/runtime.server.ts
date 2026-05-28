import 'server-only';

/**
 * Server-only Runtime configuration.
 *
 * Private env vars and control-plane Runtime resolution belong here so client
 * code never accidentally depends on them.
 */

import {
  createPublicRuntimeConfig,
  DEFAULT_RUNTIME_URL,
  INVALID_RUNTIME_URL_ERROR,
  normalizeRuntimeUrl,
  type RuntimeConfig,
} from './runtime.public';

const MISSING_RUNTIME_URL_ERROR = 'RUNTIME_URL must be configured for Studio Runtime exchanges.';

export { INVALID_RUNTIME_URL_ERROR } from './runtime.public';

function getConfiguredPublicRuntimeUrl(): string | undefined {
  const configured =
    process.env.RUNTIME_PUBLIC_BASE_URL?.trim() || process.env.NEXT_PUBLIC_RUNTIME_URL?.trim();
  return configured && configured.length > 0 ? configured : undefined;
}

/**
 * Runtime base URL for server-side control-plane requests.
 *
 * Server resolution: RUNTIME_URL → localhost fallback.
 */
export function getRuntimeUrl(): string {
  return process.env.RUNTIME_URL ?? DEFAULT_RUNTIME_URL;
}

/**
 * Required Runtime URL for server-side exchanges that must not fail open.
 */
export function getRequiredRuntimeUrl(): string {
  const configured = process.env.RUNTIME_URL;
  if (typeof configured !== 'string' || configured.trim().length === 0) {
    throw new Error(MISSING_RUNTIME_URL_ERROR);
  }

  try {
    return normalizeRuntimeUrl(configured);
  } catch {
    throw new Error(INVALID_RUNTIME_URL_ERROR);
  }
}

/**
 * Public/browser-facing Runtime config injected into Studio pages.
 *
 * Missing public config intentionally resolves to empty URLs so browser code
 * falls back to same-origin routing instead of silently targeting localhost.
 */
export function getPublicRuntimeConfig(): RuntimeConfig {
  return createPublicRuntimeConfig(
    getConfiguredPublicRuntimeUrl(),
    process.env.NODE_ENV !== 'production',
  );
}

/**
 * Resolve the browser-visible Runtime endpoint for SDK embed snippets.
 *
 * Prefer an explicitly configured public Runtime base. When none is configured,
 * fall back to the current request origin so same-host Studio+Runtime
 * deployments can generate working embed snippets without a separate public var.
 *
 * Split-host deployments should set RUNTIME_PUBLIC_BASE_URL explicitly.
 */
export function resolveSdkEmbedRuntimeUrl(requestOrigin: string): string {
  const configuredPublic = getConfiguredPublicRuntimeUrl();
  if (configuredPublic) {
    return normalizeRuntimeUrl(configuredPublic);
  }

  return normalizeRuntimeUrl(requestOrigin);
}
