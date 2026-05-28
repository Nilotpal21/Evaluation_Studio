/**
 * ContactMongoRepository
 *
 * MongoDB implementation of the ContactRepository port.
 * Uses Mongoose model injected via constructor for testability.
 *
 * Invariants:
 * - Every query includes `tenantId` (tenant isolation).
 * - Blind index lookups exclude soft-deleted contacts (`deletedAt: null`).
 * - Document-to-domain mapping strips `_id` and maps to `id`.
 */

import type { Model } from 'mongoose';
import type { IContact } from '@agent-platform/database/models';
import type { Contact, SourceIdentity, ContactAcl, AclDirectGroup } from '../domain/contact.js';
import type { ContactIdentity } from '../domain/contact-identity.js';
import type { ContactRepository } from '../domain/contact-repository.js';
import type { ChannelType } from '../../../channels/types.js';

// ─── Mapping Helpers ────────────────────────────────────────────────────

/** Map a domain Contact to a Mongoose document shape. */
function toDocument(contact: Contact): Record<string, unknown> {
  return {
    _id: contact.id,
    tenantId: contact.tenantId,
    identities: contact.identities,
    displayName: contact.displayName,
    type: contact.type,
    metadata: contact.metadata,
    tags: contact.tags,
    channelHistory: contact.channelHistory,
    sessionCount: contact.sessionCount,
    firstSeenAt: contact.firstSeenAt,
    lastSeenAt: contact.lastSeenAt,
    mergedInto: contact.mergedInto,
    deletedAt: contact.deletedAt,
    encryptionSalt: contact.encryptionSalt,
    contactContext: contact.contactContext,
    ...(contact.sourceIdentities !== undefined && { sourceIdentities: contact.sourceIdentities }),
    ...(contact.acl !== undefined && { acl: contact.acl }),
  };
}

/** Map a lean Mongoose document to a domain Contact. */
function toDomain(doc: IContact): Contact {
  return {
    id: doc._id,
    tenantId: doc.tenantId,
    identities: (doc.identities ?? []).map((i) => ({
      type: i.type as ContactIdentity['type'],
      encryptedValue: i.encryptedValue,
      blindIndex: i.blindIndex,
      verified: i.verified,
      verifiedAt: i.verifiedAt,
      verifiedVia: i.verifiedVia as ContactIdentity['verifiedVia'],
      channel: i.channel,
    })),
    displayName: doc.displayName,
    type: doc.type as Contact['type'],
    metadata: doc.metadata ?? {},
    tags: doc.tags ?? [],
    channelHistory: (doc.channelHistory ?? []).map((ch) => ({
      channelType: ch.channelType as ChannelType,
      channelId: ch.channelId,
      firstSessionAt: ch.firstSessionAt,
      lastSessionAt: ch.lastSessionAt,
      sessionCount: ch.sessionCount,
    })),
    sessionCount: doc.sessionCount ?? 0,
    firstSeenAt: doc.firstSeenAt,
    lastSeenAt: doc.lastSeenAt,
    mergedInto: doc.mergedInto ?? null,
    deletedAt: doc.deletedAt,
    encryptionSalt: doc.encryptionSalt ?? null,
    contactContext: doc.contactContext ?? null,
    sourceIdentities: (doc.sourceIdentities ?? []).map((si) => ({
      source: si.source,
      sourceUserId: si.sourceUserId,
      encryptedEmail: si.encryptedEmail ?? null,
      blindIndex: si.blindIndex ?? null,
      displayName: si.displayName ?? null,
      resolved: si.resolved,
      lastSyncAt: si.lastSyncAt,
    })),
    acl: doc.acl
      ? {
          effectiveGroups: doc.acl.effectiveGroups ?? [],
          directGroups: (doc.acl.directGroups ?? []).map((dg) => ({
            group: dg.group,
            source: dg.source,
            addedAt: dg.addedAt,
          })),
          domain: doc.acl.domain ?? null,
          effectiveGroupsComputedAt: doc.acl.effectiveGroupsComputedAt ?? null,
          syncVersion: doc.acl.syncVersion ?? 0,
        }
      : null,
  };
}

// ─── Repository ─────────────────────────────────────────────────────────

export class ContactMongoRepository implements ContactRepository {
  constructor(private readonly model: Model<IContact>) {}

  async findById(tenantId: string, contactId: string): Promise<Contact | null> {
    const doc = await this.model.findOne({ _id: contactId, tenantId }).lean();
    return doc ? toDomain(doc as IContact) : null;
  }

  async findByBlindIndex(tenantId: string, blindIndex: string): Promise<Contact | null> {
    const doc = await this.model
      .findOne({ tenantId, 'identities.blindIndex': blindIndex, deletedAt: null })
      .lean();
    return doc ? toDomain(doc as IContact) : null;
  }

  async findByBlindIndexes(tenantId: string, blindIndexes: string[]): Promise<Contact[]> {
    const docs = await this.model
      .find({ tenantId, 'identities.blindIndex': { $in: blindIndexes }, deletedAt: null })
      .lean();
    return (docs as IContact[]).map(toDomain);
  }

  async create(contact: Contact): Promise<Contact> {
    const instance = new this.model(toDocument(contact));
    await instance.save();
    const doc = instance.toObject();
    return toDomain(doc as IContact);
  }

  async update(contact: Contact): Promise<Contact> {
    const { _id, tenantId, ...rest } = toDocument(contact) as any;
    const doc = await this.model
      .findOneAndUpdate(
        { _id: contact.id, tenantId: contact.tenantId },
        { $set: rest },
        { new: true },
      )
      .lean();

    if (!doc) {
      throw new Error(`Contact not found: id=${contact.id}, tenantId=${contact.tenantId}`);
    }

    return toDomain(doc as IContact);
  }

  async addIdentity(tenantId: string, contactId: string, identity: ContactIdentity): Promise<void> {
    await this.model.updateOne({ _id: contactId, tenantId }, { $push: { identities: identity } });
  }

  async linkSession(
    tenantId: string,
    contactId: string,
    _sessionId: string,
    channelType: ChannelType,
    channelId: string,
  ): Promise<void> {
    const now = new Date();

    // Read current contact to check existing channel history
    const doc = await this.model.findOne({ _id: contactId, tenantId }).lean();
    if (!doc) {
      throw new Error(`Contact not found for linkSession: id=${contactId}, tenantId=${tenantId}`);
    }

    const existing = (doc as IContact).channelHistory?.find(
      (ch) => ch.channelType === channelType && ch.channelId === channelId,
    );

    if (existing) {
      // Update existing channel history entry
      await this.model.updateOne(
        {
          _id: contactId,
          tenantId,
          'channelHistory.channelType': channelType,
          'channelHistory.channelId': channelId,
        },
        {
          $set: {
            'channelHistory.$.lastSessionAt': now,
            lastSeenAt: now,
          },
          $inc: {
            'channelHistory.$.sessionCount': 1,
            sessionCount: 1,
          },
        },
      );
    } else {
      // Push new channel history entry
      await this.model.updateOne(
        { _id: contactId, tenantId },
        {
          $push: {
            channelHistory: {
              channelType,
              channelId,
              firstSessionAt: now,
              lastSessionAt: now,
              sessionCount: 1,
            },
          },
          $set: { lastSeenAt: now },
          $inc: { sessionCount: 1 },
        },
      );
    }
  }

  async softDelete(tenantId: string, contactId: string): Promise<void> {
    await this.model.updateOne({ _id: contactId, tenantId }, { $set: { deletedAt: new Date() } });
  }

  async hardDelete(tenantId: string, contactId: string): Promise<void> {
    await this.model.deleteOne({ _id: contactId, tenantId });
  }

  async nullifyEncryptionSalt(tenantId: string, contactId: string): Promise<void> {
    await this.model.updateOne({ _id: contactId, tenantId }, { $set: { encryptionSalt: null } });
  }

  async findMergeCandidates(tenantId: string, blindIndexes: string[]): Promise<Contact[]> {
    const docs = await this.model
      .find({ tenantId, 'identities.blindIndex': { $in: blindIndexes }, deletedAt: null })
      .lean();
    return (docs as IContact[]).map(toDomain);
  }
}
