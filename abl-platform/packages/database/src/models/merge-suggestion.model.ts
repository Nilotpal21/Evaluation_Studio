/**
 * MergeSuggestion Model
 *
 * Stores suggestions to merge two contacts that share overlapping identities.
 * Each suggestion is scoped to a tenant and tracks the resolution lifecycle
 * (pending -> accepted/rejected/auto_merged).
 *
 * OverlapIdentities use blind indexes so suggestions can be evaluated
 * without decrypting PII.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Subdocument Interfaces ─────────────────────────────────────────────

export interface IOverlapIdentity {
  type: string;
  blindIndex: string;
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface IMergeSuggestion {
  _id: string;
  tenantId: string;
  primaryContactId: string;
  secondaryContactId: string;
  overlapIdentities: IOverlapIdentity[];
  confidence: 'high' | 'medium' | 'low';
  status: 'pending' | 'accepted' | 'rejected' | 'auto_merged';
  suggestedAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Subdocument Schema ─────────────────────────────────────────────────

const OverlapIdentitySchema = new Schema<IOverlapIdentity>(
  {
    type: { type: String, required: true },
    blindIndex: { type: String, required: true },
  },
  { _id: false },
);

// ─── Schema ──────────────────────────────────────────────────────────────

const MergeSuggestionSchema = new Schema<IMergeSuggestion>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    primaryContactId: { type: String, required: true },
    secondaryContactId: { type: String, required: true },
    overlapIdentities: { type: [OverlapIdentitySchema], default: [] },
    confidence: {
      type: String,
      enum: ['high', 'medium', 'low'],
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'rejected', 'auto_merged'],
      default: 'pending',
    },
    suggestedAt: { type: Date, default: Date.now },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: String, default: null },
  },
  { timestamps: true, collection: 'merge_suggestions' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

MergeSuggestionSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Query pending suggestions per tenant
MergeSuggestionSchema.index({ tenantId: 1, status: 1 });

// Check if suggestion already exists for a contact pair
MergeSuggestionSchema.index({ tenantId: 1, primaryContactId: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const MergeSuggestion =
  (mongoose.models.MergeSuggestion as any) ||
  model<IMergeSuggestion>('MergeSuggestion', MergeSuggestionSchema);
