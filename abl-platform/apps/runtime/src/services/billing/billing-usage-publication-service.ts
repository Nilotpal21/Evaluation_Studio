import { createLogger } from '@abl/compiler/platform';
import type { AnyBulkWriteOperation } from 'mongoose';
import {
  BillingMaterializationSessionResult,
  BillingUsagePublishedSession,
  type IBillingMaterializationSessionResult,
  type IBillingUsagePublishedSession,
} from '@agent-platform/database/models';
import { uuidv7 } from '@agent-platform/database/mongo';

const log = createLogger('billing-usage-publication-service');

export interface PublishBillingUsageBatchInput {
  tenantId: string;
  batchId: string;
  applicationId: string;
  batchCreatedAt: Date;
  publishedAt?: Date;
}

export interface PublishBillingUsageBatchResult {
  publishedSessionCount: number;
  includedSessionCount: number;
  excludedSessionCount: number;
  skippedSupersededSessionCount: number;
}

interface CurrentPublishedSessionRow {
  _id: string;
  sessionId: string;
  batchId: string;
  batchCreatedAt?: Date;
}

function shouldReplacePublishedRow(
  existing: CurrentPublishedSessionRow | undefined,
  input: PublishBillingUsageBatchInput,
): boolean {
  if (!existing) {
    return true;
  }

  if (existing.batchId === input.batchId) {
    return true;
  }

  if (
    !(existing.batchCreatedAt instanceof Date) ||
    Number.isNaN(existing.batchCreatedAt.getTime())
  ) {
    return true;
  }

  return existing.batchCreatedAt.getTime() < input.batchCreatedAt.getTime();
}

export class BillingUsagePublicationService {
  async publishAppliedMaterialization(
    input: PublishBillingUsageBatchInput,
  ): Promise<PublishBillingUsageBatchResult> {
    const rows = (await BillingMaterializationSessionResult.find({
      tenantId: input.tenantId,
      batchId: input.batchId,
    })
      .sort({ sequence: 1, createdAt: 1 })
      .lean()
      .exec()) as IBillingMaterializationSessionResult[];

    if (rows.length === 0) {
      return {
        publishedSessionCount: 0,
        includedSessionCount: 0,
        excludedSessionCount: 0,
        skippedSupersededSessionCount: 0,
      };
    }

    const publishedAt = input.publishedAt ?? new Date();
    const sessionIds = rows.map((row) => row.sessionId);
    const existingRows = (await BillingUsagePublishedSession.find(
      {
        tenantId: input.tenantId,
        sessionId: { $in: sessionIds },
      },
      {
        _id: 1,
        sessionId: 1,
        batchId: 1,
        batchCreatedAt: 1,
      },
    )
      .lean()
      .exec()) as CurrentPublishedSessionRow[];
    const existingBySessionId = new Map(existingRows.map((row) => [row.sessionId, row]));

    const bulkOperations: AnyBulkWriteOperation<IBillingUsagePublishedSession>[] = [];
    const publishedRows: IBillingMaterializationSessionResult[] = [];

    for (const row of rows) {
      const existing = existingBySessionId.get(row.sessionId);
      if (!shouldReplacePublishedRow(existing, input)) {
        continue;
      }

      publishedRows.push(row);

      if (!existing) {
        bulkOperations.push({
          insertOne: {
            document: {
              _id: uuidv7(),
              tenantId: input.tenantId,
              projectId: row.projectId,
              subscriptionId: row.subscriptionId,
              sessionId: row.sessionId,
              batchId: row.batchId,
              applicationId: input.applicationId,
              batchCreatedAt: input.batchCreatedAt,
              triggerSource: row.triggerSource,
              materializationBasis: row.materializationBasis,
              channel: row.channel,
              status: row.status,
              disposition: row.disposition,
              sessionType: row.sessionType,
              startedAt: row.startedAt,
              endedAt: row.endedAt,
              publishedAt,
              durationSeconds: row.durationSeconds,
              userMessageCount: row.userMessageCount,
              assistantMessageCount: row.assistantMessageCount,
              toolMessageCount: row.toolMessageCount,
              interactiveTurnCount: row.interactiveTurnCount,
              engagedSeconds: row.engagedSeconds,
              llmCallCount: row.llmCallCount,
              toolCallCount: row.toolCallCount,
              metricsSource: row.metricsSource,
              included: row.included,
              exclusionReasons: [...row.exclusionReasons],
              baseUnits: row.baseUnits,
              llmAddonUnits: row.llmAddonUnits,
              toolAddonUnits: row.toolAddonUnits,
              totalUnits: row.totalUnits,
              _v: 1,
              createdAt: publishedAt,
              updatedAt: publishedAt,
            },
          },
        });
        continue;
      }

      bulkOperations.push({
        updateOne: {
          filter: {
            _id: existing._id,
            tenantId: input.tenantId,
          },
          update: {
            $set: {
              projectId: row.projectId,
              subscriptionId: row.subscriptionId,
              batchId: row.batchId,
              applicationId: input.applicationId,
              batchCreatedAt: input.batchCreatedAt,
              triggerSource: row.triggerSource,
              materializationBasis: row.materializationBasis,
              channel: row.channel,
              status: row.status,
              disposition: row.disposition,
              sessionType: row.sessionType,
              startedAt: row.startedAt,
              endedAt: row.endedAt,
              publishedAt,
              durationSeconds: row.durationSeconds,
              userMessageCount: row.userMessageCount,
              assistantMessageCount: row.assistantMessageCount,
              toolMessageCount: row.toolMessageCount,
              interactiveTurnCount: row.interactiveTurnCount,
              engagedSeconds: row.engagedSeconds,
              llmCallCount: row.llmCallCount,
              toolCallCount: row.toolCallCount,
              metricsSource: row.metricsSource,
              included: row.included,
              exclusionReasons: [...row.exclusionReasons],
              baseUnits: row.baseUnits,
              llmAddonUnits: row.llmAddonUnits,
              toolAddonUnits: row.toolAddonUnits,
              totalUnits: row.totalUnits,
              updatedAt: publishedAt,
            },
          },
        },
      });
    }

    if (bulkOperations.length > 0) {
      await BillingUsagePublishedSession.bulkWrite(bulkOperations, { ordered: false });
    }

    const publishedSessionCount = publishedRows.length;
    const includedSessionCount = publishedRows.filter((row) => row.included).length;
    const excludedSessionCount = publishedRows.length - includedSessionCount;
    const skippedSupersededSessionCount = rows.length - publishedRows.length;

    log.info('Published billing usage sessions from materialization application', {
      tenantId: input.tenantId,
      batchId: input.batchId,
      applicationId: input.applicationId,
      publishedSessionCount,
      includedSessionCount,
      excludedSessionCount,
      skippedSupersededSessionCount,
    });

    return {
      publishedSessionCount,
      includedSessionCount,
      excludedSessionCount,
      skippedSupersededSessionCount,
    };
  }
}
