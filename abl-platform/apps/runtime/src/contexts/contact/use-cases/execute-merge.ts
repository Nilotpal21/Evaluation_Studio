/**
 * Execute Merge Use Case
 *
 * Merges a secondary contact into a primary contact:
 * 1. Loads both contacts (verifies tenant ownership)
 * 2. Moves identities from secondary to primary (deduplicates by blindIndex)
 * 3. Merges channel history
 * 4. Reassigns sessions from secondary to primary (cross-context, optional)
 * 5. Sets secondary.mergedInto = primary.id
 * 6. Soft-deletes the secondary
 * 7. Returns MergeExecution record
 *
 * Ports: ContactRepository, ContactAuditEmitter (optional), SessionReassigner (optional)
 */

import crypto from 'node:crypto';
import type { Contact } from '../domain/contact.js';
import type { ContactIdentity } from '../domain/contact-identity.js';
import type { ContactRepository } from '../domain/contact-repository.js';
import type { MergeExecution } from '../domain/merge-execution.js';
import type { ChannelHistoryEntry } from '../domain/contact.js';
import type { ContactAuditEmitter } from '../infrastructure/contact-audit.js';

/** Optional callback to reassign sessions from one contact to another. Returns the session IDs moved. */
export type SessionReassigner = (
  tenantId: string,
  fromContactId: string,
  toContactId: string,
) => Promise<string[]>;

interface MergeResult {
  success: boolean;
  data?: MergeExecution;
  error?: { code: string; message: string };
}

export class ExecuteMerge {
  constructor(
    private readonly repo: ContactRepository,
    private readonly onAudit?: ContactAuditEmitter,
    private readonly sessionReassigner?: SessionReassigner,
  ) {}

  async execute(
    tenantId: string,
    primaryContactId: string,
    secondaryContactId: string,
    mergedBy: string,
  ): Promise<MergeResult> {
    // 1. Load both contacts with tenant ownership verification
    const primary = await this.repo.findById(tenantId, primaryContactId);
    if (!primary) {
      return {
        success: false,
        error: {
          code: 'CONTACT_NOT_FOUND',
          message: `Primary contact not found: ${primaryContactId}`,
        },
      };
    }

    const secondary = await this.repo.findById(tenantId, secondaryContactId);
    if (!secondary) {
      return {
        success: false,
        error: {
          code: 'CONTACT_NOT_FOUND',
          message: `Secondary contact not found: ${secondaryContactId}`,
        },
      };
    }

    // 2. Move identities — deduplicate by blindIndex
    const existingBlindIndexes = new Set(primary.identities.map((i) => i.blindIndex));
    const identitiesMoved: ContactIdentity[] = [];

    for (const identity of secondary.identities) {
      if (!existingBlindIndexes.has(identity.blindIndex)) {
        identitiesMoved.push(identity);
        existingBlindIndexes.add(identity.blindIndex);
      }
    }

    const mergedIdentities = [...primary.identities, ...identitiesMoved];

    // 3. Merge channel history
    const mergedChannelHistory = this.mergeChannelHistory(
      primary.channelHistory,
      secondary.channelHistory,
    );

    // 4. Reassign sessions from secondary to primary (cross-context, optional)
    const sessionsMoved =
      (await this.sessionReassigner?.(tenantId, secondaryContactId, primaryContactId)) ?? [];

    // 5. Update primary with merged data
    const updatedPrimary: Contact = {
      ...primary,
      identities: mergedIdentities,
      channelHistory: mergedChannelHistory,
      sessionCount: primary.sessionCount + secondary.sessionCount,
      lastSeenAt:
        primary.lastSeenAt > secondary.lastSeenAt ? primary.lastSeenAt : secondary.lastSeenAt,
    };
    await this.repo.update(updatedPrimary);

    // 6. Mark secondary as merged
    const updatedSecondary: Contact = {
      ...secondary,
      mergedInto: primaryContactId,
      identities: [],
    };
    await this.repo.update(updatedSecondary);
    await this.repo.softDelete(tenantId, secondaryContactId);

    // 7. Build and return MergeExecution
    const execution: MergeExecution = {
      id: crypto.randomUUID(),
      tenantId,
      primaryContactId,
      secondaryContactId,
      identitiesMoved,
      sessionsMoved,
      mergedAt: new Date(),
      mergedBy,
      suggestionId: null,
    };

    this.onAudit?.({
      action: 'contact.merged',
      tenantId,
      contactId: primaryContactId,
      metadata: {
        primaryContactId,
        secondaryContactId,
        identitiesMoved: identitiesMoved.length,
      },
      timestamp: new Date(),
    }).catch((err: unknown) => {
      console.error('[contact-audit] Failed to emit contact.merged event', err);
    });

    return { success: true, data: execution };
  }

  private mergeChannelHistory(
    primary: ChannelHistoryEntry[],
    secondary: ChannelHistoryEntry[],
  ): ChannelHistoryEntry[] {
    const merged = new Map<string, ChannelHistoryEntry>();

    for (const entry of primary) {
      const key = `${entry.channelType}:${entry.channelId}`;
      merged.set(key, { ...entry });
    }

    for (const entry of secondary) {
      const key = `${entry.channelType}:${entry.channelId}`;
      const existing = merged.get(key);
      if (existing) {
        existing.firstSessionAt =
          existing.firstSessionAt < entry.firstSessionAt
            ? existing.firstSessionAt
            : entry.firstSessionAt;
        existing.lastSessionAt =
          existing.lastSessionAt > entry.lastSessionAt
            ? existing.lastSessionAt
            : entry.lastSessionAt;
        existing.sessionCount += entry.sessionCount;
      } else {
        merged.set(key, { ...entry });
      }
    }

    return Array.from(merged.values());
  }
}
