/**
 * PendingDeliveryStore — Redis-backed store for async results that couldn't
 * be delivered in real-time (e.g., WebSocket disconnected).
 *
 * Uses a Redis LIST per sessionId so multiple async results can accumulate
 * while the user is offline. Items are delivered on reconnection and removed.
 *
 * Key pattern: pending:delivery:{sessionId} → LIST of JSON entries
 * TTL: 24 hours (configurable)
 */

import { createLogger } from '@abl/compiler/platform';
import type { ActionSetIR, RichContentIR, VoiceConfigIR } from '@abl/compiler';
import type { ChannelBinding } from '@agent-platform/execution';
import type { ResponseMessageMetadata } from '../channel/response-provenance.js';
import type { PersistedMessageLocalizationOwnershipV1 } from '../session/persisted-message-content.js';

const log = createLogger('pending-delivery-store');

const DEFAULT_TTL_SECONDS = 86400; // 24 hours

export interface PendingDeliveryEntry {
  executionId?: string;
  result: {
    response: string;
    stateUpdates?: Record<string, unknown>;
    richContent?: RichContentIR;
    actions?: ActionSetIR;
    voiceConfig?: VoiceConfigIR;
    executionId?: string;
    responseMetadata?: ResponseMessageMetadata;
    localization?: PersistedMessageLocalizationOwnershipV1;
  };
  channelBinding: ChannelBinding;
  storedAt: number;
}

/**
 * Minimal Redis client interface for pending delivery operations.
 * ioredis Redis and Cluster both satisfy this at runtime.
 */
export interface PendingDeliveryRedisClient {
  rpush(key: string, ...values: string[]): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  del(key: string | string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

export class PendingDeliveryStore {
  private readonly keyPrefix = 'pending:delivery';
  private readonly ttlSeconds: number;

  constructor(
    private readonly redis: PendingDeliveryRedisClient,
    ttlSeconds?: number,
  ) {
    this.ttlSeconds = ttlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  async store(
    sessionId: string,
    binding: ChannelBinding,
    result: PendingDeliveryEntry['result'],
  ): Promise<void> {
    const key = `${this.keyPrefix}:${sessionId}`;
    const entry: PendingDeliveryEntry = {
      result,
      channelBinding: binding,
      storedAt: Date.now(),
    };

    try {
      await this.redis.rpush(key, JSON.stringify(entry));
      await this.redis.expire(key, this.ttlSeconds);
    } catch (err) {
      log.warn('Failed to store pending delivery', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async retrieve(sessionId: string): Promise<PendingDeliveryEntry[]> {
    const key = `${this.keyPrefix}:${sessionId}`;
    try {
      const items = await this.redis.lrange(key, 0, -1);
      return items.map((item) => JSON.parse(item) as PendingDeliveryEntry);
    } catch (err) {
      log.warn('Failed to retrieve pending deliveries', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  async remove(sessionId: string): Promise<void> {
    const key = `${this.keyPrefix}:${sessionId}`;
    try {
      await this.redis.del(key);
    } catch (err) {
      log.warn('Failed to remove pending deliveries', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
