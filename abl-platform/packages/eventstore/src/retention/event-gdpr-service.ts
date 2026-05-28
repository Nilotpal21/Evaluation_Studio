/**
 * EventGDPRService - handles GDPR right-to-erasure requests.
 *
 * Delegates to IEventLifecycle for:
 * - deleteBySessionIds: Session cascade deletion
 * - anonymizeActor: Actor identity anonymization
 * - deleteTenant: Tenant offboarding
 *
 * Integrated into existing cascade-delete functions.
 */

import type { IEventGDPR } from '../interfaces/event-gdpr.js';
import type { IEventLifecycle } from '../interfaces/event-store.js';

export class EventGDPRService implements IEventGDPR {
  constructor(private lifecycle: IEventLifecycle) {}

  async deleteBySessionIds(tenantId: string, sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) return;

    await this.lifecycle.deleteBySessionIds(tenantId, sessionIds);
  }

  async anonymizeActor(tenantId: string, actorId: string): Promise<void> {
    await this.lifecycle.anonymizeActor(tenantId, actorId);
  }

  async deleteTenant(tenantId: string): Promise<void> {
    await this.lifecycle.deleteTenant(tenantId);
  }
}
