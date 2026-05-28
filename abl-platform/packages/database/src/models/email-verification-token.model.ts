/**
 * Email Verification Token Model
 *
 * Stores tokens sent to users for verifying their email address.
 * Automatically cleaned up via MongoDB TTL index on expiresAt.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IEmailVerificationToken {
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

const EmailVerificationTokenSchema = new Schema<IEmailVerificationToken>(
  {
    _id: { type: String, default: uuidv7 },
    userId: { type: String, required: true },
    token: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'email_verification_tokens' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

EmailVerificationTokenSchema.index({ token: 1 }, { unique: true });
EmailVerificationTokenSchema.index({ userId: 1 });
EmailVerificationTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ─── Model ───────────────────────────────────────────────────────────────

export const EmailVerificationToken =
  (mongoose.models.EmailVerificationToken as any) ||
  model<IEmailVerificationToken>('EmailVerificationToken', EmailVerificationTokenSchema);
