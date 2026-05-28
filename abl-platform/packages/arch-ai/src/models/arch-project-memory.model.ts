/**
 * ArchProjectMemoryModel Model
 *
 * Persists cross-session project memory for Arch AI.
 * One document per (tenantId, projectId) — stores decisions, patterns,
 * preferences, constraints, and learnings that persist across sessions.
 *
 * Max 50 memories per project. When the limit is reached, the lowest
 * relevance entry is evicted to make room for new ones.
 *
 * These memories are injected into the LLM system prompt during IN_PROJECT
 * mode so the AI retains context about previous sessions.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '@agent-platform/database/mongo';

// ─── Constants ──────────────────────────────────────────────────────────

/** Max memory entries stored per project */
const MAX_MEMORIES = 50;

// ─── Embedded Subdocument: ProjectMemoryEntry ───────────────────────────

export type ProjectMemoryType = 'decision' | 'pattern' | 'preference' | 'constraint' | 'learning';
export type ProjectMemorySource = 'auto' | 'user';

export interface IProjectMemoryEntry {
  id: string;
  type: ProjectMemoryType;
  content: string;
  source: ProjectMemorySource;
  phase: string;
  sessionId: string;
  createdAt: Date;
  relevance: number;
}

const ProjectMemoryEntrySubSchema = new Schema<IProjectMemoryEntry>(
  {
    id: { type: String, required: true },
    type: {
      type: String,
      required: true,
      enum: ['decision', 'pattern', 'preference', 'constraint', 'learning'],
    },
    content: { type: String, required: true },
    source: { type: String, required: true, enum: ['auto', 'user'] },
    phase: { type: String, required: true },
    sessionId: { type: String, required: true },
    createdAt: { type: Date, default: () => new Date() },
    relevance: { type: Number, required: true, default: 0.5, min: 0, max: 1 },
  },
  { _id: false },
);

// ─── Document Interface ────────────────────────────────────────────────

export interface IArchProjectMemoryRecord {
  _id: string;
  tenantId: string;
  projectId: string;
  memories: IProjectMemoryEntry[];
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ────────────────────────────────────────────────────────────

const ArchProjectMemorySchema = new Schema<IArchProjectMemoryRecord>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    memories: {
      type: [ProjectMemoryEntrySubSchema],
      default: [],
      validate: {
        validator: (entries: IProjectMemoryEntry[]) => entries.length <= MAX_MEMORIES,
        message: `Project memory exceeds max ${MAX_MEMORIES} entries — evict lowest relevance first`,
      },
    },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'arch_project_memories_v4' },
);

// ─── Indexes ───────────────────────────────────────────────────────────

// Primary lookup: one memory document per tenant per project
ArchProjectMemorySchema.index({ tenantId: 1, projectId: 1 }, { unique: true });

// Find all memories for a tenant (admin/cleanup)
ArchProjectMemorySchema.index({ tenantId: 1 });

// ─── Model ─────────────────────────────────────────────────────────────

export const ArchProjectMemoryModel =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models.ArchProjectMemoryModel as any) ||
  model<IArchProjectMemoryRecord>('ArchProjectMemoryModel', ArchProjectMemorySchema);
