/**
 * Agent Version Model
 *
 * Stores versioned snapshots of agent DSL and compiled IR.
 * Tracks version lifecycle: draft -> testing -> staged -> active -> deprecated.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import type { ProjectToolType } from './project-tool.model.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IAgentVersion {
  _id: string;
  agentId: string;
  version: string;
  status: string;
  dslContent: string;
  irContent: string;
  sourceHash: string;
  changelog: string | null;
  createdBy: string;
  promotedAt: Date | null;
  promotedBy: string | null;
  toolSnapshot: Array<{
    name: string;
    projectToolId: string;
    sourceHash: string;
    runtimeMetadataHash?: string;
    toolType: ProjectToolType;
    description: string | null;
    dslContent: string;
  }> | null;
  testResults: any;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const AgentVersionSchema = new Schema<IAgentVersion>(
  {
    _id: { type: String, default: uuidv7 },
    agentId: { type: String, required: true },
    version: { type: String, required: true },
    status: { type: String, required: true },
    dslContent: { type: String, required: true },
    irContent: { type: String, required: true },
    sourceHash: { type: String, required: true },
    changelog: { type: String, default: null },
    createdBy: { type: String, required: true },
    promotedAt: { type: Date, default: null },
    promotedBy: { type: String, default: null },
    toolSnapshot: { type: Schema.Types.Mixed, default: null },
    testResults: { type: Schema.Types.Mixed, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'agent_versions' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

AgentVersionSchema.index({ agentId: 1, version: 1 }, { unique: true });
AgentVersionSchema.index({ agentId: 1, createdAt: -1 }); // version listing with sort
AgentVersionSchema.index({ agentId: 1 });
AgentVersionSchema.index({ status: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const AgentVersion =
  (mongoose.models.AgentVersion as any) || model<IAgentVersion>('AgentVersion', AgentVersionSchema);
