/**
 * EventSubscriptionRegistry
 *
 * Tracks which tenants have subscribed to which event types. The RuntimeEventBus
 * consults this registry before delivering an event — if a tenant has no active
 * pipeline subscription for the event type, the event is dropped at zero cost.
 *
 * Subscriptions are periodically refreshed from the database via a sync function
 * so that pipeline configuration changes propagate without restart.
 */

import { createLogger } from '@abl/compiler/platform';

const log = createLogger('event-subscription-registry');

export type SyncFunction = () => Promise<Map<string, Set<string>>>;

export class EventSubscriptionRegistry {
  private subscriptions = new Map<string, Set<string>>();
  private syncTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Returns true if the given tenant has an active subscription for the event type.
   */
  isSubscribed(tenantId: string, eventType: string): boolean {
    const tenantSubs = this.subscriptions.get(tenantId);
    return tenantSubs !== undefined && tenantSubs.has(eventType);
  }

  /**
   * Replaces the entire subscription map. Called by the sync function or
   * directly in tests.
   */
  updateSubscriptions(newSubs: Map<string, Set<string>>): void {
    this.subscriptions = newSubs;
  }

  /**
   * Starts periodic sync. Calls syncFn immediately, then at intervalMs.
   */
  async startSync(syncFn: SyncFunction, intervalMs: number): Promise<void> {
    await this.refresh(syncFn);
    this.syncTimer = setInterval(() => {
      this.refresh(syncFn).catch((err) => {
        log.warn('Subscription registry periodic sync failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, intervalMs);
  }

  /**
   * Stops the periodic sync timer.
   */
  stop(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  private async refresh(syncFn: SyncFunction): Promise<void> {
    try {
      const newSubs = await syncFn();
      this.updateSubscriptions(newSubs);
      log.debug('Subscription registry refreshed', { tenantCount: newSubs.size });
    } catch (err) {
      log.warn('Subscription registry sync failed, keeping previous state', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
