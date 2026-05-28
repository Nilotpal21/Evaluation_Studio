/**
 * Prompt Template Model
 *
 * Stores prompt templates, system tool schemas, tool descriptions, and default
 * messages at the environment level (platform-wide, not per-tenant).
 *
 * Resolution chain: DB lookup → hardcoded PromptCatalog fallback.
 * Updated via seed script; future: admin UI for editing per environment.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IPromptTemplate {
  _id: string;
  /** Unique key, e.g., 'system_prompt.supervisor', 'tool_schema.handoff', 'message.error_default' */
  key: string;
  /** Category for grouping: system_prompt, tool_schema, tool_description, message, escalation, pattern */
  category:
    | 'system_prompt'
    | 'tool_schema'
    | 'tool_description'
    | 'message'
    | 'escalation'
    | 'pattern';
  /** Template content — string for prompt templates, object for JSON schemas */
  content: unknown;
  /** Optional description of what this template is for */
  description?: string;
  /** Schema version — increment when format changes */
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const PromptTemplateSchema = new Schema<IPromptTemplate>(
  {
    _id: { type: String, default: uuidv7 },
    key: { type: String, required: true },
    category: {
      type: String,
      required: true,
      enum: [
        'system_prompt',
        'tool_schema',
        'tool_description',
        'message',
        'escalation',
        'pattern',
      ],
    },
    content: { type: Schema.Types.Mixed, required: true },
    description: { type: String },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'prompt_templates' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

PromptTemplateSchema.index({ key: 1 }, { unique: true });
PromptTemplateSchema.index({ category: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const PromptTemplate =
  (mongoose.models.PromptTemplate as any) ||
  model<IPromptTemplate>('PromptTemplate', PromptTemplateSchema);
