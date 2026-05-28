/**
 * Lazy singleton accessor for the runtime's FeedbackService instance.
 *
 * Construction is deferred until first use so that the ClickHouse client
 * and EventStore have a chance to initialize on server startup. The
 * singleton is rebuilt only via `_resetFeedbackServiceForTesting()` —
 * production code never tears it down.
 */

import { FeedbackService } from './feedback-service.js';
import { getStores } from '../stores/store-factory.js';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import { getClickHouseEncryptionInterceptor } from '../stores/clickhouse-encryption-singleton.js';
import { getRedisClient } from '../redis/redis-client.js';
import { getEventStore } from '../eventstore-singleton.js';
import { getTraceStore } from '../trace-store.js';
import type { RedisLikeClient } from './dedup.js';

let _service: FeedbackService | null = null;

export function getFeedbackService(): FeedbackService {
  if (_service) return _service;
  _service = new FeedbackService({
    messageStore: getStores().message,
    clickhouseClient: getClickHouseClient(),
    encryptionInterceptor: getClickHouseEncryptionInterceptor(),
    redis: getRedisClient() as RedisLikeClient | null,
    eventStore: getEventStore(),
    traceStore: getTraceStore(),
  });
  return _service;
}

export function _resetFeedbackServiceForTesting(): void {
  _service = null;
}

/**
 * Test seam: inject a pre-built FeedbackService so the WS handler exercises
 * the real ingress + ack logic against a service constructed from DI fakes
 * (rather than reaching for the runtime singletons). Production paths never
 * call this.
 */
export function _setFeedbackServiceForTesting(service: FeedbackService): void {
  _service = service;
}
