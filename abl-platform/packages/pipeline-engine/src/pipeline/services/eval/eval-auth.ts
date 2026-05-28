/**
 * Eval Auth — Service-to-service JWT generation for eval pipeline.
 *
 * Uses the platform's centralized `createServiceToken` from @agent-platform/shared-auth
 * to produce properly signed JWTs that the runtime's `requireServiceAuth` middleware accepts.
 */
import { createServiceToken as createPlatformServiceToken } from '@agent-platform/shared-auth';
import { getConfig } from '../../config.js';

/**
 * Create a service-to-service JWT for Runtime API authentication.
 *
 * Delegates to the platform's `createServiceToken` which produces a JWT with:
 * - sub: 'service:<serviceName>'
 * - type: 'service'
 * - iss: 'agent-platform'
 * - aud: 'agent-platform-internal'
 * - tenantId + optional projectId in claims
 * - 5-minute expiry
 */
export function createServiceToken(tenantId: string, projectId?: string): string {
  const config = getConfig();
  return createPlatformServiceToken(config.jwt.secret, {
    tenantId,
    projectId,
    serviceName: config.eval.serviceUserId ?? 'pipeline-engine',
  });
}
