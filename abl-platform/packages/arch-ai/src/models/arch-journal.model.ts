/**
 * Arch AI Journal Model
 *
 * Append-only journal recording every significant action in an Arch session.
 * 5 record types: decision, consultation, mutation, validation, analysis.
 *
 * Contract: CC-F01, api-index.md (GET /sessions/:id/journal)
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7, tenantIsolationPlugin } from '@agent-platform/database/mongo';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IArchJournalRecord {
  _id: string;
  sessionId: string;
  projectId?: string;
  tenantId: string;
  userId: string;
  type: 'decision' | 'consultation' | 'mutation' | 'validation' | 'analysis';
  content: Record<string, unknown>;
  specialist: string;
  phase: string;
  timestamp: string;
  status: 'active' | 'superseded' | 'archived' | 'invalidated';
  sequence: number;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ArchJournalSchema = new Schema<IArchJournalRecord>(
  {
    _id: { type: String, default: uuidv7 },
    sessionId: { type: String, required: true },
    projectId: { type: String, required: false },
    tenantId: { type: String, required: true },
    userId: { type: String, required: true },
    type: {
      type: String,
      required: true,
      enum: ['decision', 'consultation', 'mutation', 'validation', 'analysis'],
    },
    content: { type: Schema.Types.Mixed, required: true },
    specialist: { type: String, required: true },
    phase: { type: String, required: true },
    timestamp: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: ['active', 'superseded', 'archived', 'invalidated'],
      default: 'active',
    },
    sequence: { type: Number, required: true },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'arch_journals_v4' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ArchJournalSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Primary query: get all entries for a session, ordered by sequence
// CC-F01 technical notes: "indexes on { sessionId: 1, sequence: 1 }"
ArchJournalSchema.index({ sessionId: 1, sequence: 1 });

// Filter by phase within a session
// CC-F01 technical notes: "{ sessionId: 1, phase: 1 }"
ArchJournalSchema.index({ sessionId: 1, phase: 1 });

// Filter by type within a session
ArchJournalSchema.index({ sessionId: 1, type: 1 });

// Query journal entries linked to a project (S4-F04 req 11: queryable by projectId)
ArchJournalSchema.index({ projectId: 1, sequence: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const ArchJournalModel =
  (mongoose.models.ArchJournalModel as mongoose.Model<IArchJournalRecord>) ||
  model<IArchJournalRecord>('ArchJournalModel', ArchJournalSchema);
