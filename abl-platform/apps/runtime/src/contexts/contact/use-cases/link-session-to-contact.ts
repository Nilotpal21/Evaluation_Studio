/**
 * Link Session To Contact Use Case
 *
 * Associates a session with a contact and updates channel interaction history.
 * Delegates to ContactRepository.linkSession() which handles session count
 * increment and channel history upsert.
 *
 * Port: ContactRepository
 */

import type { ChannelType } from '../../../channels/types.js';
import type { ContactRepository } from '../domain/contact-repository.js';
import type { ContactAuditEmitter } from '../infrastructure/contact-audit.js';

export class LinkSessionToContact {
  constructor(
    private readonly repo: ContactRepository,
    private readonly onAudit?: ContactAuditEmitter,
  ) {}

  async execute(
    tenantId: string,
    contactId: string,
    sessionId: string,
    channelType: ChannelType,
    channelId: string,
  ): Promise<void> {
    await this.repo.linkSession(tenantId, contactId, sessionId, channelType, channelId);

    this.onAudit?.({
      action: 'contact.session_linked',
      tenantId,
      contactId,
      metadata: { sessionId, channelType, channelId },
      timestamp: new Date(),
    }).catch((err: unknown) => {
      console.error('[contact-audit] Failed to emit contact.session_linked event', err);
    });
  }
}
