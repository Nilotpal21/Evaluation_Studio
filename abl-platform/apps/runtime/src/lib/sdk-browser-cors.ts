import { isBrowserSdkRoute } from '@agent-platform/shared';
import type { RuntimeConfig } from '../config/index.js';

const BROWSER_SDK_REQUIRED_CORS_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-SDK-Token',
  'X-Public-Key',
  'X-Tenant-Id',
  'X-Request-Id',
] as const;

const BROWSER_SDK_REQUIRED_CORS_METHODS = ['POST', 'OPTIONS'] as const;

interface RuntimeCorsRequestShape {
  path: string;
  headers: {
    origin?: string | string[] | undefined;
  };
}

function hasOriginHeader(request: RuntimeCorsRequestShape): boolean {
  const origin = request.headers.origin;
  if (Array.isArray(origin)) {
    return origin.some((value) => value.trim().length > 0);
  }
  return typeof origin === 'string' && origin.trim().length > 0;
}

export function isBrowserSdkCorsRoute(path: string): boolean {
  return isBrowserSdkRoute(path);
}

function resolveDefaultOriginPolicy(
  config: Pick<RuntimeConfig, 'env' | 'server' | 'cors'>,
): string | string[] | boolean {
  if (config.env === 'production') {
    return config.server.frontendUrl ?? config.cors.origins;
  }

  return config.cors.origins;
}

export function resolveRuntimeCorsOrigin(
  request: RuntimeCorsRequestShape,
  config: Pick<RuntimeConfig, 'env' | 'server' | 'cors'>,
): string | string[] | boolean {
  const defaultOrigin = resolveDefaultOriginPolicy(config);

  if (!hasOriginHeader(request)) {
    return defaultOrigin;
  }

  if (isBrowserSdkCorsRoute(request.path)) {
    // Browser SDK routes must reflect the caller origin so external websites can
    // complete preflight and read SDK auth failures. The actual allowlist is
    // enforced later by the SDK auth layer once the key/channel is known.
    return true;
  }

  return defaultOrigin;
}

function mergeCaseInsensitiveValues(
  configuredValues: string[],
  requiredValues: readonly string[],
): string[] {
  const merged = [...configuredValues];
  const configuredLookup = new Set(configuredValues.map((value) => value.toLowerCase()));

  for (const requiredValue of requiredValues) {
    if (!configuredLookup.has(requiredValue.toLowerCase())) {
      merged.push(requiredValue);
    }
  }

  return merged;
}

export function resolveRuntimeCorsAllowedHeaders(
  request: Pick<RuntimeCorsRequestShape, 'path'>,
  config: Pick<RuntimeConfig, 'cors'>,
): string[] {
  if (!isBrowserSdkCorsRoute(request.path)) {
    return config.cors.allowedHeaders;
  }

  return mergeCaseInsensitiveValues(config.cors.allowedHeaders, BROWSER_SDK_REQUIRED_CORS_HEADERS);
}

export function resolveRuntimeCorsMethods(
  request: Pick<RuntimeCorsRequestShape, 'path'>,
  config: Pick<RuntimeConfig, 'cors'>,
): string[] {
  if (!isBrowserSdkCorsRoute(request.path)) {
    return config.cors.methods;
  }

  return mergeCaseInsensitiveValues(config.cors.methods, BROWSER_SDK_REQUIRED_CORS_METHODS);
}
