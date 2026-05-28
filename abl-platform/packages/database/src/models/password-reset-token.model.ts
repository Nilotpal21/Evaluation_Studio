/**
 * Password Reset Token Model
 *
 * Stores tokens sent to users for resetting their password.
 * Automatically cleaned up via MongoDB TTL index on expiresAt.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IPasswordResetToken {
  _id: string;
  userId: string;
  token: string;
  expiresAt: Date;
  usedAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const PasswordResetTokenSchema = new Schema<IPasswordResetToken>(
  {
    _id: { type: String, default: uuidv7 },
    userId: { type: String, required: true },
    token: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'password_reset_tokens' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

PasswordResetTokenSchema.index({ token: 1 }, { unique: true });
PasswordResetTokenSchema.index({ userId: 1 });
PasswordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ─── Model ───────────────────────────────────────────────────────────────

export const PasswordResetToken =
  (mongoose.models.PasswordResetToken as any) ||
  model<IPasswordResetToken>('PasswordResetToken', PasswordResetTokenSchema);
