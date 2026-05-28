/**
 * Port adapters bridging compiler port interfaces to runtime implementations.
 *
 * The compiler's GuardrailPipelineImpl accepts port interfaces (GuardrailCachePort,
 * CostCheckerPort, WebhookPort) that have simple per-call signatures. The runtime
 * implementations (GuardrailCache, GuardrailCostTracker, GuardrailWebhookDelivery)
 * require tenantId/projectId scoping. These adapters bind the scoping parameters
 * at construction time so the pipeline can call ports without knowing about tenants.
 */

import type { GuardrailCachePort, CostCheckerPort, WebhookPort } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import type { GuardrailCache } from './cache.js';
import type { GuardrailCostTracker, CostBudget } from './cost-tracker.js';
import type { GuardrailWebhookDelivery } from './webhook.js';

const log = createLogger('port-adapters');
const DEFAULT_CACHE_SCOPE_KEY = 'global';

/**
 * Adapts GuardrailCache (tenant/project-scoped) to the GuardrailCachePort interface.
 *
 * Binds tenantId and projectId at construction so callers only need
 * guardrailName, content, and tier.
 */
export class CacheAdapter implements GuardrailCachePort {
  private readonly cache: GuardrailCache;
  private readonly tenantId: string;
  private readonly projectId: string;
  private readonly defaultTtlSeconds?: number;
  private readonly scopeKey: string;

  constructor(
    cache: GuardrailCache,
    tenantId: string,
    projectId: string,
    options?: { defaultTtlSeconds?: number; scopeKey?: string },
  ) {
    this.cache = cache;
    this.tenantId = tenantId;
    this.projectId = projectId;
    this.defaultTtlSeconds = options?.defaultTtlSeconds;
    this.scopeKey = options?.scopeKey ?? DEFAULT_CACHE_SCOPE_KEY;
  }

  async get(guardrailName: string, content: string, tier: string): Promise<unknown | null> {
    return this.cache.get(this.tenantId, this.projectId, guardrailName, content, {
      tier,
      scopeKey: this.scopeKey,
    });
  }

  async set(guardrailName: string, content: string, tier: string, result: unknown): Promise<void> {
    await this.cache.set(
      this.tenantId,
      this.projectId,
      guardrailName,
      content,
      tier,
      result as Parameters<GuardrailCache['set']>[5],
      this.defaultTtlSeconds,
      { tier, scopeKey: this.scopeKey },
    );
  }
}

/**
 * Adapts GuardrailCostTracker (tenant/project-scoped) to the CostCheckerPort interface.
 *
 * Binds tenantId, projectId, and optional budget at construction.
 */
export class CostCheckerAdapter implements CostCheckerPort {
  private readonly tracker: GuardrailCostTracker;
  private readonly tenantId: string;
  private readonly projectId: string;
  private readonly budget?: CostBudget;

  constructor(
    tracker: GuardrailCostTracker,
    tenantId: string,
    projectId: string,
    budget?: CostBudget,
  ) {
    this.tracker = tracker;
    this.tenantId = tenantId;
    this.projectId = projectId;
    this.budget = budget;
  }

  async checkBudget(): Promise<{
    exceeded: boolean;
    action: 'downgrade' | 'disable_model_checks' | 'alert_only' | 'none';
  }> {
    const result = await this.tracker.checkBudget(this.tenantId, this.projectId, this.budget);
    return {
      exceeded: result.exceeded,
      action: result.action === 'allow' ? 'alert_only' : result.action,
    };
  }

  async recordCost(costUsd: number): Promise<void> {
    await this.tracker.recordCost(this.tenantId, this.projectId, costUsd);
  }
}

/**
 * Adapts GuardrailWebhookDelivery to the WebhookPort interface.
 *
 * Simple pass-through — the WebhookDeliveryResult return value is ignored
 * since the port interface returns void.
 */
export class WebhookAdapter implements WebhookPort {
  private readonly delivery: GuardrailWebhookDelivery;

  constructor(delivery: GuardrailWebhookDelivery) {
    this.delivery = delivery;
  }

  async deliver(event: {
    type: string;
    timestamp: number;
    data: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.delivery.deliver(event);
    } catch (err) {
      log.warn('Webhook delivery failed via port adapter', {
        eventType: event.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
