/**
 * RuntimeEventBus
 *
 * Core event bus implementation. Delivers PlatformEvents to registered
 * subscribers, gated by the EventSubscriptionRegistry — events for tenants
 * without active pipeline subscriptions are silently dropped.
 *
 * Subscriber errors are caught and logged to prevent a single faulty
 * subscriber from breaking the delivery chain.
 */

import { createLogger } from '@abl/compiler/platform';
import type { AnyPlatformEvent, EventBus, EventSubscriber } from './types.js';
import type { EventSubscriptionRegistry } from './subscription-registry.js';

const log = createLogger('event-bus');

export class RuntimeEventBus implements EventBus {
  private subscribers: EventSubscriber[] = [];
  private stopped = false;

  constructor(private registry: EventSubscriptionRegistry) {}

  emit(event: AnyPlatformEvent): void {
    if (this.stopped) return;
    if (!this.registry.isSubscribed(event.tenantId, event.type)) return;

    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch (err) {
        log.warn('EventBus subscriber threw', {
          eventType: event.type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  subscribe(fn: EventSubscriber): void {
    this.subscribers.push(fn);
  }

  unsubscribe(fn: EventSubscriber): void {
    this.subscribers = this.subscribers.filter((s) => s !== fn);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.subscribers = [];
    log.info('EventBus shut down');
  }
}
