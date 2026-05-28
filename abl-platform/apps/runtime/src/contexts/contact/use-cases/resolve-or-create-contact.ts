/**
 * Resolve Or Create Contact Use Case
 *
 * Given an identity (email, phone, external), resolves to an existing contact
 * via blind index lookup or creates a new contact with encrypted identity.
 * All operations are tenant-scoped for isolation.
 *
 * Ports: ContactRepository, EncryptionService
 */

import crypto from 'node:crypto';
import { createLogger } from '@abl/compiler/platform';
import type { ContactIdentityType } from '../domain/contact-identity.js';
import { createContactIdentity } from '../domain/contact-identity.js';
import type { Contact } from '../domain/contact.js';
import type { ContactRepository } from '../domain/contact-repository.js';
import type { EncryptionService } from '@agent-platform/shared/encryption';
import { normalizeIdentity } from '../infrastructure/normalize-identity.js';
import type { ContactAuditEmitter } from '../infrastructure/contact-audit.js';

const log = createLogger('resolve-or-create-contact');

export interface ResolveOrCreateContactAuditOptions {
  suppressContactCreatedAudit?: boolean;
  contactAuditSource?:
    | 'customer_id'
    | 'channel_artifact'
    | 'session_principal'
    | 'anonymous_id'
    | 'explicit';
}

export class ResolveOrCreateContact {
  constructor(
    private readonly repo: ContactRepository,
    private readonly encryptor: EncryptionService,
    private readonly onAudit?: ContactAuditEmitter,
  ) {}

  async execute(
    tenantId: string,
    identityType: ContactIdentityType,
    identityValue: string,
    channelType?: string,
    auditOptions: ResolveOrCreateContactAuditOptions = {},
  ): Promise<Contact> {
    const normalized = normalizeIdentity(identityType, identityValue);
    const blindIdx = this.encryptor.blindIndex(tenantId, normalized);

    // Look up existing contact by blind index (tenant-scoped)
    const existing = await this.repo.findByBlindIndex(tenantId, blindIdx);
    if (existing) {
      return existing;
    }

    // No match — create a new contact with encrypted identity
    const encryptedValue = this.encryptor.encryptContactPII(tenantId, normalized);
    const now = new Date();

    const identity = createContactIdentity({
      type: identityType,
      encryptedValue,
      blindIndex: blindIdx,
      channel: channelType ?? null,
    });

    const contact: Contact = {
      id: crypto.randomUUID(),
      tenantId,
      identities: [identity],
      displayName: null,
      type: 'customer',
      metadata: {},
      tags: [],
      channelHistory: [],
      sessionCount: 0,
      firstSeenAt: now,
      lastSeenAt: now,
      mergedInto: null,
      deletedAt: null,
      encryptionSalt: crypto.randomBytes(32).toString('hex'),
      contactContext: null,
    };

    const created = await this.repo.create(contact);

    if (!auditOptions.suppressContactCreatedAudit) {
      this.onAudit?.({
        action: 'contact.created',
        tenantId,
        contactId: created.id,
        metadata: auditOptions.contactAuditSource
          ? { source: auditOptions.contactAuditSource }
          : undefined,
        timestamp: new Date(),
      }).catch((err: unknown) => {
        // Audit failure must not break the primary operation
        log.warn('Failed to emit contact.created audit event', {
          tenantId,
          contactId: created.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return created;
  }
}
