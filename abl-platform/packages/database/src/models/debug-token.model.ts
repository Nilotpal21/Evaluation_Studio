/**
 * Debug Token Model
 *
 * Manages short-lived debug tokens for session inspection.
 * Tokens grant scoped access to specific sessions and are
 * automatically removed after expiration via TTL index.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IDebugToken {
  _id: string;
  token: string;
  userId: string;
  sessionIds: string[];
  scopes: string[];
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const DebugTokenSchema = new Schema<IDebugToken>(
  {
    _id: { type: String, default: uuidv7 },
    token: { type: String, required: true },
    userId: { type: String, required: true },
    sessionIds: { type: [String], default: [] },
    scopes: { type: [String], default: [] },
    expiresAt: { type: Date, required: true },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'debug_tokens' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

DebugTokenSchema.index({ token: 1 }, { unique: true });
DebugTokenSchema.index({ userId: 1 });
DebugTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ─── Model ───────────────────────────────────────────────────────────────

export const DebugToken =
  (mongoose.models.DebugToken as any) || model<IDebugToken>('DebugToken', DebugTokenSchema);
