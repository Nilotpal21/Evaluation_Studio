import { createLogger } from '@abl/compiler/platform';
import type { RedisClient } from '@agent-platform/redis';

const log = createLogger('disposition-handler');
const DEFERRED_TTL_SECONDS = 86400; // 24 hours

export interface DeferredContext {
  tenantId: string;
  contactId: string;
  channel: string;
  provider: string;
  metadata?: Record<string, unknown>;
  storedAt: number;
}

export interface DispositionData {
  code: string;
  notes?: string;
  submittedAt: number;
}

export class DispositionHandler {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  private deferredKey(tenantId: string, contactId: string): string {
    return `at_deferred:${tenantId}:${contactId}`;
  }

  async storeDeferredContext(context: DeferredContext): Promise<void> {
    const key = this.deferredKey(context.tenantId, context.contactId);
    await this.redis.set(key, JSON.stringify(context), 'EX', DEFERRED_TTL_SECONDS);
    log.debug('Stored deferred context', {
      key,
      tenantId: context.tenantId,
    });
  }

  async getDeferredContext(tenantId: string, contactId: string): Promise<DeferredContext | null> {
    const key = this.deferredKey(tenantId, contactId);
    const data = await this.redis.get(key);
    if (!data) return null;
    try {
      return JSON.parse(data) as DeferredContext;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Failed to parse deferred context JSON', {
        key,
        error: message,
        rawData: data.slice(0, 200),
      });
      return null;
    }
  }

  async handleDispositionSubmitted(
    tenantId: string,
    contactId: string,
    disposition: DispositionData,
  ): Promise<void> {
    const key = this.deferredKey(tenantId, contactId);
    const existing = await this.redis.get(key);
    if (existing) {
      let context: DeferredContext;
      try {
        context = JSON.parse(existing) as DeferredContext;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Failed to parse existing deferred context for disposition merge', {
          key,
          error: message,
          rawData: existing.slice(0, 200),
        });
        // Skip the merge — cannot update corrupt data
        return;
      }
      context.metadata = {
        ...context.metadata,
        dispositionCode: disposition.code,
        wrapUpNotes: disposition.notes,
        dispositionSubmittedAt: disposition.submittedAt,
      };
      await this.redis.set(key, JSON.stringify(context), 'EX', DEFERRED_TTL_SECONDS);
    }
    log.info('Disposition submitted', {
      tenantId,
      contactId,
      code: disposition.code,
    });
  }

  async clearDeferredContext(tenantId: string, contactId: string): Promise<void> {
    const key = this.deferredKey(tenantId, contactId);
    await this.redis.del(key);
    log.debug('Cleared deferred context', { key });
  }
}
