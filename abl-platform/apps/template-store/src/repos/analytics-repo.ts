/**
 * Analytics Repository
 *
 * Records marketplace analytics events (views, searches, category browsing).
 * Events auto-expire after 90 days via TTL index on the model.
 *
 * IP addresses are one-way hashed before storage (never stored in plain text).
 */

import crypto from 'node:crypto';
import { createLogger } from '@agent-platform/shared-observability';

const log = createLogger('analytics-repo');

// ─── Types ────────────────────────────────────────────────────────────────

export interface TrackEventInput {
  eventType:
    | 'marketplace_view'
    | 'detail_view'
    | 'search'
    | 'category_browse'
    | 'bundle_access'
    | 'install';
  templateId?: string;
  templateSlug?: string;
  userId?: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
  ipHash?: string;
}

// ─── IP Hashing ───────────────────────────────────────────────────────────

/**
 * Create a one-way hash of an IP address for analytics tracking.
 * Returns first 16 hex characters of the SHA-256 hash.
 */
export function hashIp(ip: string): string {
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

// ─── Repository Functions ─────────────────────────────────────────────────

/**
 * Record an analytics event. Fire-and-forget — errors are logged but not thrown.
 */
export async function trackEvent(input: TrackEventInput): Promise<void> {
  try {
    const { TemplateAnalyticsEvent } = await import('@agent-platform/database/models');

    await TemplateAnalyticsEvent.create({
      eventType: input.eventType,
      templateId: input.templateId ?? null,
      templateSlug: input.templateSlug ?? null,
      userId: input.userId ?? null,
      tenantId: input.tenantId ?? null,
      metadata: input.metadata ?? null,
      ipHash: input.ipHash ?? null,
      createdAt: new Date(),
    });

    log.debug('Analytics event recorded', {
      eventType: input.eventType,
      templateSlug: input.templateSlug,
    });
  } catch (err) {
    log.error('Failed to record analytics event', {
      error: err instanceof Error ? err.message : String(err),
      eventType: input.eventType,
    });
  }
}
