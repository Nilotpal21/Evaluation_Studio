/**
 * TagRule Model
 *
 * Stores per-tenant, per-project tag rules for automatic or manual
 * conversation tagging.  Each rule defines a set of conditions that,
 * when matched, apply a named tag to a conversation.
 */

import mongoose, { Schema, type Document } from 'mongoose';

// ─── Document Interface ──────────────────────────────────────────────────

export interface ITagRule extends Document {
  tenantId: string;
  projectId: string;
  tagName: string;
  description?: string;
  color?: string;
  conditions: Array<{
    field: string;
    operator: 'eq' | 'neq' | 'gt' | 'lt' | 'contains' | 'in';
    value: unknown;
  }>;
  conditionLogic: 'AND' | 'OR';
  autoApply: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const TagRuleSchema = new Schema<ITagRule>(
  {
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    tagName: { type: String, required: true },
    description: { type: String },
    color: { type: String },
    conditions: [
      {
        field: { type: String, required: true },
        operator: {
          type: String,
          required: true,
          enum: ['eq', 'neq', 'gt', 'lt', 'contains', 'in'],
        },
        value: { type: Schema.Types.Mixed, required: true },
      },
    ],
    conditionLogic: {
      type: String,
      enum: ['AND', 'OR'],
      default: 'AND',
    },
    autoApply: { type: Boolean, default: false },
    createdBy: { type: String, required: true },
  },
  { timestamps: true, collection: 'tag_rules' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

TagRuleSchema.index({ tenantId: 1, projectId: 1, tagName: 1 }, { unique: true });
TagRuleSchema.index({ tenantId: 1, projectId: 1, autoApply: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const TagRuleModel =
  mongoose.models['TagRule'] ?? mongoose.model<ITagRule>('TagRule', TagRuleSchema);
