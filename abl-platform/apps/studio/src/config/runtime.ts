/**
 * Browser-safe Runtime configuration.
 *
 * This module is safe to import from client code. It only relies on
 * build-time public env values and pure helpers from `runtime.public.ts`.
 *
 * Server-only Runtime resolution (private env vars, required control-plane
 * exchanges, embed endpoint resolution) lives in `runtime.server.ts`.
 */

import {
  createPublicRuntimeConfig,
  type ConfigValidationError,
  type RuntimeConfig,
  validateRuntimeConfig as validateResolvedRuntimeConfig,
} from './runtime.public';

/**
 * Browser-safe Runtime base URL.
 *
 * Missing public config intentionally resolves to an empty string so browser
 * callers use same-origin routing instead of silently targeting localhost.
 */
export function getRuntimeUrl(): string {
  return process.env.NEXT_PUBLIC_RUNTIME_URL?.replace(/\/+$/, '') ?? '';
}

/**
 * Public/browser-facing Runtime config.
 */
export function getPublicRuntimeConfig(): RuntimeConfig {
  return createPublicRuntimeConfig(
    process.env.NEXT_PUBLIC_RUNTIME_URL,
    process.env.NODE_ENV !== 'production',
  );
}

/**
 * Backward-compatible public config validation entrypoint.
 */
export function validateRuntimeConfig(): ConfigValidationError[] {
  return validateResolvedRuntimeConfig(getPublicRuntimeConfig());
}

/**
 * Browser-safe Runtime health check.
 */
export async function checkRuntimeHealth(): Promise<{
  healthy: boolean;
  error?: string;
  latencyMs?: number;
}> {
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(`${getRuntimeUrl()}/health`, {
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      return {
        healthy: false,
        error: `Health check returned ${res.status}`,
        latencyMs: Date.now() - start,
      };
    }

    return {
      healthy: true,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      healthy: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

export type { ConfigValidationError, RuntimeConfig } from './runtime.public';
export {
  INVALID_RUNTIME_URL_ERROR,
  normalizeRuntimeUrl,
  resolveBrowserWsUrl,
} from './runtime.public';
