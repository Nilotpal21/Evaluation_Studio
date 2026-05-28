/**
 * MongoDB GDPR Store
 *
 * Concrete implementation of GDPRStore using Mongoose models.
 * Handles subject data lookup, deletion, message anonymization,
 * and audit log anonymization for GDPR right-to-be-forgotten.
 */

import crypto from 'crypto';
import type { GDPRStore } from './retention-service';

const BATCH_SIZE = 100;

export class MongoGDPRStore implements GDPRStore {
  /**
   * Find all sessions where the subject is a participant via any identifier field.
   * A subject may appear as initiatedById, contactId, customerId, anonymousId,
   * or callerNumber depending on the channel and identity tier.
   */
  private async findAllSubjectSessionIds(subjectId: string, tenantId: string): Promise<string[]> {
    const { Session } = await import('@agent-platform/database/models');
    const sessions = await Session.find({
      tenantId,
      $or: [
        { initiatedById: subjectId },
        { contactId: subjectId },
        { customerId: subjectId },
        { anonymousId: subjectId },
        { callerNumber: subjectId },
      ],
    })
      .select('_id')
      .lean();
    return sessions.map((s: any) => s._id as string);
  }

  async findSubjectSessions(subjectId: string, tenantId: string): Promise<string[]> {
    return this.findAllSubjectSessionIds(subjectId, tenantId);
  }

  async findSubjectMessages(subjectId: string, tenantId: string): Promise<string[]> {
    const { Message } = await import('@agent-platform/database/models');
    const sessionIds = await this.findAllSubjectSessionIds(subjectId, tenantId);

    // Also find messages linked to the subject via contactId on the message itself
    const filter: Record<string, unknown> = { tenantId };
    const orClauses: Record<string, unknown>[] = [{ contactId: subjectId }];
    if (sessionIds.length > 0) {
      orClauses.push({ sessionId: { $in: sessionIds } });
    }
    filter.$or = orClauses;

    // All message roles (user, assistant, system, tool) may contain subject data
    // and must be discoverable for GDPR right-to-erasure compliance.
    const messages = await Message.find(filter).select('_id').limit(10_000).lean();
    return messages.map((m: any) => m._id as string);
  }

  async findSubjectTraces(subjectId: string, tenantId: string): Promise<string[]> {
    const { Message } = await import('@agent-platform/database/models');
    const sessionIds = await this.findAllSubjectSessionIds(subjectId, tenantId);

    // Build query: messages in subject's sessions OR messages mentioning
    // the subject in content/metadata (catch-all for data that may have
    // leaked into assistant/system/tool messages outside owned sessions).
    const orClauses: Record<string, unknown>[] = [
      { contactId: subjectId },
      { content: { $regex: subjectId, $options: 'i' } },
      { 'metadata.userId': subjectId },
      { 'metadata.email': subjectId },
      { 'metadata.externalId': subjectId },
    ];
    if (sessionIds.length > 0) {
      orClauses.push({ sessionId: { $in: sessionIds } });
    }

    const messages = await Message.find({
      tenantId,
      $or: orClauses,
    })
      .select('_id')
      .limit(10_000)
      .lean();
    return messages.map((m: any) => m._id as string);
  }

  async deleteSession(sessionId: string, _tenantId: string): Promise<void> {
    const { deleteSession: cascadeDeleteSession } =
      await import('@agent-platform/database/cascade');
    await cascadeDeleteSession(sessionId);
  }

  async deleteMessages(messageIds: string[], tenantId?: string): Promise<void> {
    const { Message } = await import('@agent-platform/database/models');
    const filter: Record<string, unknown> = { _id: { $in: messageIds } };
    if (tenantId) filter.tenantId = tenantId;
    await Message.deleteMany(filter);
  }

  async anonymizeTraces(traceIds: string[], tenantId: string): Promise<void> {
    const { Message } = await import('@agent-platform/database/models');
    for (let i = 0; i < traceIds.length; i += BATCH_SIZE) {
      const batch = traceIds.slice(i, i + BATCH_SIZE);
      await Message.updateMany(
        { tenantId, _id: { $in: batch } },
        { $set: { content: '[ANONYMIZED]', scrubbed: true } },
      );
    }
  }

  async findSubjectContacts(subjectId: string, tenantId: string): Promise<string[]> {
    const { Contact } = await import('@agent-platform/database/models');
    const contacts = await Contact.find({
      tenantId,
      $or: [{ identity: subjectId }, { employeeId: subjectId }],
      deletedAt: null,
    })
      .select('_id')
      .lean();
    return contacts.map((c: any) => c._id as string);
  }

  async anonymizeContacts(contactIds: string[], tenantId?: string): Promise<void> {
    const { Contact } = await import('@agent-platform/database/models');
    for (let i = 0; i < contactIds.length; i += BATCH_SIZE) {
      const batch = contactIds.slice(i, i + BATCH_SIZE);
      const filter: Record<string, unknown> = { _id: { $in: batch } };
      if (tenantId) filter.tenantId = tenantId;
      await Contact.updateMany(filter, {
        $set: {
          identity: null,
          identityType: null,
          displayName: '[ANONYMIZED]',
          employeeId: null,
          company: null,
          accountRef: null,
          type: 'anonymous',
          deletedAt: new Date(),
          metadata: {},
          tags: [],
        },
      });
    }
  }

  async anonymizeAuditEntries(subjectId: string, tenantId: string): Promise<void> {
    const { AuditLog } = await import('@agent-platform/database/models');
    const hash = crypto.createHash('sha256').update(subjectId).digest('hex').slice(0, 12);

    await AuditLog.updateMany(
      { userId: subjectId, tenantId },
      { $set: { userId: `[ANONYMIZED:${hash}]` } },
    );
  }

  async findSubjectAttachments(subjectId: string, tenantId: string): Promise<string[]> {
    const { Attachment } = await import('@agent-platform/database');

    // Find all sessions where the subject is a participant
    const sessionIds = await this.findAllSubjectSessionIds(subjectId, tenantId);
    if (sessionIds.length === 0) return [];

    const attachments = await Attachment.find({
      tenantId,
      sessionId: { $in: sessionIds },
    })
      .select('_id')
      .limit(1000)
      .lean();
    return attachments.map((a: any) => a._id as string);
  }

  async anonymizeAttachments(attachmentIds: string[], tenantId: string): Promise<void> {
    const { Attachment } = await import('@agent-platform/database');
    for (let i = 0; i < attachmentIds.length; i += BATCH_SIZE) {
      const batch = attachmentIds.slice(i, i + BATCH_SIZE);
      await Attachment.updateMany(
        { _id: { $in: batch }, tenantId },
        {
          $set: {
            originalFilename: '[ANONYMIZED]',
            processedContent: null,
            imageDescription: null,
          },
        },
      );
    }
  }

  async deletePersonalAuthProfiles(subjectId: string, tenantId: string): Promise<void> {
    const { AuthProfile } = await import('@agent-platform/database/models');
    await AuthProfile.deleteMany({
      tenantId,
      createdBy: subjectId,
      visibility: 'personal',
    });
  }

  async reassignSharedAuthProfiles(subjectId: string, tenantId: string): Promise<void> {
    const { AuthProfile } = await import('@agent-platform/database/models');
    await AuthProfile.updateMany(
      { tenantId, createdBy: subjectId, visibility: 'shared' },
      { $set: { createdBy: '[SYSTEM:gdpr-erasure]' } },
    );
  }

  async anonymizeUser(subjectId: string, tenantId: string): Promise<void> {
    const { User } = await import('@agent-platform/database/models');

    // Find the user to generate a deterministic anonymized email
    const user = await User.findOne({ _id: subjectId, tenantId }).lean();
    if (!user) return;

    const emailHash = crypto
      .createHash('sha256')
      .update((user as any).email || subjectId)
      .digest('hex')
      .slice(0, 8);

    await User.updateOne(
      { _id: subjectId, tenantId },
      {
        $set: {
          email: `anonymized-${emailHash}@deleted.local`,
          name: '[DELETED USER]',
          avatarUrl: null,
          googleId: null,
          microsoftId: null,
          linkedinId: null,
          passwordHash: null,
          passwordHistory: [],
          mfaEnabled: false,
          mfaSecret: null,
          recoveryCodes: [],
          lastUsedTotpCounter: null,
          emailVerified: false,
          deletedAt: new Date(),
          anonymizedAt: new Date(),
        },
      },
    );
  }
}
