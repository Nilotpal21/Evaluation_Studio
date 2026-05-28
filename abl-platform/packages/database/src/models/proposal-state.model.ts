/**
 * Proposal State Model
 *
 * Tracks the lifecycle of a connector configuration proposal — from generation
 * through section-by-section review to approval or abandonment.
 * One active proposal per connector (enforced via partial unique index).
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Types ──────────────────────────────────────────────────────────────

export type ProposalStatus = 'generating' | 'ready' | 'approved' | 'failed' | 'abandoned';
export type GenerationStepStatus = 'pending' | 'in_progress' | 'done' | 'waiting' | 'failed';
export type SectionReviewStatus = 'pending' | 'accepted' | 'modified' | 'skipped';

const ACTIVE_PROPOSAL_STATUSES: ProposalStatus[] = ['generating', 'ready', 'approved'];

export interface IGenerationStep {
  id: string;
  label: string;
  status: GenerationStepStatus;
  statusText: string;
  dependsOn: string[];
  startedAt?: Date;
  completedAt?: Date;
}

export interface ISectionData {
  status: SectionReviewStatus;
  data: Record<string, unknown>;
  reviewedAt?: Date;
  reviewedBy?: string;
}

export interface IDecisionEntry {
  timestamp: Date;
  user: string;
  section: string;
  decision: 'accept' | 'modify' | 'skip' | 'disable' | 'accept_all';
  detail?: string;
}

export interface IProposalState {
  _id: string;
  connectorId: string;
  tenantId: string;
  status: ProposalStatus;
  generationSteps: IGenerationStep[];
  sections: Record<string, ISectionData>;
  decisions: IDecisionEntry[];
  generatedAt?: Date;
  approvedAt?: Date;
  approvedBy?: string;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ─────────────────────────────────────────────────────────────

const ProposalStateSchema = new Schema<IProposalState>(
  {
    _id: { type: String, default: uuidv7 },
    connectorId: { type: String, required: true },
    tenantId: { type: String, required: true },
    status: {
      type: String,
      enum: ['generating', 'ready', 'approved', 'failed', 'abandoned'],
      default: 'generating',
    },
    generationSteps: [
      {
        id: String,
        label: String,
        status: {
          type: String,
          enum: ['pending', 'in_progress', 'done', 'waiting', 'failed'],
        },
        statusText: String,
        dependsOn: [String],
        startedAt: Date,
        completedAt: Date,
      },
    ],
    sections: { type: Schema.Types.Mixed, default: {} },
    decisions: [
      {
        timestamp: { type: Date, default: Date.now },
        user: String,
        section: String,
        decision: {
          type: String,
          enum: ['accept', 'modify', 'skip', 'disable', 'accept_all'],
        },
        detail: String,
      },
    ],
    generatedAt: Date,
    approvedAt: Date,
    approvedBy: String,
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'proposal_states' },
);

// ─── Plugins ────────────────────────────────────────────────────────────

ProposalStateSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ────────────────────────────────────────────────────────────

// Primary query pattern: active proposal for a connector
ProposalStateSchema.index({ tenantId: 1, connectorId: 1, status: 1 });

// One active proposal per connector (abandoned/failed excluded so re-creation works)
ProposalStateSchema.index(
  { tenantId: 1, connectorId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ACTIVE_PROPOSAL_STATUSES } },
  },
);

// ─── Model ──────────────────────────────────────────────────────────────

// Register with ModelRegistry for dual-database support
ModelRegistry.registerModelDefinition('ProposalState', ProposalStateSchema, 'platform');

// Hot-reload safe export (prevents "Cannot overwrite model" in dev)
export const ProposalState =
  (mongoose.models.ProposalState as mongoose.Model<IProposalState>) ||
  model<IProposalState>('ProposalState', ProposalStateSchema);
