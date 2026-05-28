/**
 * Self Merge Use Case
 *
 * When a contact provides a new identity (e.g. logs in with email after
 * using phone), checks if another contact already owns that identity.
 * If so, merges the two contacts. If not, adds the identity to the
 * current contact.
 *
 * Ports: ContactRepository, EncryptionService
 */

import type { ContactIdentityType } from '../domain/contact-identity.js';
import { createContactIdentity } from '../domain/contact-identity.js';
import type { Contact } from '../domain/contact.js';
import type { ContactRepository } from '../domain/contact-repository.js';
import type { EncryptionService } from '@agent-platform/shared/encryption';
import { normalizeIdentity } from '../infrastructure/normalize-identity.js';
import type { ContactAuditEmitter } from '../infrastructure/contact-audit.js';
import { ExecuteMerge } from './execute-merge.js';
import type { SessionReassigner } from './execute-merge.js';

interface SelfMergeResult {
  success: boolean;
  contact: Contact | null;
  merged: boolean;
  error?: { code: string; message: string };
}

export class SelfMerge {
  private readonly executeMerge: ExecuteMerge;

  constructor(
    private readonly repo: ContactRepository,
    private readonly encryptor: EncryptionService,
    private readonly onAudit?: ContactAuditEmitter,
    private readonly sessionReassigner?: SessionReassigner,
  ) {
    this.executeMerge = new ExecuteMerge(repo, onAudit, sessionReassigner);
  }

  async execute(
    tenantId: string,
    currentContactId: string,
    identityType: ContactIdentityType,
    identityValue: string,
  ): Promise<SelfMergeResult> {
    const normalized = normalizeIdentity(identityType, identityValue);
    const blindIdx = this.encryptor.blindIndex(tenantId, normalized);

    // Check if another contact already has this identity
    const existingContact = await this.repo.findByBlindIndex(tenantId, blindIdx);

    if (existingContact && existingContact.id !== currentContactId) {
      // Another contact owns this identity — merge current into existing
      // The existing contact (with the verified identity) is primary.
      // Determine primary by recency: more recently seen contact is primary.
      const current = await this.repo.findById(tenantId, currentContactId);
      if (!current) {
        return {
          success: false,
          contact: null,
          merged: false,
          error: {
            code: 'CONTACT_NOT_FOUND',
            message: `Current contact not found: ${currentContactId}`,
          },
        };
      }

      const primaryId =
        existingContact.lastSeenAt >= current.lastSeenAt ? existingContact.id : current.id;
      const secondaryId = primaryId === existingContact.id ? current.id : existingContact.id;

      const mergeResult = await this.executeMerge.execute(tenantId, primaryId, secondaryId, 'self');
      if (!mergeResult.success) {
        return {
          success: false,
          contact: null,
          merged: false,
          error: mergeResult.error,
        };
      }

      const mergedContact = await this.repo.findById(tenantId, primaryId);

      this.onAudit?.({
        action: 'contact.self_merged',
        tenantId,
        contactId: primaryId,
        metadata: { primaryContactId: primaryId, secondaryContactId: secondaryId },
        timestamp: new Date(),
      }).catch((err: unknown) => {
        console.error('[contact-audit] Failed to emit contact.self_merged event', err);
      });

      return { success: true, contact: mergedContact, merged: true };
    }

    // No existing contact with this identity — add it to current
    if (!existingContact || existingContact.id === currentContactId) {
      // Check if the current contact already has this identity
      const current = await this.repo.findById(tenantId, currentContactId);
      if (!current) {
        return {
          success: false,
          contact: null,
          merged: false,
          error: {
            code: 'CONTACT_NOT_FOUND',
            message: `Current contact not found: ${currentContactId}`,
          },
        };
      }

      const alreadyHas = current.identities.some((i) => i.blindIndex === blindIdx);
      if (alreadyHas) {
        return { success: true, contact: current, merged: false };
      }

      const encryptedValue = this.encryptor.encryptContactPII(tenantId, normalized);
      const identity = createContactIdentity({
        type: identityType,
        encryptedValue,
        blindIndex: blindIdx,
      });

      await this.repo.addIdentity(tenantId, currentContactId, identity);

      this.onAudit?.({
        action: 'contact.identity_added',
        tenantId,
        contactId: currentContactId,
        metadata: { identityType },
        timestamp: new Date(),
      }).catch((err: unknown) => {
        console.error('[contact-audit] Failed to emit contact.identity_added event', err);
      });

      const updated = await this.repo.findById(tenantId, currentContactId);
      return { success: true, contact: updated, merged: false };
    }

    return { success: true, contact: existingContact, merged: false };
  }
}
