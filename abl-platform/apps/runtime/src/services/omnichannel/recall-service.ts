/**
 * Recall Service
 *
 * Retrieves cross-channel transcript history for a contact.
 * Query flow:
 *   1. Check consent (ContactCapabilityConsent)
 *   2. Resolve merged contacts (Contact.mergedInto chain)
 *   3. Exclude soft-deleted contacts
 *   4. Query messages with tenant/project isolation
 *   5. Validate payload size (64KB max)
 *   6. Return RecallResult
 *
 * Uses standard find() (not .lean()) so the encryption plugin auto-decrypts content.
 * Implements timeout via Promise.race for graceful degradation.
 */

import { createLogger } from '@abl/compiler/platform';
import {
  OMNICHANNEL_RECALL_MAX_MESSAGES,
  OMNICHANNEL_RECALL_MAX_AGE_DAYS,
  OMNICHANNEL_RECALL_TIMEOUT_MS,
  OMNICHANNEL_RECALL_MAX_PAYLOAD_BYTES,
} from '@agent-platform/config/constants';
import type { IMessage } from '@agent-platform/database/models';
import type { RecallRequest, RecallResult, RecallMessage } from './types.js';
import { emitOmnichannelAudit } from './omnichannel-audit.js';
import { renderSessionMessagesForUserSurface } from '../pii/runtime-pii-boundary-service.js';
import { buildProjectPIIReadSurfaceContext } from '../pii/session-pii-context.js';

const log = createLogger('omnichannel-recall');

/** Maximum depth for following mergedInto chains to prevent infinite loops */
const MAX_MERGE_DEPTH = 10;

/**
 * RecallService — scoped to a tenant and project.
 *
 * Use: `new RecallService(tenantId, projectId)`
 */
export class RecallService {
  private readonly tenantId: string;
  private readonly projectId: string;

  constructor(tenantId: string, projectId: string) {
    this.tenantId = tenantId;
    this.projectId = projectId;
  }

  /**
   * Retrieve cross-channel recall messages for a contact.
   *
   * Returns an empty result (not an error) on:
   * - Missing consent
   * - Timeout
   * - Database errors
   *
   * This ensures recall failures never block the primary session flow.
   */
  async getRecallMessages(request: RecallRequest): Promise<RecallResult> {
    const emptyResult: RecallResult = {
      messages: [],
      metadata: { matchedSessions: 0, truncated: false, payloadBytes: 0 },
    };

    try {
      // Race the actual query against a timeout, tracking duration
      const startMs = Date.now();
      const timeoutMs = OMNICHANNEL_RECALL_TIMEOUT_MS;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<RecallResult>((resolve) => {
        timeoutHandle = setTimeout(() => {
          log.warn('Recall query timed out', { sessionId: request.sessionId, timeoutMs });
          resolve({
            messages: [],
            metadata: { matchedSessions: 0, truncated: false, payloadBytes: 0 },
          });
        }, timeoutMs);
      });
      const result = await Promise.race([this.executeRecallQuery(request), timeoutPromise]);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const durationMs = Date.now() - startMs;

      log.info('Recall query completed', {
        sessionId: request.sessionId,
        contactId: request.contactId,
        durationMs,
        messageCount: result.messages.length,
        matchedSessions: result.metadata.matchedSessions,
        payloadBytes: result.metadata.payloadBytes,
        truncated: result.metadata.truncated,
      });

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Recall query failed', {
        sessionId: request.sessionId,
        contactId: request.contactId,
        error: message,
      });
      return emptyResult;
    }
  }

  /**
   * Execute the full recall query pipeline.
   */
  private async executeRecallQuery(request: RecallRequest): Promise<RecallResult> {
    const emptyResult: RecallResult = {
      messages: [],
      metadata: { matchedSessions: 0, truncated: false, payloadBytes: 0 },
    };

    const { Message, Contact, ContactCapabilityConsent } =
      await import('@agent-platform/database/models');

    // 1. Check consent for cross_channel_recall
    const consent = await ContactCapabilityConsent.findOne({
      tenantId: this.tenantId,
      projectId: this.projectId,
      contactId: request.contactId,
      capability: 'cross_channel_recall',
      state: 'granted',
    }).lean();

    if (!consent) {
      log.info('Recall denied — no consent', {
        contactId: request.contactId,
        sessionId: request.sessionId,
      });
      return emptyResult;
    }

    // 2. Resolve merged contacts — follow mergedInto chain
    const allContactIds = await this.resolveMergedContacts(Contact, request.contactId);

    // 3. Exclude soft-deleted contacts
    const activeContacts = await this.filterActiveContacts(Contact, allContactIds);

    if (activeContacts.length === 0) {
      log.info('Recall returned empty — all contacts soft-deleted', {
        contactId: request.contactId,
      });
      return emptyResult;
    }

    // 4. Build query
    const maxMessages = Math.min(
      request.maxMessages ?? OMNICHANNEL_RECALL_MAX_MESSAGES,
      OMNICHANNEL_RECALL_MAX_MESSAGES * 5, // Hard cap at 100
    );
    let maxAgeDays = request.maxAgeDays ?? OMNICHANNEL_RECALL_MAX_AGE_DAYS;

    // Enforce retention compliance boundary — data beyond retention must not be returned
    if (request.retentionMaxDays !== undefined && request.retentionMaxDays > 0) {
      maxAgeDays = Math.min(maxAgeDays, request.retentionMaxDays);
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);

    const filter: Record<string, unknown> = {
      tenantId: this.tenantId,
      projectId: this.projectId,
      contactId: { $in: activeContacts },
      final: true,
      createdAt: { $gte: cutoffDate },
    };

    // Apply channel filter if specified
    if (request.allowedChannels && request.allowedChannels.length > 0) {
      filter.channel = { $in: request.allowedChannels };
    }

    // Exclude the current session's messages from recall
    filter.sessionId = { $ne: request.sessionId };

    // 5. Query messages — do NOT use .lean() so encryption plugin auto-decrypts
    const messages = await Message.find(filter).sort({ createdAt: -1 }).limit(maxMessages).exec();

    // Emit audit event
    emitOmnichannelAudit({
      eventType: 'omnichannel_recall_requested',
      tenantId: this.tenantId,
      projectId: this.projectId,
      sessionId: request.sessionId,
      data: {
        contactId: request.contactId,
        resolvedContactIds: activeContacts,
        maxMessages,
        maxAgeDays,
      },
    });

    // 6. Render recalled content through the same project-scoped PII read boundary
    const piiReadContext = await buildProjectPIIReadSurfaceContext({
      tenantId: this.tenantId,
      projectId: this.projectId,
    });

    const rawRecallMessages: RecallMessage[] = messages.map((msg: IMessage) => ({
      id: msg._id as string,
      sessionId: msg.sessionId,
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      channel: msg.channel,
      sourceChannel: msg.sourceChannel ?? null,
      timestamp: msg.createdAt ?? msg.timestamp,
      inputMode: msg.inputMode ?? null,
    }));

    const renderedRecallMessages = renderSessionMessagesForUserSurface<RecallMessage>(
      rawRecallMessages,
      piiReadContext,
    );

    // 7. Validate payload size
    let truncated = false;
    const recallMessages: RecallMessage[] = [];
    let payloadBytes = 0;
    const sessionIds = new Set<string>();

    for (const recallMsg of renderedRecallMessages) {
      // Estimate size (rough byte count of content)
      const msgSize = Buffer.byteLength(JSON.stringify(recallMsg), 'utf8');
      if (payloadBytes + msgSize > OMNICHANNEL_RECALL_MAX_PAYLOAD_BYTES) {
        truncated = true;
        break;
      }

      payloadBytes += msgSize;
      recallMessages.push(recallMsg);
      sessionIds.add(recallMsg.sessionId);
    }

    // If we hit the message limit, mark as truncated
    if (messages.length >= maxMessages) {
      truncated = true;
    }

    const result: RecallResult = {
      messages: recallMessages,
      metadata: {
        matchedSessions: sessionIds.size,
        truncated,
        payloadBytes,
      },
    };

    emitOmnichannelAudit({
      eventType: 'omnichannel_recall_returned',
      tenantId: this.tenantId,
      projectId: this.projectId,
      sessionId: request.sessionId,
      data: {
        messageCount: recallMessages.length,
        matchedSessions: sessionIds.size,
        truncated,
        payloadBytes,
      },
    });

    return result;
  }

  /**
   * Resolve all contact IDs by following mergedInto chains.
   * Returns the canonical ID plus all IDs that merged into it.
   */
  private async resolveMergedContacts(
    Contact: typeof import('@agent-platform/database/models').Contact,
    contactId: string,
  ): Promise<string[]> {
    const allIds = new Set<string>([contactId]);

    // Follow mergedInto chain forward (this contact was merged into another)
    let currentId = contactId;
    let depth = 0;
    while (depth < MAX_MERGE_DEPTH) {
      const contact = await Contact.findOne({
        _id: currentId,
        tenantId: this.tenantId,
      }).lean();
      if (!contact || !contact.mergedInto) break;
      if (allIds.has(contact.mergedInto)) break; // cycle detection
      allIds.add(contact.mergedInto);
      currentId = contact.mergedInto;
      depth++;
    }

    // Walk reverse merge edges breadth-first so deeper trees like A <- B <- C
    // include every secondary contact, not just one reverse hop.
    let reverseFrontier = [...allIds];
    let reverseDepth = 0;
    while (reverseFrontier.length > 0 && reverseDepth < MAX_MERGE_DEPTH) {
      const mergedContacts = await Contact.find({
        tenantId: this.tenantId,
        mergedInto: { $in: reverseFrontier },
      })
        .select('_id')
        .lean();

      const nextFrontier: string[] = [];
      for (const contact of mergedContacts) {
        if (!allIds.has(contact._id)) {
          allIds.add(contact._id);
          nextFrontier.push(contact._id);
        }
      }

      if (nextFrontier.length === 0) {
        break;
      }

      reverseFrontier = nextFrontier;
      reverseDepth++;
    }

    return [...allIds];
  }

  /**
   * Filter out soft-deleted contacts.
   * Contacts with deletedAt set are considered soft-deleted (GDPR).
   */
  private async filterActiveContacts(
    Contact: typeof import('@agent-platform/database/models').Contact,
    contactIds: string[],
  ): Promise<string[]> {
    const activeContacts = await Contact.find({
      _id: { $in: contactIds },
      tenantId: this.tenantId,
      deletedAt: null,
    })
      .select('_id')
      .lean();

    return activeContacts.map((c: { _id: string }) => c._id);
  }
}
