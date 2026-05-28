import { createLogger } from '@abl/compiler/platform';
import type { RedisClient } from '@agent-platform/redis';

const log = createLogger('citation-token-service');

export class CitationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CitationError';
    this.code = code;
  }
}

/**
 * Extract S3 key from sourceUrl.
 * Strips s3://bucket/ prefix or /uploads/ prefix.
 * e.g. "s3://my-bucket/documents/t1/idx/file.pdf" -> "documents/t1/idx/file.pdf"
 */
export function extractS3Key(sourceUrl: string): string {
  if (sourceUrl.startsWith('s3://')) {
    const withoutProtocol = sourceUrl.slice(5);
    const slashIndex = withoutProtocol.indexOf('/');
    return slashIndex >= 0 ? withoutProtocol.slice(slashIndex + 1) : withoutProtocol;
  }
  if (sourceUrl.startsWith('/uploads/')) {
    return sourceUrl.slice('/uploads/'.length);
  }
  return sourceUrl;
}

/**
 * Validate that an S3 key belongs to the specified tenant.
 * File upload keys use documents/{tenantId}/... pattern.
 * Crawled keys use crawler/cleaned/{tenantId}/... pattern.
 * assertTenantOwnsPath() only checks tenants/{id}/ or {id}/ -- doesn't work for these.
 */
export function validateTenantOwnership(tenantId: string, s3Key: string): void {
  if (!s3Key.includes(`/${tenantId}/`) && !s3Key.startsWith(`${tenantId}/`)) {
    throw new CitationError('TENANT_VIOLATION', 'S3 key does not belong to tenant');
  }
}

/**
 * Check and decrement click counter for click-limited citations.
 * Uses atomic Redis SET NX + DECR pattern (no TOCTOU race).
 *
 * Flow:
 *   1. SET NX initializes counter to maxClicks (only first time)
 *   2. DECR atomically decrements
 *   3. If remaining < 0 → exhausted (link is dead forever)
 *
 * IMPORTANT: We do NOT delete the key when exhausted. Deleting would allow
 * SET NX to reinitialize the counter, giving the user more clicks after
 * the TTL-protected key is gone. Instead we leave the negative value —
 * every future DECR stays negative, so the link stays dead until the
 * Redis TTL naturally garbage-collects the key (which is fine because
 * the JWT TTL matches the Redis TTL).
 */
export async function checkClickLimit(
  redis: RedisClient,
  jti: string,
  maxClicks: number,
  exp?: number,
): Promise<number> {
  const redisKey = `citation:clicks:${jti}`;
  // Derive TTL from JWT exp claim -- single source of truth.
  // Default 1 year (matches click_limited JWT TTL) so click counters survive long-lived tokens.
  const redisTtl = exp ? exp - Math.floor(Date.now() / 1000) : 31536000;

  if (redisTtl <= 0) {
    throw new CitationError('CITATION_EXPIRED', 'Citation link has expired');
  }

  // Atomic: SET NX first (only succeeds if key doesn't exist), then DECR
  await redis.set(redisKey, String(maxClicks), 'EX', redisTtl, 'NX');
  const remaining = await redis.decr(redisKey);

  if (remaining < 0) {
    // Don't delete — leave the negative counter so future attempts always fail.
    // The Redis TTL will garbage-collect the key eventually.
    throw new CitationError('CITATION_EXHAUSTED', 'Maximum clicks reached');
  }

  log.info('Citation click tracked', { jti, remaining });
  return remaining;
}
