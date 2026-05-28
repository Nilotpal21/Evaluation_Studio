/**
 * EventWebhookForwarder - forwards events to tenant webhook subscriptions.
 *
 * Features:
 * - Pattern matching: `events.session.*` matches `session.started`, `session.ended`, etc.
 * - Enqueues to existing BullMQ `webhook-delivery` queue
 * - Subscription cache: in-memory Map with 1-min TTL, max 1000 entries
 * - Non-blocking: maybeForward() is async fire-and-forget
 *
 * Reuses existing webhook infrastructure:
 * - HMAC-SHA256 signing
 * - SSRF protection
 * - Retry logic (3 attempts with exponential backoff)
 * - Idempotency
 */

import { createLogger } from '@agent-platform/shared-observability';
import type { PlatformEvent } from '../schema/platform-event.js';

const log = createLogger('eventstore:webhook-forwarder');

export interface WebhookSubscription {
  id: string;
  tenantId: string;
  eventPattern: string; // e.g., "events.session.*", "events.llm.call.completed"
  url: string;
  secret: string;
  enabled: boolean;
}

export interface WebhookForwarderConfig {
  deliveryQueue: unknown; // BullMQ queue instance
  getSubscriptions: (tenantId: string) => Promise<WebhookSubscription[]>;
  cacheTTLMs?: number; // default: 60000 (1 minute)
  maxCacheSize?: number; // default: 1000
}

export class EventWebhookForwarder {
  private subscriptionCache = new Map<
    string,
    { subscriptions: WebhookSubscription[]; expiresAt: number }
  >();
  private readonly cacheTTL: number;
  private readonly maxCacheSize: number;

  constructor(private config: WebhookForwarderConfig) {
    this.cacheTTL = config.cacheTTLMs ?? 60_000;
    this.maxCacheSize = config.maxCacheSize ?? 1000;

    // Periodic cache cleanup (every 2 minutes)
    setInterval(() => this.cleanupCache(), 120_000).unref?.();
  }

  /**
   * Check subscriptions and forward event if matches.
   * Non-blocking, fire-and-forget.
   */
  async maybeForward(event: PlatformEvent): Promise<void> {
    try {
      // Get subscriptions for tenant (cached)
      const subscriptions = await this.getSubscriptionsForTenant(event.tenant_id);

      // Find matching subscriptions
      const matches = subscriptions.filter(
        (sub) => sub.enabled && this.matchesPattern(event.event_type, sub.eventPattern),
      );

      if (matches.length === 0) return;

      // Enqueue webhook deliveries
      for (const subscription of matches) {
        await this.enqueueWebhook(subscription, event);
      }
    } catch (err) {
      log.error('Failed to forward event', {
        eventId: event.event_id,
        eventType: event.event_type,
        error: err instanceof Error ? err.message : String(err),
      });
      // Don't throw - webhook forwarding failures should not block event processing
    }
  }

  /**
   * Get subscriptions for tenant (with caching).
   */
  private async getSubscriptionsForTenant(tenantId: string): Promise<WebhookSubscription[]> {
    const cached = this.subscriptionCache.get(tenantId);
    const now = Date.now();

    // Check cache
    if (cached && now < cached.expiresAt) {
      return cached.subscriptions;
    }

    // Fetch from database
    const subscriptions = await this.config.getSubscriptions(tenantId);

    // Evict oldest entry if at max size
    if (this.subscriptionCache.size >= this.maxCacheSize && !this.subscriptionCache.has(tenantId)) {
      const firstKey = this.subscriptionCache.keys().next().value;
      if (firstKey !== undefined) {
        this.subscriptionCache.delete(firstKey);
      }
    }

    // Cache result
    this.subscriptionCache.set(tenantId, {
      subscriptions,
      expiresAt: now + this.cacheTTL,
    });

    return subscriptions;
  }

  /**
   * Check if event type matches subscription pattern.
   * Pattern examples:
   *   "events.session.*" matches "session.started", "session.ended"
   *   "events.llm.call.completed" matches exactly "llm.call.completed"
   */
  private matchesPattern(eventType: string, pattern: string): boolean {
    // Remove "events." prefix from pattern if present
    const cleanPattern = pattern.startsWith('events.') ? pattern.slice(7) : pattern;

    // Exact match
    if (cleanPattern === eventType) return true;

    // Wildcard match
    if (cleanPattern.endsWith('.*')) {
      const prefix = cleanPattern.slice(0, -2); // Remove ".*"
      return eventType.startsWith(prefix + '.');
    }

    return false;
  }

  /**
   * Enqueue webhook delivery to BullMQ queue.
   */
  private async enqueueWebhook(
    subscription: WebhookSubscription,
    event: PlatformEvent,
  ): Promise<void> {
    const queue = this.config.deliveryQueue as {
      add: (name: string, data: unknown) => Promise<unknown>;
    };

    await queue.add('webhook-delivery', {
      subscriptionId: subscription.id,
      url: subscription.url,
      secret: subscription.secret,
      event: {
        event_id: event.event_id,
        event_type: event.event_type,
        timestamp: event.timestamp.toISOString(),
        tenant_id: event.tenant_id,
        project_id: event.project_id,
        session_id: event.session_id,
        agent_name: event.agent_name,
        data: event.data,
      },
    });
  }

  /**
   * Cleanup expired cache entries.
   */
  private cleanupCache(): void {
    const now = Date.now();
    for (const [key, value] of this.subscriptionCache.entries()) {
      if (now > value.expiresAt) {
        this.subscriptionCache.delete(key);
      }
    }
  }

  /**
   * Clear cache (for testing or manual refresh).
   */
  clearCache(): void {
    this.subscriptionCache.clear();
  }
}
