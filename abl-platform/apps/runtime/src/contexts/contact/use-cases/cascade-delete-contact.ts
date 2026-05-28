/**
 * Cascade Delete Contact Use Case
 *
 * Performs a hard-delete of a contact (right to erasure / GDPR compliance):
 * 1. Loads the contact (verifies tenant ownership)
 * 2. Cleans up resolution keys (cross-context, optional)
 * 3. Hard-deletes via repository (removes all data)
 * 4. Emits an audit event via callback port
 *
 * The audit callback is a port so callers can plug in their audit infrastructure
 * without coupling this use case to a specific audit store.
 *
 * Resolution key cleanup runs before hard-delete so that if it fails,
 * the contact record is still intact (better failure mode for GDPR retries).
 *
 * Ports: ContactRepository, AuditCallback, ResolutionKeyCleanup (optional)
 */

import { createLogger } from '@abl/compiler/platform';
import type { ContactRepository } from '../domain/contact-repository.js';

const log = createLogger('cascade-delete-contact');

/**
 * Audit event emitted after a contact is hard-deleted.
 * Contains enough context for compliance auditing without PII.
 */
export interface ContactDeletedAuditEvent {
  action: 'contact.hard_deleted';
  tenantId: string;
  contactId: string;
  identityCount: number;
  sessionCount: number;
  scrubbedMessageCount?: number;
  timestamp: Date;
}

/** Callback port for emitting audit events after contact deletion. */
export type AuditCallback = (event: ContactDeletedAuditEvent) => Promise<void>;

/** Optional callback to clean up resolution keys when a contact is deleted. */
export type ResolutionKeyCleanup = (tenantId: string, contactId: string) => Promise<void>;

/**
 * Optional port that purges `memory.user.*` facts owned by the deleted
 * contact (LLD §Phase 5, D-8). Returns the count of erased documents so
 * the cascade can audit-log it. Failures here MUST NOT abort the cascade —
 * the use case logs and continues, mirroring the existing `clickhouseCleanup`
 * failure mode.
 */
export type FactErasure = (tenantId: string, contactId: string) => Promise<{ erased: number }>;

interface DeleteResult {
  success: boolean;
  error?: { code: string; message: string };
}

export class CascadeDeleteContact {
  constructor(
    private readonly repo: ContactRepository,
    private readonly onAudit: AuditCallback,
    private readonly resolutionKeyCleanup?: ResolutionKeyCleanup,
    private readonly scrubMessages?: (tenantId: string, contactId: string) => Promise<number>,
    private readonly clickhouseCleanup?: (tenantId: string, contactId: string) => Promise<void>,
    private readonly factErasure?: FactErasure,
  ) {}

  async execute(tenantId: string, contactId: string): Promise<DeleteResult> {
    // 1. Load contact — verifies tenant ownership
    const contact = await this.repo.findById(tenantId, contactId);
    if (!contact) {
      return {
        success: false,
        error: { code: 'CONTACT_NOT_FOUND', message: `Contact not found: ${contactId}` },
      };
    }

    // 2. Clean up resolution keys (cross-context dependency, optional)
    //    Runs before hard-delete so if it fails, the contact is still intact.
    await this.resolutionKeyCleanup?.(tenantId, contactId);

    // 2b. Scrub messages associated with this contact (optional)
    const scrubbedCount = (await this.scrubMessages?.(tenantId, contactId)) ?? 0;

    // 2b-i. Right-to-erasure cascade for memory.user.* facts (LLD §Phase 5, D-8).
    //       Wrapped in try/catch: a transient fact-store failure must not block
    //       hardDelete or audit. The cascade audit-logs and continues, mirroring
    //       the existing clickhouseCleanup pattern.
    if (this.factErasure) {
      try {
        const erasureResult = await this.factErasure(tenantId, contactId);
        log.info('factErasure completed', {
          tenantId,
          contactId,
          erased: erasureResult.erased,
        });
      } catch (err) {
        log.warn('factErasure failed — continuing with hardDelete', {
          tenantId,
          contactId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 2c. Clean up ClickHouse analytics data for this contact (optional)
    //     Wrapped in try/catch: CH failure must not block salt nullification + hard-delete + audit.
    try {
      await this.clickhouseCleanup?.(tenantId, contactId);
    } catch (err) {
      log.warn('clickhouseCleanup failed — continuing with hardDelete', {
        tenantId,
        contactId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 2d. Crypto-shredding: nullify encryptionSalt before hard-delete (defense-in-depth).
    //     Wrapped in try/catch: a transient DB error must not block the hard-delete.
    //     The salt is irrelevant once the contact document is gone.
    try {
      await this.repo.nullifyEncryptionSalt(tenantId, contactId);
    } catch (err) {
      log.warn('nullifyEncryptionSalt failed — continuing with hardDelete', {
        tenantId,
        contactId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 3. Hard-delete (cascading removal of all associated data)
    await this.repo.hardDelete(tenantId, contactId);

    // 4. Emit audit event (non-critical — deletion already completed)
    try {
      await this.onAudit({
        action: 'contact.hard_deleted',
        tenantId,
        contactId,
        identityCount: contact.identities.length,
        sessionCount: contact.sessionCount,
        scrubbedMessageCount: scrubbedCount,
        timestamp: new Date(),
      });
    } catch {
      // Audit infrastructure failure is non-critical — the deletion itself succeeded.
      // The audit callback is expected to handle its own logging.
    }

    return { success: true };
  }
}
