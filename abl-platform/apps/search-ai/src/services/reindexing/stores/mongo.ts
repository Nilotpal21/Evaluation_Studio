/**
 * MongoDB Change Store
 *
 * Default ChangeStore implementation using MongoDB.
 * Stores persisted change sets as documents in the reindex_change_sets collection.
 *
 * Reference: docs/searchai/pipelines/REINDEXING-OPTIMIZATION-STRATEGY.md section 3
 */

import { randomUUID } from 'node:crypto';
import mongoose, { Schema, model } from 'mongoose';
import { createLogger } from '@abl/compiler/platform';
import type { ChangeStore, PersistedChangeSet } from '../types.js';

const logger = createLogger('reindex-change-store');

// ─── Schema ──────────────────────────────────────────────────────────────

const ChangeSetSchema = new Schema(
  {
    _id: { type: String, default: () => randomUUID() },
    changeSetId: { type: String, required: true, index: true },
    tenantId: { type: String, required: true, index: true },
    knowledgeBaseId: { type: String, required: true },
    pipelineId: { type: String, required: true },
    previousPipelineVersion: { type: Number, required: true },
    newPipelineVersion: { type: Number, required: true },
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'executing', 'completed', 'cancelled'],
      default: 'pending',
    },
    embeddingChanged: { type: Boolean, default: false },
    routingChanged: { type: Boolean, default: false },
    preChunkChanges: { type: Schema.Types.Mixed, default: [] },
    postChunkChanges: { type: Schema.Types.Mixed, default: [] },
    plan: { type: Schema.Types.Mixed, default: null },
  },
  {
    timestamps: true,
    collection: 'reindex_change_sets',
  },
);

// TTL: 90 days
ChangeSetSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
ChangeSetSchema.index({ tenantId: 1, knowledgeBaseId: 1, status: 1 });

const ChangeSetModel =
  (mongoose.models.ReindexChangeSet as any) || model('ReindexChangeSet', ChangeSetSchema);

// ─── Implementation ──────────────────────────────────────────────────────

export class MongoChangeStore implements ChangeStore {
  async save(tenantId: string, changeSet: PersistedChangeSet): Promise<string> {
    const doc = await ChangeSetModel.create({
      changeSetId: changeSet.changeSetId,
      tenantId,
      knowledgeBaseId: changeSet.knowledgeBaseId,
      pipelineId: changeSet.pipelineId,
      previousPipelineVersion: changeSet.previousPipelineVersion,
      newPipelineVersion: changeSet.newPipelineVersion,
      status: changeSet.status,
      embeddingChanged: changeSet.embeddingChanged,
      routingChanged: changeSet.routingChanged,
      preChunkChanges: changeSet.preChunkChanges,
      postChunkChanges: changeSet.postChunkChanges,
      plan: changeSet.plan ?? null,
    });

    logger.info('Change set saved', {
      changeSetId: changeSet.changeSetId,
      tenantId,
      status: changeSet.status,
    });

    return doc._id as string;
  }

  async get(tenantId: string, changeSetId: string): Promise<PersistedChangeSet | null> {
    const doc = await ChangeSetModel.findOne({ changeSetId, tenantId }).lean();
    if (!doc) return null;
    return this.toPersistedChangeSet(doc);
  }

  async listPending(tenantId: string, knowledgeBaseId: string): Promise<PersistedChangeSet[]> {
    const docs = await ChangeSetModel.find({
      tenantId,
      knowledgeBaseId,
      status: { $in: ['pending', 'executing'] },
    })
      .sort({ createdAt: -1 })
      .lean();

    return docs.map((doc: any) => this.toPersistedChangeSet(doc));
  }

  async markProcessed(tenantId: string, changeSetId: string): Promise<void> {
    await ChangeSetModel.updateOne({ changeSetId, tenantId }, { $set: { status: 'completed' } });

    logger.info('Change set marked as processed', { changeSetId, tenantId });
  }

  private toPersistedChangeSet(doc: any): PersistedChangeSet {
    return {
      changeSetId: doc.changeSetId,
      tenantId: doc.tenantId,
      knowledgeBaseId: doc.knowledgeBaseId,
      pipelineId: doc.pipelineId,
      previousPipelineVersion: doc.previousPipelineVersion,
      newPipelineVersion: doc.newPipelineVersion,
      status: doc.status,
      embeddingChanged: doc.embeddingChanged,
      routingChanged: doc.routingChanged,
      preChunkChanges: doc.preChunkChanges ?? [],
      postChunkChanges: doc.postChunkChanges ?? [],
      plan: doc.plan ?? undefined,
      createdAt: doc.createdAt,
    };
  }
}
