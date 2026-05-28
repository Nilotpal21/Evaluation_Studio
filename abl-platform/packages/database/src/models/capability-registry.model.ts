/**
 * Capability Registry Model - RFC-SEARCHAI-001
 *
 * Stores registered capabilities (aggregations, operators, sort functions) that
 * vocabulary terms can resolve to at query time. Enables dynamic vocabulary
 * resolution (FR-1) by providing a registry of what operations are available.
 *
 * Capabilities define:
 * - What operations are supported (count, sum, filter, sort, etc.)
 * - Which field types they work with
 * - Keywords that trigger them in natural language queries
 * - Examples for LLM context
 *
 * Starts with 'global' tenantId for system-wide capabilities, prepared for
 * tenant-specific customization in the future.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface ICapability {
  _id: string;
  tenantId: string; // Start with 'global', prepare for tenant customization
  name: string; // "count", "sum", "avg", "equals", "contains"
  type: 'aggregation' | 'operator' | 'sort'; // Capability category
  description: string; // Human-readable description
  supportedFieldTypes: string[]; // ["number", "text", "date"] - field types this works with
  triggerKeywords: string[]; // ["count", "total", "number of"] - NL keywords
  examples: string[]; // ["count bugs by status", "total revenue"] - for LLM context
  enabled: boolean; // Whether this capability is active
  metadata: {
    version: number; // Capability version
    createdBy: 'system' | 'admin'; // Who created this capability
  };
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const CapabilitySchema = new Schema<ICapability>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: {
      type: String,
      required: true,
      index: true,
      default: 'global', // Global capabilities for all tenants
    },
    name: {
      type: String,
      required: true,
      maxlength: 50,
    },
    type: {
      type: String,
      enum: ['aggregation', 'operator', 'sort'],
      required: true,
    },
    description: {
      type: String,
      required: true,
      maxlength: 500,
    },
    supportedFieldTypes: {
      type: [String],
      required: true,
      validate: {
        validator: (arr: string[]) => arr.length > 0,
        message: 'At least one supported field type required',
      },
    },
    triggerKeywords: {
      type: [String],
      required: true,
      validate: {
        validator: (arr: string[]) => arr.length > 0,
        message: 'At least one trigger keyword required',
      },
    },
    examples: {
      type: [String],
      required: true,
      validate: {
        validator: (arr: string[]) => arr.length > 0,
        message: 'At least one example required',
      },
    },
    enabled: {
      type: Boolean,
      default: true,
    },
    metadata: {
      version: {
        type: Number,
        default: 1,
      },
      createdBy: {
        type: String,
        enum: ['system', 'admin'],
        default: 'system',
      },
    },
  },
  {
    timestamps: true,
    collection: 'capability_registry',
  },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

CapabilitySchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Query capabilities by tenant and type
CapabilitySchema.index({ tenantId: 1, type: 1 });

// Query enabled capabilities for a tenant
CapabilitySchema.index({ tenantId: 1, enabled: 1 });

// Ensure unique capability names per tenant
CapabilitySchema.index({ tenantId: 1, name: 1 }, { unique: true });

// ─── Model ───────────────────────────────────────────────────────────────

export const CapabilityRegistry =
  (mongoose.models.CapabilityRegistry as any) ||
  model<ICapability>('CapabilityRegistry', CapabilitySchema);
