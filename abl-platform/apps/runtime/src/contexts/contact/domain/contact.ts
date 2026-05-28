/**
 * Contact Aggregate
 *
 * The root entity for the Contact bounded context. A Contact represents
 * a single end-user across all channels and sessions within a tenant.
 *
 * Contacts hold encrypted identities (email, phone, external), channel
 * interaction history, and metadata. They can be soft-deleted or merged
 * into another Contact.
 *
 * Domain layer: zero infrastructure imports.
 */

import type { ChannelType } from '../../../channels/types.js';
import type { ContactIdentity } from './contact-identity.js';

// =============================================================================
// ACL TYPES (for unified contact + permission card)
// =============================================================================

/**
 * A source identity from a SearchAI connector (e.g., Azure AD, Jira, SharePoint).
 * Maps connector-specific user IDs back to this contact.
 */
export interface SourceIdentity {
  source: string;
  sourceUserId: string;
  encryptedEmail: string | null;
  blindIndex: string | null;
  displayName: string | null;
  resolved: boolean;
  lastSyncAt: Date;
}

/**
 * A direct group membership with source attribution.
 * Tracks which connector/IdP granted the membership (for un-merge safety).
 */
export interface AclDirectGroup {
  group: string;
  source: string;
  addedAt: Date;
}

/**
 * Pre-computed ACL data stored on the contact card.
 * Replaces Neo4j user groups for permission filtering at search time.
 */
export interface ContactAcl {
  effectiveGroups: string[];
  directGroups: AclDirectGroup[];
  domain: string | null;
  effectiveGroupsComputedAt: Date | null;
  syncVersion: number;
}

// =============================================================================
// TYPES
// =============================================================================

/**
 * Whether the contact represents a customer or an employee/agent.
 */
export type ContactType = 'customer' | 'employee' | 'anonymous';

/**
 * Cross-session context that persists across a contact's sessions.
 * Promoted from session data at session close and pre-loaded at session start.
 */
export interface ContactContext {
  preferences: Record<string, unknown>;
  dataValues: Record<string, unknown>;
  lastDisposition: string | null;
  lastInteraction: Date | null;
  sessionCount: number;
  updatedAt: Date;
}

/**
 * Tracks a Contact's interaction history with a specific channel.
 * Each entry records when the contact first/last used that channel
 * and how many sessions occurred through it.
 */
export interface ChannelHistoryEntry {
  channelType: ChannelType;
  channelId: string;
  firstSessionAt: Date;
  lastSessionAt: Date;
  sessionCount: number;
}

/**
 * The Contact aggregate root.
 *
 * Each Contact belongs to exactly one tenant (tenantId). Identities are
 * stored encrypted with tenant-scoped keys. The mergedInto field points
 * to the surviving Contact when this Contact has been merged away.
 */
export interface Contact {
  /** UUID v7 identifier. */
  id: string;
  /** Tenant that owns this contact. Every query must filter by tenantId. */
  tenantId: string;
  /** Encrypted identities (email, phone, external) attached to this contact. */
  identities: ContactIdentity[];
  /** Human-readable display name, if known. */
  displayName: string | null;
  /** Whether this is a customer or employee contact. */
  type: ContactType;
  /** Arbitrary tenant-defined metadata. */
  metadata: Record<string, unknown>;
  /** Searchable tags applied to this contact. */
  tags: string[];
  /** Per-channel interaction history. */
  channelHistory: ChannelHistoryEntry[];
  /** Total session count across all channels. */
  sessionCount: number;
  /** When this contact was first seen. */
  firstSeenAt: Date;
  /** When this contact was last active. */
  lastSeenAt: Date;
  /** If merged, the ID of the surviving contact. Null if not merged. */
  mergedInto: string | null;
  /** Soft-delete timestamp. Null if active. */
  deletedAt: Date | null;
  /** Per-contact salt for HKDF key derivation. Generated at creation, never overwritten. */
  encryptionSalt: string | null;
  /** Cross-session context promoted from completed sessions. Null until first session completes. */
  contactContext: ContactContext | null;
  /** Source identities from SearchAI connector sync (Jira, SharePoint, etc.). */
  sourceIdentities?: SourceIdentity[];
  /** Pre-computed ACL data for permission filtering. Null until first IdP/connector sync. */
  acl?: ContactAcl | null;
}
