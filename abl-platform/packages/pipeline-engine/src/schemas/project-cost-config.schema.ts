/**
 * ProjectCostConfig Model
 *
 * Stores per-tenant, per-project cost configuration inputs used by
 * the ROI calculator to compute savings, FTE equivalents, and budget status.
 */

import mongoose, { Schema, type Document } from 'mongoose';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IProjectCostConfig extends Document {
  tenantId: string;
  projectId: string;
  costPerHumanInteraction: number;
  costPerAIInteraction: number;
  fteCapacityPerDay: number;
  fteCostPerYear: number;
  monthlyBudget: number;
  containmentRate: number;
  totalConversationsPerMonth: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ProjectCostConfigSchema = new Schema<IProjectCostConfig>(
  {
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    costPerHumanInteraction: { type: Number, required: true },
    costPerAIInteraction: { type: Number, required: true },
    fteCapacityPerDay: { type: Number, required: true },
    fteCostPerYear: { type: Number, required: true },
    monthlyBudget: { type: Number, required: true },
    containmentRate: { type: Number, required: true },
    totalConversationsPerMonth: { type: Number, required: true },
    createdBy: { type: String, required: true },
  },
  { timestamps: true, collection: 'project_cost_configs' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

ProjectCostConfigSchema.index({ tenantId: 1, projectId: 1 }, { unique: true });

// ─── Model ───────────────────────────────────────────────────────────────

export const ProjectCostConfigModel =
  mongoose.models['ProjectCostConfig'] ??
  mongoose.model<IProjectCostConfig>('ProjectCostConfig', ProjectCostConfigSchema);
