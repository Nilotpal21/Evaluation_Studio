/**
 * MergeSuggestionMongoStore
 *
 * MongoDB implementation of the MergeSuggestionStore port.
 * Uses Mongoose model injected via constructor for testability.
 *
 * Invariants:
 * - Every query includes `tenantId` (tenant isolation).
 * - Document-to-domain mapping strips `_id` and maps to `id`.
 */

import type { Model } from 'mongoose';
import type { IMergeSuggestion } from '@agent-platform/database/models';
import type { MergeSuggestion, MergeSuggestionStatus } from '../domain/merge-suggestion.js';
import type { MergeSuggestionStore } from '../../../routes/merge-suggestions.js';

// ─── Mapping Helpers ────────────────────────────────────────────────────

/** Map a lean Mongoose document to a domain MergeSuggestion. */
function toDomain(doc: IMergeSuggestion): MergeSuggestion {
  return {
    id: doc._id,
    tenantId: doc.tenantId,
    primaryContactId: doc.primaryContactId,
    secondaryContactId: doc.secondaryContactId,
    overlapIdentities: (doc.overlapIdentities ?? []).map((o) => ({
      type: o.type,
      blindIndex: o.blindIndex,
    })),
    confidence: doc.confidence,
    status: doc.status,
    suggestedAt: doc.suggestedAt,
    resolvedAt: doc.resolvedAt,
    resolvedBy: doc.resolvedBy,
  };
}

// ─── Store ──────────────────────────────────────────────────────────────

export class MergeSuggestionMongoStore implements MergeSuggestionStore {
  constructor(private readonly model: Model<IMergeSuggestion>) {}

  async create(suggestion: Omit<MergeSuggestion, 'id'>): Promise<MergeSuggestion> {
    const instance = new this.model(suggestion);
    await instance.save();
    const doc = instance.toObject();
    return toDomain(doc as IMergeSuggestion);
  }

  async findByTenant(tenantId: string, status?: MergeSuggestionStatus): Promise<MergeSuggestion[]> {
    const filter: Record<string, unknown> = { tenantId };
    if (status) {
      filter.status = status;
    }
    const docs = await this.model.find(filter).lean();
    return (docs as IMergeSuggestion[]).map(toDomain);
  }

  async findById(tenantId: string, suggestionId: string): Promise<MergeSuggestion | null> {
    const doc = await this.model.findOne({ _id: suggestionId, tenantId }).lean();
    return doc ? toDomain(doc as IMergeSuggestion) : null;
  }

  async updateStatus(
    tenantId: string,
    suggestionId: string,
    status: MergeSuggestionStatus,
    resolvedBy: string,
  ): Promise<MergeSuggestion | null> {
    const doc = await this.model
      .findOneAndUpdate(
        { _id: suggestionId, tenantId },
        { $set: { status, resolvedBy, resolvedAt: new Date() } },
        { new: true },
      )
      .lean();
    return doc ? toDomain(doc as IMergeSuggestion) : null;
  }
}
