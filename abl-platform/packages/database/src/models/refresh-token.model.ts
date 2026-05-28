/**
 * Refresh Token Model
 *
 * Stores refresh tokens for JWT-based authentication.
 * Supports token families for rotation detection and automatic
 * TTL-based expiration via MongoDB's expireAfterSeconds index.
 */

import crypto from 'node:crypto';
import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IRefreshToken {
  _id: string;
  token: string;
  userId: string;
  familyId: string | null;
  generation: number;
  rotatedFromId: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const RefreshTokenSchema = new Schema<IRefreshToken>(
  {
    _id: { type: String, default: uuidv7 },
    token: { type: String, required: true },
    userId: { type: String, required: true },
    // New refresh tokens start as their own family roots. Legacy null familyId
    // rows are preserved until the backfill/cleanup migrations finish.
    familyId: { type: String, default: () => crypto.randomUUID() },
    generation: { type: Number, default: 1 },
    rotatedFromId: { type: String, default: null },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'refresh_tokens' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

RefreshTokenSchema.index({ token: 1 }, { unique: true });
RefreshTokenSchema.index({ userId: 1 });
RefreshTokenSchema.index({ familyId: 1 });
RefreshTokenSchema.index(
  { familyId: 1, generation: 1 },
  {
    unique: true,
    name: 'familyId_1_generation_1_unique',
    partialFilterExpression: {
      familyId: { $type: 'string' },
      generation: { $exists: true },
    },
  },
);
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ─── Model ───────────────────────────────────────────────────────────────

export const RefreshToken =
  (mongoose.models.RefreshToken as any) || model<IRefreshToken>('RefreshToken', RefreshTokenSchema);
