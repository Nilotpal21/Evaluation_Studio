/**
 * Contact Context -- Public API
 *
 * Re-exports all domain types, use cases, and infrastructure adapters.
 * Provides a `createContactContext()` factory that wires everything together,
 * returning a typed object with all use cases ready to invoke.
 */

// =============================================================================
// DOMAIN
// =============================================================================

export type { Contact, ContactType, ChannelHistoryEntry } from './domain/contact.js';

export type {
  ContactIdentity,
  ContactIdentityType,
  CreateContactIdentityParams,
} from './domain/contact-identity.js';
export { createContactIdentity } from './domain/contact-identity.js';

export type { ContactRepository } from './domain/contact-repository.js';

export type { MergeExecution } from './domain/merge-execution.js';

export type {
  MergeSuggestion,
  MergeSuggestionConfidence,
  MergeSuggestionStatus,
  OverlapIdentity,
} from './domain/merge-suggestion.js';

// =============================================================================
// USE CASES
// =============================================================================

export { ResolveOrCreateContact } from './use-cases/resolve-or-create-contact.js';
export { LinkSessionToContact } from './use-cases/link-session-to-contact.js';
export { DetectMergeCandidates } from './use-cases/detect-merge-candidates.js';
export { ExecuteMerge } from './use-cases/execute-merge.js';
export { SelfMerge } from './use-cases/self-merge.js';
export { CascadeDeleteContact } from './use-cases/cascade-delete-contact.js';
export type {
  AuditCallback,
  ContactDeletedAuditEvent,
  ResolutionKeyCleanup,
  FactErasure,
} from './use-cases/cascade-delete-contact.js';
export { eraseUserScopedFacts } from './fact-erasure.js';
export type { SessionReassigner } from './use-cases/execute-merge.js';

// =============================================================================
// INFRASTRUCTURE
// =============================================================================

export { normalizeIdentity } from './infrastructure/normalize-identity.js';
export { ContactMongoRepository } from './infrastructure/contact-mongo-repository.js';
export { MergeSuggestionMongoStore } from './infrastructure/merge-suggestion-store.js';
export type {
  ContactAuditEmitter,
  ContactAuditEvent,
  ContactAuditAction,
} from './infrastructure/contact-audit.js';

// =============================================================================
// FACTORY
// =============================================================================

import type { ContactRepository } from './domain/contact-repository.js';
import type {
  AuditCallback,
  FactErasure,
  ResolutionKeyCleanup,
} from './use-cases/cascade-delete-contact.js';
import type { SessionReassigner } from './use-cases/execute-merge.js';
import type { ContactAuditEmitter } from './infrastructure/contact-audit.js';
import type { EncryptionService } from '@agent-platform/shared/encryption';
import { ResolveOrCreateContact } from './use-cases/resolve-or-create-contact.js';
import { LinkSessionToContact } from './use-cases/link-session-to-contact.js';
import { DetectMergeCandidates } from './use-cases/detect-merge-candidates.js';
import { ExecuteMerge } from './use-cases/execute-merge.js';
import { SelfMerge } from './use-cases/self-merge.js';
import { CascadeDeleteContact } from './use-cases/cascade-delete-contact.js';

/** Dependencies required to wire the contact context. */
export interface ContactContextDeps {
  /** Contact persistence adapter. */
  readonly repository: ContactRepository;
  /** Contact field-level encryptor with tenant-scoped keys. */
  readonly encryptor: EncryptionService;
  /** Audit callback for deletion events (GDPR compliance). */
  readonly onAudit: AuditCallback;
  /** Optional audit emitter for all contact lifecycle events (SOC 2 / compliance). */
  readonly onContactAudit?: ContactAuditEmitter;
  /** Optional callback to reassign sessions during contact merge (cross-context). */
  readonly sessionReassigner?: SessionReassigner;
  /** Optional callback to clean up resolution keys during contact deletion (cross-context). */
  readonly resolutionKeyCleanup?: ResolutionKeyCleanup;
  /** Optional callback to scrub messages associated with a contact (GDPR compliance). */
  readonly scrubMessages?: (tenantId: string, contactId: string) => Promise<number>;
  /** Optional callback to clean up ClickHouse analytics data for a contact. */
  readonly clickhouseCleanup?: (tenantId: string, contactId: string) => Promise<void>;
  /** Optional port to purge `memory.user.*` facts owned by the deleted contact (GDPR cascade). */
  readonly factErasure?: FactErasure;
}

/** Wired contact context with all use cases ready to invoke. */
export interface ContactContext {
  readonly resolveOrCreateContact: ResolveOrCreateContact;
  readonly linkSessionToContact: LinkSessionToContact;
  readonly detectMergeCandidates: DetectMergeCandidates;
  readonly executeMerge: ExecuteMerge;
  readonly selfMerge: SelfMerge;
  readonly cascadeDeleteContact: CascadeDeleteContact;
}

/**
 * Wire all contact use cases from their dependencies.
 * Returns a typed object -- callers access use cases directly
 * without needing to know their constructor signatures.
 */
export function createContactContext(deps: ContactContextDeps): ContactContext {
  return {
    resolveOrCreateContact: new ResolveOrCreateContact(
      deps.repository,
      deps.encryptor,
      deps.onContactAudit,
    ),
    linkSessionToContact: new LinkSessionToContact(deps.repository, deps.onContactAudit),
    detectMergeCandidates: new DetectMergeCandidates(deps.repository),
    executeMerge: new ExecuteMerge(deps.repository, deps.onContactAudit, deps.sessionReassigner),
    selfMerge: new SelfMerge(
      deps.repository,
      deps.encryptor,
      deps.onContactAudit,
      deps.sessionReassigner,
    ),
    cascadeDeleteContact: new CascadeDeleteContact(
      deps.repository,
      deps.onAudit,
      deps.resolutionKeyCleanup,
      deps.scrubMessages,
      deps.clickhouseCleanup,
      deps.factErasure,
    ),
  };
}
