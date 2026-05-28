/**
 * Observability Middleware — Thin wrapper around shared-observability.
 *
 * Auto-injects getTenantContext so callers don't have to wire it manually.
 */

import {
  createObservabilityMiddleware as createBase,
  type ObservabilityMiddlewareConfig as BaseConfig,
  type ObservabilityContext,
} from '@agent-platform/shared-observability';
import { getTenantContextData } from './tenant-context.js';

export type { ObservabilityContext };

export type ObservabilityMiddlewareConfig = Omit<BaseConfig, 'getTenantContext'>;

/**
 * Create an observability middleware that automatically reads tenant context
 * from AsyncLocalStorage (set by the upstream auth middleware).
 */
export function createObservabilityMiddleware(config: ObservabilityMiddlewareConfig) {
  return createBase({
    ...config,
    getTenantContext: getTenantContextData,
  });
}
