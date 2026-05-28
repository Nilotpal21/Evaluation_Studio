/**
 * ArchLearningMemoryModel Model
 *
 * Persists Arch AI's cross-project learning memory (Layer 3).
 * Stores patterns that Arch discovers across all projects:
 * error→fix patterns, topology→domain mappings, construct usage,
 * and model preferences.
 *
 * Unlike project memory (Layer 2, scoped per project), learning memory
 * is Arch's OWN knowledge that improves recommendations over time.
 *
 * Bounded to MAX_LEARNINGS entries. When exceeded, the lowest
 * confidence entry is evicted to make room for new observations.
 *
 * Confidence increases with repeated observations (capped at 0.95).
 * Learnings are anonymized — no project names, user names, or data.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '@agent-platform/database/mongo';

// ─── Constants ──────────────────────────────────────────────────────────

/** Max learning entries stored globally — evict lowest confidence */
const MAX_LEARNINGS = 1000;

// ─── Types ──────────────────────────────────────────────────────────────

export type LearningMemoryType =
  | 'error_fix'
  | 'topology_pattern'
  | 'construct_usage'
  | 'model_preference';

// ─── Document Interface ────────────────────────────────────────────────

export interface IArchLearningMemoryRecord {
  _id: string;
  type: LearningMemoryType;

  /** Short description: "Missing HANDOFF target" */
  pattern: string;
  /** What works: "Add target agent to topology first" */
  resolution: string;
  /** 0-1, increases with observations (capped at 0.95) */
  confidence: number;
  /** How many times this pattern has been observed */
  observationCount: number;

  /** Domain context: e-commerce, support, healthcare, etc. */
  domain?: string;
  /** Agent role context: triage, specialist, supervisor */
  agentRole?: string;
  /** ABL construct context: HANDOFF, GATHER, TOOLS, etc. */
  construct?: string;

  /** Tenant scope — null means global (anonymized) */
  tenantId?: string;

  /** When this pattern was first observed */
  firstSeen: Date;
  /** When this pattern was last observed */
  lastSeen: Date;

  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ────────────────────────────────────────────────────────────

const ArchLearningMemorySchema = new Schema<IArchLearningMemoryRecord>(
  {
    _id: { type: String, default: uuidv7 },
    type: {
      type: String,
      required: true,
      enum: ['error_fix', 'topology_pattern', 'construct_usage', 'model_preference'],
    },
    pattern: { type: String, required: true },
    resolution: { type: String, required: true },
    confidence: { type: Number, required: true, default: 0.3, min: 0, max: 1 },
    observationCount: { type: Number, required: true, default: 1, min: 1 },
    domain: { type: String, default: undefined },
    agentRole: { type: String, default: undefined },
    construct: { type: String, default: undefined },
    tenantId: { type: String, default: undefined },
    firstSeen: { type: Date, required: true, default: () => new Date() },
    lastSeen: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true, collection: 'arch_learning_memories_v4' },
);

// ─── Indexes ───────────────────────────────────────────────────────────

// Primary lookup: by type sorted by confidence (descending)
ArchLearningMemorySchema.index({ type: 1, confidence: -1 });

// Domain-specific lookups
ArchLearningMemorySchema.index({ type: 1, domain: 1 });

// Construct-specific lookups
ArchLearningMemorySchema.index({ type: 1, construct: 1 });

// Duplicate detection: find existing patterns by type + pattern text
ArchLearningMemorySchema.index({ type: 1, pattern: 1 });

// Eviction: find lowest confidence entries for bounded collection
ArchLearningMemorySchema.index({ confidence: 1 });

// ─── Model ─────────────────────────────────────────────────────────────

export const ArchLearningMemoryModel =
  (mongoose.models.ArchLearningMemoryModel as any) ||
  model<IArchLearningMemoryRecord>('ArchLearningMemoryModel', ArchLearningMemorySchema);
