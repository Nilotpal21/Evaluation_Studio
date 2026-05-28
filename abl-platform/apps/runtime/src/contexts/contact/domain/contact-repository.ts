/**
 * Contact Repository Port
 *
 * Defines what the Contact domain needs from infrastructure for
 * persistence operations. Implementations live in the infrastructure
 * layer (e.g. MongoDB adapter).
 *
 * Every method requires tenantId to enforce tenant isolation at the
 * domain boundary -- not just at the infrastructure layer.
 *
 * Domain layer: zero infrastructure imports.
 */

import type { ChannelType } from '../../../channels/types.js';
import type { Contact } from './contact.js';
import type { ContactIdentity } from './contact-identity.js';

/**
 * Port interface for Contact persistence.
 *
 * All read operations are tenant-scoped. Blind index lookups enable
 * searching encrypted identities without decryption.
 */
export interface ContactRepository {
  /** Find a contact by its ID within a tenant. */
  findById(tenantId: string, contactId: string): Promise<Contact | null>;

  /** Find a contact by a single blind index within a tenant. */
  findByBlindIndex(tenantId: string, blindIndex: string): Promise<Contact | null>;

  /** Find all contacts matching any of the given blind indexes within a tenant. */
  findByBlindIndexes(tenantId: string, blindIndexes: string[]): Promise<Contact[]>;

  /** Persist a new contact. Returns the created contact. */
  create(contact: Contact): Promise<Contact>;

  /** Update an existing contact. Returns the updated contact. */
  update(contact: Contact): Promise<Contact>;

  /** Add an identity to an existing contact. */
  addIdentity(tenantId: string, contactId: string, identity: ContactIdentity): Promise<void>;

  /** Link a session to a contact and update channel history. */
  linkSession(
    tenantId: string,
    contactId: string,
    sessionId: string,
    channelType: ChannelType,
    channelId: string,
  ): Promise<void>;

  /** Soft-delete a contact (set deletedAt). */
  softDelete(tenantId: string, contactId: string): Promise<void>;

  /** Hard-delete a contact and all associated data (right to erasure). */
  hardDelete(tenantId: string, contactId: string): Promise<void>;

  /** Nullify encryptionSalt (crypto-shredding step for GDPR cascade). */
  nullifyEncryptionSalt(tenantId: string, contactId: string): Promise<void>;

  /** Find contacts that share any of the given blind indexes (merge candidates). */
  findMergeCandidates(tenantId: string, blindIndexes: string[]): Promise<Contact[]>;
}
